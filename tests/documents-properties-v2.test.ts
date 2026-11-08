import test from 'node:test';import assert from 'node:assert/strict';
import {patchDocument} from '../src/documents/properties.js';
import type {Doc2} from '../src/documents/model.js';
import {DocumentLibrary} from '../src/documents/library.js';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {merge3} from '../src/documents/merge.js';import {restoreAll} from '../src/documents/restore.js';import {DocumentSession} from '../src/documents/session.js';
const id='00000000-0000-4000-8000-000000000001';
const doc=():Doc2=>({schemaVersion:2,id,kind:'workspace',name:'Sebelum',revision:0,objects:{},meta:{createdAt:null,updatedAt:null,sort:[]},defaults:{groups:{}},secrets:{}});
test('one metadata edit patches only selected fields and uses UTC dates without inventing migration creation time',()=>{
 const before=doc(),after=patchDocument(before,{name:'Sesudah',sort:[{by:'name',dir:'asc'}],defaults:{notes:'catatan'}},'2026-10-24T10:00:00.000Z');
 assert.equal(after.name,'Sesudah');assert.deepEqual(after.meta,{createdAt:null,updatedAt:'2026-10-24T10:00:00.000Z',sort:[{by:'name',dir:'asc'}]});assert.deepEqual(after.defaults.groups,{notes:'catatan'});assert.equal(before.name,'Sebelum');assert.equal(after.id,before.id);
});
test('invalid metadata patch fails before mutation and no-op/false/unset keep their separate meanings',()=>{
 const original=doc();for(const patch of [{name:''},{name:'   '},{createdAt:'2026-10-24T11:00:00.000Z'},{sort:[{by:'date',dir:'asc'}]},{sort:[{by:'name',dir:'asc'},{by:'name',dir:'desc'}]},{defaults:{customField11:{secretId:id}}}])assert.throws(()=>patchDocument(original,patch,'2026-10-24T11:00:00.000Z'));
 assert.equal(patchDocument(original,{name:'Sebelum'},'invalid clock unused by no-op'),original);
 const edited=patchDocument(original,{defaults:{customField1:false,notes:'x'}},'2026-10-24T11:00:00.000Z');const unset=patchDocument(edited,{unsetDefaults:['notes']},'2026-10-24T10:00:00.000Z');assert.equal(unset.defaults.groups.customField1,false);assert.equal(Object.hasOwn(unset.defaults.groups,'notes'),false);assert.equal(unset.meta.updatedAt,'2026-10-24T11:00:00.000Z');
});
test('metadata survives encrypted save/reopen, merges without timestamp conflicts and restores only after an explicit edit',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'c3-property-roundtrip-'));const file=join(dir,'synthetic.rwdoc');const base=doc(),a=patchDocument(base,{name:'A'},'2026-10-24T10:00:00.000Z'),b=patchDocument(base,{sort:[{by:'name',dir:'desc'}],defaults:{notes:'B'}},'2026-10-24T11:00:00.000Z');const merged=merge3(base,a,b);assert.deepEqual(merged.conflicts,[]);assert.equal((merged.merged as Doc2).meta.updatedAt,'2026-10-24T11:00:00.000Z');
 let session=await DocumentSession.create(file,merged.merged,'synthetic-only',{kdf:{logN:14,r:8,p:1}});
 try{session.dispose();session=await DocumentSession.open(file,{password:'synthetic-only'});assert.deepEqual((session.doc as Doc2).meta,(merged.merged as Doc2).meta);assert.equal(session.doc.name,'A');const restored=restoreAll(session.doc,base) as Doc2;assert.equal(restored.meta.createdAt,null);assert.deepEqual(restored.meta.sort,[]);assert.deepEqual(restored.defaults,base.defaults);assert.equal((session.doc as Doc2).meta.updatedAt,'2026-10-24T11:00:00.000Z','preview/restore draft does not edit the open session');session.update(draft=>Object.assign(draft,restored));assert.equal(session.dirty,true);await session.save();assert.equal(session.doc.name,'Sebelum');}finally{session.dispose();await rm(dir,{recursive:true,force:true});}
});
test('no-op trusted edit keeps a saved document clean and ordinary object edits update its timestamp once',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'c3-properties-'));let time=Date.parse('2026-10-24T10:00:00.000Z');const lib=new DocumentLibrary({now:()=>time,kdf:{logN:14,r:8,p:1}});
 try{
  const made=await lib.create(join(dir,'spike.rwdoc'),'Dokumen','synthetic-only');lib.changePrivate(made.id,made.seq,()=>{});assert.equal(lib.view(made.id).dirty,false,'no-op must retain clean working copy');
  const before=lib.privateDocument(made.id).doc as Doc2;assert.equal(before.meta.createdAt,'2026-10-24T10:00:00.000Z');
  time+=1000;lib.add(made.id,{parentId:null,type:'folder',name:'folder'});assert.equal((lib.privateDocument(made.id).doc as Doc2).meta.updatedAt,'2026-10-24T10:00:01.000Z');await lib.save(made.id);const seq=lib.view(made.id).seq;
  time+=1000;const delta=lib.changePrivate(made.id,seq,d=>{d.name='Dokumen';});assert.equal(delta.seq,seq);assert.equal(lib.view(made.id).dirty,false);assert.equal((lib.privateDocument(made.id).doc as Doc2).meta.updatedAt,'2026-10-24T10:00:01.000Z');
 }finally{lib.closeAll();await rm(dir,{recursive:true,force:true});}
});

test('default group writes allocate secret IDs internally, retire only unused records and preserve no-op/false/unset',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'c3-default-'));const lib=new DocumentLibrary({kdf:{logN:14,r:8,p:1}});try{
  const made=await lib.create(join(dir,'d.rwdoc'),'Doc','synthetic-only');assert.equal(typeof (lib as any).writeDefaultGroup,'function');
  const write=(input:any)=>(lib as any).writeDefaultGroup(made.id,lib.view(made.id).seq,input);
  write({group:'notes',value:''});const seq=lib.view(made.id).seq;write({group:'notes',value:''});assert.equal(lib.view(made.id).seq,seq);
  write({group:'customField1',value:false});write({group:'notes'});let d=lib.privateDocument(made.id).doc as Doc2;assert.equal(d.defaults.groups.customField1,false);assert.equal(Object.hasOwn(d.defaults.groups,'notes'),false);
  const c=lib.writeCredential(made.id,{name:'kept',record:{kind:'credential',username:'lab',domain:'',password:'SYNTHETIC-KEPT'}});const kept=(lib.node(made.id,c.objectId)!.props.secretId)as string;
  write({group:'credentials',value:{mode:'inline'},secret:{kind:'credential',username:'local',domain:'',password:'SYNTHETIC-DEFAULT'}});d=lib.privateDocument(made.id).doc as Doc2;const retired=(d.defaults.groups.credentials as any).secretId;assert.notEqual(retired,kept);
  write({group:'credentials',value:{mode:'none'}});d=lib.privateDocument(made.id).doc as Doc2;assert.equal(Object.hasOwn(d.secrets,retired),false);assert.equal(Object.hasOwn(d.secrets,kept),true);
  const before=structuredClone(d);for(const bad of [{group:'credentials',value:{mode:'parent'}},{group:'notes',value:'x',secret:{kind:'protected-value',value:'secret'}},{group:'unknown',value:'x'}])assert.throws(()=>write(bad));assert.deepEqual(lib.privateDocument(made.id).doc,before);
 }finally{lib.closeAll();await rm(dir,{recursive:true,force:true});}
});
test('conflict resolution and explicit restore stamp meaningful edits while preserving document creation identity',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'c3-date-life-'));let at=Date.parse('2026-10-24T00:00:00.000Z');const opts={now:()=>at,kdf:{logN:14,r:8,p:1}},file=join(dir,'d.rwdoc');const start=doc();start.meta.createdAt='2000-01-01T00:00:00.000Z';const a=await DocumentSession.create(file,start,'synthetic',opts),b=await DocumentSession.open(file,{password:'synthetic'},opts);
 try{at+=1000;a.update(d=>d.name='A');await a.save();at+=1000;b.update(d=>d.name='B');assert.equal((await b.save()).saved,false);at+=1000;b.resolve(b.conflicts[0]!,'theirs');assert.equal((b.doc as Doc2).meta.updatedAt,'2026-10-24T00:00:03.000Z');await b.save();at+=1000;const revision=structuredClone(start);revision.meta.createdAt=null;b.replaceWith(revision);assert.equal((b.doc as Doc2).meta.createdAt,'2000-01-01T00:00:00.000Z');assert.equal((b.doc as Doc2).meta.updatedAt,'2026-10-24T00:00:04.000Z');}finally{a.dispose();b.dispose();await rm(dir,{recursive:true,force:true});}
});
