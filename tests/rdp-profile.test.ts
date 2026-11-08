import baseTest from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chmod,mkdir,mkdtemp,realpath,rm,lstat,symlink,readdir,readFile,writeFile,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import cp from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import {existsSync} from 'node:fs';
const helper=resolve(process.env.RDP_PROFILE_HELPER??`native/bin/rdp-bridge${process.platform==='win32'?'.exe':''}`);
const test=existsSync(helper)?baseTest:baseTest.skip;
function policy(op:string,path:string,extra:object={}){
  const requestId=randomUUID();
  const result=spawnSync(helper,['--profile-policy'],{input:JSON.stringify({schema:1,op,path,requestId,...extra})+'\n',timeout:5000,maxBuffer:8192});
  return {...result,requestId};
}
test('native policy exclusively creates and inspects a private Unicode directory',async()=>{
  const dir=await realpath(await mkdtemp(join(tmpdir(),'rdp-policy-'))),path=join(dir,'profil-é-你好');
  try{
    for(const op of ['create','inspect']){
      const r=policy(op,path);assert.equal(r.status,0,r.stderr.toString());assert.equal(r.stderr.length,0);
      assert.deepEqual(JSON.parse(r.stdout.toString()),{schema:1,op,requestId:r.requestId,owner:true,private:true});
    }
    const st=await lstat(path);assert.ok(st.isDirectory());
    if(process.platform!=='win32'){assert.equal(st.mode&0o777,0o700);assert.equal(st.uid,process.geteuid!());}
    assert.notEqual(policy('create',path).status,0,'existing directory must never be adopted by create');
    assert.equal(policy('inspect',path).status,0,'refused create preserves original directory');
  }finally{await rm(dir,{recursive:true,force:true});}
});
async function manager(){const {RdpProfiles}=await import('../src/protocols/rdp/profile.js');const dir=await realpath(await mkdtemp(join(tmpdir(),'rdp-leases-')));return {dir,profiles:new RdpProfiles({root:dir,helper})};}
test('profile leases isolate concurrent connections and remove only their own trees',async()=>{
  const {dir,profiles}=await manager();
  try{
    const leases=await Promise.all([profiles.prepare(),profiles.prepare(),profiles.prepare()]);
    assert.equal(new Set(leases.map(l=>l.path)).size,3);
    for(const lease of leases){const marker=JSON.parse(await readFile(join(lease.path,'lease.json'),'utf8'));assert.deepEqual(Object.keys(marker).sort(),['appInstanceId','ownerPid','profileId','schema']);assert.equal(marker.ownerPid,process.pid);await mkdir(join(lease.path,'cache'));await writeFile(join(lease.path,'cache','setting'),'synthetic');}
    await leases[0].close();await assert.rejects(lstat(leases[0].path),{code:'ENOENT'});assert.ok((await lstat(leases[1].path)).isDirectory());
    await Promise.all(leases.map(l=>l.close()));assert.deepEqual((await readdir(join(dir,'rdp-profiles-v1'))).sort(),['root.json']);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('an existing unmarked profile root is preserved and never adopted',async()=>{
  const {dir,profiles}=await manager();await mkdir(join(dir,'rdp-profiles-v1'),{mode:0o700});
  try{await assert.rejects(profiles.prepare(),/RDP profile unavailable/);assert.deepEqual(await readdir(join(dir,'rdp-profiles-v1')),[]);}finally{await rm(dir,{recursive:true,force:true});}
});
test('lease cleanup waits for child close rather than exit and survives a real child crash',async()=>{
  const {dir,profiles}=await manager();
  try{
    const lease=await profiles.prepare();
    const child=spawn(process.execPath,['-e',"require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},250)'],{stdio:['ignore',1,2]});process.exit(7)"],{stdio:['pipe','pipe','pipe']});lease.bind(child);
    await once(child,'exit');assert.ok((await lstat(lease.path)).isDirectory(),'pipe is still held by child descendant');
    await lease.closed;await assert.rejects(lstat(lease.path),{code:'ENOENT'});await lease.close();
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('reaper preserves a live owner and reaps its residual only after that owned child exited',async()=>{
  const {dir,profiles}=await manager();const owner=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:['pipe','pipe','pipe']});
  try{
    const stale=await profiles.prepare(),marker=join(stale.path,'lease.json'),value=JSON.parse(await readFile(marker,'utf8'));value.ownerPid=owner.pid;await writeFile(marker,JSON.stringify(value));
    const live=await profiles.prepare();assert.ok((await lstat(stale.path)).isDirectory());await live.close();
    const exited=once(owner,'close');owner.kill();await exited;
    const fresh=await profiles.prepare();await assert.rejects(lstat(stale.path),{code:'ENOENT'});await fresh.close();
  }finally{owner.kill();await rm(dir,{recursive:true,force:true});}
});
test('quota counts unknown directories and preserves them at the 256 profile boundary',async()=>{
  const {dir,profiles}=await manager();
  try{
    const first=await profiles.prepare();await first.close();const root=join(dir,'rdp-profiles-v1');
    await Promise.all(Array.from({length:255},()=>mkdir(join(root,randomUUID()),{mode:0o700})));
    const last=await profiles.prepare();assert.equal((await readdir(root)).length,257);await last.close();
    await mkdir(join(root,randomUUID()),{mode:0o700});await assert.rejects(profiles.prepare(),/RDP profile unavailable/);assert.equal((await readdir(root)).length,257);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('cleanup refuses a linked or over-depth tree and preserves external data',async()=>{
  const {dir,profiles}=await manager();
  try{
    const lease=await profiles.prepare();let deep=lease.path;for(let n=0;n<9;n++){deep=join(deep,'deep');await mkdir(deep);}
    await assert.rejects(lease.close(),/RDP profile cleanup/);assert.ok((await lstat(lease.path)).isDirectory());
    if(process.platform!=='win32'){
      const other=await profiles.prepare();await writeFile(join(dir,'external'),'keep');await symlink(dir,join(other.path,'escape'));
      await assert.rejects(other.close(),/RDP profile cleanup/);assert.equal(await readFile(join(dir,'external'),'utf8'),'keep');
    }
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('policy client refuses duplicate response fields instead of launching with ambiguous policy',async t=>{
  const {dir,profiles}=await manager();
  try{
    const initial=await profiles.prepare();await initial.close();
    const launch=cp.spawn;t.mock.method(cp,'spawn',(_path:string,_args:readonly string[],options:cp.SpawnOptions)=>launch(process.execPath,[fileURLToPath(new URL('../../tests/fixtures/rdp-profile-helper.mjs',import.meta.url)),'duplicate'],options));
    await assert.rejects(profiles.prepare(),/RDP profile unavailable/);
    assert.deepEqual(await readdir(join(dir,'rdp-profiles-v1')),['root.json']);
  }finally{t.mock.restoreAll();await rm(dir,{recursive:true,force:true});}
});
test('root markers with duplicate fields are rejected and preserved byte for byte',async()=>{
  const {dir,profiles}=await manager();
  try{
    const initial=await profiles.prepare();await initial.close();const path=join(dir,'rdp-profiles-v1','root.json');
    const text=(await readFile(path,'utf8')).replace('"schema":1','"schema":0,"schema":1');await writeFile(path,text);
    await assert.rejects(profiles.prepare(),/RDP profile unavailable/);assert.equal(await readFile(path,'utf8'),text);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('reaper rechecks absent ownership after validation instead of deleting a reused live PID',async t=>{
  const {dir,profiles}=await manager(),owner=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['pipe','pipe','pipe']});
  try{
    const stale=await profiles.prepare(),path=join(stale.path,'lease.json'),v=JSON.parse(await readFile(path,'utf8'));v.ownerPid=owner.pid;await writeFile(path,JSON.stringify(v));
    const kill=process.kill;let probes=0;
    t.mock.method(process,'kill',(pid:number,signal:NodeJS.Signals|number=0)=>{if(pid===owner.pid&&signal===0&&probes++===0)throw Object.assign(new Error('absent'),{code:'ESRCH'});return kill(pid,signal);});
    const next=await profiles.prepare();assert.ok((await lstat(stale.path)).isDirectory());assert.ok(probes>=2);await next.close();
  }finally{t.mock.restoreAll();const closed=once(owner,'close');owner.kill('SIGKILL');await closed;await rm(dir,{recursive:true,force:true});}
});
test('reaper deletes at most 16 validated dead-owner residuals in one preparation',async()=>{
  const {dir,profiles}=await manager(),owner=spawn(process.execPath,['-e','process.exit(0)'],{stdio:['pipe','pipe','pipe']});await once(owner,'close');
  try{
    const first=await profiles.prepare();await first.close();const root=join(dir,'rdp-profiles-v1');
    for(let n=0;n<18;n++){const profileId=randomUUID(),path=join(root,profileId);assert.equal(policy('create',path).status,0);await writeFile(join(path,'lease.json'),JSON.stringify({schema:1,profileId,appInstanceId:randomUUID(),ownerPid:owner.pid}),{mode:0o600});}
    const next=await profiles.prepare();assert.equal((await readdir(root)).length,4,'root marker, two residuals and one new lease');await next.close();
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('unknown owner access and a replaced directory identity are preserved',async t=>{
  const {dir,profiles}=await manager();
  try{
    const stale=await profiles.prepare(),path=join(stale.path,'lease.json'),v=JSON.parse(await readFile(path,'utf8'));v.ownerPid=4294967294;await writeFile(path,JSON.stringify(v));
    const kill=process.kill;t.mock.method(process,'kill',(pid:number,signal:NodeJS.Signals|number=0)=>{if(pid===v.ownerPid)throw Object.assign(new Error('unknown'),{code:'EPERM'});return kill(pid,signal);});
    const other=await profiles.prepare();assert.ok((await lstat(stale.path)).isDirectory());t.mock.restoreAll();
    await rename(other.path,join(dir,'moved'));assert.equal(policy('create',other.path).status,0);await writeFile(join(other.path,'lease.json'),await readFile(join(dir,'moved','lease.json')),{mode:0o600});
    await assert.rejects(other.close(),/RDP profile cleanup/);assert.ok((await lstat(join(dir,'moved'))).isDirectory());assert.ok((await lstat(other.path)).isDirectory());
  }finally{t.mock.restoreAll();await rm(dir,{recursive:true,force:true});}
});
test('cleanup refuses more than 1024 entries without partially deleting the tree',async()=>{
  const {dir,profiles}=await manager();
  try{const lease=await profiles.prepare();await Promise.all(Array.from({length:1024},(_,n)=>writeFile(join(lease.path,`f${n}`),'')));await assert.rejects(lease.close(),/RDP profile cleanup/);assert.equal((await readdir(lease.path)).length,1025);}finally{await rm(dir,{recursive:true,force:true});}
});
for(const mode of ['wrong-id','unknown','stderr','oversize','truncated','utf8','extra','nonzero'])test(`policy client rejects ${mode} reply before a session can be prepared`,async t=>{
  const {dir,profiles}=await manager();
  try{
    const initial=await profiles.prepare();await initial.close();
    const launch=cp.spawn;t.mock.method(cp,'spawn',(_path:string,_args:readonly string[],options:cp.SpawnOptions)=>launch(process.execPath,[fileURLToPath(new URL('../../tests/fixtures/rdp-profile-helper.mjs',import.meta.url)),mode],options));
    await assert.rejects(profiles.prepare(),/^Error: RDP profile unavailable$/);assert.deepEqual(await readdir(join(dir,'rdp-profiles-v1')),['root.json']);
  }finally{t.mock.restoreAll();await rm(dir,{recursive:true,force:true});}
});
test('cleanup timeout reports incomplete, reaps only its broker and never repeats deletion',async t=>{
  const {dir,profiles}=await manager();let starts=0;const children:cp.ChildProcess[]=[];
  try{
    const lease=await profiles.prepare(),launch=cp.spawn;
    t.mock.method(cp,'spawn',(_path:string,_args:readonly string[],options:cp.SpawnOptions)=>{starts++;const child=launch(process.execPath,[fileURLToPath(new URL('../../tests/fixtures/rdp-profile-helper.mjs',import.meta.url)),'hang'],options);children.push(child);return child;});
    const settled=lease.close();await assert.rejects(settled,{code:'cleanup-pending'});await assert.rejects(lease.close(),{code:'cleanup-pending'});assert.equal(starts,1);assert.ok((await lstat(lease.path)).isDirectory());
    await Promise.all(children.map(c=>c.exitCode!==null||c.signalCode!==null?Promise.resolve():once(c,'close')));assert.equal(children[0].signalCode,'SIGKILL');
  }finally{t.mock.restoreAll();for(const child of children)child.kill('SIGKILL');await rm(dir,{recursive:true,force:true});}
});
test('preparation deadline aborts its slow broker and preserves an unacknowledged private leaf',async t=>{
  const {dir,profiles}=await manager(),children:cp.ChildProcess[]=[];const launch=cp.spawn;let calls=0;
  try{
    t.mock.method(cp,'spawn',(_path:string,args:readonly string[],options:cp.SpawnOptions)=>{assert.deepEqual(args,['--profile-policy']);calls++;const child=launch(process.execPath,[fileURLToPath(new URL('../../tests/fixtures/rdp-profile-helper.mjs',import.meta.url)),'slow'],options);children.push(child);return child;});
    const started=Date.now();await assert.rejects(profiles.prepare(),/RDP profile unavailable/);assert.ok(Date.now()-started<12000);assert.equal(calls,3);
    await Promise.all(children.map(c=>c.exitCode!==null||c.signalCode!==null?Promise.resolve():once(c,'close')));assert.equal(children.at(-1)!.signalCode,'SIGKILL');
    const entries=(await readdir(join(dir,'rdp-profiles-v1'))).filter(n=>n!=='root.json');assert.equal(entries.length,1);assert.deepEqual(await readdir(join(dir,'rdp-profiles-v1',entries[0])),[]);
  }finally{t.mock.restoreAll();for(const child of children)child.kill('SIGKILL');await rm(dir,{recursive:true,force:true});}
});
test('aborting during policy inspection reaps only the owned broker without changing the root',async t=>{
  const {dir,profiles}=await manager(),abort=new AbortController(),children:cp.ChildProcess[]=[];
  try{
    const initial=await profiles.prepare();await initial.close();const launch=cp.spawn;
    t.mock.method(cp,'spawn',(_path:string,_args:readonly string[],options:cp.SpawnOptions)=>{const child=launch(process.execPath,[fileURLToPath(new URL('../../tests/fixtures/rdp-profile-helper.mjs',import.meta.url)),'hang'],options);children.push(child);child.once('spawn',()=>abort.abort());return child;});
    await assert.rejects(profiles.prepare(abort.signal),/RDP profile unavailable/);assert.equal(children[0].signalCode,'SIGKILL');assert.deepEqual(await readdir(join(dir,'rdp-profiles-v1')),['root.json']);
  }finally{t.mock.restoreAll();for(const child of children)child.kill('SIGKILL');await rm(dir,{recursive:true,force:true});}
});
test('native policy rejects malformed requests and nonprivate/link paths without repairing them',async()=>{
  const dir=await realpath(await mkdtemp(join(tmpdir(),'rdp-policy-bad-'))),path=join(dir,'profile');
  try{
    assert.notEqual(policy('create',path,{unknown:'private-canary'}).status,0);
    await assert.rejects(lstat(path),{code:'ENOENT'});
    assert.notEqual(policy('create','relative').status,0);
    const made=policy('create',path);assert.equal(made.status,0);
    if(process.platform!=='win32'){
      await chmod(path,0o755);assert.notEqual(policy('inspect',path).status,0);assert.equal((await lstat(path)).mode&0o777,0o755);
      await symlink(path,join(dir,'link'));assert.notEqual(policy('inspect',join(dir,'link')).status,0);
    }
    for(const input of ['{bad}\n','x'.repeat(8193)+'\n',Buffer.from([0xff,10]),JSON.stringify({schema:1,op:'inspect',path,requestId:'bad'})+'\n']){
      const r=spawnSync(helper,['--profile-policy'],{input,timeout:5000,maxBuffer:8192});
      assert.notEqual(r.status,0);assert.equal(r.stdout.length,0);assert.equal(r.stderr.includes('private-canary'),false);
    }
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('missing or nonprivate ConfigPath cannot send an RDP negotiation packet',async()=>{
  const dir=await realpath(await mkdtemp(join(tmpdir(),'rdp-no-config-')));await chmod(dir,0o755);
  let packets=0;const server=createServer(socket=>{socket.on('error',()=>{});socket.on('data',b=>{packets+=b.length;socket.destroy();});});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    for(const path of [undefined,dir]){
      const env:NodeJS.ProcessEnv={...process.env,HOME:dir,USERPROFILE:dir};if(path)env.RW_RDP_CONFIG_PATH=path;else delete env.RW_RDP_CONFIG_PATH;
      const child=spawn(helper,['--bridge-v1'],{stdio:['pipe','pipe','pipe'],env});let err='',out=0;
      child.stdin.on('error',()=>{});child.stdout.on('data',b=>{out+=b.length;});child.stderr.on('data',b=>{err+=b;});const ended=once(child,'close');const timer=setTimeout(()=>child.kill('SIGKILL'),3000);
      child.stdin.write(JSON.stringify({type:'connect',target:{host:'127.0.0.1',port:(server.address() as {port:number}).port,username:'synthetic'},secret:{password:'profile-config-canary',domain:''}})+'\n');
      try{assert.deepEqual(await ended,[2,null]);assert.equal(packets,0);assert.equal(out,0);assert.equal(err.includes('profile-config-canary'),false);}finally{clearTimeout(timer);child.kill('SIGKILL');}
    }
  }finally{server.close();await once(server,'close');await rm(dir,{recursive:true,force:true});}
});
