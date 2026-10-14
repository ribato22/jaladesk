import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeOwner, ipcAllowed } from '../src/protocols/rdp/owner.js';
import type { Frame, State } from '../src/protocols/rdp/wire.js';
const fixture=fileURLToPath(new URL('../../tests/fixtures/rdp-helper.mjs',import.meta.url));
function openFixture(host='lab.invalid') {
  const frames:Frame[]=[],states:{state:State;reason?:string}[]=[];let argv:readonly string[]=[];
  const owner=makeOwner((_path,args)=>{argv=args;return spawn(process.execPath,[fixture],{stdio:['pipe','pipe','pipe']});},'unused-helper');
  return {frames,states,argv:()=>argv,session:owner.open({host,port:3389,username:'user'},{password:'fixture-secret',domain:''},{frame:f=>frames.push(f),state:(state,reason)=>states.push({state,reason})})};
}
async function until(fn:()=>boolean) {for(let i=0;i<100&&!fn();i++)await new Promise(r=>setTimeout(r,10));assert.ok(fn(),'event never arrived');}
test('real child frames stop when session closes and close is idempotent',async()=>{
  const f=openFixture();const s=await f.session;await until(()=>f.frames.length===1);
  assert.deepEqual([...f.frames[0].rgba],[255,0,0,255,0,255,0,255]);
  await Promise.all([s.close(),s.close()]);await new Promise(r=>setTimeout(r,30));
  assert.equal(f.frames.length,1);assert.deepEqual(f.argv(),['--bridge-v1']);
  assert.equal(f.states.at(-1)?.state,'closed');
});
test('child exit fails the owning session',async()=>{
  const f=openFixture('crash.invalid');const s=await f.session;await until(()=>f.states.some(x=>x.state==='failed'));
  assert.equal(f.states.at(-1)?.reason,'helper-exit');await s.close();
});
test('untrusted child reason cannot leak password',async()=>{
  const f=openFixture('leak.invalid');const s=await f.session;await until(()=>f.states.some(x=>x.state==='failed'));
  assert.equal(JSON.stringify(f.states).includes('fixture-secret'),false);await s.close();
});
test('two child sessions keep frame ownership independent',async()=>{
  const a=openFixture(),b=openFixture();const sa=await a.session,sb=await b.session;
  await until(()=>a.frames.length===1&&b.frames.length===1);await sa.close();
  assert.equal(b.states.at(-1)?.state,'connected');await sb.close();
});
test('IPC denies a remote URL, subframe and different window',()=>{
  const url='file:///local/index.html';
  assert.equal(ipcAllowed({senderId:1,frameUrl:url,isMainFrame:true},1,url),true);
  assert.equal(ipcAllowed({senderId:2,frameUrl:url,isMainFrame:true},1,url),false);
  assert.equal(ipcAllowed({senderId:1,frameUrl:'https://evil.invalid',isMainFrame:true},1,url),false);
  assert.equal(ipcAllowed({senderId:1,frameUrl:url,isMainFrame:false},1,url),false);
});
