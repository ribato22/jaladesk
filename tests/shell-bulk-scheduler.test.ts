import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {BulkScheduler} from '../src/desktop/bulk-scheduler.js';
import {validateV2,type Doc2} from '../src/documents/model.js';
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
const deferred=<T>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(yes=>resolve=yes);return{promise,resolve};};
const fixture=(count=5)=>{const handle=randomUUID(),folder=randomUUID(),ids=Array.from({length:count},()=>randomUUID()),doc=validateV2({schemaVersion:2,id:randomUUID(),kind:'workspace',name:'Synthetic',revision:0,meta:{createdAt:null,updatedAt:null,sort:[]},defaults:{groups:{}},secrets:{},objects:{[folder]:{id:folder,parentId:null,type:'folder',name:'Folder',order:0,props:{}},...Object.fromEntries(ids.map((id,i)=>[id,{id,parentId:folder,type:'connection',name:`Connection ${i}`,order:i,props:{protocol:'rdp',host:'example.invalid',username:'fixture'}}]))}});return{handle,folder,ids,doc,library:{privateDocument:(id:string)=>{assert.equal(id,handle);return{doc,generation:1,seq:0};}},target:(objectId:string)=>({documentHandle:handle,objectId,expectedSeq:0})};};
test('global connection slots wait for owner terminal events across jobs and folder expansion never duplicates targets',async()=>{
 const f=fixture(),started:string[]=[],gates=new Map<string,ReturnType<typeof deferred<'connected'|'failed'|'closed'>>>();
 const scheduler=new BulkScheduler({library:f.library,beginStored:async(ref:any)=>{started.push(ref.objectId);const gate=deferred<'connected'|'failed'|'closed'>();gates.set(ref.objectId,gate);return{sessionId:randomUUID(),established:gate.promise,close:async()=>{gate.resolve('closed');}};}});
 const a=scheduler.start('window-a',{targets:[f.target(f.folder),f.target(f.ids[0]!)]});
 const b=scheduler.start('window-b',{targets:[f.target(f.ids[0]!)]});
 await tick();assert.equal(started.length,2);assert.equal(scheduler.progress('window-a',a).targets.length,5);assert.equal(scheduler.progress('window-a',a).targets.filter((v:any)=>v.status==='connected').length,0);
 gates.get(started[0]!)!.resolve('connected');await tick();assert.equal(started.length,3);
 assert.throws(()=>scheduler.progress('foreign',a));
 for(let i=0;i<8;i++){for(const gate of gates.values())gate.resolve('connected');await tick();}
 assert.equal(scheduler.progress('window-a',a).done,true);assert.equal(scheduler.progress('window-b',b).done,true);assert.equal(started.length,6);
 assert.equal(scheduler.progress('window-a',a).targets.every((v:any)=>v.status==='connected'),true);
 scheduler.close('window-a');scheduler.close('window-b');
});
test('cancel preserves connected sessions, aborts connecting starts and never starts pending targets',async()=>{
 const f=fixture(4),starts:string[]=[],closed:string[]=[],signals=new Map<string,AbortSignal>(),second=deferred<'connected'|'failed'|'closed'>(),third=deferred<any>();
 const scheduler=new BulkScheduler({library:f.library,beginStored:async(ref,signal)=>{starts.push(ref.objectId);signals.set(ref.objectId,signal);if(ref.objectId===f.ids[2])return third.promise;return{sessionId:randomUUID(),established:ref.objectId===f.ids[0]?Promise.resolve('connected' as const):second.promise,close:async()=>{closed.push(ref.objectId);second.resolve('closed');}};}});
 const job=scheduler.start('window',{targets:[f.target(f.folder)]});await tick();assert.equal(starts.length,3);
 assert.deepEqual(scheduler.cancel('window',job),{cancelled:true});assert.equal(signals.get(f.ids[1]!)?.aborted,true);assert.equal(signals.get(f.ids[2]!)?.aborted,true);
 third.resolve({sessionId:randomUUID(),established:new Promise(()=>{}),close:async()=>{closed.push(f.ids[2]!);}});await tick();await tick();
 const result=scheduler.progress('window',job);assert.equal(result.done,true);assert.equal(result.targets[0].status,'connected');assert.deepEqual(result.targets.slice(1).map((v:any)=>v.status),['cancelled','cancelled','cancelled']);assert.deepEqual(closed.sort(),[f.ids[1],f.ids[2]].sort());assert.equal(starts.includes(f.ids[3]!),false);
 await scheduler.disconnect('window',{...job,targets:[`${f.handle}:${f.ids[0]}`]});assert.equal(scheduler.progress('window',job).targets[0].status,'disconnected');assert.equal(closed.includes(f.ids[0]!),true);scheduler.close('window');
});
test('retry resolves only failures afresh while native authentication cancellation remains cancelled and private errors stay private',async()=>{
 const f=fixture(3),calls:string[]=[];let retried=false;
 const scheduler=new BulkScheduler({library:f.library,beginStored:async ref=>{calls.push(ref.objectId);if(ref.objectId===f.ids[0])throw Object.assign(Error('private canary'),{code:'cancelled'});if(ref.objectId===f.ids[1]&&!retried)throw Error('private canary');return{sessionId:randomUUID(),established:Promise.resolve('connected' as const),close:async()=>{}};}});
 const first=scheduler.start('window',{targets:[f.target(f.folder)]});await tick();await tick();assert.deepEqual(scheduler.progress('window',first).targets.map((v:any)=>v.status),['cancelled','failed','connected']);assert.equal(JSON.stringify(scheduler.progress('window',first)).includes('private canary'),false);
 retried=true;const retry=scheduler.retry('window',first);await tick();await tick();assert.equal(scheduler.progress('window',retry).targets.length,1);assert.equal(calls.filter(id=>id===f.ids[1]).length,2);assert.equal(calls.filter(id=>id===f.ids[0]).length,1);assert.throws(()=>scheduler.cancel('foreign',retry));scheduler.close('window');
});
test('owner close failure is explicit and revoking an owner prevents any queued target from starting',async()=>{
 const f=fixture(3),gate=deferred<'connected'|'failed'|'closed'>(),starts:string[]=[];
 const scheduler=new BulkScheduler({library:f.library,beginStored:async ref=>{starts.push(ref.objectId);return{sessionId:randomUUID(),established:gate.promise,close:async()=>{throw Error('private close failure');}};}});
 const job=scheduler.start('window',{targets:[f.target(f.folder)]});await tick();scheduler.cancel('window',job);await tick();assert.equal(scheduler.progress('window',job).done,true);assert.equal(scheduler.progress('window',job).targets[0].errorCode,'close-failed');assert.equal(JSON.stringify(scheduler.progress('window',job)).includes('private close failure'),false);assert.equal(starts.length,2);
 scheduler.close('window');assert.throws(()=>scheduler.progress('window',job));
});
test('owner connected before its late start receipt survives cancellation in that return gap',async()=>{
 const f=fixture(1),receipt=deferred<any>();let closed=0;const scheduler=new BulkScheduler({library:f.library,beginStored:async()=>receipt.promise}),job=scheduler.start('window',{targets:[f.target(f.ids[0]!)]});await tick();scheduler.cancel('window',job);receipt.resolve({sessionId:randomUUID(),established:Promise.resolve('connected'),close:async()=>{closed++;}});await tick();await tick();assert.equal(scheduler.progress('window',job).targets[0].status,'connected');assert.equal(closed,0);await scheduler.disconnect('window',job);assert.equal(closed,1);scheduler.close('window');
});
test('owner connected event wins same-turn cancellation before the worker continuation updates the visible state',async()=>{
 const f=fixture(1),gate=deferred<'connected'|'failed'|'closed'>();let closed=0;const scheduler=new BulkScheduler({library:f.library,beginStored:async()=>({sessionId:randomUUID(),established:gate.promise,close:async()=>{closed++;}})}),job=scheduler.start('window',{targets:[f.target(f.ids[0]!)]});await tick();assert.equal(scheduler.progress('window',job).targets[0].status,'connecting');gate.resolve('connected');scheduler.cancel('window',job);await tick();assert.equal(scheduler.progress('window',job).targets[0].status,'connected');assert.equal(closed,0);await scheduler.disconnect('window',job);assert.equal(closed,1);scheduler.close('window');
});
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import type {DocumentLibrary} from '../src/documents/library.js';
import {StoredConnections} from '../src/desktop/connections.js';
import {ConnectFifo,StoredBeginAdapter} from '../src/desktop/stored-begin.js';
import {makeOwner,type Session} from '../src/protocols/rdp/owner.js';
test('actual stored and owner adapter hold both scheduler slots until helper terminal state rather than helper-start resolution',async t=>{
 const f=fixture(3);for(const id of f.ids)f.doc.objects[id]!.props.groups={credentials:{mode:'none'}};
 const children:(EventEmitter&{stdin:PassThrough;stdout:PassThrough;stderr:PassThrough;kill():boolean})[]=[],sessions=new Map<string,Session>(),ready=new Map<string,Promise<Session>>(),closed:string[]=[];
 const owner=makeOwner(()=>{const child=new EventEmitter() as typeof children[number];child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();let ended=false;const exit=()=>{if(!ended){ended=true;queueMicrotask(()=>child.emit('close',0));}};child.kill=()=>{exit();return true;};child.stdin.on('data',(buffer:Buffer)=>{for(const line of buffer.toString().trim().split('\n'))if(JSON.parse(line).type==='close')exit();});children.push(child);return child as unknown as ChildProcessWithoutNullStreams;},'synthetic-helper');
 const queue=new ConnectFifo();let adapter:StoredBeginAdapter;const library={...f.library,privateDocuments:()=>[{handle:f.handle,doc:f.doc,seq:0,generation:1}]} as unknown as DocumentLibrary;
 const stored=new StoredConnections({library,prompt:async()=>{throw Error('unexpected modal');},approveScope:async()=>true,open:async(target,secret)=>{const id=randomUUID(),receipt=adapter.beforeSpawn(id),pending=owner.open(target,secret,{frame(){},state:state=>receipt.state(state)});ready.set(id,pending);try{const session=await pending;sessions.set(id,session);return id;}catch(error){receipt.failed(error);throw error;}}});
 adapter=new StoredBeginAdapter({queue,openStored:ref=>stored.openStored(ref),close:async id=>{closed.push(id);await(await(ready.get(id)??Promise.resolve(sessions.get(id))))?.close();}});
 const scheduler=new BulkScheduler({library:f.library,beginStored:(ref,signal)=>adapter.beginStored(ref,signal)});t.after(async()=>{scheduler.close('window');await Promise.all([...sessions.values()].map(session=>session.close()));});
 const job=scheduler.start('window',{targets:[f.target(f.folder)]});await tick();await tick();assert.equal(children.length,2);assert.equal(scheduler.progress('window',job).targets.filter((state:any)=>state.status==='connected').length,0);
 children[0]!.stderr.write('{"state":"connected"}\n');await tick();await tick();assert.equal(children.length,3);children[1]!.stderr.write('{"state":"failed","reason":"connection"}\n');children[2]!.stderr.write('{"state":"closed"}\n');await tick();await tick();const progress=scheduler.progress('window',job);assert.equal(progress.done,true);assert.deepEqual(progress.targets.map(state=>state.status),['connected','failed','failed']);scheduler.cancel('window',job);assert.equal(closed.includes(progress.targets[0]!.sessionId!),false);await scheduler.disconnect('window',{...job,targets:[progress.targets[0]!.target]});assert.equal(closed.includes(progress.targets[0]!.sessionId!),true);
});
test('cancelling a job waiting behind another owner releases its pending work without waiting for unrelated sessions',async()=>{
 const f=fixture(3),gate=deferred<'connected'|'failed'|'closed'>(),started:string[]=[];const scheduler=new BulkScheduler({library:f.library,beginStored:async ref=>{started.push(ref.objectId);return{sessionId:randomUUID(),established:gate.promise,close:async()=>gate.resolve('closed')};}}),a=scheduler.start('owner-a',{targets:[f.target(f.ids[0]!),f.target(f.ids[1]!)]});await tick();const b=scheduler.start('owner-b',{targets:[f.target(f.ids[2]!)]});await tick();scheduler.cancel('owner-b',b);await tick();assert.equal(scheduler.progress('owner-b',b).done,true);assert.equal(scheduler.progress('owner-b',b).targets[0]!.status,'cancelled');assert.equal(started.includes(f.ids[2]!),false);assert.equal(scheduler.progress('owner-a',a).done,false);scheduler.cancel('owner-a',a);await tick();scheduler.close('owner-a');scheduler.close('owner-b');
});
