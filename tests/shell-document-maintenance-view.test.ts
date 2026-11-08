import test from 'node:test';import assert from 'node:assert/strict';
import {maintenanceResultSummary,maintenanceNoticeSummary,initDocumentMaintenance,type MaintenanceNotice} from '../src/desktop/document-maintenance-ui.js';
import type {ConfigHost} from '../src/desktop/credentials-ui.js';
test('password result distinguishes cancellation, committed warning and uncertain outcome without echoing raw diagnostics',()=>{
 assert.deepEqual(maintenanceResultSummary({status:'cancelled'}),{kind:'cancelled',message:'Ganti password dibatalkan.'});
 const changed=maintenanceResultSummary({status:'changed'});assert.equal(changed.kind,'changed');assert.match(changed.message,/Revisi lama/);
 const warning=maintenanceResultSummary({status:'changed',warnings:['cache-forget-failed']});assert.equal(warning.kind,'warning');assert.match(warning.message,/sudah diganti/);assert.match(warning.message,/kunci yang diingat/);
 const unknown=maintenanceResultSummary({status:'changed',warnings:['PRIVATE-PATH-SECRET']});assert.equal(unknown.kind,'warning');assert.ok(!unknown.message.includes('PRIVATE-PATH-SECRET'));
 const uncertain=maintenanceResultSummary({status:'reopen-required'});assert.equal(uncertain.kind,'reopen-required');assert.match(uncertain.message,/mungkin sudah berubah/);assert.match(uncertain.message,/perubahan lokal/);assert.throws(()=>maintenanceResultSummary({status:'PRIVATE-PATH-SECRET'}));
});
class Field{
 textContent='';disabled=false;className='';children:Field[]=[];onclick?:()=>unknown;attributes=new Map<string,string>();
 constructor(readonly id:string,private doc:FakeDoc){}
 setAttribute(name:string,value:string){this.attributes.set(name,value);}getAttribute(name:string){return this.attributes.get(name)??null;}removeAttribute(name:string){this.attributes.delete(name);}
 append(...children:Field[]){this.children.push(...children);}replaceChildren(...children:Field[]){this.children=children;}focus(){this.doc.focused=this.id;}
}
class FakeDoc{
 fields=new Map<string,Field>();focused='';getElementById(id:string){let f=this.fields.get(id);if(!f){f=new Field(id,this);this.fields.set(id,f);}return f;}createElement(tag:string){return new Field(tag,this);}
}
const first='00000000-0000-4000-8000-000000000001',second='00000000-0000-4000-8000-000000000002';
type Runner=(action:string,input:any)=>Promise<any>;
function harness(run?:Runner){
 const doc=new FakeDoc(),calls:{action:string;input:any}[]=[];const prior=(globalThis as any).window;let selected:string|undefined=first,refreshes=0,listener:(()=>void)|undefined,removed=0;
 const notices:MaintenanceNotice[]=[];const snapshots=[{id:first,name:'Dokumen satu'},{id:second,name:'Dokumen dua'}];
 const call=async(action:string,input:any)=>{calls.push({action,input:structuredClone(input)});if(run)return run(action,input);if(action==='maintenance.view')return{ok:true,value:{id:input.id,seq:4,maintenanceVersion:'version-one'}};if(action==='maintenance.notices')return{ok:true,value:structuredClone(notices)};if(action==='maintenance.password')return{ok:true,value:{status:'changed'}};if(action==='views')return{ok:true,snapshots};if(action==='save')return{ok:true,saved:true,conflicts:0,delta:{dirty:false}};return{ok:true,delta:{}};};
 (globalThis as any).window={workspace:{run:call},documents:{views:()=>call('views',{}),reload:(id:string)=>call('reload',{id}),save:(id:string)=>call('save',{id}),onRefresh:(callback:()=>void)=>{listener=callback;return()=>{removed++;listener=undefined;};}}};
 const host:ConfigHost={selected:()=>selected?{id:selected,expectedSeq:4}:undefined,refresh:async()=>{refreshes++;},revealSource:()=>{},opened:()=>{}};
 const controller=initDocumentMaintenance(host,doc as unknown as Document);
 return{doc,calls,controller,notices,snapshots,field:(id:string)=>doc.getElementById(id),select:(id?:string)=>{selected=id;},refreshes:()=>refreshes,listener:()=>listener,removed:()=>removed,restore:()=>{controller.dispose();(globalThis as any).window=prior;}};
}
const noticeButtons=(doc:FakeDoc)=>doc.getElementById('document-maintenance-notices').children.flatMap(row=>row.children).filter(child=>!!child.onclick);
test('password action binds the reviewed document and sends only its sequence and opaque version',async()=>{
 let release!:(value:any)=>void;const view=new Promise<any>(resolve=>{release=resolve;});
 const h=harness(async(action,input)=>action==='maintenance.view'?view:action==='maintenance.password'?{ok:true,value:{status:'changed'}}:action==='views'?{ok:true,snapshots:[{id:first,name:'Dokumen satu'},{id:second,name:'Dokumen dua'}]}:{ok:true,value:[]});
 try{const changing=h.controller.changePassword();await Promise.resolve();h.select(second);release({ok:true,value:{id:first,seq:4,maintenanceVersion:'version-one'}});await changing;
  assert.deepEqual(h.calls.find(c=>c.action==='maintenance.password')?.input,{id:first,expectedSeq:4,expectedMaintenanceVersion:'version-one'});assert.match(h.field('document-maintenance-status').textContent,/sudah diganti/);assert.equal([...h.doc.fields.keys()].some(key=>/old-password|new-password|password-value/.test(key)),false);
 }finally{h.restore();}
});
test('pending native password decision blocks duplicates, then cancellation restores focus without an error',async()=>{
 let release!:(value:any)=>void;const gate=new Promise<any>(resolve=>{release=resolve;});const h=harness(async(action,input)=>action==='maintenance.view'?{ok:true,value:{id:input.id,seq:4,maintenanceVersion:'version-one'}}:action==='maintenance.password'?gate:action==='views'?{ok:true,snapshots:[]}:{ok:true,value:[]});
 try{const changing=h.controller.changePassword();for(let i=0;i<8;i++)await Promise.resolve();assert.equal(h.field('doc-password-open').disabled,true);await h.controller.changePassword();assert.equal(h.calls.filter(c=>c.action==='maintenance.password').length,1);release({ok:true,value:{status:'cancelled'}});await changing;assert.equal(h.field('document-maintenance-error').textContent,'');assert.match(h.field('document-maintenance-status').textContent,/dibatalkan/);assert.equal(h.doc.focused,'doc-password-open');
 }finally{h.restore();}
});
test('watch notices never trigger reload themselves and an explicit cancelled Reload keeps local work intact',async()=>{
 const h=harness(async(action,input)=>action==='maintenance.notices'?{ok:true,value:[{id:first,status:'changed',dirty:true,actions:['reload','save-merge']},{id:'closed-document',status:'missing',dirty:false,actions:['reload']}]}:action==='views'?{ok:true,snapshots:[{id:first,name:'Dokumen satu'}]}:action==='reload'?{ok:false,code:'cancelled',message:'Dibatalkan.'}:{ok:true,value:[]});
 try{await h.controller.refresh();assert.equal(h.calls.some(c=>c.action==='reload'||c.action==='save'),false);const buttons=noticeButtons(h.doc);assert.equal(buttons.length,2);h.select(second);await buttons.find(b=>b.textContent==='Muat ulang')!.onclick!();assert.deepEqual(h.calls.find(c=>c.action==='reload')?.input,{id:first});assert.equal(h.refreshes(),0);assert.equal(h.field('document-maintenance-error').textContent,'');assert.match(h.field('document-maintenance-status').textContent,/dibatalkan/);assert.equal(h.field('document-maintenance-notices').children.length,1);
 }finally{h.restore();}
});
test('Save & Merge reports unresolved conflicts rather than successful disk storage and uses the notice document',async()=>{
 const h=harness(async(action,input)=>action==='maintenance.notices'?{ok:true,value:[{id:first,status:'changed',dirty:true,actions:['save-merge']}]}:action==='views'?{ok:true,snapshots:[{id:first,name:'Dokumen satu'}]}:action==='save'?{ok:true,saved:false,conflicts:2,delta:{dirty:true}}:{ok:true,value:[]});
 try{await h.controller.refresh();h.select(second);await noticeButtons(h.doc)[0]!.onclick!();assert.deepEqual(h.calls.find(c=>c.action==='save')?.input,{id:first});assert.match(h.field('document-maintenance-error').textContent,/2 konflik/);assert.match(h.field('document-maintenance-error').textContent,/tidak ada yang ditulis/);assert.equal(h.field('document-maintenance-error').getAttribute('role'),'alert');assert.equal(h.refreshes(),1);
 }finally{h.restore();}
});
test('reopen-required stays visible without dangerous actions and disposal suppresses late notice rendering',async()=>{
 let resolve!:(value:any)=>void;const waiting=new Promise<any>(done=>{resolve=done;});let calls=0;
 const h=harness(async(action,input)=>action==='maintenance.view'?{ok:true,value:{id:input.id,seq:4,maintenanceVersion:'version-one',requiresReopen:true}}:action==='maintenance.notices'?(++calls===1?{ok:true,value:[]}:waiting):action==='views'?{ok:true,snapshots:[{id:first,name:'Dokumen satu'}]}:{ok:true,value:[]});
 try{await h.controller.changePassword();assert.equal(h.calls.some(c=>c.action==='maintenance.password'),false);assert.match(h.field('document-maintenance-error').textContent,/mungkin sudah berubah/);assert.equal(noticeButtons(h.doc).length,0);const pending=h.controller.refresh();await Promise.resolve();const callback=h.listener();h.controller.dispose();resolve({ok:true,value:[{id:first,status:'changed',dirty:true,actions:['reload']}]});await pending;callback?.();assert.equal(h.removed(),1);assert.equal(noticeButtons(h.doc).length,0);
 }finally{h.restore();}
});
test('external notices keep dirty edits visible and offer only explicit safe actions',()=>{
 const base:MaintenanceNotice={id:'doc',status:'changed',dirty:true,actions:['reload','save-merge','execute']};const result=maintenanceNoticeSummary(base);assert.match(result.message,/perubahan lokal/);assert.deepEqual(result.actions,['reload','save-merge']);
 for(const status of ['missing','unreadable'] as const){const view=maintenanceNoticeSummary({...base,status,dirty:false});assert.ok(view.message.length>0);assert.deepEqual(view.actions,['reload','save-merge']);}
 const uncertain=maintenanceNoticeSummary({...base,status:'reopen-required'});assert.deepEqual(uncertain.actions,[]);assert.match(uncertain.message,/Jangan menimpa/);
 assert.deepEqual(maintenanceNoticeSummary({...base,actions:[]}).actions,[]);
});
