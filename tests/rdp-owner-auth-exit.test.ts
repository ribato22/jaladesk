import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {makeOwner} from '../src/protocols/rdp/owner.js';
import type {State,Frame} from '../src/protocols/rdp/wire.js';
const target={host:'fixture.invalid',port:3389,username:'fixture',clipboard:{toRemote:true,fromRemote:true}};
const secret={password:'synthetic-only',domain:''};
const authentication='{"state":"failed","reason":"authentication","lastError":131094}\n';

test('reported authentication failure lets the real helper exit1 without a signal and remains terminal',async()=>{
  const frames:Frame[]=[],states:{state:State;reason?:string}[]=[];let child!:ChildProcessWithoutNullStreams;
  const owner=makeOwner(()=>child=spawn(process.execPath,[fileURLToPath(new URL('../../tests/fixtures/rdp-auth-exit.mjs',import.meta.url))],{stdio:['pipe','pipe','pipe']}),'fixture');
  let failed!:()=>void;const failure=new Promise<void>(resolve=>{failed=resolve;});
  const session=await owner.open(target,secret,{frame:f=>frames.push(f),state:(state,reason)=>{states.push({state,reason});if(state==='failed')failed();}});
  const exit=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  try{
    await failure;
    session.send({type:'resize',width:800,height:600});
    assert.equal(session.sendClipboard('after failure'),'closed');
    assert.deepEqual(await exit,{code:1,signal:null});
    assert.deepEqual(states,[{state:'connecting',reason:undefined},{state:'failed',reason:'authentication'}]);
    assert.deepEqual(frames,[]);
    await session.close();
    assert.equal(states.length,2);
  }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
});

type FakeChild=ChildProcessWithoutNullStreams & {stdin:PassThrough;stdout:PassThrough;stderr:PassThrough};
function fakeHelper(){
  const raw=new EventEmitter(),stdin=new PassThrough(),stdout=new PassThrough(),stderr=new PassThrough();
  const kills:(NodeJS.Signals|number|undefined)[]=[],input:string[]=[];
  stdin.on('data',b=>input.push(b.toString()));
  const child=Object.assign(raw,{stdin,stdout,stderr,kill:(signal?:NodeJS.Signals|number)=>{kills.push(signal);raw.emit('close',null,signal??'SIGTERM');return true;}}) as unknown as FakeChild;
  return {child,kills,input};
}
test('an authentication helper that ignores close is force-killed at the existing1500ms bound',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fakeHelper(),states:State[]=[],frames:Frame[]=[];
  const session=await makeOwner(()=>f.child,'fixture').open(target,secret,{state:s=>states.push(s),frame:f=>frames.push(f)});
  f.child.stderr.write(authentication);
  assert.deepEqual(f.kills,[]);
  assert.equal(f.child.stdin.writableEnded,true);
  assert.equal(f.input.filter(v=>v==='{"type":"close"}\n').length,1);
  session.send({type:'resize',width:800,height:600});assert.equal(session.sendClipboard('late'),'closed');
  f.child.stderr.write('{"state":"connected"}\n'+authentication);
  f.child.stdout.write(Buffer.from([12,0,0,0,1,0,0,0,1,0,0,0,255,0,0,255]));
  t.mock.timers.tick(1499);assert.deepEqual(f.kills,[]);
  t.mock.timers.tick(1);assert.deepEqual(f.kills,['SIGKILL']);
  await session.close();assert.deepEqual(states,['connecting','failed']);assert.deepEqual(frames,[]);
});
test('other helper failures, untrusted diagnostics, parser errors and timeouts still kill immediately',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const cases:[string,(child:FakeChild)=>void][]=[
    ...['connection','certificate','control-protocol','surface','resize-reconnect','unknown'].map(reason=>[reason,(child:FakeChild)=>child.stderr.write(JSON.stringify({state:'failed',reason})+'\n')] as [string,(child:FakeChild)=>void]),
    ['bad authentication diagnostic',child=>{child.stderr.write('{"state":"failed","reason":"authentication","lastError":"secret"}\n');}],
    ['bad status',child=>{child.stderr.write('not-json\n');}],
    ['bad frame',child=>{child.stdout.write(Buffer.alloc(4));}],
    ['helper error',child=>{child.emit('error',new Error('synthetic'));}],
    ['input error',child=>{child.stdin.emit('error',new Error('synthetic'));}],
    ['timeout',()=>{t.mock.timers.tick(30000);}]
  ];
  for(const [label,trigger] of cases){
    const f=fakeHelper(),states:State[]=[];
    const session=await makeOwner(()=>f.child,'fixture').open(target,secret,{state:s=>states.push(s),frame:()=>{assert.fail(label);}});
    trigger(f.child);assert.deepEqual(f.kills,[undefined],label);assert.deepEqual(states,['connecting','failed'],label);
    await session.close();assert.equal(f.kills.length,1,label);
  }
});
