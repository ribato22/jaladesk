import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentLibrary } from '../src/documents/library.js';
import { TemplateService } from '../src/desktop/template-service.js';
import { OverrideService } from '../src/desktop/override-service.js';
import type { Doc2, ObjectNode } from '../src/documents/model.js';

const canary = 'PRIVATE-TEMPLATE-CANARY';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'c2-template-')), library = new DocumentLibrary({ kdf: { logN: 14, r: 8, p: 1 } });
  const summary = await library.create(join(dir, 'test.rwdoc'), 'Test', 'pw');
  const node: ObjectNode = { id:id(3),type:'connection',name:'Server',parentId:null,order:0,props:{protocol:'rdp',host:'original.example',port:4321,username:'user',opaque:canary,groups:{customField1:'value',credentials:{mode:'inline',secretId:id(10)}}} };
  library.changePrivate(summary.id,0,doc=>{ doc.objects[node.id]=node; doc.secrets[id(10)]={kind:'credential',username:'u',domain:'',password:canary}; });
  const opened:ObjectNode[]=[];
  const deps={ openAdHoc:async(node:ObjectNode)=>{opened.push(node);return{sessionId:'temporary',label:node.name,publicTarget:{host:String(node.props.host),port:Number(node.props.port),username:'u'}}; } };
  const service=new TemplateService(library,deps);
  const request=()=>({id:summary.id,expectedSeq:library.view(summary.id).seq,objectId:node.id,name:'Template'});
  return{library,summary,node,opened,deps,service,request};
}

test('capture stores a detached hidden template and safe list with no secret data',async()=>{
  const f=await fixture();const result=await f.service.capture(f.request());
  assert.equal(f.library.node(f.summary.id,result.templateId)?.type,'template');
  const list=f.service.list();assert.deepEqual(list,[{handle:f.summary.id,id:result.templateId,name:'Template',roots:1}]);
  assert.equal(JSON.stringify(result).includes(canary),false);assert.equal(JSON.stringify(list).includes(canary),false);
  const stored=JSON.parse(String(f.library.node(f.summary.id,result.templateId)!.props.snapshot));
  assert.equal(JSON.stringify(stored).includes(canary),false);assert.equal(JSON.stringify(stored).includes(id(10)),false);
  assert.equal(f.library.snapshot(f.summary.id).objects.some(n=>n.id===result.templateId),false);f.library.closeAll();
});

test('apply clones new UUIDs, public values and preserves template after source edit',async()=>{
  const f=await fixture();const made=await f.service.capture(f.request());
  f.library.update(f.summary.id,f.node.id,{patch:{set:{host:'changed.example'}}});
  const applied=f.service.apply({id:f.summary.id,expectedSeq:f.library.view(f.summary.id).seq,templateHandle:f.summary.id,templateId:made.templateId,name:'New'});
  const created=f.library.node(f.summary.id,applied.objectIds[0]!)!;
  assert.notEqual(created.id,f.node.id);assert.equal(created.name,'New');assert.equal(created.props.host,'original.example');assert.equal((created.props.groups as any).credentials,undefined);
  assert.throws(()=>f.service.apply({id:f.summary.id,expectedSeq:0,templateHandle:f.summary.id,templateId:made.templateId}),{code:'stale'});f.library.closeAll();
});

test('reference copy requires a human main decision and rechecks hidden generations',async()=>{
  const f=await fixture();const vault=await f.library.createVault(join(await mkdtemp(join(tmpdir(),'c2-template-vault-')),'vault.rwdoc'),'Vault','pw');
  const credential=f.library.writeCredential(vault.id,{name:'Private',record:{kind:'credential',username:'u',domain:'',password:canary}});
  f.library.writeGroup(f.summary.id,{objectId:f.node.id,group:'credentials',inherit:false,value:{mode:'id',vaultId:vault.docId,credentialId:credential.objectId}});
  let allow=false;const asks:any[]=[];
  const service=new TemplateService(f.library,{...f.deps,confirmReferences:async request=>{asks.push(request);return allow;}});
  await assert.rejects(service.capture({...f.request(),copyReferences:true}),{code:'scope-denied'});assert.equal(service.list().length,0);
  allow=true;const made=await service.capture({...f.request(),copyReferences:true});assert.equal(asks.length,2);assert.equal(JSON.stringify(asks).includes(canary),false);
  let entered:()=>void=()=>{},release:(v:boolean)=>void=()=>{};const waiting=new Promise<void>(r=>{entered=r;});
  const delayed=new TemplateService(f.library,{...f.deps,confirmReferences:()=>new Promise<boolean>(r=>{release=r;entered();})});
  const pending=delayed.capture({...f.request(),copyReferences:true});await waiting;
  f.library.writeCredential(vault.id,{objectId:credential.objectId,name:'Changed',record:{kind:'credential',username:'u',domain:'',password:canary}});
  release(true);await assert.rejects(pending,{code:'stale'});assert.equal(delayed.list().length,1);assert.ok(made.templateId);f.library.closeAll();
});

test('ad-hoc expands only typed fields then opens without document, dirty or file mutation',async()=>{
  const f=await fixture();f.library.update(f.summary.id,f.node.id,{patch:{set:{host:'$Host$',port:4321,notes:'$Description$'}}});
  const made=await f.service.capture(f.request());const before=JSON.stringify(f.library.privateDocument(f.summary.id));const disk=await readFile(f.summary.path);
  const result=await f.service.adHoc({templateHandle:f.summary.id,templateId:made.templateId,values:{Host:'temporary.example',Description:'new notes'}});
  assert.equal(result.sessionId,'temporary');assert.equal(f.opened[0]!.props.host,'temporary.example');assert.equal(f.opened[0]!.props.notes,'new notes');
  assert.equal(JSON.stringify(f.library.privateDocument(f.summary.id)),before);assert.deepEqual(await readFile(f.summary.path),disk);
  await assert.rejects(f.service.adHoc({templateHandle:f.summary.id,templateId:made.templateId,values:{Password:canary}}),{code:'invalid'});
  await assert.rejects(f.service.adHoc({templateHandle:f.summary.id,templateId:made.templateId,values:{Host:'bad host'}}));f.library.closeAll();
});

test('apply resolves public typed token fields before one atomic working-copy change',async()=>{
  const f=await fixture();
  f.library.update(f.summary.id,f.node.id,{name:'$Name$',patch:{set:{host:'$Host$',notes:'$Description$'}}});
  const made=await f.service.capture(f.request());
  const input={id:f.summary.id,expectedSeq:f.library.view(f.summary.id).seq,templateHandle:f.summary.id,templateId:made.templateId,values:{Host:'resolved.example',Name:'Resolved',Description:'description'}};
  const applied=f.service.apply(input as any);const node=f.library.node(f.summary.id,applied.objectIds[0]!)!;
  assert.equal(node.props.host,'resolved.example');assert.equal(node.name,'Resolved');assert.equal(node.props.notes,'description');
  const before=JSON.stringify(f.library.privateDocument(f.summary.id));
  assert.throws(()=>f.service.apply({...input,expectedSeq:f.library.view(f.summary.id).seq,values:{Host:'bad host'}} as any));
  assert.equal(JSON.stringify(f.library.privateDocument(f.summary.id)),before);f.library.closeAll();
});

test('forged keys, template types, missing objects and oversized snapshots are refused atomically',async()=>{
  const f=await fixture();const count=f.library.size(f.summary.id);
  for(const request of [{...f.request(),allowedCredentialDocumentIds:[id(99)]},{...f.request(),password:canary},{...f.request(),copyReferences:'yes'}]) await assert.rejects(f.service.capture(request as any),{code:'invalid'});
  assert.equal(f.library.size(f.summary.id),count);
  assert.throws(()=>f.service.apply({id:f.summary.id,expectedSeq:f.library.view(f.summary.id).seq,templateHandle:f.summary.id,templateId:f.node.id}),{code:'invalid'});
  f.library.changePrivate(f.summary.id,f.library.view(f.summary.id).seq,doc=>{doc.objects[f.node.id]!.props.groups={customField1:'x'.repeat(65536)};});
  await assert.rejects(f.service.capture(f.request()),{code:'too-large'});assert.equal(f.library.size(f.summary.id),count);f.library.closeAll();
});

test('remove deletes only the selected hidden template and rejects stale source document',async()=>{
  const f=await fixture();const made=await f.service.capture(f.request());const before=f.library.size(f.summary.id);
  const result=f.service.remove({id:f.summary.id,expectedSeq:f.library.view(f.summary.id).seq,templateId:made.templateId});
  assert.equal(f.library.size(f.summary.id),before-1);assert.ok(f.library.node(f.summary.id,f.node.id));assert.equal(f.library.node(f.summary.id,made.templateId),undefined);assert.equal(JSON.stringify(result).includes(canary),false);
  assert.throws(()=>f.service.remove({id:f.summary.id,expectedSeq:f.library.view(f.summary.id).seq,templateId:f.node.id}),{code:'invalid'});f.library.closeAll();
});

test('vaults never receive a new template or connection from template application',async()=>{
  const f=await fixture(),made=await f.service.capture(f.request());const vault=await f.library.createVault(join(await mkdtemp(join(tmpdir(),'c2-template-kind-')),'vault.rwdoc'),'Vault','pw');
  assert.throws(()=>f.service.apply({id:vault.id,expectedSeq:0,templateHandle:f.summary.id,templateId:made.templateId}),{code:'invalid'});
  await assert.rejects(f.service.capture({...f.request(),id:vault.id,expectedSeq:0}),{code:'invalid'});f.library.closeAll();
});

async function overlayFixture() {
  const f = await fixture();
  f.library.writeGroup(f.summary.id,{objectId:f.node.id,group:'color',inherit:false,value:'blue'});
  const overrides = await OverrideService.load(f.library,{path:join(await mkdtemp(join(tmpdir(),'c2-template-overlay-')),'private.rwdoc'),options:{kdf:{logN:14,r:8,p:1}},askPassword:async()=>'private-password',prompt:async()=>({kind:'protected-value',value:canary}),confirmDirty:async()=>'save',confirmDisable:async()=>true});
  await overrides.create();
  const edit=async(objectId:string,color:string)=>overrides.set({id:f.summary.id,objectId,expectedSeq:f.library.view(f.summary.id).seq,overlaySeq:overrides.state().seq,group:'color',inherit:false,value:color});
  await edit(f.node.id,'red');
  const layers=(ref:{documentHandle:string;objectId:string;expectedSeq:number})=>overrides.layers({id:ref.documentHandle,objectId:ref.objectId,expectedSeq:ref.expectedSeq});
  return{...f,overrides,layers,edit};
}

test('template snapshots use active trusted override values only after a safe human export decision',async()=>{
  const f=await overlayFixture(),asks:any[]=[];
  await f.overrides.set({id:f.summary.id,objectId:f.node.id,expectedSeq:f.library.view(f.summary.id).seq,overlaySeq:f.overrides.state().seq,group:'customField11',inherit:false});
  const service=new TemplateService(f.library,{...f.deps,layers:f.layers,confirmPrivateValues:async(request:any)=>{asks.push(request);return true;}} as any);
  const made=await service.capture(f.request());
  const snapshot=JSON.parse(String(f.library.node(f.summary.id,made.templateId)!.props.snapshot));
  assert.equal(snapshot.objects[0].props.groups.color,'red');assert.equal(asks.length,1);
  assert.deepEqual(asks[0],{documentHandle:f.summary.id,objectId:f.node.id,name:'Server',count:1});
  assert.equal(JSON.stringify(asks).includes('red'),false);assert.equal(JSON.stringify(snapshot).includes(canary),false);assert.equal(JSON.stringify(snapshot).includes('customField11'),false);
  await f.overrides.lock();f.library.closeAll();
});

test('private override export is blocked without approval and expected locked overlays never fall back',async()=>{
  const f=await overlayFixture(),before=JSON.stringify(f.library.privateDocument(f.summary.id));
  const absent=new TemplateService(f.library,{...f.deps,layers:f.layers} as any);
  await assert.rejects(absent.capture(f.request()),{code:'scope-denied'});
  const refused=new TemplateService(f.library,{...f.deps,layers:f.layers,confirmPrivateValues:async()=>false} as any);
  await assert.rejects(refused.capture(f.request()),{code:'scope-denied'});assert.equal(JSON.stringify(f.library.privateDocument(f.summary.id)),before);
  await f.overrides.lock();
  const locked=new TemplateService(f.library,{...f.deps,layers:f.layers,confirmPrivateValues:async()=>true} as any);
  await assert.rejects(locked.capture(f.request()),{code:'locked'});assert.equal(JSON.stringify(f.library.privateDocument(f.summary.id)),before);f.library.closeAll();
});

test('subtree capture resolves each object through its own trusted override layer',async()=>{
  const f=await overlayFixture();
  f.library.changePrivate(f.summary.id,f.library.view(f.summary.id).seq,doc=>{doc.objects[id(2)]={id:id(2),type:'folder',name:'Folder',parentId:null,order:0,props:{groups:{color:'blue'}}};doc.objects[f.node.id]!.parentId=id(2);});
  await f.edit(id(2),'green');
  const refs:string[]=[];
  const service=new TemplateService(f.library,{...f.deps,layers:(ref:any)=>{refs.push(ref.objectId);return f.layers(ref);},confirmPrivateValues:async()=>true} as any);
  const made=await service.capture({...f.request(),objectId:id(2)});
  const snapshot=JSON.parse(String(f.library.node(f.summary.id,made.templateId)!.props.snapshot));
  assert.equal(snapshot.objects.find((n:any)=>n.name==='Folder').props.groups.color,'green');assert.equal(snapshot.objects.find((n:any)=>n.name==='Server').props.groups.color,'red');assert.ok(refs.includes(id(2)));assert.ok(refs.includes(f.node.id));
  await f.overrides.lock();f.library.closeAll();
});

test('override generations are rechecked after private export and credential-reference decisions',async()=>{
  for(const stage of ['references','private'] as const){
    const f=await overlayFixture();
    if(stage==='references'){
      const vault=await f.library.createVault(join(await mkdtemp(join(tmpdir(),'c2-template-ref-overlay-')),'vault.rwdoc'),'Vault','pw');
      const credential=f.library.writeCredential(vault.id,{name:'Private',record:{kind:'credential',username:'u',domain:'',password:canary}});
      f.library.writeGroup(f.summary.id,{objectId:f.node.id,group:'credentials',inherit:false,value:{mode:'id',vaultId:vault.docId,credentialId:credential.objectId}});
    }
    let reached:()=>void=()=>{},release:(value:boolean)=>void=()=>{};
    const entered=new Promise<void>(resolve=>{reached=resolve;});const answer=()=>new Promise<boolean>(resolve=>{release=resolve;reached();});
    const service=new TemplateService(f.library,{...f.deps,layers:f.layers,confirmPrivateValues:stage==='private'?answer:async()=>true,confirmReferences:stage==='references'?answer:async()=>true} as any);
    const before=JSON.stringify(f.library.privateDocument(f.summary.id)),pending=service.capture({...f.request(),copyReferences:stage==='references'});
    await entered;await f.edit(f.node.id,'green');release(true);
    await assert.rejects(pending,{code:'stale'});assert.equal(JSON.stringify(f.library.privateDocument(f.summary.id)),before);
    await f.overrides.lock();f.library.closeAll();
  }
});

test('one-use named expressions apply typed public tokens without altering the stored template',async()=>{
  const f=await fixture(),made=await f.service.capture(f.request());
  const before=JSON.stringify(f.library.node(f.summary.id,made.templateId));
  const input={id:f.summary.id,expectedSeq:f.library.view(f.summary.id).seq,templateHandle:f.summary.id,templateId:made.templateId,fields:{Name:'$Name$ Ω',Host:'$Host$',Port:'$Port$',UserName:'$UserName$',Description:'$Description$'},values:{Name:'Instance',Host:'expression.example',Port:3390,UserName:'alternate',Description:'one use'}};
  const applied=f.service.apply(input as any),node=f.library.node(f.summary.id,applied.objectIds[0]!)!;
  assert.equal(node.name,'Instance Ω');assert.equal(node.props.host,'expression.example');assert.equal(node.props.port,3390);assert.equal(node.props.username,'alternate');assert.equal(node.props.notes,'one use');
  assert.equal(JSON.stringify(f.library.node(f.summary.id,made.templateId)),before);
  const state=JSON.stringify(f.library.privateDocument(f.summary.id));
  await f.service.adHoc({templateHandle:f.summary.id,templateId:made.templateId,fields:{Name:'$Name$',Host:'$EffectiveHost$',Port:4322,UserName:'$UserName$'},values:{Name:'$Host$',UserName:'temporary-user',Host:'ignored.example'}} as any);
  assert.equal(f.opened[0]!.name,'$Host$');assert.equal(f.opened[0]!.props.host,'original.example');assert.equal(f.opened[0]!.props.port,4322);assert.equal(f.opened[0]!.props.username,'temporary-user');
  assert.equal(JSON.stringify(f.library.privateDocument(f.summary.id)),state);f.library.closeAll();
});

test('one-use expressions affect connections only and reject invalid types or secret taint before mutation',async()=>{
  const f=await fixture();
  f.library.changePrivate(f.summary.id,f.library.view(f.summary.id).seq,doc=>{doc.objects[id(2)]={id:id(2),type:'folder',name:'Folder',parentId:null,order:0,props:{}};doc.objects[f.node.id]!.parentId=id(2);});
  const made=await f.service.capture({...f.request(),objectId:id(2)});
  const input={id:f.summary.id,expectedSeq:f.library.view(f.summary.id).seq,templateHandle:f.summary.id,templateId:made.templateId,name:'New folder',fields:{Name:'$Name$',Host:'next.example',Port:'$Port$'},values:{Name:'New child',Port:4323}};
  const applied=f.service.apply(input as any),folder=f.library.node(f.summary.id,applied.objectIds[0]!)!;
  assert.equal(folder.name,'New folder');assert.deepEqual(folder.props,{});
  const child=Object.values(f.library.privateDocument(f.summary.id).doc.objects).find(node=>node.parentId===folder.id)!;
  assert.equal(child.name,'New child');assert.equal(child.props.host,'next.example');assert.equal(child.props.port,4323);
  for(const fields of [{Password:canary},{Host:{kind:'secret-ref',secretId:canary}},{Host:'$Password$'},{Host:'bad host'},{Port:'4321'},{Port:1.5},{Name:2},{Description:'x'.repeat(65537)},{UserName:'x'.repeat(257)}]){
    const before=JSON.stringify(f.library.privateDocument(f.summary.id));
    assert.throws(()=>f.service.apply({...input,expectedSeq:f.library.view(f.summary.id).seq,fields} as any),(error:any)=>!error.message.includes(canary));
    assert.equal(JSON.stringify(f.library.privateDocument(f.summary.id)),before);
  }
  f.library.closeAll();
});
