import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { ConnectFifo, StoredBeginAdapter } from '../src/desktop/stored-begin.js';
import { StoredConnections, type OpenStored } from '../src/desktop/connections.js';
import { makeOwner, type Session } from '../src/protocols/rdp/owner.js';
import type { DocumentLibrary } from '../src/documents/library.js';
import type { Doc2 } from '../src/documents/model.js';
import type { State } from '../src/protocols/rdp/wire.js';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
function child(initial?:State){const value=new EventEmitter() as EventEmitter&{stdin:PassThrough;stdout:PassThrough;stderr:PassThrough;kill():boolean};value.stdin=new PassThrough();value.stdout=new PassThrough();value.stderr=new PassThrough();let ended=false;const exit=()=>{if(!ended){ended=true;queueMicrotask(()=>value.emit('close',0));}};value.kill=()=>{exit();return true;};value.stdin.on('data',(bytes:Buffer)=>{for(const line of bytes.toString().trim().split('\n')){const message=JSON.parse(line);if(message.type==='connect'&&initial)value.stderr.write(JSON.stringify({state:initial,...(initial==='failed'?{reason:'connection'}:{})})+'\n');if(message.type==='close')exit();}});return value;}
function fixture(options:{initial?:State;holdOpened?:boolean;holdPrompt?:boolean}={}){
 const queue=new ConnectFifo(),children:ReturnType<typeof child>[]=[],sessions=new Map<string,Session>(),ready=new Map<string,Promise<Session>>(),closeCalls:string[]=[],opened=deferred<void>(),promptEntered=deferred<void>();let engineCount=0,promptAborts=0,refCount=0;
 const doc:Doc2={schemaVersion:2,id:id(1),kind:'workspace',name:'fixture',revision:0,meta:{createdAt:null,updatedAt:null,sort:[]},defaults:{groups:{}},secrets:{},objects:{[id(2)]:{id:id(2),type:'connection',name:'synthetic',parentId:null,order:0,props:{protocol:'rdp',host:'fixture.invalid',username:'synthetic',...(options.holdPrompt?{}:{groups:{credentials:{mode:'none'}}})}}}};
 const library={privateDocument(){return{doc,seq:0,generation:1};},privateDocuments(){return[{handle:id(3),doc,seq:0,generation:1}];}} as unknown as DocumentLibrary;
 const owner=makeOwner(()=>{const c=child(options.initial);children.push(c);return c as unknown as ChildProcessWithoutNullStreams;},'synthetic-helper');
 let adapter:StoredBeginAdapter;
 const raw=new StoredConnections({library,prompt:async()=>{promptEntered.resolve();const signal=queue.activeSignal!;return new Promise<undefined>(resolve=>{const cancel=()=>{promptAborts++;resolve(undefined);};signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();});},approveScope:async()=>true,open:async(target,secret)=>{
  const sessionId=id(100+ ++engineCount),receipt=adapter.beforeSpawn(sessionId);const promise=owner.open(target,secret,{frame(){},state:state=>receipt.state(state)});ready.set(sessionId,promise);let session:Session;try{session=await promise;}catch(error){receipt.failed(error);throw error;}sessions.set(sessionId,session);if(options.holdOpened)await opened.promise;return sessionId;
 }});
 adapter=new StoredBeginAdapter({queue,openStored:async(ref,signal)=>{refCount++;return raw.openStored(ref);},close:async sessionId=>{closeCalls.push(sessionId);const session=sessions.get(sessionId)??await ready.get(sessionId);await session?.close();}});
 const ref:OpenStored={documentHandle:id(3),objectId:id(2),expectedSeq:0};
 return{queue,adapter,children,sessions,closeCalls,opened,promptEntered,ref,raw,get engineCount(){return engineCount;},get promptAborts(){return promptAborts;},get refCount(){return refCount;},async dispose(){opened.resolve();await Promise.all([...sessions.values()].map(s=>s.close()));}};
}

test('global FIFO serializes whole manual, stored, reconnect and ad hoc starts and releases after helper start',async()=>{
 const queue=new ConnectFifo(),hold=deferred<void>(),order:string[]=[];
 const first=queue.run(async signal=>{assert.equal(queue.activeSignal,signal);order.push('manual');await hold.promise;return'first';});
 const jobs=['stored','reconnect','adHoc'].map(label=>queue.run(async signal=>{assert.equal(queue.activeSignal,signal);order.push(label);return label;}));await tick();assert.deepEqual(order,['manual']);hold.resolve();assert.deepEqual(await Promise.all([first,...jobs]),['first','stored','reconnect','adHoc']);assert.equal(queue.activeSignal,undefined);
});
test('pending FIFO abort never invokes the request and active cancellation is scoped to its own signal',async()=>{
 const queue=new ConnectFifo(),hold=deferred<void>(),active=new AbortController(),pending=new AbortController();let invoked=0,aborted=false;const first=queue.run(async signal=>{signal.addEventListener('abort',()=>{aborted=true;});await hold.promise;return'finished';},active.signal);const second=queue.run(async()=>{invoked++;},pending.signal);const refusal=assert.rejects(second,{name:'AbortError'});pending.abort();await refusal;assert.equal(invoked,0);assert.equal(aborted,false);active.abort();assert.equal(aborted,true);hold.resolve();await first;assert.equal(getEventListeners(active.signal,'abort').length,0);assert.equal(getEventListeners(pending.signal,'abort').length,0);
});
test('real owner open resolution alone never reports connected; owner state releases established and listener cleanup',async()=>{
 const f=fixture(),controller=new AbortController();try{const result=await f.adapter.beginStored(f.ref,controller.signal);let state:string|undefined;void result.established.then(value=>{state=value;});await tick();assert.equal(state,undefined);f.children[0].stderr.write('{"state":"connected"}\n');assert.equal(await result.established,'connected');assert.equal(getEventListeners(controller.signal,'abort').length,0);controller.abort();await tick();assert.deepEqual(f.closeCalls,[]);await result.close();assert.deepEqual(f.closeCalls,[result.sessionId]);}finally{await f.dispose();}
});
for(const state of ['failed','closed','connected'] as const)test(`real owner ${state} before open Promise returns is retained without event loss`,async()=>{
 const f=fixture({initial:state});try{const result=await f.adapter.beginStored(f.ref,new AbortController().signal);assert.equal(await result.established,state);}finally{await f.dispose();}
});
test('active abort in helper-start versus StoredOpened gap closes the exact session before the open call returns',async()=>{
 const f=fixture({holdOpened:true}),controller=new AbortController();try{const pending=f.adapter.beginStored(f.ref,controller.signal);await tick();assert.equal(f.engineCount,1);controller.abort();await tick();assert.deepEqual(f.closeCalls,[id(101)]);f.opened.resolve();const result=await pending;assert.equal(result.sessionId,id(101));assert.equal(await result.established,'closed');assert.equal(getEventListeners(controller.signal,'abort').length,0);}finally{await f.dispose();}
});
test('a connected session in the same pre-return gap survives cancellation and close remains explicit/idempotent',async()=>{
 const f=fixture({initial:'connected',holdOpened:true}),controller=new AbortController();try{const pending=f.adapter.beginStored(f.ref,controller.signal);await tick();controller.abort();await tick();assert.deepEqual(f.closeCalls,[]);f.opened.resolve();const result=await pending;assert.equal(await result.established,'connected');await Promise.all([result.close(),result.close()]);assert.deepEqual(f.closeCalls,[result.sessionId]);}finally{await f.dispose();}
});
test('shared FIFO permits two helpers awaiting state but cannot open a second credential modal concurrently',async()=>{
 const f=fixture();try{const a=await f.adapter.beginStored(f.ref,new AbortController().signal),b=await f.adapter.beginStored(f.ref,new AbortController().signal);assert.equal(f.engineCount,2);let states=0;void a.established.then(()=>states++);void b.established.then(()=>states++);await tick();assert.equal(states,0);f.children[0].stderr.write('{"state":"failed","reason":"connection"}\n');f.children[1].stderr.write('{"state":"closed"}\n');assert.deepEqual(await Promise.all([a.established,b.established]),['failed','closed']);}finally{await f.dispose();}
});
test('active credential prompt abort uses its scoped hook, produces no helper, then the next queued request runs',async()=>{
 const f=fixture({holdPrompt:true}),controller=new AbortController();try{const pending=f.adapter.beginStored(f.ref,controller.signal);const refusal=assert.rejects(pending,{code:'cancelled'});await f.promptEntered.promise;let next=false;const nextJob=f.queue.run(async()=>{next=true;return'next';});await tick();assert.equal(next,false);controller.abort();await refusal;assert.equal(await nextJob,'next');assert.equal(f.promptAborts,1);assert.equal(f.engineCount,0);}finally{await f.dispose();}
});
test('queued begin cancellation never reaches StoredConnections and helper throw settles receipt as failed without unhandled rejection',async()=>{
 const queue=new ConnectFifo(),hold=deferred<void>(),controller=new AbortController();const first=queue.run(async()=>hold.promise);let opens=0;const adapter=new StoredBeginAdapter({queue,openStored:async()=>{opens++;throw Error('synthetic owner failure');},close:async()=>{}});const result=adapter.beginStored({documentHandle:id(3),objectId:id(2),expectedSeq:0},controller.signal);const refused=assert.rejects(result,{name:'AbortError'});controller.abort();await refused;hold.resolve();await first;assert.equal(opens,0);
 const errors:unknown[]=[];const listen=(error:unknown)=>errors.push(error);process.on('unhandledRejection',listen);try{const active=new StoredBeginAdapter({queue,openStored:async()=>{const receipt=active.beforeSpawn(id(101));receipt.failed(Error('synthetic'));throw Error('synthetic owner failure');},close:async()=>{}});await assert.rejects(active.beginStored({documentHandle:id(3),objectId:id(2),expectedSeq:0},new AbortController().signal),/synthetic owner failure/);await tick();assert.deepEqual(errors,[]);}finally{process.off('unhandledRejection',listen);}
});

test('abort after StoredOpened returns still reaches a connecting receipt after FIFO relay cleanup',async()=>{
 const f=fixture(),controller=new AbortController();try{const result=await f.adapter.beginStored(f.ref,controller.signal);controller.abort();await tick();assert.deepEqual(f.closeCalls,[result.sessionId]);assert.equal(await result.established,'closed');assert.equal(getEventListeners(controller.signal,'abort').length,0);}finally{await f.dispose();}
});
