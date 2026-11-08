import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const path='../src/desktop/connections.js';
const source=(name:string)=>readFileSync(resolve('src/desktop',name),'utf8');
test('stored IPC authenticates the sender before reading any ref and returns fixed diagnostics only',async()=>{
 const {registerStoredIpc}=await import(path);assert.equal(typeof registerStoredIpc,'function');
 const handlers=new Map<string,Function>();let opens=0;
 registerStoredIpc({ipc:{handle:(name:string,fn:Function)=>handlers.set(name,fn)},check:(event:any)=>{if(!event.ok)throw Error('PRIVATE-CANARY');},service:{openStored:async()=>{opens++;throw Error('PRIVATE-CANARY');},reconnectStored:async()=>{opens++;throw Error('PRIVATE-CANARY');},forget:()=>{opens++;}}});
 for(const channel of ['rdp:open-stored','rdp:reconnect-stored','rdp:forget-stored']){
  const reply=await handlers.get(channel)!({ok:false},'id');assert.equal(reply.ok,false);assert.ok(!JSON.stringify(reply).includes('PRIVATE-CANARY'));
 }
 assert.equal(opens,0);const reply=await handlers.get('rdp:open-stored')!({ok:true},{});assert.equal(reply.ok,false);assert.equal(opens,1);assert.ok(!JSON.stringify(reply).includes('PRIVATE-CANARY'));
});
test('stored tree actions and reconnect use main references; only quick connect sends a raw target',()=>{
 const ui=source('documents-ui.ts'),renderer=source('renderer.ts'),preload=source('preload.cjs'),main=source('main.ts');
 const connect=ui.slice(ui.indexOf('  async function connect('),ui.indexOf('  function activate('));
 assert.ok(connect.includes('openStored'));assert.ok(!connect.includes('requestFor('));
 assert.ok(renderer.includes('reconnectStored('));assert.ok(renderer.includes('storedSessionId'));
 assert.ok(preload.includes("'rdp:open-stored'"));assert.ok(preload.includes("'rdp:reconnect-stored'"));
 assert.ok(main.includes('registerStoredIpc('));assert.ok(main.includes('requestCredentialInput('));assert.ok(main.includes('upgradeQuestion('));
});
