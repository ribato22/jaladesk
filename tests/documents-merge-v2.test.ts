import test from 'node:test';
import assert from 'node:assert/strict';
import { merge3, resolveField } from '../src/documents/merge.js';
import { resolveMany, keyOf, describe } from '../src/documents/conflicts.js';
import { restoreAll, restoreObjects } from '../src/documents/restore.js';
import { applyOp } from '../src/documents/ops.js';

const id = (n:number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const secret = 'SYNTHETIC-C1-SECRET-CANARY';
const start = ():any => ({ schemaVersion:2,id:id(900),kind:'workspace',name:'ws',revision:0,objects:{[id(1)]:{id:id(1),type:'connection',name:'host',parentId:null,order:0,props:{protocol:'rdp',host:'example.invalid',username:'lab',groups:{credentials:{mode:'inline',secretId:id(11)}}}}}, meta:{createdAt:null,updatedAt:null,sort:[]},defaults:{groups:{}},secrets:{[id(11)]:{kind:'credential',username:'lab',domain:'',password:secret}} });
test('merge v2 keeps metadata and secrets; disjoint groups merge and credential records conflict atomically', () => {
  const b=start(),m=structuredClone(b),t=structuredClone(b);
  m.defaults.groups.notes='mine'; t.defaults.groups.color='red';
  m.meta.updatedAt='2026-10-24T01:00:00.000Z';t.meta.updatedAt='2026-10-24T02:00:00.000Z';
  let result=merge3(b,m,t);
  assert.equal(result.conflicts.length,0);assert.deepEqual((result.merged as any).defaults.groups,{notes:'mine',color:'red'});
  assert.equal((result.merged as any).meta.updatedAt,t.meta.updatedAt);assert.equal((result.merged as any).secrets[id(11)].password,secret);
  m.secrets[id(11)].username='mine';t.secrets[id(11)].password='THEIRS-SECRET';
  result=merge3(b,m,t);assert.equal(result.conflicts.length,1);
  const conflict=result.conflicts[0];assert.equal(conflict.kind,'field');
  const resolved:any=resolveField(result.merged,conflict as any,'theirs');assert.deepEqual(resolved.secrets[id(11)],t.secrets[id(11)]);
  const views=JSON.stringify(describe(result.merged,result.conflicts));assert.ok(!views.includes(secret)&&!views.includes('THEIRS-SECRET'));
  const many:any=resolveMany(result.merged,result.conflicts,[{key:keyOf(conflict),choice:'theirs'}]).doc;
  assert.deepEqual(many.secrets[id(11)],t.secrets[id(11)]);
});
test('disjoint inherited groups on the same object merge without replacing the other group',()=>{
  const b=start(),m=structuredClone(b),t=structuredClone(b);
  m.objects[id(1)].props.groups.notes='m';t.objects[id(1)].props.groups.color='blue';
  const {merged,conflicts}=merge3(b,m,t);assert.equal(conflicts.length,0);
  assert.deepEqual((merged.objects[id(1)]!.props.groups as any).notes,'m');assert.deepEqual((merged.objects[id(1)]!.props.groups as any).color,'blue');
});
test('restore all preserves v2 defaults/meta/secrets; object restore brings referenced secrets and remaps collisions',()=>{
  const old=start(),current=start();current.objects={};current.secrets={};
  assert.equal(restoreAll(current,old).schemaVersion,2);
  let n=50;const restored:any=restoreObjects(current,old,[id(1)],{newId:()=>id(n++)},'Restored').doc;
  assert.equal(restored.secrets[id(11)].password,secret);
  const copy:any=restoreObjects(old,old,[id(1)],{newId:()=>id(n++)},'Copy').doc;
  const newConn=Object.values(copy.objects).find((o:any)=>o.type==='connection'&&o.id!==id(1)) as any;
  assert.ok(newConn);const secretId=newConn.props.groups.credentials.secretId;
  assert.notEqual(secretId,id(11));assert.equal(copy.secrets[secretId].password,secret);
});
test('duplicate remaps internal credential IDs, retains explicit external refs, and clones only referenced secrets',()=>{
 const doc=start();let n=80;
 const result:any=applyOp(doc,{op:'duplicate',id:id(1),name:'copy'},{newId:()=>id(n++)});
 const ref=result.doc.objects[result.created].props.groups.credentials;
 assert.notEqual(ref.secretId,id(11));assert.equal(result.doc.secrets[ref.secretId].password,secret);
 assert.equal(doc.objects[id(1)].props.groups.credentials.secretId,id(11));
});
test('credential selection and its inheritance flag merge and resolve as one identity choice',()=>{
 const b=start();b.objects[id(1)].props.inherit={credentials:false};b.secrets[id(12)]={kind:'credential',username:'other',domain:''};
 for(const implicitParent of [false,true]){
  const m=structuredClone(b),t=structuredClone(b);
  m.objects[id(1)].props.groups.credentials={mode:'parent'};m.objects[id(1)].props.inherit.credentials=true;
  if(implicitParent){delete t.objects[id(1)].props.groups.credentials;t.objects[id(1)].props.inherit.credentials=true;}
  else t.objects[id(1)].props.groups.credentials={mode:'inline',secretId:id(12)};
  const result=merge3(b,m,t);assert.equal(result.conflicts.length,1);
  for(const side of ['mine','theirs'] as const){
   const expected=side==='mine'?m:t;
   const one=resolveField(result.merged,result.conflicts[0] as any,side);
   assert.deepEqual(one.objects[id(1)]!.props.groups,expected.objects[id(1)].props.groups);
   assert.deepEqual(one.objects[id(1)]!.props.inherit,expected.objects[id(1)].props.inherit);
   const many=resolveMany(result.merged,result.conflicts,[{key:keyOf(result.conflicts[0]),choice:side}]).doc;
   assert.deepEqual(many.objects[id(1)]!.props.groups,expected.objects[id(1)].props.groups);
   assert.deepEqual(many.objects[id(1)]!.props.inherit,expected.objects[id(1)].props.inherit);
  }
 }
});
