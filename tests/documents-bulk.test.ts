import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBatch, mixedPublicField, selectedConnections, type BulkAction } from '../src/documents/bulk.js';
import { validateDocument, type Doc2 } from '../src/documents/model.js';
import { captureTemplate, instantiateTemplate } from '../src/documents/templates.js';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const fresh=()=>{let n=1000;return()=>id(++n);};
function fixture():Doc2{return{schemaVersion:2,id:id(1),kind:'workspace',name:'synthetic',revision:7,meta:{createdAt:null,updatedAt:null,sort:[]},defaults:{groups:{color:'blue'}},secrets:{[id(6)]:{kind:'credential',username:'synthetic',domain:'',password:'SYNTHETIC-ONLY'}},objects:{
 [id(2)]:{id:id(2),type:'folder',name:'parent',parentId:null,order:0,props:{}},
 [id(3)]:{id:id(3),type:'connection',name:'first',parentId:id(2),order:9,props:{protocol:'rdp',host:'first.invalid',notes:'keep',clipboardToRemote:true,futureOpaque:{retained:'literal'}}},
 [id(4)]:{id:id(4),type:'connection',name:'second',parentId:id(2),order:30,props:{protocol:'rdp',host:'second.invalid'}},
 [id(5)]:{id:id(5),type:'credential',name:'fixture credential',parentId:null,order:1,props:{secretId:id(6)}}
 }};}
const create=(name='new',parentId:string|null=id(2)):BulkAction=>({kind:'create',parentId,type:'connection',name,props:{protocol:'rdp',host:'new.invalid'}});

test('one batch preserves untouched identities, appends after sparse orders and detaches changed props',()=>{
 const doc=fixture(),before=structuredClone(doc),action=create();const result=applyBatch(doc,[{kind:'update',objectId:id(3),patch:{set:{notes:'changed',clipboardToRemote:false},unset:['host']}},action],{newId:fresh()});
 assert.notEqual(result.doc,doc);assert.notEqual(result.doc.objects,doc.objects);assert.equal(result.doc.objects[id(2)],doc.objects[id(2)]);assert.equal(result.doc.objects[id(4)],doc.objects[id(4)]);assert.equal(result.doc.secrets,doc.secrets);assert.equal(result.doc.defaults,doc.defaults);assert.equal(result.doc.revision,7);assert.deepEqual(result.createdIds,[id(1001)]);assert.equal(result.doc.objects[id(1001)].order,31);assert.equal(result.change.upsert.length,2);assert.deepEqual(result.change.remove,[]);assert.equal(result.doc.objects[id(3)].props.clipboardToRemote,false);assert.equal(Object.hasOwn(result.doc.objects[id(3)].props,'host'),false);assert.deepEqual(result.doc.objects[id(3)].props.futureOpaque,{retained:'literal'});(action as any).props.host='after.invalid';assert.equal(result.doc.objects[id(1001)].props.host,'new.invalid');assert.deepEqual(doc,before);validateDocument(result.doc);
});
test('invalid last action and failed full reference closure publish nothing and leave every original node intact',()=>{
 const doc=fixture(),before=structuredClone(doc);assert.throws(()=>applyBatch(doc,[create(),{kind:'update',objectId:id(999),patch:{set:{notes:'bad'}}}],{newId:fresh()}));
 assert.throws(()=>applyBatch(doc,[create(),{kind:'create',parentId:null,type:'connection',name:'bad ref',props:{groups:{credentials:{mode:'id',vaultId:doc.id,credentialId:id(999)}}}}],{newId:fresh()}));assert.deepEqual(doc,before);
});
test('generated UUID collisions with objects, secrets, a prior allocation or malformed UUID fail closed',()=>{
 for(const allocation of [()=>id(3),()=>id(6),()=>id(1001),()=> 'invalid']){const doc=fixture(),before=structuredClone(doc);assert.throws(()=>applyBatch(doc,[create(),create('other')],{newId:allocation}));assert.deepEqual(doc,before);}
});
test('bulk parents are existing folders only; a new parent and hidden object targets are rejected',()=>{
 const doc=fixture(),before=structuredClone(doc);for(const actions of [
 [{kind:'create',parentId:null,type:'folder',name:'new parent'},{kind:'create',parentId:id(1001),type:'connection',name:'new child'}],
 [create('bad parent',id(3))],[{kind:'update',objectId:id(5),name:'credential change'}],
 [{kind:'create',parentId:null,type:'credential',name:'hidden'}],
 ])assert.throws(()=>applyBatch(doc,actions as BulkAction[],{newId:fresh()}));assert.deepEqual(doc,before);
});
test('strict update grammar refuses private fields, malformed patches, conflicting keys, unknown fields and invalid written metadata',()=>{
 const doc=fixture(),before=structuredClone(doc),bad:unknown[]=[null,{}, {kind:'delete',objectId:id(3)},
 {kind:'update',objectId:id(3),parentId:null},{kind:'update',objectId:id(3),patch:{extra:true}},
 ...[[],null,'bad'].map(patch=>({kind:'update',objectId:id(3),patch})),
 ...[{set:{groups:{credentials:{mode:'prompt'}}}},{set:{password:'RAW'}},{set:{notes:undefined}},{set:{port:NaN}},{set:{clipboardToRemote:'false'}},{unset:'host'},{unset:['groups']},{unset:['host','host']},{set:{host:'x'},unset:['host']},{set:{notes:'x'.repeat(4001)}},{set:{sort:[{by:'name',dir:'asc'}]}},{set:{color:'unlisted'}}].map(patch=>({kind:'update',objectId:id(3),patch})),
 {kind:'update',objectId:id(3),name:'  '},{kind:'create',parentId:null,type:'connection',name:''},{kind:'create',parentId:null,type:'connection',name:'x',id:id(1001)},
 ];for(const action of bad)assert.throws(()=>applyBatch(doc,[action] as BulkAction[],{newId:fresh()}),JSON.stringify(action));assert.deepEqual(doc,before);
});
test('an idempotent empty, same-value or unset-missing batch stays the same document and duplicate equal updates produce one change',()=>{
 const doc=fixture();for(const actions of [[],[{kind:'update',objectId:id(3),name:'first',patch:{set:{notes:'keep'},unset:['username']}}]]){const out=applyBatch(doc,actions as BulkAction[],{newId:fresh()});assert.equal(out.doc,doc);assert.deepEqual(out.change,{upsert:[],remove:[]});assert.deepEqual(out.createdIds,[]);}
 const action:BulkAction={kind:'update',objectId:id(3),patch:{set:{notes:'new'}}};const out=applyBatch(doc,[action,{kind:'update',objectId:id(3),patch:{set:{notes:'new'}}}],{newId:fresh()});assert.equal(out.change.upsert.length,1);assert.throws(()=>applyBatch(doc,[action,{kind:'update',objectId:id(3),patch:{set:{notes:'other'}}}],{newId:fresh()}));
});
test('10,000 actions use bounded original table passes and enforce action, object and depth bounds atomically',()=>{
 const doc=fixture(),actions=Array.from({length:10000},(_,i)=>create('new '+i));let scans=0;doc.objects=new Proxy(doc.objects,{ownKeys(target){scans++;return Reflect.ownKeys(target);}});const out=applyBatch(doc,actions,{newId:fresh()});assert.equal(out.createdIds.length,10000);assert.ok(scans<=6,`original table scanned ${scans} times`);assert.equal(new Set(out.createdIds).size,10000);assert.equal(out.doc.objects[id(11000)].order,10030);validateDocument(out.doc);
 assert.throws(()=>applyBatch(fixture(),[...actions,create()],{newId:fresh()}));assert.throws(()=>applyBatch(fixture(),[create()],{newId:fresh(),limits:{maxObjects:4}}));assert.throws(()=>applyBatch(fixture(),[create()],{newId:fresh(),limits:{maxDepth:1}}));
});
test('trusted Task7 expansion preserves frozen inherited values and opted-in external credential refs without copying secrets',()=>{
 const doc=fixture();doc.objects[id(2)].props={groups:{notes:'frozen parent'}};doc.objects[id(3)].props.groups={credentials:{mode:'id',vaultId:doc.id,credentialId:id(5)}};doc.objects[id(3)].props.inherit={notes:true};
 const snap=captureTemplate(doc,[id(3)],{documentGeneration:1},{copyCredentialReferences:true,allowedCredentialDocumentIds:[doc.id]}),expanded=instantiateTemplate(snap,doc,{parentId:id(2)}),node=expanded.doc.objects[expanded.objectIds[0]],before=structuredClone(snap);doc.objects[id(2)].props={groups:{notes:'changed parent'}};
 const out=applyBatch(doc,[{kind:'create',parentId:id(2),type:'connection',name:'expanded',props:node.props}],{newId:fresh()}),made=out.doc.objects[out.createdIds[0]];assert.equal((made.props.groups as any).notes,'frozen parent');assert.deepEqual((made.props.groups as any).credentials,{mode:'id',vaultId:doc.id,credentialId:id(5)});assert.equal(made.props.protocol,'rdp');assert.equal(out.doc.secrets,doc.secrets);assert.deepEqual(snap,before);(node.props.groups as any).notes='mutated after';assert.equal((made.props.groups as any).notes,'frozen parent');validateDocument(out.doc);
});
test('trusted creates still validate secret closure and never accept legacy plaintext secret fields',()=>{
 const doc=fixture();for(const props of [{password:'RAW'},{groups:{credentials:{mode:'inline',secretId:id(999)}}},{groups:{customField11:{secretId:id(999)}}},{groups:{preConnectTask:{documentId:doc.id,objectId:id(999)}}}])assert.throws(()=>applyBatch(doc,[{kind:'create',parentId:null,type:'connection',name:'bad',props:props as any}],{newId:fresh()}));
});
test('mixed fields keep unset, empty string and false distinct and return detached JSON values',()=>{
 const doc=fixture(),a=doc.objects[id(3)],b=doc.objects[id(4)];assert.deepEqual(mixedPublicField([a,b],'username'),{kind:'unset'});a.props.username='';assert.deepEqual(mixedPublicField([a,b],'username'),{kind:'mixed'});b.props.username='';assert.deepEqual(mixedPublicField([a,b],'username'),{kind:'value',value:''});a.props.clipboardToRemote=false;b.props.clipboardToRemote=false;assert.deepEqual(mixedPublicField([a,b],'clipboardToRemote'),{kind:'value',value:false});delete b.props.clipboardToRemote;assert.deepEqual(mixedPublicField([a,b],'clipboardToRemote'),{kind:'mixed'});a.props.sort=[{by:'name',dir:'asc'}];const value=mixedPublicField([a],'sort');(value as any).value[0].dir='desc';assert.equal((a.props.sort as any)[0].dir,'asc');for(const key of ['groups','password','futureOpaque'])assert.throws(()=>mixedPublicField([a],key));assert.throws(()=>mixedPublicField([],'notes'));
});
test('folder selection is ordered, descendant/ancestor duplicates are unique and at most 64 connections can be selected',()=>{
 const doc=fixture();assert.deepEqual(selectedConnections(doc,[id(3),id(2),id(3)]),[id(3),id(4)]);assert.deepEqual(selectedConnections(doc,[id(2),id(4)]),[id(3),id(4)]);assert.throws(()=>selectedConnections(doc,[id(5)]));assert.throws(()=>selectedConnections(doc,[id(999)]));for(let n=100;n<163;n++)doc.objects[id(n)]={id:id(n),type:'connection',name:'extra',parentId:id(2),order:n,props:{}};assert.throws(()=>selectedConnections(doc,[id(2)]));assert.throws(()=>selectedConnections(fixture(),Array(10001).fill(id(3))));
});

test('explicit null create props are invalid rather than silently treated as absent',()=>{
 assert.throws(()=>applyBatch(fixture(),[{kind:'create',parentId:null,type:'connection',name:'invalid',props:null}] as any,{newId:fresh()}));
});
test('explicit null unset lists are invalid rather than silently treated as absent',()=>{
 assert.throws(()=>applyBatch(fixture(),[{kind:'update',objectId:id(3),patch:{unset:null}}] as any,{newId:fresh()}));
});
