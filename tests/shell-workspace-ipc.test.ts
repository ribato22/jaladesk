import test from 'node:test';import assert from 'node:assert/strict';
const modulePath='../src/desktop/workspace-ipc.js';
test('workspace IPC authenticates before touching input and rejects unknown actions, extra keys and private paths',async()=>{
 const {registerWorkspaceIpc}=await import(modulePath);let handler:Function=()=>{};let called=0;
 registerWorkspaceIpc({ipc:{handle:(_n:string,fn:Function)=>{handler=fn;}},check:(e:any)=>{if(!e.ok)throw Error('PRIVATE-CANARY');},actions:{'credentials.list':{keys:[],run:()=>{called++;return[];}},'credentials.edit':{keys:['id','expectedSeq','name'],run:()=>{called++;return{};}}}});
 const trapped=new Proxy({},{get(){throw Error('input touched');},getPrototypeOf(){throw Error('input touched');}});
 assert.deepEqual(await handler({ok:false},'credentials.list',trapped),{ok:false,code:'credential-error',message:'Operasi tidak dapat diselesaikan.'});
 for(const [action,payload] of [['constructor',{}],['credentials.list',{path:'/private'}],['credentials.edit',{id:'id',password:'PRIVATE-CANARY'}],['credentials.list',[]]]){const reply=await handler({ok:true},action,payload);assert.equal(reply.ok,false);assert.ok(!JSON.stringify(reply).includes('PRIVATE-CANARY'));}
 assert.equal(called,0);assert.deepEqual(await handler({ok:true},'credentials.list',{}),{ok:true,value:[]});assert.equal(called,1);
});
test('workspace mutation pushes refresh only after success and returns fixed diagnostics for failures',async()=>{
 const {registerWorkspaceIpc}=await import(modulePath);let handler:Function=()=>{};let pushes=0;
 registerWorkspaceIpc({ipc:{handle:(_n:string,fn:Function)=>handler=fn},check:()=>{},refresh:()=>{pushes++;},actions:{good:{keys:[],changes:true,run:()=>({saved:true})},bad:{keys:[],changes:true,run:()=>{throw Object.assign(Error('PRIVATE-CANARY'),{code:'stale',cause:'PRIVATE-CANARY'});}}}});
 assert.equal((await handler({},'bad',{})).ok,false);assert.equal(pushes,0);assert.ok(!JSON.stringify(await handler({},'bad',{})).includes('PRIVATE-CANARY'));
 assert.deepEqual(await handler({},'good',{}),{ok:true,value:{saved:true}});assert.equal(pushes,1);
});

test('double-click and concurrent mutations share one pending native decision budget',async()=>{
 const {registerWorkspaceIpc}=await import(modulePath);let handler:Function=()=>{};let calls=0;let release!:()=>void;const wait=new Promise<void>(r=>release=r);
 registerWorkspaceIpc({ipc:{handle:(_n:string,fn:Function)=>handler=fn},check:()=>{},actions:{edit:{keys:[],changes:true,run:async()=>{calls++;await wait;return 'done';}},list:{keys:[],run:()=>[]}}});
 const first=handler({},'edit',{});assert.deepEqual(await handler({},'list',{}),{ok:true,value:[]});const second=handler({},'edit',{});const result=await Promise.race([second,new Promise<any>(r=>setImmediate(()=>r({code:'no-budget'})))]);release();assert.equal(result.code,'busy');assert.equal(calls,1);assert.equal((await first).ok,true);assert.equal((await handler({},'edit',{})).ok,true);
});

test('public token failures retain a fixed named code without exposing expressions or values',async()=>{
 const {registerWorkspaceIpc}=await import(modulePath);let handler:Function=()=>{};
 for(const code of ['missing-token','unknown-token','secret-token','token-limit']){
  registerWorkspaceIpc({ipc:{handle:(_n:string,fn:Function)=>handler=fn},check:()=>{},actions:{template:{keys:[],run:()=>{throw Object.assign(Error('PRIVATE-CANARY'),{code,cause:'PRIVATE-CANARY'});}}}});
  const reply=await handler({},'template',{});assert.equal(reply.code,code);assert.ok(!JSON.stringify(reply).includes('PRIVATE-CANARY'));
 }
});
