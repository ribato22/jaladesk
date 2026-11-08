import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentLibrary } from '../src/documents/library.js';
import { DocumentSession } from '../src/documents/session.js';
import { createDocument } from '../src/documents/store.js';
import { serializeDocument, upgradeV1 } from '../src/documents/model.js';
import { merge3 } from '../src/documents/merge.js';
import { describe } from '../src/documents/conflicts.js';
import { projectNode } from '../src/documents/projection.js';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const kdf={logN:14,r:8,p:1};const canary='SYNTHETIC-PRIVATE-PASSWORD-SEED-KEY';
const absent=(value:unknown)=>assert.ok(!JSON.stringify(value).includes(canary),'private canary absent from public data');
test('all library public paths project an allowlist, including incremental/reset deltas and revisions',async()=>{
 const path=join(await mkdtemp(join(tmpdir(),'c1-project-')),'doc.rwdoc');
 const lib=new DocumentLibrary({kdf});const {id:handle}=await lib.create(path,'Fixture','pw');
 const added=lib.add(handle,{parentId:null,type:'connection',name:'Host',props:{host:'example.invalid',protocol:'rdp',username:'lab',opaque:{nested:canary},notes:'public'}});
 absent(added.delta);absent(lib.snapshot(handle));absent(lib.snapshots());
 assert.deepEqual(lib.snapshot(handle).objects[0]!.props,{host:'example.invalid',protocol:'rdp',username:'lab',notes:'public'});
 const delta=lib.update(handle,added.objectId,{patch:{set:{futureSecret:canary}}});absent(delta);
 await lib.save(handle);lib.update(handle,added.objectId,{name:'Renamed'});await lib.save(handle);
 const revs=await lib.revisions(handle);assert.ok(revs.length);absent(await lib.revision(handle,revs[0]!.name));
 const other=await DocumentSession.open(path,{password:'pw'},{kdf});other.update(d=>{d.objects[added.objectId]!.props.opaque={nested:'OTHER-'+canary};});await other.save();other.dispose();
 lib.update(handle,added.objectId,{patch:{set:{opaque:{nested:'MINE-'+canary}}}});
 const held=await lib.save(handle);assert.equal(held.saved,false);absent(held);absent(lib.conflicts(handle));
 lib.closeAll();
});
test('vault credential CRUD is private and legacy workspace credentials remain usable without readback',async()=>{
 const lib:any=new DocumentLibrary({kdf});const path=join(await mkdtemp(join(tmpdir(),'c1-vault-')),'vault.rwdoc');
 assert.equal(typeof lib.createVault,'function');const view=await lib.createVault(path,'Private','pw');
 const made=lib.writeCredential(view.id,{name:'Lab',record:{kind:'credential',username:'administrator',domain:'',password:canary}});
 absent(made);absent(lib.snapshot(view.id));const choices=lib.credentialViews(view.id);absent(choices);
 assert.equal(choices[0].hasPassword,true);assert.equal(choices[0].username,'administrator');assert.equal(choices[0].id,made.objectId);
 const gen=lib.privateDocument(view.id).generation;
 lib.writeCredential(view.id,{objectId:made.objectId,name:'Lab',record:{kind:'credential',username:'changed',domain:'',password:canary}});
 assert.notEqual(lib.privateDocument(view.id).generation,gen);await lib.save(view.id);
 assert.equal(lib.credentialViews(view.id)[0].username,'changed');lib.removeCredential(view.id,made.objectId);assert.equal(lib.credentialViews(view.id).length,0);lib.closeAll();
 const legacyPath=join(await mkdtemp(join(tmpdir(),'c1-legacy-')),'ws.rwdoc');
 const old:any={schemaVersion:1,id:id(900),kind:'workspace',name:'Legacy',revision:0,objects:{[id(1)]:{id:id(1),type:'credential',name:'kept',parentId:null,order:0,props:{username:'lab',password:canary}}}};
 const h=await createDocument(legacyPath,serializeDocument(old),'pw',{kdf});h.unlocked.dispose();
 const ws=await lib.open(legacyPath,'pw');assert.equal(lib.credentialViews(ws.id).length,1);absent(lib.credentialViews(ws.id));absent(lib.snapshot(ws.id));lib.closeAll();
});
test('legacy opaque values under public property names never leak through conflict views',()=>{
 for(const key of ['notes','host','port','sort','clipboardToRemote']){
  const old:any={schemaVersion:1,id:id(900),kind:'workspace',name:'ws',revision:0,objects:{[id(1)]:{id:id(1),type:'connection',name:'host',parentId:null,order:0,props:{[key]:{nested:'base'}}}}};
  const b=upgradeV1(old),m=structuredClone(b),t=structuredClone(b);
  m.objects[id(1)]!.props[key]={nested:canary};t.objects[id(1)]!.props[key]={nested:'THEIRS-'+canary};
  const result=merge3(b,m,t);assert.equal(result.conflicts.length,1);absent(projectNode(result.merged.objects[id(1)]!));absent(describe(result.merged,result.conflicts));
 }
});
test('editing a credential keeps its opaque and group properties in the encrypted working copy',async()=>{
 const lib=new DocumentLibrary({kdf});const path=join(await mkdtemp(join(tmpdir(),'c1-edit-opaque-')),'vault.rwdoc');const view=await lib.createVault(path,'Vault','pw');
 const credential=lib.writeCredential(view.id,{name:'Before',record:{kind:'credential',username:'lab',domain:'',password:canary}});
 lib.update(view.id,credential.objectId,{patch:{set:{opaque:{nested:'kept'},groups:{notes:'credential-note'}}}});
 lib.writeCredential(view.id,{objectId:credential.objectId,name:'After',record:{kind:'credential',username:'changed',domain:'',password:canary}});
 assert.deepEqual(lib.node(view.id,credential.objectId)!.props.opaque,{nested:'kept'});assert.deepEqual(lib.node(view.id,credential.objectId)!.props.groups,{notes:'credential-note'});lib.closeAll();
});
test('the shared document library refuses a private override file and leaves nothing registered',async()=>{
 const path=join(await mkdtemp(join(tmpdir(),'c1-private-override-')),'override.rwdoc');
 const doc:any={schemaVersion:2,id:id(900),kind:'overrides',name:'Private overlay',revision:0,objects:{},meta:{createdAt:null,updatedAt:null,sort:[]},defaults:{groups:{}},secrets:{}};
 const session=await DocumentSession.create(path,doc,'pw',{kdf});session.dispose();
 const lib=new DocumentLibrary({kdf});await assert.rejects(lib.open(path,'pw'),{code:'invalid'});
 assert.deepEqual(lib.views(),[]);assert.deepEqual(lib.snapshots(),[]);lib.closeAll();
});
