import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeOwner, ipcAllowed } from '../src/protocols/rdp/owner.js';
import { CLIPBOARD_MAX_BYTES } from '../src/protocols/rdp/clipboard.js';
import type { Frame, RdpTarget, State } from '../src/protocols/rdp/wire.js';
const fixture=fileURLToPath(new URL('../../tests/fixtures/rdp-helper.mjs',import.meta.url));
function openFixture(host='lab.invalid',extra:Partial<RdpTarget>={},onClipboard?:(text:string)=>void) {
  const frames:Frame[]=[],states:{state:State;reason?:string;lastError?:number}[]=[],clips:string[]=[];let argv:readonly string[]=[];
  const owner=makeOwner((_path,args)=>{argv=args;return spawn(process.execPath,[fixture],{stdio:['pipe','pipe','pipe']});},'unused-helper');
  return {frames,states,clips,argv:()=>argv,session:owner.open({host,port:3389,username:'user',...extra},{password:'fixture-secret',domain:''},{frame:f=>frames.push(f),state:(state,reason,lastError?:number)=>states.push({state,reason,lastError}),clipboard:text=>{clips.push(text);onClipboard?.(text);}})};
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
  assert.equal(JSON.stringify(f.states).includes('fixture-secret'),false);
  assert.equal(f.states.at(-1)?.reason,'helper-failure');assert.equal(f.states.at(-1)?.lastError,0x00020008);await s.close();
});
test('native failure preserves only optional uint32 diagnostics',async()=>{
  for(const [host,code] of [['code.invalid',0x00020008],['zero.invalid',0],['maximum.invalid',0xffffffff],['old-failure.invalid',undefined]] as const){
    const f=openFixture(host),s=await f.session;try{
      await until(()=>f.states.some(x=>x.state==='failed'));
      assert.deepEqual(f.states.at(-1),{state:'failed',reason:'connection',lastError:code});
    }finally{await s.close();}
  }
});
test('invalid diagnostic values and diagnostics on non-failed states are rejected',async()=>{
  for(const host of ['string-code.invalid','negative-code.invalid','fractional-code.invalid','overflow-code.invalid','null-code.invalid','connected-code.invalid']){
    const f=openFixture(host),s=await f.session;try{
      await until(()=>f.states.some(x=>x.state==='failed'));
      assert.deepEqual(f.states.at(-1),{state:'failed',reason:'status-protocol',lastError:undefined});
      assert.equal(JSON.stringify(f.states).includes('fixture-secret'),false);
    }finally{await s.close();}
  }
});
test('a session the server ends is reported as closed with the server\'s reason, never as a crashed helper',async()=>{
  for(const [host,expected] of [
    ['server-closed.invalid',{state:'closed',reason:'server-closed',lastError:undefined}],
    ['other-connection.invalid',{state:'closed',reason:'other-connection',lastError:5}],
    ['logoff.invalid',{state:'closed',reason:'logoff',lastError:12}],
    ['unknown-reason.invalid',{state:'closed',reason:'server-closed',lastError:5}],   // an untrusted reason text is never shown, nor is the password it might carry
  ] as const){
    const f=openFixture(host),s=await f.session;try{
      await until(()=>f.states.some(x=>x.state==='closed'));await settle(100);   // the helper's exit afterwards must not turn the end into a failure
      assert.deepEqual(f.states.at(-1),expected,host);
      assert.equal(f.states.some(x=>x.state==='failed'),false,host);assert.equal(f.states.filter(x=>x.state==='closed').length,1,host);
      assert.equal(JSON.stringify(f.states).includes('fixture-secret'),false);
    }finally{await s.close();}
  }
});
test('closing a session the server already ended is harmless, and a closed status with an invalid code is a protocol violation',async()=>{
  const f=openFixture('other-connection.invalid'),s=await f.session;
  await until(()=>f.states.some(x=>x.state==='closed'));await s.close();await s.close();await settle(60);
  assert.deepEqual(f.states.filter(x=>x.state==='closed'),[{state:'closed',reason:'other-connection',lastError:5}]);
  const h=openFixture('stubborn.invalid'),u=await h.session;   // a helper that outlives the server's goodbye: the user's close then arrives while it is still alive
  await until(()=>h.states.some(x=>x.state==='closed'));await u.close();await settle(60);
  assert.deepEqual(h.states.filter(x=>x.state==='closed'),[{state:'closed',reason:'server-closed',lastError:undefined}]);
  const g=openFixture('closed-bad-code.invalid'),t=await g.session;try{
    await until(()=>g.states.some(x=>x.state==='failed'));
    assert.deepEqual(g.states.at(-1),{state:'failed',reason:'status-protocol',lastError:undefined});
  }finally{await t.close();}
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
const settle=(ms=60)=>new Promise(r=>setTimeout(r,ms));
test('client resize reaches the helper and the resized frame reaches the sink without ending the session',async()=>{
  const f=openFixture(),s=await f.session;try{
    await until(()=>f.frames.length===1);
    s.send({type:'resize',width:800,height:600});await until(()=>f.frames.length===2);
    assert.deepEqual([f.frames[1].width,f.frames[1].height],[800,600]);assert.equal(f.states.at(-1)?.state,'connected');
    assert.throws(()=>s.send({type:'resize',width:100,height:600}));
  }finally{await s.close();}
});
test('remote text reaches the sink only when the remote-to-local direction was opted in',async()=>{
  const on=openFixture('clip-remote.invalid',{clipboard:{toRemote:false,fromRemote:true}}),son=await on.session;
  const off=openFixture('clip-remote.invalid'),soff=await off.session;try{
    await until(()=>on.clips.length===1);assert.deepEqual(on.clips,['halo dari remote 😀']);assert.deepEqual(son.clipboard,{toRemote:false,fromRemote:true});
    await until(()=>off.frames.length===1);await settle();
    assert.deepEqual(off.clips,[]);assert.deepEqual(soff.clipboard,{toRemote:false,fromRemote:false});assert.equal(off.states.at(-1)?.state,'connected');
  }finally{await son.close();await soff.close();}
});
test('local text is sent only when the local-to-remote direction was opted in, and arrives intact',async()=>{
  const f=openFixture('clip-echo.invalid',{clipboard:{toRemote:true,fromRemote:true}}),s=await f.session;
  const off=openFixture('clip-echo.invalid',{clipboard:{toRemote:false,fromRemote:true}}),so=await off.session;try{
    await until(()=>f.frames.length===1&&off.frames.length===1);
    assert.equal(s.sendClipboard('teks lokal — 你好 😀'),'sent');await until(()=>f.clips.length===1);assert.deepEqual(f.clips,['teks lokal — 你好 😀']);
    assert.equal(s.sendClipboard('a'.repeat(CLIPBOARD_MAX_BYTES+1)),'too-large');assert.equal(s.sendClipboard('a\0b'),'invalid');
    assert.equal(so.sendClipboard('tidak boleh'),'disabled');await settle();assert.equal(f.clips.length,1);assert.deepEqual(off.clips,[]);
    await s.close();assert.equal(s.sendClipboard('terlambat'),'closed');
  }finally{await s.close();await so.close();}
});
test('malformed or oversized clipboard events, unknown events and overlong status lines fail the session as protocol violations',async()=>{
  for(const host of ['clip-bad.invalid','clip-big.invalid','event-unknown.invalid','long-line.invalid']){
    const f=openFixture(host,{clipboard:{toRemote:false,fromRemote:true}}),s=await f.session;try{
      await until(()=>f.states.some(x=>x.state==='failed'));
      assert.deepEqual(f.states.at(-1),{state:'failed',reason:'status-protocol',lastError:undefined},host);assert.deepEqual(f.clips,[]);
    }finally{await s.close();}
  }
});
test('back-to-back clipboard lines split across reads do not trip the line limit',async()=>{
  const f=openFixture('clip-burst.invalid',{clipboard:{toRemote:false,fromRemote:true}}),s=await f.session;try{
    await until(()=>f.clips.length===2);assert.equal(f.clips[0].length,CLIPBOARD_MAX_BYTES);assert.equal(f.clips[1].length,CLIPBOARD_MAX_BYTES);
    assert.equal(f.states.at(-1)?.state,'connected');
  }finally{await s.close();}
});
test('a clipboard sink that throws does not end the session',async()=>{
  const f=openFixture('clip-remote.invalid',{clipboard:{toRemote:false,fromRemote:true}},()=>{throw new Error('clipboard OS menolak');}),s=await f.session;try{
    await until(()=>f.clips.length===1);
    s.send({type:'resize',width:800,height:600});await until(()=>f.frames.length===2);
    assert.equal(f.states.at(-1)?.state,'connected');
  }finally{await s.close();}
});
test('clipboard text that arrives after close or failure is never delivered',async()=>{
  const f=openFixture('clip-late.invalid',{clipboard:{toRemote:false,fromRemote:true}}),s=await f.session;
  await until(()=>f.frames.length===1);await s.close();await settle(120);
  assert.deepEqual(f.clips,[]);assert.equal(f.states.at(-1)?.state,'closed');
  const g=openFixture('clip-big.invalid',{clipboard:{toRemote:false,fromRemote:true}}),t=await g.session;
  await until(()=>g.states.some(x=>x.state==='failed'));await settle(120);
  assert.deepEqual(g.clips,[]);await t.close();
});
