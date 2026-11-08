import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {X509Certificate} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {spawnProfiledHelper} from '../dist/src/protocols/rdp/profiled-owner.js';

// Loopback only: 127.0.0.1, a throwaway certificate, no credentials. The REAL helper talks to a FreeRDP-based test server
// (native/test-server) so the real display control and clipboard plugins run end to end, which the scripted network
// tests cannot do. Usage: node scripts/test-native-integration.mjs [helper] [test-server]   (exit 3 = skipped)
const skip=reason=>{console.log(JSON.stringify({test:'native-integration',skipped:true,reason}));process.exit(3);};
const helperBinary=resolve(process.argv[2]??'native/bin/rdp-bridge');
const serverBinary=resolve(process.argv[3]??process.env.RDP_TEST_SERVER??'native/test-server/build/rdp-test-server');
if(process.platform==='win32')skip('the test server is POSIX only');
if(!existsSync(serverBinary))skip(`test server not built: ${serverBinary}`);
const dir=mkdtempSync(join(tmpdir(),'rdp-integration-'));
const keyFile=join(dir,'key.pem'),certFile=join(dir,'cert.pem');
const openssl=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyFile,'-out',certFile,'-days','2','-subj','/CN=integration-test'],{env:{...process.env,OPENSSL_CONF:'/dev/null'},stdio:'ignore'});
if(openssl.status!==0){rmSync(dir,{recursive:true,force:true});skip('openssl CLI unavailable');}
const pin=new X509Certificate(readFileSync(certFile)).fingerprint256.replaceAll(':','').toLowerCase();
const wrongPin=(pin[0]==='0'?'1':'0')+pin.slice(1);
const quietEnv={WLOG_LEVEL:'OFF',WLOG_FILTER:'*:OFF',PATH:'/usr/bin:/bin',...(process.env.HOME?{HOME:process.env.HOME}:{})};

// Events in order of arrival; tests look only at what arrived after a mark.
class Feed{
  items=[];
  constructor(label){this.label=label;}
  push(item){this.items.push(item);if(process.env.RDP_INTEGRATION_TRACE)console.error(`${String(Date.now()%1e6).padStart(6)} ${this.label}: ${JSON.stringify(item).slice(0,160)}`);}
  mark(){return this.items.length;}
  count(test,from=0){return this.items.slice(from).filter(test).length;}
  async wait(test,{from=0,ms=10000,what=String(test)}={}){
    for(const end=Date.now()+ms;;await sleep(10)){
      const hit=this.items.slice(from).find(test);if(hit!==undefined)return hit;
      if(Date.now()>=end)throw new Error(`timeout waiting for ${what}; latest: ${JSON.stringify(this.items.slice(-6)).slice(0,600)}`);
    }
  }
  async quiet(test,{from=0,ms=600,what=String(test)}={}){
    await sleep(ms);const hit=this.items.slice(from).find(test);
    if(hit!==undefined)assert.fail(`unexpected ${what}: ${JSON.stringify(hit).slice(0,300)}`);
  }
}
const children=new Set();
const profileClosures=[];let cleanupOK=true;
const track=child=>{children.add(child);child.once('close',()=>children.delete(child));return child;};
const lines=(sink)=>{let partial='';return bytes=>{partial+=bytes;const parts=partial.split('\n');partial=parts.pop();for(const part of parts)if(part)sink(part);};};
async function freePort(){const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const {port}=probe.address();probe.close();await once(probe,'close');return port;}

// Wire v1 on stdout: u32 size, u32 width, u32 height, RGBA. Only the pixels the tests look at are kept.
function frameReader(onFrame){
  let pending=[],have=0,need=12;
  return chunk=>{
    pending.push(chunk);have+=chunk.length;
    while(have>=need){
      let buffer=pending.length===1?pending[0]:Buffer.concat(pending);
      const size=buffer.readUInt32LE(0),width=buffer.readUInt32LE(4),height=buffer.readUInt32LE(8);
      if(width<1||height<1||width>8192||height>8192||size!==8+width*height*4)throw new Error('malformed frame header');
      need=size+4;
      if(have<need){pending=[buffer];break;}
      const at=(x,y)=>Array.from(buffer.subarray(12+(y*width+x)*4,16+(y*width+x)*4));
      onFrame({width,height,left:at(width>>2,height>>1),right:at((width*3)>>2,height>>1)});
      buffer=buffer.subarray(need);pending=buffer.length?[buffer]:[];have=buffer.length;need=12;
    }
  };
}
async function startServer(...extra){
  const port=await freePort(),events=new Feed('server');
  const child=track(spawn(serverBinary,[`--port=${port}`,`--cert=${certFile}`,`--key=${keyFile}`,...extra],{stdio:['pipe','pipe','pipe'],env:process.env.RDP_INTEGRATION_TRACE==='2'?{...quietEnv,WLOG_LEVEL:'DEBUG',WLOG_FILTER:undefined}:quietEnv}));
  child.stdout.on('data',lines(line=>{if(line[0]!=='[')events.push(line);else if(process.env.RDP_INTEGRATION_TRACE==='2')console.error('serverlog: '+line.slice(0,260));}));   // library log lines start with '['
  child.stdin.on('error',()=>{});child.stderr.on('data',()=>{});
  await events.wait(e=>e===`READY ${port}`,{what:'server READY'});
  return {port,events,send:text=>child.stdin.write(text+'\n'),kill:()=>child.kill('SIGKILL')};
}
async function startHelper(port,target,certificateSha256=pin){
  const status=new Feed('helper'),frames=new Feed('frame');
  const run=await spawnProfiledHelper(helperBinary,['--bridge-v1'],{root:dir,env:quietEnv}),child=track(run.child);
  profileClosures.push(run.closed);void run.closed.catch(()=>{});
  const exited=new Promise(done=>child.once('close',(code,signal)=>done({code,signal}))).then(async result=>{await run.closed;return result;});
  child.stderr.on('data',lines(line=>{try{status.push(JSON.parse(line));}catch{status.push({invalid:line.slice(0,200)});}}));
  const read=frameReader(frame=>frames.push(frame));
  child.stdout.on('data',bytes=>{try{read(bytes);}catch(error){status.push({invalid:error.message});}});
  child.stdin.on('error',()=>{});
  const send=message=>child.stdin.write(JSON.stringify(message)+'\n');
  send({type:'connect',target:{host:'127.0.0.1',port,username:'test',certificateSha256,...target},secret:{password:'',domain:''}});
  // A requested close ends the session as `closed`. Its exit code is 0 or 1 (the abort that interrupts the event loop races the
  // closing flag and nothing reads the code), but never a signal: a crash or the thread guard's abort() would show up as one.
  return {status,frames,send,exited,async close(expectedCode){
    send({type:'close'});const timer=setTimeout(()=>child.kill('SIGKILL'),5000);const result=await exited;clearTimeout(timer);
    assert.equal(status.count(s=>'invalid' in s),0,`helper wrote something that is not protocol: ${JSON.stringify(status.items.find(s=>'invalid' in s))}`);
    assert.equal(result.signal,null,'the helper must not die from a signal');
    if(expectedCode===undefined){assert.ok(result.code===0||result.code===1,`exit code ${result.code}`);assert.deepEqual(status.items.filter(s=>s.state).at(-1),{state:'closed'});}
    else assert.equal(result.code,expectedCode,'helper exit code');
    return result;
  }};
}
async function open(target,serverArgs=[]){
  const server=await startServer(...serverArgs),helper=await startHelper(server.port,target);
  await helper.status.wait(s=>s.state==='connected'||s.state==='failed',{what:'helper connected'});
  assert.equal(helper.status.items.find(s=>s.state==='failed'),undefined,'the helper must connect to the test server');
  return {server,helper};
}

const RED=[255,0,0,255],BLUE=[0,0,255,255];   // the test server paints the left half red and the right half blue
const drawn=(width,height)=>f=>f.width===width&&f.height===height&&String(f.left)===String(RED)&&String(f.right)===String(BLUE);
const wide=text=>Buffer.from(text.replace(/\n/g,'\r\n')+'\0','utf16le').toString('hex');   // CF_UNICODETEXT as a Windows server sends it
const unwide=hex=>Buffer.from(hex,'hex').toString('utf16le');
const encode=text=>Buffer.from(text,'utf8').toString('base64');
const decode=event=>Buffer.from(event.b64,'base64').toString('utf8');
const isList=e=>e.startsWith('CLIPLIST');
async function resizeTo(server,helper,width,height,desktopWidth=width){
  const s=server.events.mark(),f=helper.frames.mark();
  helper.send({type:'resize',width,height});
  await server.events.wait(e=>e===`LAYOUT ${desktopWidth} ${height}`,{from:s});
  await server.events.wait(e=>e===`DESKTOP ${desktopWidth} ${height} drawn`,{from:s});
  await helper.frames.wait(drawn(desktopWidth,height),{from:f,what:`a ${desktopWidth}x${height} frame`});
}
async function pasteFromRemote(server,helper,text){
  const m=helper.status.mark();server.send('announce '+wide(text));
  return decode(await helper.status.wait(s=>s.event==='clipboard',{from:m,what:'remote text arriving'}));
}
async function copyToRemote(server,helper,text){
  const m=server.events.mark();helper.send({type:'clipboard',b64:encode(text)});
  await server.events.wait(e=>e==='CLIPLIST 13',{from:m});
  return unwide((await server.events.wait(e=>e.startsWith('CLIPTEXT '),{from:m})).slice(9));
}

const results=[];
async function scenario(name,body){
  const started=Date.now();
  try{await body();}finally{
    const ended=[...children].map(child=>new Promise(resolve=>{child.once('close',resolve);child.kill('SIGKILL');}));await Promise.all(ended);
    const closed=await Promise.allSettled(profileClosures.splice(0));if(closed.some(r=>r.status==='rejected')){cleanupOK=false;throw new Error('RDP profile cleanup incomplete');}
  }
  results.push({name,ms:Date.now()-started});
}
const watchdog=setTimeout(()=>{console.error('native-integration: overall timeout');for(const child of children)child.kill('SIGKILL');process.exit(1);},240000);
try{
  await scenario('display control resize round trip',async()=>{
    const {server,helper}=await open({width:1024,height:768});
    await server.events.wait(e=>e==='CONNECTED 1024 768');
    await helper.frames.wait(drawn(1024,768),{what:'the first 1024x768 frame'});
    await server.events.wait(e=>e==='DISPCAPS');
    const input=server.events.mark();   // keyboard and pointer reach the server through the real protocol stack
    helper.send({type:'key',scanCode:30,down:true});helper.send({type:'key',scanCode:30,down:false});
    helper.send({type:'pointer',x:10,y:20,buttons:1});helper.send({type:'pointer',x:10,y:20,buttons:0});
    const sequence=['KEY 0 30','KEY 32768 30','MOUSE 10 20 36864','MOUSE 10 20 4096'];   // press before release, button down before up
    for(const expected of sequence)await server.events.wait(e=>e===expected,{from:input,what:expected});
    const at=sequence.map(expected=>server.events.items.indexOf(expected,input));
    assert.ok(at[0]<at[1]&&at[2]<at[3],`input arrived out of order: ${at}`);
    await resizeTo(server,helper,800,600);
    await resizeTo(server,helper,200,200);   // the smallest desktop
    await resizeTo(server,helper,800,600);
    const again=server.events.mark();helper.send({type:'resize',width:800,height:600});
    await server.events.quiet(e=>e.startsWith('LAYOUT'),{from:again,what:'a layout for an unchanged size'});
    await resizeTo(server,helper,1001,601,1000);   // the width is rounded down to an even value
    const pointer=server.events.mark();helper.send({type:'pointer',x:5000,y:5000,buttons:0});
    await server.events.wait(e=>/^MOUSE 999 600 /.test(e),{from:pointer,what:'a pointer clamped into the 1000x601 desktop'});
    const burst=server.events.mark(),burstFrames=helper.frames.mark();
    for(const [width,height] of [[640,480],[700,500],[900,700]])helper.send({type:'resize',width,height});
    await server.events.wait(e=>e==='DESKTOP 900 700 drawn',{from:burst,what:'the last of three quick resizes'});
    await helper.frames.wait(drawn(900,700),{from:burstFrames});
    await server.events.quiet(e=>e.startsWith('DESKTOP'),{from:server.events.mark(),ms:500,what:'a later desktop size'});
    assert.equal(helper.status.count(s=>s.state==='failed'),0);
    await helper.close();
    await server.events.wait(e=>e==='DISCONNECTED');
  });

  // The wheel never reached the remote before (found live on 17 Oct 2026: no wheel code anywhere). A wheel event is the wheel flag 0x200 plus a
  // 9-bit two's complement count of 1/120 notches (at most 255 per event); FreeRDP's own clients send 0x278 up and 0x388 down for one notch.
  await scenario('the mouse wheel reaches the server as signed wheel events at the pointer, large turns are split, a wheel past the edge is clamped',async()=>{
    const {server,helper}=await open({width:1024,height:768});
    await server.events.wait(e=>e==='CONNECTED 1024 768');
    await helper.frames.wait(drawn(1024,768),{what:'the first 1024x768 frame'});
    await server.events.wait(e=>e==='DISPCAPS');
    const cases=[[120,[0x278]],[-120,[0x388]],[1,[0x201]],[-1,[0x3FF]],[255,[0x2FF]],[300,[0x2FF,0x22D]],[-300,[0x301,0x3D3]],[600,[0x2FF,0x2FF,0x25A]]];
    for(const [delta,flags] of cases){
      const m=server.events.mark();helper.send({type:'wheel',x:10,y:20,delta});
      const expected=['MOUSE 10 20 2048',...flags.map(f=>`MOUSE 10 20 ${f}`)];   // the pointer is moved to the wheel's position first
      await server.events.wait(e=>e===expected.at(-1),{from:m,what:`${expected.at(-1)} for a wheel of ${delta}`});
      await server.events.quiet(e=>e.startsWith('MOUSE')&&!expected.includes(e),{from:m,ms:100,what:`a mouse event beyond the ones for a wheel of ${delta}`});
      assert.deepEqual(server.events.items.slice(m).filter(e=>e.startsWith('MOUSE')),expected,`events for a wheel of ${delta}`);
    }
    const edge=server.events.mark();helper.send({type:'wheel',x:5000,y:5000,delta:-120});
    await server.events.wait(e=>e==='MOUSE 1023 767 904',{from:edge,what:'a wheel clamped into the 1024x768 desktop'});
    assert.equal(helper.status.count(s=>s.state==='failed'),0);
    await helper.close();
    await server.events.wait(e=>e==='DISCONNECTED');
  });

  // The horizontal wheel is the same turn under the flag 0x400 (PTR_FLAGS_HWHEEL), positive = right as WM_MOUSEHWHEEL; FreeRDP's Windows client sends
  // 0x400 | delta the same way. The server announces horizontal wheel support by default, so the real client sends it.
  await scenario('the horizontal wheel reaches the server as signed horizontal wheel events at the pointer, large turns are split, one past the edge is clamped',async()=>{
    const {server,helper}=await open({width:1024,height:768});
    await server.events.wait(e=>e==='CONNECTED 1024 768');
    await helper.frames.wait(drawn(1024,768),{what:'the first 1024x768 frame'});
    await server.events.wait(e=>e==='DISPCAPS');
    const cases=[[120,[0x478]],[-120,[0x588]],[1,[0x401]],[-1,[0x5FF]],[255,[0x4FF]],[300,[0x4FF,0x42D]],[-300,[0x501,0x5D3]],[600,[0x4FF,0x4FF,0x45A]]];
    for(const [delta,flags] of cases){
      const m=server.events.mark();helper.send({type:'hwheel',x:10,y:20,delta});
      const expected=['MOUSE 10 20 2048',...flags.map(f=>`MOUSE 10 20 ${f}`)];   // the pointer is moved to the wheel's position first
      await server.events.wait(e=>e===expected.at(-1),{from:m,what:`${expected.at(-1)} for a horizontal wheel of ${delta}`});
      await server.events.quiet(e=>e.startsWith('MOUSE')&&!expected.includes(e),{from:m,ms:100,what:`a mouse event beyond the ones for a horizontal wheel of ${delta}`});
      assert.deepEqual(server.events.items.slice(m).filter(e=>e.startsWith('MOUSE')),expected,`events for a horizontal wheel of ${delta}`);
    }
    const edge=server.events.mark();helper.send({type:'hwheel',x:5000,y:5000,delta:-120});
    await server.events.wait(e=>e==='MOUSE 1023 767 1416',{from:edge,what:'a horizontal wheel clamped into the 1024x768 desktop'});
    const both=server.events.mark();helper.send({type:'wheel',x:3,y:4,delta:-120});helper.send({type:'hwheel',x:3,y:4,delta:120});helper.send({type:'wheel',x:3,y:4,delta:120});
    await server.events.wait(e=>e==='MOUSE 3 4 632',{from:both,what:'the vertical wheel after a horizontal one'});
    assert.deepEqual(server.events.items.slice(both).filter(e=>e.startsWith('MOUSE')).filter(e=>e!=='MOUSE 3 4 2048'),['MOUSE 3 4 904','MOUSE 3 4 1144','MOUSE 3 4 632'],'the two axes keep their own flags and their order');
    assert.equal(helper.status.count(s=>s.state==='failed'),0);
    await helper.close();
    await server.events.wait(e=>e==='DISCONNECTED');
  });

  // A server that does not announce the horizontal wheel makes the client library drop such events (libfreerdp/core/input.c): nothing goes out, the
  // session carries on, and the vertical wheel still works. Windows servers from RDP 8.1 on announce it; an older one would behave like this.
  await scenario('a server that does not announce the horizontal wheel never receives one and the session carries on',async()=>{
    const {server,helper}=await open({width:1024,height:768},['--no-hwheel']);
    await server.events.wait(e=>e==='CONNECTED 1024 768');
    await server.events.wait(e=>e==='DISPCAPS');
    const m=server.events.mark();helper.send({type:'hwheel',x:10,y:20,delta:120});helper.send({type:'hwheel',x:10,y:20,delta:-120});
    await server.events.quiet(e=>e.startsWith('MOUSE')&&e!=='MOUSE 10 20 2048',{from:m,ms:400,what:'a horizontal wheel event for a server that did not announce it'});
    const after=server.events.mark();helper.send({type:'wheel',x:10,y:20,delta:-120});
    await server.events.wait(e=>e==='MOUSE 10 20 904',{from:after,what:'the vertical wheel after the dropped horizontal ones'});
    assert.equal(helper.status.count(s=>s.state==='failed'),0,'dropping the event must not end the session');
    await helper.close();
  });

  // A pinch is sent as Ctrl pressed around a wheel turn (src/protocols/rdp/view.ts); the remote only zooms if the turn arrives while Ctrl is down,
  // so the helper must keep the press, the wheel and the release in the order they were sent.
  await scenario('a Ctrl press around a wheel turn arrives in that order, for either axis',async()=>{
    const {server,helper}=await open({width:1024,height:768});
    await server.events.wait(e=>e==='DISPCAPS');
    for(const [type,flag] of [['wheel',632],['hwheel',1144]]){
      const m=server.events.mark();
      helper.send({type:'key',scanCode:29,down:true});helper.send({type,x:10,y:20,delta:120});helper.send({type:'key',scanCode:29,down:false});
      await server.events.wait(e=>e==='KEY 32768 29',{from:m,what:`the Ctrl release after a ${type} turn`});
      assert.deepEqual(server.events.items.slice(m).filter(e=>/^(KEY|MOUSE) /.test(e)),['KEY 0 29','MOUSE 10 20 2048',`MOUSE 10 20 ${flag}`,'KEY 32768 29'],`${type} between the Ctrl press and release`);
    }
    assert.equal(helper.status.count(s=>s.state==='failed'),0);
    await helper.close();
  });

  await scenario('a resize started by the server is followed',async()=>{
    const {server,helper}=await open({width:1024,height:768});
    await server.events.wait(e=>e==='DISPCAPS');
    let s=server.events.mark();const f=helper.frames.mark();
    server.send('resize 1280 720');
    await server.events.wait(e=>e==='DESKTOP 1280 720 drawn',{from:s});
    await helper.frames.wait(drawn(1280,720),{from:f});
    s=server.events.mark();helper.send({type:'resize',width:1280,height:720});
    await server.events.quiet(e=>e.startsWith('LAYOUT'),{from:s,what:'a layout for the size the server chose'});
    await resizeTo(server,helper,800,600);
    await helper.close();
  });

  await scenario('a resize asked before display control is announced waits for it',async()=>{
    let {server,helper}=await open({width:1024,height:768},['--caps-delay=2000']);
    let s=server.events.mark();
    helper.send({type:'resize',width:640,height:480});helper.send({type:'resize',width:800,height:600});
    await server.events.quiet(e=>e.startsWith('LAYOUT'),{from:s,ms:400,what:'a layout before the caps'});
    assert.equal(server.events.count(e=>e==='DISPCAPS'),0,'the caps must still be pending here');
    await server.events.wait(e=>e==='DISPCAPS');
    await server.events.wait(e=>e==='LAYOUT 800 600',{from:s});
    await server.events.wait(e=>e==='DESKTOP 800 600 drawn',{from:s});
    assert.equal(server.events.count(e=>e==='LAYOUT 640 480'),0,'only the latest waiting size is sent');
    await helper.close();
    for(const child of children)child.kill('SIGKILL');
    ({server,helper}=await open({width:1024,height:768},['--caps-delay=1000']));
    helper.send({type:'resize',width:800,height:600});helper.send({type:'resize',width:1024,height:768});   // back to the real desktop size
    await server.events.wait(e=>e==='DISPCAPS');
    s=server.events.mark();
    await server.events.quiet(e=>e.startsWith('LAYOUT'),{from:s,what:'a layout for a size equal to the desktop'});
    await helper.close();
  });

  await scenario('clipboard from the remote only',async()=>{
    const {server,helper}=await open({clipboard:{toRemote:false,fromRemote:true}});
    await server.events.wait(e=>e==='CHANNEL cliprdr');
    await server.events.wait(e=>e==='CLIPCAPS 2');   // no file streaming, no locking
    await server.events.wait(isList);
    assert.equal(await pasteFromRemote(server,helper,'Halo\ndunia é 😀'),'Halo\ndunia é 😀');   // CRLF becomes LF, a surrogate pair survives
    assert.equal(server.events.count(e=>e==='CLIPREQUEST 13'),1);
    let m=helper.status.mark();const asked=server.events.mark();
    server.send('announce '+Buffer.from([0x00,0xd8,0x41,0x00,0x00,0x00]).toString('hex'));   // lone high surrogate
    await server.events.wait(e=>e==='CLIPREQUEST 13',{from:asked,what:'the request for the malformed text'});
    await helper.status.quiet(s=>s.event==='clipboard',{from:m,what:'malformed text delivered'});
    assert.equal(await pasteFromRemote(server,helper,'a'.repeat(32768)),'a'.repeat(32768));   // exactly the limit, in many channel chunks
    m=helper.status.mark();server.send('announce '+wide('a'.repeat(32769)));
    await helper.status.quiet(s=>s.event==='clipboard',{from:m,what:'oversized text delivered'});
    assert.equal(await pasteFromRemote(server,helper,'masih hidup'),'masih hidup');   // the session survived all of that
    const mixed=server.events.mark();m=helper.status.mark();   // a Windows application lists several text formats and, for files, two more
    server.send('announce-mixed '+wide('campuran'));
    assert.equal(decode(await helper.status.wait(s=>s.event==='clipboard',{from:m,what:'text from a mixed format list'})),'campuran');
    assert.equal(server.events.count(e=>e==='CLIPREQUEST 13',mixed),1);
    assert.equal(server.events.count(e=>e.startsWith('CLIPREQUEST')&&e!=='CLIPREQUEST 13',mixed),0,'only CF_UNICODETEXT may be requested');
    const files=server.events.mark();m=helper.status.mark();server.send('announce-files');
    await server.events.wait(e=>e.startsWith('CLIPACK'),{from:files});
    await server.events.quiet(e=>e.startsWith('CLIPREQUEST'),{from:files,what:'a request for file formats'});
    assert.equal(helper.status.count(s=>s.event==='clipboard',m),0);
    // the local clipboard never leaves in a direction that is off, even when the server simply asks for it
    helper.send({type:'clipboard',b64:encode('RAHASIA-LOKAL')});
    const ask=server.events.mark();server.send('request-text');
    await server.events.wait(e=>e==='CLIPFAIL',{from:ask});
    await server.events.quiet(e=>e.startsWith('CLIPTEXT'),{from:ask,ms:300,what:'local text leaving'});
    assert.equal(server.events.count(e=>/^CLIPLIST .+/.test(e)),0,'nothing may be offered to the remote');
    assert.equal(helper.status.count(s=>s.state==='failed'),0);
    await helper.close();
  });

  await scenario('clipboard to the remote only',async()=>{
    const {server,helper}=await open({clipboard:{toRemote:true,fromRemote:false}});
    await server.events.wait(e=>e==='CLIPCAPS 2');
    await server.events.wait(isList);
    assert.equal(await copyToRemote(server,helper,'Salam\ndunia é 😀'),'Salam\r\ndunia é 😀\0');   // LF becomes CRLF, NUL terminated
    assert.equal(await copyToRemote(server,helper,'a'.repeat(32768)),'a'.repeat(32768)+'\0');
    assert.equal(await copyToRemote(server,helper,'abc'),'abc\0');
    const refused=server.events.mark();
    helper.send({type:'clipboard',b64:encode('a'.repeat(32769))});
    helper.send({type:'clipboard',b64:Buffer.from([0xc0,0x80]).toString('base64')});   // overlong NUL
    await server.events.quiet(isList,{from:refused,what:'an offer that must be refused'});
    const ask=server.events.mark();server.send('request-text');
    await server.events.wait(e=>e==='CLIPFAIL',{from:ask,what:'a refused offer clearing the previous text'});
    const remote=server.events.mark(),pasted=helper.status.mark();
    server.send('announce '+wide('dari jauh'));
    await server.events.quiet(e=>e.startsWith('CLIPREQUEST'),{from:remote,what:'a request for remote text while that direction is off'});
    assert.equal(helper.status.count(s=>s.event==='clipboard',pasted),0);
    assert.equal(helper.status.count(s=>s.state==='failed'),0);
    await helper.close();
  });

  await scenario('a server without long format names still exchanges text',async()=>{
    const {server,helper}=await open({clipboard:{toRemote:true,fromRemote:true}},['--short-names']);
    await server.events.wait(isList);
    assert.equal(await pasteFromRemote(server,helper,'nama pendek é'),'nama pendek é');
    assert.equal(await copyToRemote(server,helper,'balasan\nbaris'),'balasan\r\nbaris\0');
    await helper.close();
  });

  await scenario('clipboard is off unless it is opted into',async()=>{
    for(const target of [{width:1024,height:768},{width:1024,height:768,clipboard:{toRemote:false,fromRemote:false}}]){
      const {server,helper}=await open(target);
      helper.send({type:'clipboard',b64:encode('RAHASIA-LOKAL')});
      server.send('announce '+wide('dari jauh'));server.send('request-text');
      await server.events.quiet(e=>/^(CHANNEL cliprdr|CLIP)/.test(e),{what:'clipboard activity'});
      assert.equal(helper.status.count(s=>s.event==='clipboard'),0);
      await helper.close();
      for(const child of children)child.kill('SIGKILL');
    }
  });

  await scenario('both directions together with repeated resizes',async()=>{
    const {server,helper}=await open({width:1024,height:768,clipboard:{toRemote:true,fromRemote:true}});
    await server.events.wait(e=>e==='DISPCAPS');await server.events.wait(isList);
    const sizes=[[800,600],[1280,720],[640,480],[1024,768],[900,700],[1100,650],[700,500],[1000,600]];
    for(const [index,[width,height]] of sizes.entries()){
      await resizeTo(server,helper,width,height);
      const remote=`jauh ${index} é\nbaris`;
      assert.equal(await pasteFromRemote(server,helper,remote),remote);
      const local=`lokal ${index} 😀\nbaris`;
      assert.equal(await copyToRemote(server,helper,local),local.replace(/\n/g,'\r\n')+'\0');
    }
    assert.equal(helper.status.count(s=>s.state==='failed'),0);
    await helper.close();
  });

  await scenario('a certificate that does not match the pin is refused',async()=>{
    const server=await startServer(),helper=await startHelper(server.port,{width:1024,height:768},wrongPin);
    const failed=await helper.status.wait(s=>s.state==='failed',{what:'the certificate failure'});
    assert.equal(failed.reason,'certificate');
    await helper.close(1);
    await server.events.quiet(e=>e.startsWith('CONNECTED'),{ms:300,what:'a session after a rejected certificate'});
    assert.equal(helper.frames.items.length,0);
  });

  await scenario('losing the server ends the session without hanging',async()=>{
    const {server,helper}=await open({width:1024,height:768,clipboard:{toRemote:true,fromRemote:true}});
    await helper.frames.wait(drawn(1024,768));
    server.kill();
    const ended=await helper.status.wait(s=>s.state==='failed'||s.state==='closed',{ms:20000,what:'the end of the session'});
    const exit=await Promise.race([helper.exited,sleep(10000).then(()=>{throw new Error('the helper did not exit after the connection was lost');})]);
    assert.deepEqual([ended.state,ended.reason,exit.code],['failed','connection',1]);
  });

  // A real server says why it ends a session with an error info PDU before it disconnects (the test server sends one on command).
  // The helper reports the end as `closed` with the category the UI knows and the server's own code; a code it does not know is still a plain end.
  await scenario('a session the server ends reports why',async()=>{
    for(const [code,reason] of [[5,'other-connection'],[12,'logoff'],[2,'logoff'],[1,'admin-disconnect'],[11,'admin-disconnect'],[3,'timeout'],[4,'timeout'],[7,'server-denied'],[99,'server-closed']]){
      const {server,helper}=await open({width:1024,height:768});
      await helper.frames.wait(drawn(1024,768));
      server.send(`end-session ${code}`);
      await server.events.wait(e=>e===`ERRINFO ${code}`,{what:`the server sending error info ${code}`});
      const ended=await helper.status.wait(s=>s.state==='closed'||s.state==='failed',{ms:15000,what:`the end of the session (error info ${code})`});
      assert.deepEqual(ended,{state:'closed',reason,lastError:code},`error info ${code}`);
      const exit=await Promise.race([helper.exited,sleep(10000).then(()=>{throw new Error('the helper did not exit after the server ended the session');})]);
      assert.equal(exit.code,0,`exit code after error info ${code}`);assert.equal(exit.signal,null);
      assert.equal(helper.status.count(s=>'invalid' in s),0);
      server.kill();
    }
  });

  console.log(JSON.stringify({test:'native-integration',passed:true,scenarios:results,scope:'127.0.0.1 only; throwaway certificate, no credentials'}));
}catch(error){console.error(error.stack??error.message);process.exitCode=1;}
finally{
  clearTimeout(watchdog);const ended=[...children].map(child=>new Promise(resolve=>{child.once('close',resolve);child.kill('SIGKILL');}));await Promise.all(ended);
  const closed=await Promise.allSettled(profileClosures);if(closed.some(r=>r.status==='rejected'))cleanupOK=false;
  if(cleanupOK)rmSync(dir,{recursive:true,force:true});else{console.error('RDP profile cleanup incomplete');process.exitCode=1;}
}
