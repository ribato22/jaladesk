import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {DocumentLibrary} from '../src/documents/library.js';
const kdf={logN:14,r:8,p:1};
async function fixture(){const lib=new DocumentLibrary({kdf});const path=join(await mkdtemp(join(tmpdir(),'c2-retired-')),'doc.rwdoc');const d=await lib.create(path,'Fixture','pw');const add=()=>lib.add(d.id,{type:'connection',name:'Host',parentId:null,props:{protocol:'rdp',host:'example.invalid',username:'lab'}}).objectId;return{lib,path,d,add};}
test('removing an inline password deletes the retired record from the current encrypted document after save and reopen',async()=>{
 const {lib,path,d,add}=await fixture(),n=add(),canary='SYNTHETIC-RETIRED-CREDENTIAL';
 lib.writeGroup(d.id,{objectId:n,group:'credentials',inherit:false,value:{mode:'inline'},secret:{kind:'credential',username:'lab',domain:'',password:canary}});
 lib.writeGroup(d.id,{objectId:n,group:'credentials',inherit:false,value:{mode:'inline'},secret:{kind:'credential',username:'lab',domain:''}});
 assert.ok(!JSON.stringify(lib.privateDocument(d.id).doc).includes(canary));await lib.save(d.id);lib.closeAll();const reopened=await lib.open(path,'pw');assert.ok(!JSON.stringify(lib.privateDocument(reopened.id).doc).includes(canary));lib.closeAll();
});
test('retirement retains a secret used by a sibling or document default, and drops it only when the last typed reference is removed',async()=>{
 const {lib,d,add}=await fixture(),a=add(),b=add();
 lib.writeGroup(d.id,{objectId:a,group:'credentials',inherit:false,value:{mode:'inline'},secret:{kind:'credential',username:'lab',domain:'',password:'shared'}});
 let doc:any=lib.privateDocument(d.id).doc;const sid=doc.objects[a].props.groups.credentials.secretId;
 lib.changePrivate(d.id,lib.view(d.id).seq,draft=>{draft.objects[b]!.props.groups={credentials:{mode:'inline',secretId:sid}};draft.defaults.groups.credentials={mode:'inline',secretId:sid};});
 lib.writeGroup(d.id,{objectId:a,group:'credentials',inherit:true});lib.writeGroup(d.id,{objectId:b,group:'credentials',inherit:false,value:{mode:'none'}});
 doc=lib.privateDocument(d.id).doc;assert.ok(Object.hasOwn(doc.secrets,sid));
 lib.changePrivate(d.id,lib.view(d.id).seq,draft=>{delete draft.defaults.groups.credentials;});
 doc=lib.privateDocument(d.id).doc;assert.equal(Object.hasOwn(doc.secrets,sid),false);lib.closeAll();
});
test('protected clearing and generic connection or credential deletion retire their unreferenced current secrets',async()=>{
 const {lib,d,add}=await fixture(),n=add();
 lib.writeGroup(d.id,{objectId:n,group:'customField11',inherit:false,secret:{kind:'protected-value',value:'PROTECTED-RETIRED'}});
 lib.writeGroup(d.id,{objectId:n,group:'customField11',inherit:false,value:false});assert.ok(!JSON.stringify(lib.privateDocument(d.id).doc).includes('PROTECTED-RETIRED'));
 lib.writeGroup(d.id,{objectId:n,group:'credentials',inherit:false,value:{mode:'inline'},secret:{kind:'credential',username:'lab',domain:'',password:'DELETE-CONNECTION'}});lib.remove(d.id,n);assert.ok(!JSON.stringify(lib.privateDocument(d.id).doc).includes('DELETE-CONNECTION'));
 const made=lib.writeCredential(d.id,{name:'Identity',record:{kind:'credential',username:'lab',domain:'',password:'DELETE-CREDENTIAL'}});lib.removeCredential(d.id,made.objectId);assert.ok(!JSON.stringify(lib.privateDocument(d.id).doc).includes('DELETE-CREDENTIAL'));lib.closeAll();
});
