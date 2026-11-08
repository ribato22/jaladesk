import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {DocumentLibrary} from '../src/documents/library.js';import {modelOf} from '../src/desktop/docmodel.js';import {registerDocumentIpc} from '../src/desktop/documents-ipc.js';
test('vault projection identifies its private kind and generic tree creation offers folders but rejects new connections',async()=>{
 const lib=new DocumentLibrary({kdf:{logN:14,r:8,p:1}});const dir=await mkdtemp(join(tmpdir(),'c2-vault-ui-'));const vault=await lib.createVault(join(dir,'vault.rwdoc'),'Private','pw');const workspace=await lib.create(join(dir,'workspace.rwdoc'),'Shared','pw');
 assert.equal((lib.snapshot(vault.id) as any).kind,'vault');assert.equal((modelOf(lib.snapshot(vault.id)) as any).kind,'vault');
 const handlers=new Map<string,Function>();registerDocumentIpc({ipc:{handle:(n:string,fn:Function)=>{handlers.set(n,fn);}},check:()=>{},library:lib,dialogs:{} as any});
 const add=(id:string,type:string)=>handlers.get('documents:add')!({}, {id,parentId:null,type,name:'Fixture',props:type==='connection'?{protocol:'rdp',host:'example.invalid',username:'lab',port:3389}:{}});
 assert.equal((await add(vault.id,'connection')).ok,false);assert.equal((await add(vault.id,'folder')).ok,true);assert.equal((await add(workspace.id,'connection')).ok,true);
 assert.equal(Object.values(lib.privateDocument(vault.id).doc.objects).filter(n=>n.type==='connection').length,0);lib.closeAll();
});
