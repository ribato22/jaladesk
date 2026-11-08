import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {X509Certificate} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {once} from 'node:events';
import {TLSSocket} from 'node:tls';
import {spawnProfiledHelper} from '../dist/src/protocols/rdp/profiled-owner.js';

// Loopback only. A throwaway self-signed certificate is served over TLS after a minimal X.224 negotiation; no real
// credentials exist and CredSSP is never answered. It checks the certificate pin decision of the built helper:
// a wrong pin ends the connection as `certificate`, the right pin reaches the CredSSP step instead.
const binary=resolve(process.argv[2]??`native/bin/rdp-bridge${process.platform==='win32'?'.exe':''}`);
const dir=mkdtempSync(join(tmpdir(),'rdp-pin-'));
let cleanupOK=true;
const openssl=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem'),'-days','2','-subj','/CN=pin-test'],{env:{...process.env,OPENSSL_CONF:process.platform==='win32'?'NUL':'/dev/null'},stdio:'ignore'});
if(openssl.status!==0){console.log(JSON.stringify({test:'native-pin',skipped:true,reason:'openssl CLI unavailable'}));rmSync(dir,{recursive:true,force:true});process.exit(3);}
const key=readFileSync(join(dir,'key.pem')),cert=readFileSync(join(dir,'cert.pem'));
const pin=new X509Certificate(cert).fingerprint256.replaceAll(':','').toLowerCase();
const wrongPin=(pin[0]==='0'?'1':'0')+pin.slice(1);
const env={WLOG_LEVEL:'OFF',WLOG_FILTER:'*:OFF'};
if(process.platform==='win32'){
  const system=process.env.SystemRoot??process.env.SYSTEMROOT??'C:\\Windows';
  Object.assign(env,{SystemRoot:system,WINDIR:system,PATH:`${dirname(binary)};${join(system,'System32')}`});
  for(const name of ['TEMP','TMP','USERPROFILE'])if(process.env[name])env[name]=process.env[name];
}else{env.PATH='/usr/bin:/bin';if(process.env.HOME)env.HOME=process.env.HOME;}
// TPKT + X.224 Connection Confirm + RDP_NEG_RSP selecting CredSSP (PROTOCOL_HYBRID).
const confirm=Buffer.from('030000130ed000001234000200080002000000','hex');
async function attempt(certificateSha256){
  let handshakes=0,clientBytes=0,child,run;
  const server=createServer(socket=>{
    socket.once('data',()=>{
      socket.write(confirm);
      const tls=new TLSSocket(socket,{isServer:true,key,cert});
      tls.on('secure',()=>{handshakes++;});tls.on('data',bytes=>{clientBytes+=bytes.length;});tls.on('error',()=>{});
    });
    socket.on('error',()=>{});
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  let stderr='';const timer=setTimeout(()=>child?.kill('SIGKILL'),8000);
  try{
    run=await spawnProfiledHelper(binary,['--bridge-v1'],{root:dir,env});child=run.child;
    child.stdout.on('data',()=>{});child.stderr.on('data',bytes=>{stderr+=bytes.toString('utf8');});child.stdin.on('error',()=>{});
    const exited=once(child,'close');
    child.stdin.write(JSON.stringify({type:'connect',target:{host:'127.0.0.1',port:server.address().port,username:'fixture',certificateSha256},secret:{password:'',domain:''}})+'\n');
    // Without a CredSSP answer the right pin waits for the server; end the attempt once the client has spoken or failed.
    const done=setInterval(()=>{if(clientBytes>0||/"state":"failed"/.test(stderr))child.stdin.write('{"type":"close"}\n');},50);
    await exited;clearInterval(done);
  }finally{clearTimeout(timer);child?.kill('SIGKILL');server.close();if(run)try{await run.closed;}catch{cleanupOK=false;throw new Error('RDP profile cleanup incomplete');}}
  const failed=stderr.trim().split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}).find(v=>v.state==='failed');
  return {handshakes,clientBytes,failed};
}
try{
  const wrong=await attempt(wrongPin);
  assert.equal(wrong.failed?.reason,'certificate','a wrong pin must end the connection as a certificate failure');
  assert.equal(wrong.clientBytes,0,'no application data may follow a rejected certificate');
  const right=await attempt(pin);
  assert.notEqual(right.failed?.reason,'certificate','the verified pin must be accepted');
  assert.ok(right.handshakes===1&&right.clientBytes>0,'the verified pin must continue to the CredSSP step');
  console.log(JSON.stringify({test:'native-pin',passed:true,wrong:{reason:wrong.failed.reason,clientBytes:wrong.clientBytes},right:{reason:right.failed?.reason??null,clientBytes:right.clientBytes},scope:'127.0.0.1 only; throwaway certificate, no credentials'}));
}catch(error){console.error(error.message);process.exitCode=1;}
finally{if(cleanupOK)rmSync(dir,{recursive:true,force:true});}
