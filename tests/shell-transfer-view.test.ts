import test from 'node:test';import assert from 'node:assert/strict';
import {transferPreviewText,transferResultText,transferPreviewRequest,initTransfer,type TransferPreview,type TransferSource} from '../src/desktop/transfer-ui.js';
import type {ConfigHost} from '../src/desktop/credentials-ui.js';
const source='00000000-0000-4000-8000-000000000001',destination='00000000-0000-4000-8000-000000000002',object='00000000-0000-4000-8000-000000000003',folder='00000000-0000-4000-8000-000000000004';
const preview:TransferPreview={planId:'opaque-plan',expiresAt:60000,count:3,containsSecrets:true,containsPrivateData:true,externalReferences:2,missingReferences:1,unavailableSources:1,inheritanceMayChange:2,privateOverridesCopied:false,canApply:false,requiresPrivateConsent:true};
const sources:TransferSource[]=[{id:source,name:'Sumber',seq:4,objects:[{id:object,name:'Objek',type:'connection',parentId:null}]},{id:destination,name:'Tujuan',seq:8,objects:[{id:folder,name:'Folder',type:'folder',parentId:null}]}];
test('preview renders only counts and private/reference/default impacts with a clear opt-in instruction',()=>{
 const text=transferPreviewText({...preview,privatePayload:'PRIVATE-CANARY'} as TransferPreview);assert.match(text,/3 objek/);assert.match(text,/Secret terenkripsi: ada/);assert.match(text,/Data privat\/opaque: ada/);assert.match(text,/Referensi hilang: 1/);assert.match(text,/Override privat tidak ikut/);assert.match(text,/Buat preview baru/);assert.ok(!text.includes('PRIVATE-CANARY'));assert.ok(!text.includes('opaque-plan'));
});
class Field{
 textContent='';checked=false;disabled=false;hidden=false;open=false;multiple=false;selected=false;options:Field[]=[];attributes=new Map<string,string>();onclick?:()=>unknown;onchange?:()=>unknown;oncancel?:(event:{preventDefault():void})=>void;onclose?:()=>void;private current='';
 constructor(readonly id:string,private doc:FakeDoc){}get value(){return this.current;}set value(value:string){this.current=value;for(const o of this.options)o.selected=o.value===value;}get selectedOptions(){return this.options.filter(o=>o.selected);}
 replaceChildren(...children:Field[]){this.options=children;this.current=children[0]?.value??'';for(const o of children)o.selected=!this.multiple&&o.value===this.current;}
 setAttribute(name:string,value:string){this.attributes.set(name,value);}getAttribute(name:string){return this.attributes.get(name)??null;}removeAttribute(name:string){this.attributes.delete(name);}showModal(){this.open=true;}close(){this.open=false;this.onclose?.();}focus(){this.doc.focused=this.id;}
}
class FakeDoc{fields=new Map<string,Field>();focused='';getElementById(id:string){let f=this.fields.get(id);if(!f){f=new Field(id,this);this.fields.set(id,f);}return f;}createElement(_tag:string){return new Field('',this);}}
type Runner=(action:string,input:any)=>Promise<any>;
function harness(run?:Runner){
 const doc=new FakeDoc(),calls:{action:string;input:any}[]=[];const prior=(globalThis as any).window;let refreshes=0;
 const docs=structuredClone(sources);docs[0]!.objects.push({id:folder,name:'Identitas tersembunyi',type:'credential',parentId:null});
 (globalThis as any).window={workspace:{run:async(action:string,input:any)=>{calls.push({action,input:structuredClone(input)});if(run)return run(action,input);if(action==='transfer.sources')return{ok:true,value:structuredClone(docs)};if(action==='transfer.preview')return{ok:true,value:{...preview,canApply:!!input.copyPrivate,requiresPrivateConsent:!input.copyPrivate}};if(action==='transfer.apply')return{ok:true,value:{destination:'verified',sourceDisk:'retained',sourceMemory:'removal-pending',stage:'source-write',status:'partial',errorCode:'PRIVATE-IO-CANARY'}};return{ok:true,value:{cancelled:true}};}}};
 const host:ConfigHost={selected:()=>({id:source,expectedSeq:4,objectId:object,type:'connection',parentId:null}),refresh:async()=>{refreshes++;},revealSource:()=>{},opened:()=>{}};
 const controller=initTransfer(host,doc as unknown as Document);
 return{doc,controller,calls,docs,field:(name:string)=>doc.getElementById(name==='obj-transfer'?name:'transfer-'+name),refreshes:()=>refreshes,restore:()=>{(globalThis as any).window=prior;}};
}
async function chooseDestination(h:ReturnType<typeof harness>){h.field('destination').value=destination;await h.field('destination').onchange!();h.field('parent').value=folder;}
test('controller preselects only the current source object and requires private opt-in followed by a fresh preview',async()=>{
 const h=harness();try{
  await h.controller.open();assert.equal(h.field('dialog').open,true);assert.equal(h.field('source').value,source);assert.deepEqual(h.field('objects').selectedOptions.map(o=>o.value),[object]);assert.equal(h.field('objects').options.some(o=>o.textContent.includes('Identitas tersembunyi')),true);assert.equal(h.field('destination').value,'');assert.equal(h.field('copy-private').checked,false);assert.equal(h.field('apply').disabled,true);assert.equal(h.calls.some(c=>c.action==='transfer.apply'),false);
  await chooseDestination(h);await h.field('preview').onclick!();assert.equal(h.field('apply').disabled,true);assert.match(h.field('preview-summary').textContent,/Buat preview baru/);h.field('copy-private').checked=true;h.field('copy-private').onchange!();assert.equal(h.field('apply').disabled,true);await h.field('preview').onclick!();assert.equal(h.field('apply').disabled,false);
  assert.deepEqual(h.calls.filter(c=>c.action==='transfer.preview')[0]?.input,{sourceId:source,sourceSeq:4,destinationId:destination,destinationSeq:8,objectIds:[object],parentId:folder,mode:'copy',copyPrivate:false});
 }finally{h.restore();}
});
test('Apply sends the token alone, displays partial disk/memory phases and requires a new preview',async()=>{
 const h=harness();try{await h.controller.open();await chooseDestination(h);h.field('copy-private').checked=true;h.field('copy-private').onchange!();await h.field('preview').onclick!();await h.field('apply').onclick!();assert.deepEqual(h.calls.find(c=>c.action==='transfer.apply')?.input,{planId:'opaque-plan'});assert.match(h.field('result').textContent,/Sumber di memory: Penghapusan belum selesai/);assert.match(h.field('result').textContent,/Tujuan: Tersimpan dan terverifikasi/);assert.ok(!h.field('result').textContent.includes('PRIVATE-IO-CANARY'));assert.equal(h.field('apply').disabled,true);await h.field('apply').onclick!();assert.equal(h.calls.filter(c=>c.action==='transfer.apply').length,1);assert.equal(h.refreshes(),1);
 }finally{h.restore();}
});
test('Escape during Apply requests cancellation without closing or cleaning up the destination',async()=>{
 let finish!:(value:any)=>void;const gate=new Promise<any>(resolve=>{finish=resolve;});const h=harness(async(action,input)=>action==='transfer.sources'?{ok:true,value:structuredClone(sources)}:action==='transfer.preview'?{ok:true,value:{...preview,canApply:true,requiresPrivateConsent:false}}:action==='transfer.apply'?gate:{ok:true,value:{requested:true}});
 try{await h.controller.open();await chooseDestination(h);await h.field('preview').onclick!();const applying=h.field('apply').onclick!();for(let i=0;i<8;i++)await Promise.resolve();let prevented=false;h.field('dialog').oncancel!({preventDefault:()=>{prevented=true;}});for(let i=0;i<8;i++)await Promise.resolve();assert.equal(prevented,true);assert.equal(h.field('dialog').open,true);assert.deepEqual(h.calls.find(c=>c.action==='transfer.cancel')?.input,{planId:'opaque-plan'});assert.equal(h.calls.filter(c=>/rollback|remove|cleanup/.test(c.action)).length,0);
  finish({ok:true,value:{status:'cancelled',destination:'verified',sourceDisk:'retained',sourceMemory:'unchanged',stage:'move-cancelled'}});await applying;assert.equal(h.field('dialog').open,true);assert.match(h.field('result').textContent,/Salinan tujuan dipertahankan/);assert.equal(h.field('apply').disabled,true);
 }finally{h.restore();}
});
test('a stale preview is an accessible error and Cancel before Apply closes without any mutation',async()=>{
 const h=harness(async(action,input)=>action==='transfer.sources'?{ok:true,value:structuredClone(sources)}:{ok:false,code:'stale',message:'Data berubah; muat ulang sumber.'});
 try{await h.controller.open();await chooseDestination(h);await h.field('preview').onclick!();assert.equal(h.field('error').getAttribute('role'),'alert');assert.match(h.field('error').textContent,/muat ulang/);assert.equal(h.field('dialog').open,true);await h.field('cancel').onclick!();assert.equal(h.field('dialog').open,false);assert.equal(h.doc.focused,'obj-transfer');assert.equal(h.calls.some(c=>c.action==='transfer.apply'||c.action==='transfer.cancel'),false);
 }finally{h.restore();}
});
test('a move blocked by source references shows the impact count and requires Copy or a new reviewed preview',async()=>{
 const h=harness(async(action,input)=>action==='transfer.sources'?{ok:true,value:structuredClone(sources)}:action==='transfer.preview'?{ok:true,value:{...preview,canApply:false,requiresPrivateConsent:false,sourceReferencesAffected:2,sourceCanRemove:false,blockedReason:'source-references'}}:{ok:true,value:{}});
 try{await h.controller.open();await chooseDestination(h);h.field('mode').value='move';h.field('mode').onchange!();await h.field('preview').onclick!();assert.equal(h.field('apply').disabled,true);assert.match(h.field('preview-summary').textContent,/Referensi pada sumber terdampak: 2/);assert.match(h.field('preview-summary').textContent,/referensi yang tidak dipilih tidak diubah/);assert.match(h.field('preview-summary').textContent,/Pilih Salin/);assert.equal(h.calls.some(c=>c.action==='transfer.apply'),false);
 }finally{h.restore();}
});
test('result labels disk and memory separately and never renders raw diagnostic codes',()=>{
 const text=transferResultText({destination:'verified',sourceDisk:'retained',sourceMemory:'removal-pending',stage:'source-write',status:'partial',errorCode:'PRIVATE-IO-CANARY'});assert.match(text,/Tujuan: Tersimpan dan terverifikasi/);assert.match(text,/Sumber di disk: Dipertahankan/);assert.match(text,/Sumber di memory: Penghapusan belum selesai/);assert.ok(!text.includes('PRIVATE-IO-CANARY'));assert.match(text,/Fase terakhir: Menyimpan penghapusan sumber/);const uncertain=transferResultText({destination:'uncertain',sourceDisk:'retained',sourceMemory:'unchanged',stage:'destination-uncertain'});assert.match(uncertain,/Status penyimpanan tujuan belum pasti/);assert.match(uncertain,/Tidak ada penghapusan sumber bila tujuan belum terverifikasi/);assert.match(transferResultText({destination:'verified',sourceDisk:'uncertain',sourceMemory:'removal-pending',stage:'source-uncertain'}),/Status penyimpanan sumber belum pasti/);
 assert.match(transferResultText({destination:'verified',sourceDisk:'retained',sourceMemory:'unchanged',stage:'move-cancelled',status:'cancelled'}),/Salinan tujuan dipertahankan/);
});
test('preview request uses selected metadata references and requires existing distinct targets without private values',()=>{
 const values:Record<string,string>={'transfer-source':source,'transfer-destination':destination,'transfer-parent':folder,'transfer-mode':'copy'};const read=(id:string)=>values[id]??'';
 assert.deepEqual(transferPreviewRequest(sources,read,()=>false,()=>[object,object]),{sourceId:source,sourceSeq:4,destinationId:destination,destinationSeq:8,objectIds:[object],parentId:folder,mode:'copy',copyPrivate:false});
 values['transfer-destination']=source;assert.throws(()=>transferPreviewRequest(sources,read,()=>false,()=>[object]));values['transfer-destination']=destination;assert.throws(()=>transferPreviewRequest(sources,read,()=>false,()=>[]));assert.throws(()=>transferPreviewRequest(sources,read,()=>false,()=>['foreign-object']));values['transfer-parent']=object;assert.throws(()=>transferPreviewRequest(sources,read,()=>false,()=>[object]));
});
