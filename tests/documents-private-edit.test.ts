import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DocumentLibrary} from '../src/documents/library.js';
const kdf={logN:14,r:8,p:1};
test('private edits validate atomically and reject stale public sequence without losing existing data',async()=>{
 const lib:any=new DocumentLibrary({kdf});const d=await lib.create(join(await mkdtemp(join(tmpdir(),'c2-private-')),'doc.rwdoc'),'Fixture','pw');
 const n=lib.add(d.id,{type:'connection',name:'Host',parentId:null,props:{host:'example.invalid',username:'lab',opaque:'keep'}}).objectId;
 assert.equal(typeof lib.changePrivate,'function');const seq=lib.view(d.id).seq;
 assert.throws(()=>lib.changePrivate(d.id,seq+1,()=>{}),{code:'invalid'});
 const before=JSON.stringify(lib.privateDocument(d.id).doc);
 assert.throws(()=>lib.changePrivate(d.id,seq,(doc:any)=>{doc.objects[n].props.groups={customField11:{secretId:'missing'}};}));
 assert.equal(JSON.stringify(lib.privateDocument(d.id).doc),before);
 lib.changePrivate(d.id,seq,(doc:any)=>{doc.objects[n].props.groups={notes:'new'};});
 assert.equal(lib.privateDocument(d.id).doc.objects[n].props.opaque,'keep');lib.closeAll();
});
test('one private group write creates its secret and inheritance consistently without public readback',async()=>{
 const lib:any=new DocumentLibrary({kdf});const d=await lib.create(join(await mkdtemp(join(tmpdir(),'c2-group-')),'doc.rwdoc'),'Fixture','pw');
 const n=lib.add(d.id,{type:'connection',name:'Host',parentId:null,props:{host:'example.invalid',username:'lab'}}).objectId;
 assert.equal(typeof lib.writeGroup,'function');
 const delta=lib.writeGroup(d.id,{objectId:n,group:'credentials',inherit:false,value:{mode:'inline'},secret:{kind:'credential',username:'lab',domain:'',password:'SYNTHETIC-C2-CANARY'}});
 assert.ok(!JSON.stringify(delta).includes('SYNTHETIC-C2-CANARY'));
 const doc=lib.privateDocument(d.id).doc;assert.equal(doc.secrets[doc.objects[n].props.groups.credentials.secretId].password,'SYNTHETIC-C2-CANARY');
 lib.writeGroup(d.id,{objectId:n,group:'credentials',inherit:true});assert.equal(lib.privateDocument(d.id).doc.objects[n].props.inherit.credentials,true);
 assert.throws(()=>lib.writeGroup(d.id,{objectId:n,group:'notes',inherit:false,secret:{kind:'protected-value',value:'bad'}}));
 lib.closeAll();
});
