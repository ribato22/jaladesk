import test from 'node:test';import assert from 'node:assert/strict';
import {documentMetadataPatch,documentDateLabel,documentDefaultChange,initDocumentProperties,type DocumentMetadata} from '../src/desktop/document-properties-ui.js';
import type {ConfigHost} from '../src/desktop/credentials-ui.js';
const prefix='doc-properties-';
const meta:DocumentMetadata={name:'Dokumen lama',meta:{createdAt:null,updatedAt:'2026-10-24T00:00:00.000Z',sort:[{by:'name',dir:'asc'}]}};
test('metadata Apply sends only name or root-sort fields the user changed, never dates or defaults',()=>{
 const input:Record<string,string>={'name':'Dokumen baru','sort-by-1':'name','sort-dir-1':'asc','sort-by-2':'','sort-dir-2':'asc'};
 const read=(id:string)=>{assert.ok(Object.hasOwn(input,id.slice(prefix.length)),'metadata reads only name/sort fields');return input[id.slice(prefix.length)]!;};
 assert.deepEqual(documentMetadataPatch(meta,read),{name:'Dokumen baru'});input.name='Dokumen lama';assert.deepEqual(documentMetadataPatch(meta,read),{});input['sort-by-1']='';assert.deepEqual(documentMetadataPatch(meta,read),{sort:[]});assert.deepEqual(meta.meta.sort,[{by:'name',dir:'asc'}]);
});
class Field{
 textContent='';checked=false;hidden=false;disabled=false;open=false;selected=false;type='';attributes=new Map<string,string>();options:Field[]=[];onclick?:()=>unknown;onchange?:()=>unknown;oncancel?:(e:{preventDefault():void})=>void;onclose?:()=>void;private current='';
 constructor(readonly id:string,private owner:FakeDoc){}
 get value(){return this.current;}set value(value:string){this.current=value;for(const o of this.options)o.selected=o.value===value;}
 get selectedOptions(){return this.options.filter(o=>o.selected);}
 replaceChildren(...children:Field[]){this.options=children;this.current=children[0]?.value??'';for(const o of children)o.selected=o.value===this.current;}
 setAttribute(name:string,value:string){this.attributes.set(name,value);}removeAttribute(name:string){this.attributes.delete(name);}getAttribute(name:string){return this.attributes.get(name)??null;}
 showModal(){this.open=true;}close(){this.open=false;this.onclose?.();}focus(){this.owner.focused=this.id;}
}
class FakeDoc{
 fields=new Map<string,Field>();focused='';getElementById(id:string){let f=this.fields.get(id);if(!f){f=new Field(id,this);this.fields.set(id,f);}return f;}createElement(_tag:string){return new Field('',this);}
}
const handle='00000000-0000-4000-8000-000000000010',other='00000000-0000-4000-8000-000000000011';
const initial=()=>({id:handle,seq:7,name:'Dokumen satu',meta:{createdAt:null,updatedAt:'2026-10-24T00:00:00.000Z',sort:[]},defaults:{credentials:{mode:'id'},customField11:{hasValue:true}},propertiesVersion:'version-1'});
function harness(run?:(action:string,input:any)=>Promise<any>){
 const doc=new FakeDoc(),calls:{action:string;input:any}[]=[];let selected=handle,refreshes=0;const state=initial();const prior=(globalThis as any).window;
 (globalThis as any).window={workspace:{run:async(action:string,input:any)=>{calls.push({action,input:structuredClone(input)});if(run)return run(action,input);if(action==='properties.view')return{ok:true,value:structuredClone(state)};if(action==='credentials.list')return{ok:true,value:[{documentId:other,name:'Vault sintetis',credentials:[{id:handle,name:'Identitas',username:'lab',domain:''}]}]};return{ok:true,value:{}};}}};
 const host:ConfigHost={selected:()=>({id:selected,expectedSeq:7}),refresh:async()=>{refreshes++;},revealSource:()=>{},opened:()=>{}};
 const controller=initDocumentProperties(host,doc as unknown as Document);return{doc,controller,calls,state,host,field:(name:string)=>doc.getElementById(prefix+name),selectOther:()=>{selected=other;},refreshes:()=>refreshes,restore:()=>{(globalThis as any).window=prior;}};
}
test('property controller binds the opened document, keeps references blank and applies only changed metadata',async()=>{
 const h=harness();try{
  await h.controller.open();assert.equal(h.field('dialog').open,true);assert.equal(h.field('created').textContent,'Tidak diketahui');assert.equal(h.field('name').value,'Dokumen satu');assert.equal(h.field('default-group').options.length,30);assert.equal(h.field('default-identity').value,'');
  await h.field('save').onclick!();assert.equal(h.calls.filter(c=>c.action==='properties.apply').length,0,'unchanged metadata does not request a mutation');
  h.selectOther();h.field('name').value='Nama pengganti';await h.field('save').onclick!();assert.deepEqual(h.calls.find(c=>c.action==='properties.apply')?.input,{id:handle,expectedSeq:7,expectedPropertiesVersion:'version-1',patch:{name:'Nama pengganti'}});assert.equal(h.calls.filter(c=>c.action==='properties.default').length,0);assert.equal(h.refreshes(),1);
  h.field('close').onclick!();assert.equal(h.field('dialog').open,false);assert.equal(h.doc.focused,prefix+'open');
 }finally{h.restore();}
});
test('pending property mutation blocks duplicate requests and Escape, then a stale error remains accessible',async()=>{
 let reject!:()=>void;const gate=new Promise<any>(resolve=>{reject=()=>resolve({ok:false,code:'stale',message:'Data berubah; muat ulang sebelum menerapkan.'});});
 const h=harness(async(action,input)=>action==='properties.apply'?gate:action==='properties.view'?{ok:true,value:initial()}:{ok:true,value:[]});
 try{
  await h.controller.open();h.field('name').value='Draft';const pending=h.field('save').onclick!();await Promise.resolve();let prevented=false;h.field('dialog').oncancel!({preventDefault:()=>{prevented=true;}});assert.equal(prevented,true);await h.field('save').onclick!();assert.equal(h.calls.filter(c=>c.action==='properties.apply').length,1);
  reject();await pending;assert.equal(h.field('error').getAttribute('role'),'alert');assert.match(h.field('error').textContent,/muat ulang/);assert.equal(h.field('dialog').open,true);assert.equal(h.field('name').value,'Draft');h.field('close').onclick!();assert.equal(h.doc.focused,prefix+'open');
 }finally{h.restore();}
});
test('private default actions send decisions only, preserve the metadata draft and distinguish false from unset',async()=>{
 let state:any=initial();const h=harness(async(action,input)=>{
  if(action==='properties.view')return{ok:true,value:structuredClone(state)};if(action==='credentials.list')return{ok:true,value:[]};
  if(action==='properties.default'){state.seq++;state.propertiesVersion='version-'+state.seq;state.defaults.customField11=input.unset?undefined:{hasValue:input.value!==false};if(input.unset)delete state.defaults.customField11;return{ok:true,value:{seq:state.seq}};}return{ok:true,value:{}};
 });
 try{
  await h.controller.open();h.field('name').value='Draft nama belum diterapkan';h.field('default-group').value='customField11';h.field('default-group').onchange!();assert.match(h.field('default-current').textContent,/hasValue/);
  await h.field('default-inline').onclick!();assert.deepEqual(h.calls.filter(c=>c.action==='properties.default')[0]?.input,{id:handle,expectedSeq:7,expectedPropertiesVersion:'version-1',group:'customField11'});assert.equal(h.field('name').value,'Draft nama belum diterapkan');
  h.field('default-false').checked=true;await h.field('apply-default').onclick!();assert.equal(h.calls.filter(c=>c.action==='properties.default')[1]?.input.value,false);
  h.field('default-unset').checked=true;await h.field('apply-default').onclick!();const last=h.calls.filter(c=>c.action==='properties.default')[2]!.input;assert.equal(last.unset,true);assert.equal(Object.hasOwn(last,'value'),false);assert.equal(h.calls.some(c=>c.action==='properties.apply'),false);
  let prevented=false;h.field('dialog').oncancel!({preventDefault:()=>{prevented=true;}});assert.equal(prevented,false,'idle Escape may close the native dialog');h.field('dialog').close();assert.equal(h.doc.focused,prefix+'open');
 }finally{h.restore();}
});
test('default commands distinguish empty text, false and unset and never read a stored private value',()=>{
 const values:Record<string,string>={'default-value-kind':'string','default-value':''};const checks:Record<string,boolean>={};
 const read=(id:string)=>{assert.ok(!/password|secret|seed/.test(id));return values[id.slice(prefix.length)]??'';};const checked=(id:string)=>checks[id.slice(prefix.length)]??false;
 assert.deepEqual(documentDefaultChange('notes',read,checked,()=>[]),{group:'notes',value:''});values['default-value-kind']='false';assert.deepEqual(documentDefaultChange('color',read,checked,()=>[]),{group:'color',value:false});
 checks['default-unset']=true;assert.deepEqual(documentDefaultChange('notes',()=>{throw Error('unset must not read value');},checked,()=>[]),{group:'notes',unset:true});checks['default-unset']=false;
 assert.deepEqual(documentDefaultChange('customField11',()=>{throw Error('protected must not read value');},checked,()=>[]),{group:'customField11'});checks['default-false']=true;assert.deepEqual(documentDefaultChange('customField11',read,checked,()=>[]),{group:'customField11',value:false});
 values['default-mode']='inline';assert.deepEqual(documentDefaultChange('credentials',read,checked,()=>[]),{group:'credentials',value:{mode:'inline'}});
});
test('credential defaults require explicit typed ID or scoped name and reject parent or raw identity payload',()=>{
 const vault='00000000-0000-4000-8000-000000000001',credential='00000000-0000-4000-8000-000000000002';const values:Record<string,string>={'default-mode':'id','default-identity':''};
 const read=(id:string)=>values[id.slice(prefix.length)]??'';
 assert.throws(()=>documentDefaultChange('credentials',read,()=>false,()=>[]),/Pilih identitas/);
 values['default-identity']=JSON.stringify({vaultId:vault,credentialId:credential});assert.deepEqual(documentDefaultChange('credentials',read,()=>false,()=>[]),{group:'credentials',value:{mode:'id',vaultId:vault,credentialId:credential}});
 values['default-identity']=JSON.stringify({vaultId:vault,credentialId:credential,secretId:'never'});assert.throws(()=>documentDefaultChange('credentials',read,()=>false,()=>[]));
 values['default-mode']='name';values['default-name']='Identitas';assert.throws(()=>documentDefaultChange('credentials',read,()=>false,()=>[]),/scope/);assert.deepEqual(documentDefaultChange('credentials',read,()=>false,()=>[vault]),{group:'credentials',value:{mode:'name',name:'Identitas',scopeVaultIds:[vault]}});
 values['default-mode']='parent';assert.throws(()=>documentDefaultChange('credentials',read,()=>false,()=>[]));
});
test('unknown migration dates remain explicit while known dates retain their UTC value',()=>{
 assert.equal(documentDateLabel(null),'Tidak diketahui');assert.equal(documentDateLabel('2026-10-24T00:00:00.000Z'),'2026-10-24T00:00:00.000Z');
});
