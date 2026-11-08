import test from 'node:test';import assert from 'node:assert/strict';
import {OperationPlans} from '../src/desktop/operation-plans.js';
import {DocumentLibrary} from '../src/documents/library.js';
import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
async function fixture(t:{after(fn:()=>Promise<void>):void}){
 const dir=await mkdtemp(join(tmpdir(),'c3-plans-')),library=new DocumentLibrary({kdf:{logN:14,r:8,p:1},now:()=>0});let now=1000,scope='scope-1';
 const document=await library.create(join(dir,'document.rwdoc'),'Sintetis','synthetic-password');const plans=new OperationPlans(library,{now:()=>now,scopeStamp:(_excluded:readonly string[])=>scope});
 t.after(async()=>{plans.close();library.closeAll();await rm(dir,{recursive:true,force:true});});
 return{library,document,plans,advance:(milliseconds:number)=>now+=milliseconds,setScope:(value:string)=>scope=value};
}
test('operation preview receipts are opaque, detached and once-only without letting a foreign owner consume them',async t=>{
 const f=await fixture(t),payload={secret:'SYNTHETIC-PRIVATE',nested:{name:'reviewed'}},stamp=f.library.entryStamp(f.document.id),receipt=f.plans.store('window-one','transfer',payload,[stamp]);
 assert.deepEqual(Object.keys(receipt).sort(),['expiresAt','planId']);assert.match(receipt.planId,/^[0-9a-f-]{36}$/);assert.equal(receipt.expiresAt,61000);assert.equal(JSON.stringify(receipt).includes('SYNTHETIC'),false);
 payload.nested.name='not reviewed';stamp.generation=999;
 assert.throws(()=>f.plans.take('window-two','transfer',receipt.planId),{code:'stale'});assert.throws(()=>f.plans.take('window-one','bulk',receipt.planId),{code:'stale'});
 const taken=f.plans.take<{secret:string;nested:{name:string}}>('window-one','transfer',receipt.planId);assert.equal(taken.payload.nested.name,'reviewed');assert.equal(taken.valid(),true);assert.equal(taken.scopeValid(),true);assert.throws(()=>f.plans.take('window-one','transfer',receipt.planId),{code:'stale'});
});
test('preview replacement is shared across operation kinds and TTL does not expire an accepted continuation scope',async t=>{
 const f=await fixture(t),stamp=f.library.entryStamp(f.document.id),old=f.plans.store('window','bulk',{value:1},[stamp]),newer=f.plans.store('window','transfer',{value:2},[stamp]);
 assert.throws(()=>f.plans.take('window','bulk',old.planId),{code:'stale'});const accepted=f.plans.take('window','transfer',newer.planId);f.advance(59999);assert.equal(accepted.valid(),true);f.advance(1);assert.equal(accepted.valid(),false);assert.equal(accepted.scopeValid(),true,'already accepted IO uses current receipts and scope rather than preview TTL');
 const expired=f.plans.store('window','bulk',{},[stamp]);f.advance(60000);assert.throws(()=>f.plans.take('window','bulk',expired.planId),{code:'stale'});
 const scoped=f.plans.store('window','transfer',{},[stamp]);f.setScope('new-scope');assert.throws(()=>f.plans.take('window','transfer',scoped.planId),{code:'stale'});assert.equal(accepted.scopeValid(),false);
});
test('private generation changes, close and uncertain handles invalidate reviewed entry stamps',async t=>{
 const f=await fixture(t),secretId='00000000-0000-4000-8000-000000000099';
 f.library.changePrivate(f.document.id,f.document.seq,doc=>{doc.defaults.groups.credentials={mode:'inline',secretId};doc.secrets[secretId]={kind:'credential',username:'lab',domain:'',password:'SYNTHETIC-PRIVATE'};});
 const stamp=f.library.entryStamp(f.document.id),receipt=f.plans.store('window','bulk',{},[stamp]);f.library.changePrivate(f.document.id,stamp.seq,doc=>{(doc.secrets[secretId] as any).password='SYNTHETIC-NEW';});assert.equal(f.library.view(f.document.id).seq,stamp.seq);assert.throws(()=>f.plans.take('window','bulk',receipt.planId),{code:'stale'});
 let blocked=false;const guarded=new OperationPlans({entryStamp:(handle:string)=>({...f.library.entryStamp(handle),...(blocked?{requiresReopen:true as const}:{})})},{scopeStamp:()=>''}),healthy=f.library.entryStamp(f.document.id),uncertain=guarded.store('window','transfer',{},[healthy]);blocked=true;assert.throws(()=>guarded.take('window','transfer',uncertain.planId),{code:'stale'});guarded.close();
 const live=f.plans.store('window','transfer',{},[f.library.entryStamp(f.document.id)]);f.library.close(f.document.id,{discard:true});assert.throws(()=>f.plans.take('window','transfer',live.planId),{code:'stale'});
});
test('revoking a window invalidates accepted bindings while foreign discard cannot remove another window plan',async t=>{
 const f=await fixture(t),stamp=f.library.entryStamp(f.document.id),receipt=f.plans.store('window','transfer',{},[stamp]);assert.equal(f.plans.discard('foreign','transfer',receipt.planId),false);
 const accepted=f.plans.take('window','transfer',receipt.planId);f.library.add(f.document.id,{type:'folder',name:'own phase A',parentId:null});assert.equal(accepted.valid(),false);assert.equal(accepted.scopeValid(),true);f.plans.revoke('window');assert.equal(accepted.scopeValid(),false);
 const next=f.plans.store('window','bulk',{},[f.library.entryStamp(f.document.id)]);assert.equal(accepted.scopeValid(),false,'reusing an owner name does not revive an old owner binding');assert.equal(f.plans.discard('window','bulk',next.planId),true);assert.throws(()=>f.plans.take('window','bulk',next.planId),{code:'stale'});
 f.plans.close();assert.throws(()=>f.plans.store('window','bulk',{},[f.library.entryStamp(f.document.id)]),{code:'stale'});
});
