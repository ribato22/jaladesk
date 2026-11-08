import test from 'node:test';import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';import {existsSync} from 'node:fs';import {resolve} from 'node:path';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {spawnProfiledHelper} from '../src/protocols/rdp/profiled-owner.js';
import {decodeClipboard} from '../src/protocols/rdp/clipboard.js';
import {decodeFrame,FrameStream} from '../src/protocols/rdp/wire.js';
const binary=resolve(process.env.RDP_PROFILE_HELPER??`native/bin/rdp-bridge${process.platform==='win32'?'.exe':''}`);
test('built native fixture emits the independently expected RGBA packet',{skip:!existsSync(binary)},()=>{
  const result=spawnSync(binary,['--fixture'],{input:'{"type":"connect"}\n{"type":"close"}\n',timeout:4000});
  assert.equal(result.status,0);const frame=decodeFrame(result.stdout);
  assert.deepEqual([...frame.rgba],[255,0,0,255,0,255,0,255]);
  assert.match(result.stderr.toString(),/"state":"connected"/);
});
test('native helper rejects oversized controls without echoing secret data',{skip:!existsSync(binary)},()=>{
  const result=spawnSync(binary,['--bridge-v1'],{input:'sensitive-marker'.repeat(5000)+'\n',timeout:4000});
  assert.equal(result.status,2);assert.equal(result.stdout.length,0);
  assert.equal(result.stderr.includes('sensitive-marker'),false);assert.match(result.stderr.toString(),/control-protocol/);
});
test('native loopback refusal preserves frame channel and suppresses inherited trace logging',{skip:!existsSync(binary),timeout:5000},async()=>{
  const connect={type:'connect',target:{host:'127.0.0.1',port:1,username:'fixture'},secret:{password:'sensitive-marker',domain:''}};
  const root=await mkdtemp(join(tmpdir(),'rdp-refusal-'));
  const run=await spawnProfiledHelper(binary,['--bridge-v1'],{root,env:{...process.env,WLOG_LEVEL:'TRACE',WLOG_FILTER:'*:TRACE'}}),child=run.child;
  let stdout=0,stderr='';child.stdout.on('data',(bytes:Buffer)=>{stdout+=bytes.length;});
  child.stderr.on('data',(bytes:Buffer)=>{stderr+=bytes.toString('utf8');});child.stdin.on('error',()=>{});
  const exit=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  const kill=setTimeout(()=>child.kill('SIGKILL'),4000);
  // Keep stdin open: EOF would request cancellation before connect can report its error.
  child.stdin.write(JSON.stringify(connect)+'\n');
  try{
    assert.equal(await exit,1);assert.equal(stdout,0);assert.equal(stderr.includes('sensitive-marker'),false);
    const states=stderr.trim().split('\n').map(line=>JSON.parse(line));
    for(const state of states){assert.ok(state.state);if(state.state!=='failed')assert.equal(state.lastError,undefined);}
    const failure=states.find(state=>state.state==='failed');assert.ok(failure);
    assert.equal(Number.isInteger(failure.lastError),true);assert.ok(failure.lastError>=0&&failure.lastError<=0xffffffff);
  }finally{clearTimeout(kill);child.stdin.destroy();child.kill('SIGKILL');await run.closed;await rm(root,{recursive:true,force:true});}
});
test('native fixture follows client resize and shares remote text only in the opted-in direction',{skip:!existsSync(binary)},()=>{
  const run=(clipboard?:object)=>spawnSync(binary,['--fixture'],{input:JSON.stringify({type:'connect',target:{host:'fixture.invalid',port:3389,username:'u',...(clipboard?{clipboard}:{})}})+'\n{"type":"resize","width":320,"height":240}\n{"type":"close"}\n',timeout:4000,maxBuffer:4<<20});
  const on=run({toRemote:false,fromRemote:true});assert.equal(on.status,0);
  assert.deepEqual(new FrameStream().push(on.stdout).map(f=>[f.width,f.height]),[[2,1],[320,240]]);
  const events=on.stderr.toString().trim().split('\n').map(line=>JSON.parse(line)).filter(v=>v.event==='clipboard');
  assert.equal(events.length,1);assert.equal(decodeClipboard(events[0].b64),'fixture-remote-text');
  const off=run({toRemote:true,fromRemote:false});assert.equal(off.status,0);assert.equal(off.stderr.includes('"event"'),false);
  const none=run();assert.equal(none.status,0);assert.equal(none.stderr.includes('"event"'),false);
});
test('native helper treats malformed resize, clipboard and connect options as a control-protocol failure',{skip:!existsSync(binary)},()=>{
  const connect=(target:object)=>JSON.stringify({type:'connect',target:{host:'fixture.invalid',port:3389,username:'u',...target}})+'\n';
  for(const input of [connect({})+'{"type":"resize","width":10,"height":10}\n',connect({})+'{"type":"clipboard","b64":7}\n',connect({clipboard:{toRemote:true,fromRemote:false,files:true}}),connect({width:1000})]){
    const result=spawnSync(binary,['--fixture'],{input:input+'{"type":"close"}\n',timeout:4000});
    assert.equal(result.status,2,input);assert.match(result.stderr.toString(),/control-protocol/);
  }
});
test('native fixture echoes offered text back as remote text only when both directions are on',{skip:!existsSync(binary)},()=>{
  const run=(clipboard:object)=>spawnSync(binary,['--fixture'],{input:JSON.stringify({type:'connect',target:{host:'fixture.invalid',port:3389,username:'u',clipboard}})+'\n'+JSON.stringify({type:'clipboard',b64:Buffer.from('halo — 你好').toString('base64')})+'\n{"type":"close"}\n',timeout:4000});
  const texts=(r:ReturnType<typeof run>)=>r.stderr.toString().trim().split('\n').map(line=>JSON.parse(line)).filter(v=>v.event==='clipboard').map(v=>decodeClipboard(v.b64));
  const both=run({toRemote:true,fromRemote:true});assert.equal(both.status,0);
  assert.deepEqual(texts(both),['fixture-remote-text','fixture-echo:halo — 你好']);
  for(const one of [{toRemote:true,fromRemote:false},{toRemote:false,fromRemote:true}]){const r=run(one);assert.equal(r.status,0);assert.equal(texts(r).includes('fixture-echo:halo — 你好'),false);}
});
