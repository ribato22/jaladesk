import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {DocumentLibrary} from '../src/documents/library.js';import {OverrideService} from '../src/desktop/override-service.js';import {StoredConnections} from '../src/desktop/connections.js';
for(const change of ['lock','edit'] as const)test(`a pending stored connection refuses a public-only overlay ${change} before opening its engine`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'c2-overlay-race-'));const lib=new DocumentLibrary({kdf:{logN:14,r:8,p:1}});const d=await lib.create(join(dir,'shared.rwdoc'),'Shared','pw');const n=lib.add(d.id,{type:'connection',name:'Host',parentId:null,props:{protocol:'rdp',host:'example.invalid',username:'lab'}}).objectId;
 const overlay=await OverrideService.load(lib,{path:join(dir,'private.rwdoc'),options:{kdf:{logN:14,r:8,p:1}},askPassword:async()=> 'pw',prompt:async()=>undefined,confirmDirty:async()=> 'save'});await overlay.create();
 const ref=()=>({id:d.id,objectId:n,expectedSeq:lib.view(d.id).seq});await overlay.set({...ref(),overlaySeq:overlay.state().seq,group:'color',inherit:false,value:'blue'});await overlay.save({expectedSeq:overlay.state().seq});
 let entered!:()=>void,release!:(value:any)=>void;const reached=new Promise<void>(r=>entered=r),answer=new Promise<any>(r=>release=r);let opened=0;
 const stored=new StoredConnections({library:lib,layers:r=>overlay.layers({id:r.documentHandle,objectId:r.objectId}),privateSources:()=>overlay.privateSources(),approveScope:async()=>true,prompt:async()=>{entered();return answer;},open:async()=>{opened++;return 'forbidden';}});
 const pending=stored.openStored({documentHandle:d.id,objectId:n,expectedSeq:lib.view(d.id).seq});await reached;
 if(change==='lock')await overlay.lock();else await overlay.set({...ref(),overlaySeq:overlay.state().seq,group:'color',inherit:false,value:'red'});
 release({username:'lab',domain:'',password:'SYNTHETIC'});await assert.rejects(pending,(e:any)=>e.code==='stale'||e.code==='locked');assert.equal(opened,0);await overlay.disable();lib.closeAll();
});
