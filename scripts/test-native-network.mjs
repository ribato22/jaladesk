import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {spawnProfiledHelper} from '../dist/src/protocols/rdp/profiled-owner.js';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {dirname,join,resolve} from 'node:path';

// Loopback only. The server never replies, so TLS/NLA and credential transmission cannot start.
const binary=resolve(process.argv[2]??`native/bin/rdp-bridge${process.platform==='win32'?'.exe':''}`);
const env={WLOG_LEVEL:'OFF',WLOG_FILTER:'*:OFF'};
if(process.platform==='win32'){
  const system=process.env.SystemRoot??process.env.SYSTEMROOT??'C:\\Windows';
  Object.assign(env,{SystemRoot:system,WINDIR:system,PATH:`${dirname(binary)};${join(system,'System32')}`});
  for(const name of ['TEMP','TMP','USERPROFILE'])if(process.env[name])env[name]=process.env[name];
}else{
  env.PATH='/usr/bin:/bin';
  if(process.env.HOME)env.HOME=process.env.HOME;
}
// Channel loading happens before the first byte is sent, so every channel set must reach the negotiation.
const scenarios=[['default',{}],['display size and both clipboard directions',{width:1024,height:768,clipboard:{toRemote:true,fromRemote:true}}]];
// RDP_LOOPBACK_REPEAT=N repeats the whole set: cancelling a connection races its own failure, so a hang shows up on a few percent of runs.
const repeat=Math.max(1,Number(process.env.RDP_LOOPBACK_REPEAT)||1);
const profileRoot=await mkdtemp(join(tmpdir(),'rdp-network-'));let cleanupOK=true;
try{
for(const [name,options] of Array.from({length:repeat},()=>scenarios).flat()){
let peer,child,run,timer,packet=Buffer.alloc(0),stderr='',stdout=0,overflow=false;
let accept,reject;
const negotiation=new Promise((yes,no)=>{accept=yes;reject=no;});
const server=createServer(socket=>{
  peer=socket;
  socket.on('error',reject);
  socket.on('data',bytes=>{
    packet=Buffer.concat([packet,bytes]);
    if(packet.length>4096){reject(new Error('Unexpected loopback packet size'));socket.destroy();return;}
    if(packet.length>=4&&packet.length>=packet.readUInt16BE(2))accept();
  });
});
try{
  server.listen(0,'127.0.0.1');await once(server,'listening');
  run=await spawnProfiledHelper(binary,['--bridge-v1'],{root:profileRoot,env});child=run.child;
  const exited=new Promise((yes,no)=>{child.once('error',no);child.once('close',yes);});
  child.stdout.on('data',bytes=>{stdout+=bytes.length;if(stdout){overflow=true;reject(new Error('Unexpected helper frame before server response'));child.kill('SIGKILL');}});
  child.stdin.on('error',()=>{});
  child.stderr.on('data',bytes=>{
    if(stderr.length+bytes.length>65536){overflow=true;reject(new Error('Helper output limit'));child.kill('SIGKILL');return;}
    stderr+=bytes.toString('utf8');
  });
  const earlyExit=exited.then(code=>{
    if(packet.length)return;
    const failed=stderr.trim().split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}).find(v=>v.state==='failed');
    const number=Number.isInteger(failed?.lastError)?`0x${failed.lastError.toString(16).padStart(8,'0')}`:'unavailable';
    throw new Error(`No RDP negotiation reached loopback; exit=${code}, lastError=${number}`);
  });
  timer=setTimeout(()=>reject(new Error('No RDP negotiation reached loopback before timeout')),4000);
  child.stdin.write(JSON.stringify({type:'connect',target:{host:'127.0.0.1',port:server.address().port,username:'fixture',...options},secret:{password:'',domain:''}})+'\n');
  await Promise.race([negotiation,earlyExit]);
  assert.ok(packet.length>=11);assert.equal(packet[0],3);assert.equal(packet[1],0);
  assert.equal(packet.readUInt16BE(2),packet.length);assert.equal(packet[5],0xe0);
  clearTimeout(timer);
  child.stdin.write('{"type":"close"}\n');peer.destroy();
  timer=setTimeout(()=>child.kill('SIGKILL'),2000);
  assert.equal(await exited,1,'Helper did not finish its canceled connection');
  assert.equal(overflow,false);assert.equal(stdout,0);
  console.log(JSON.stringify({test:'native-loopback-negotiation',scenario:name,passed:true,bytes:packet.length,scope:'127.0.0.1 only; no server reply, TLS, NLA or real credentials'}));
}catch(error){
  console.error(error.message);process.exitCode=1;
}finally{
  clearTimeout(timer);child?.stdin.destroy();child?.kill('SIGKILL');peer?.destroy();server.close();
  if(run)try{await run.closed;}catch{cleanupOK=false;process.exitCode=1;console.error('RDP profile cleanup incomplete');}
}
if(process.exitCode)break;
}
}finally{if(cleanupOK)await rm(profileRoot,{recursive:true,force:true});}
