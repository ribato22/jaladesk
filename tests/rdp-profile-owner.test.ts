import baseTest from 'node:test';import assert from 'node:assert/strict';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {mkdtemp,realpath,rm,lstat,readdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {existsSync} from 'node:fs';
const helper=resolve(process.env.RDP_PROFILE_HELPER??`native/bin/rdp-bridge${process.platform==='win32'?'.exe':''}`);
const test=existsSync(helper)?baseTest:baseTest.skip;
const target={host:'fixture.invalid',port:3389,username:'synthetic'},secret={password:'profile-secret-canary',domain:''};
async function setup(){const mod=await import('../src/protocols/rdp/profiled-owner.js');const dir=await realpath(await mkdtemp(join(tmpdir(),'rdp-profile-owner-')));return {dir,...mod};}
test('profiled owner closes its real child and removes only that session profile',async()=>{
  const {dir,createProfiledOwner}=await setup();let child:ChildProcessWithoutNullStreams|undefined,path='';
  try{
    const owner=createProfiledOwner({root:dir,helper,launch:(_binary:string,_args:readonly string[],env:NodeJS.ProcessEnv)=>{path=env.RW_RDP_CONFIG_PATH!;child=spawn(helper,['--fixture'],{stdio:['pipe','pipe','pipe'],env});return child;}});
    const states:string[]=[];const session=await owner.open(target,secret,{frame:()=>{},state:s=>states.push(s)});
    assert.ok((await lstat(path)).isDirectory());assert.equal((await readFile(join(path,'lease.json'),'utf8')).includes(secret.password),false);
    await Promise.all([session.close(),session.close()]);assert.notEqual(child?.exitCode,null);await assert.rejects(lstat(path),{code:'ENOENT'});assert.ok(states.includes('closed'));
  }finally{child?.kill('SIGKILL');await rm(dir,{recursive:true,force:true});}
});
test('profiled owner keeps authentication failed terminal while allowing natural exit and cleanup',async()=>{
  const {dir,createProfiledOwner}=await setup();let child:ChildProcessWithoutNullStreams|undefined,path='';
  try{
    const owner=createProfiledOwner({root:dir,helper,launch:(_binary:string,_args:readonly string[],env:NodeJS.ProcessEnv)=>{path=env.RW_RDP_CONFIG_PATH!;child=spawn(process.execPath,['-e',`process.stdin.once('data',()=>{process.stderr.write('{"state":"failed","reason":"authentication"}\\n');setTimeout(()=>process.exit(1),30)})`],{stdio:['pipe','pipe','pipe'],env});return child;}});
    const states:string[]=[];let observed!:()=>void;
    const failure=new Promise<void>((yes,no)=>{const timer=setTimeout(()=>no(new Error('synthetic authentication status not received')),3000);observed=()=>{clearTimeout(timer);yes();};});
    const session=await owner.open(target,secret,{frame:()=>{},state:s=>{states.push(s);if(s==='failed')observed();}});
    await failure;await session.close();assert.equal(child!.exitCode,1);assert.equal(child!.signalCode,null);assert.deepEqual(states,['connecting','failed']);await assert.rejects(lstat(path),{code:'ENOENT'});
  }finally{child?.kill('SIGKILL');await rm(dir,{recursive:true,force:true});}
});
test('invalid target and synchronous launcher failure release their prepared leases',async()=>{
  const {dir,createProfiledOwner}=await setup();let launches=0;
  try{
    const owner=createProfiledOwner({root:dir,helper,launch:()=>{launches++;throw new Error('launch-canary');}});
    await assert.rejects(owner.open({...target,port:0},secret,{frame:()=>{},state:()=>{}}));assert.equal(launches,0);
    await assert.rejects(owner.open(target,secret,{frame:()=>{},state:()=>{}}));assert.equal(launches,1);
    assert.deepEqual(await readdir(join(dir,'rdp-profiles-v1')),['root.json']);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('abort before preparation never launches or creates a profile',async()=>{
  const {dir,createProfiledOwner}=await setup();const abort=new AbortController();abort.abort();let launches=0;
  try{
    const owner=createProfiledOwner({root:dir,helper,launch:()=>{launches++;throw new Error('must not launch');}});
    await assert.rejects(owner.open(target,secret,{frame:()=>{},state:()=>{}},{signal:abort.signal}));assert.equal(launches,0);assert.deepEqual(await readdir(dir),[]);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('abort immediately after spawn prevents secret delivery and cleans the owned child',async()=>{
  const {dir,createProfiledOwner}=await setup();const abort=new AbortController();let child:ChildProcessWithoutNullStreams|undefined,writes=0;
  try{
    const owner=createProfiledOwner({root:dir,helper,launch:(_binary:string,_args:readonly string[],env:NodeJS.ProcessEnv)=>{
      child=spawn(process.execPath,['-e','process.stdin.resume();setInterval(()=>{},1000)'],{stdio:['pipe','pipe','pipe'],env});const write=child.stdin.write.bind(child.stdin);child.stdin.write=((...args:Parameters<typeof write>)=>{writes++;return write(...args);}) as typeof write;abort.abort();return child;
    }});
    await assert.rejects(owner.open(target,secret,{frame:()=>{},state:()=>{}},{signal:abort.signal}));assert.equal(writes,0);assert.notEqual(child!.signalCode,null);assert.deepEqual(await readdir(join(dir,'rdp-profiles-v1')),['root.json']);
  }finally{child?.kill('SIGKILL');await rm(dir,{recursive:true,force:true});}
});
test('script helper spawn exposes cleanup completion after natural fixture closure',async()=>{
  const {dir,spawnProfiledHelper}=await setup();
  try{
    const run=await spawnProfiledHelper(helper,['--fixture'],{root:dir});run.child.stdout.resume();run.child.stderr.resume();run.child.stdin.end('{"type":"connect"}\n{"type":"close"}\n');
    await run.closed;assert.equal(run.child.exitCode,0);assert.deepEqual(await readdir(join(dir,'rdp-profiles-v1')),['root.json']);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('aborting one active profiled session leaves another session and its profile alive',async()=>{
  const {dir,createProfiledOwner}=await setup(),abort=new AbortController();const paths:string[]=[],children:ChildProcessWithoutNullStreams[]=[];
  try{
    const owner=createProfiledOwner({root:dir,helper,launch:(_binary:string,_args:readonly string[],env:NodeJS.ProcessEnv)=>{paths.push(env.RW_RDP_CONFIG_PATH!);const child=spawn(helper,['--fixture'],{stdio:['pipe','pipe','pipe'],env});children.push(child);return child;}});
    const first=await owner.open(target,secret,{frame:()=>{},state:()=>{}},{signal:abort.signal});const second=await owner.open(target,secret,{frame:()=>{},state:()=>{}});
    abort.abort();await first.close();await assert.rejects(lstat(paths[0]),{code:'ENOENT'});assert.ok((await lstat(paths[1])).isDirectory());assert.equal(children[1].exitCode,null);
    await second.close();assert.deepEqual(await readdir(join(dir,'rdp-profiles-v1')),['root.json']);
  }finally{for(const child of children)child.kill('SIGKILL');await rm(dir,{recursive:true,force:true});}
});
test('closing all sessions completes despite one cleanup failure and reports only a fixed diagnostic',async()=>{
  const {dir,createProfiledOwner,closeProfiledSessions}=await setup(),paths:string[]=[],children:ChildProcessWithoutNullStreams[]=[];
  try{
    const owner=createProfiledOwner({root:dir,helper,launch:(_binary:string,_args:readonly string[],env:NodeJS.ProcessEnv)=>{paths.push(env.RW_RDP_CONFIG_PATH!);const child=spawn(helper,['--fixture'],{stdio:['pipe','pipe','pipe'],env});children.push(child);return child;}});
    const sessions=[await owner.open(target,secret,{frame:()=>{},state:()=>{}}),await owner.open(target,secret,{frame:()=>{},state:()=>{}})];
    await writeFile(join(paths[0],'lease.json'),'private-error-canary');const diagnostics:string[]=[];
    await closeProfiledSessions(sessions,message=>diagnostics.push(message));
    assert.deepEqual(diagnostics,['RDP profile cleanup incomplete']);assert.ok((await lstat(paths[0])).isDirectory());await assert.rejects(lstat(paths[1]),{code:'ENOENT'});
    assert.ok(children.every(c=>c.exitCode===0&&c.signalCode===null));
  }finally{for(const child of children)child.kill('SIGKILL');await rm(dir,{recursive:true,force:true});}
});
