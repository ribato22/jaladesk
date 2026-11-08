import test from 'node:test';import assert from 'node:assert/strict';
import * as module from '../src/desktop/bulk-ui.js';
const ui=module as any;
const a='00000000-0000-4000-8000-000000000001',b='00000000-0000-4000-8000-000000000002',f='00000000-0000-4000-8000-000000000003',c='00000000-0000-4000-8000-000000000004',d='00000000-0000-4000-8000-000000000005';
const sources=[{id:a,name:'Lab A',seq:3,objects:[{id:d,name:'Template',type:'template',parentId:null},{id:f,name:'Folder',type:'folder',parentId:null},{id:c,name:'One',type:'connection',parentId:f},{id:'00000000-0000-4000-8000-000000000006',name:'Two',type:'connection',parentId:null}]},{id:b,name:'Lab B',seq:8,objects:[{id:c,name:'Same object ID, other document',type:'connection',parentId:null}]}];
test('explicit folder selections expand unique descendant connections while keeping document identities separate',()=>{
 assert.equal(typeof ui.bulkTargets,'function');
 assert.deepEqual(ui.bulkTargets(sources,[`${a}:${f}`,`${a}:${c}`,`${a}:${f}`,`${b}:${c}`]),[{documentHandle:a,objectId:c,expectedSeq:3},{documentHandle:b,objectId:c,expectedSeq:8}]);
 assert.throws(()=>ui.bulkTargets(sources,[`${a}:missing`]));
});
test('bulk edits send only checked typed fields; unset and explicit false never mean a mixed empty value',()=>{
 assert.equal(typeof ui.bulkDraft,'function');
 const draft={mode:'edit',fields:[{field:'notes',unset:true},{field:'clipboardToRemote',value:false}],save:false};
 assert.deepEqual(ui.bulkDraft(sources,[`${a}:${f}`,`${a}:${c}`,`${b}:${c}`],draft),{documents:[{id:a,expectedSeq:3,actions:[{kind:'update',objectId:c,patch:{set:{clipboardToRemote:false},unset:['notes']}}]},{id:b,expectedSeq:8,actions:[{kind:'update',objectId:c,patch:{set:{clipboardToRemote:false},unset:['notes']}}]}],save:false});
 assert.throws(()=>ui.bulkDraft(sources,[`${a}:${c}`],{...draft,fields:[]}));
 assert.throws(()=>ui.bulkDraft(sources,[`${a}:${c}`],{...draft,fields:[{field:'password',value:'PRIVATE-CANARY'}]}));
 assert.throws(()=>ui.bulkDraft(sources,[`${a}:${c}`],{...draft,fields:[{field:'port',value:0}]}));
});
test('bulk add uses explicit names and existing parents per document; template refs are opt-in metadata with no cloned IDs',()=>{
 const draft={mode:'create',fields:[],save:true,create:{documents:[a,b],parents:{[a]:f,[b]:null},kind:'template',names:['North','South'],template:{templateHandle:a,templateId:d,copyReferences:false}}};
 assert.deepEqual(ui.bulkDraft(sources,[],draft),{documents:[{id:a,expectedSeq:3,actions:[{kind:'create',parentId:f,type:'connection',name:'North',templateRef:{templateHandle:a,templateId:d,copyReferences:false}},{kind:'create',parentId:f,type:'connection',name:'South',templateRef:{templateHandle:a,templateId:d,copyReferences:false}}]},{id:b,expectedSeq:8,actions:[{kind:'create',parentId:null,type:'connection',name:'North',templateRef:{templateHandle:a,templateId:d,copyReferences:false}},{kind:'create',parentId:null,type:'connection',name:'South',templateRef:{templateHandle:a,templateId:d,copyReferences:false}}]}],save:true});
 assert.throws(()=>ui.bulkDraft(sources,[],{...draft,create:{...draft.create,parents:{[a]:'new-parent',[b]:null}}}));
 assert.throws(()=>ui.bulkDraft(sources,[],{...draft,create:{...draft.create,names:[]}}));
 assert.throws(()=>ui.bulkDraft(sources,[],{...draft,create:{...draft.create,documents:[a],names:Array(10001).fill('Many')}}));
});
test('preview and partial results distinguish mixed, memory and disk while hiding raw diagnostics and input values',()=>{
 assert.equal(typeof ui.bulkPreviewText,'function');assert.equal(typeof ui.bulkProgressText,'function');
 const text=ui.bulkPreviewText({planId:'PRIVATE-PLAN',count:2,documents:[{id:a,name:'Lab A',count:2,containsPrivateData:true,fields:[{field:'host',state:'mixed',count:2,value:'PRIVATE-CANARY'},{field:'notes',state:'unset',count:2}]}]});
 assert.match(text,/Beragam/);assert.match(text,/bukan nilai kosong/);assert.match(text,/Data privat: ada/);assert.ok(!text.includes('PRIVATE'));
 const result=ui.bulkProgressText({jobId:'PRIVATE-JOB',done:true,documents:[{id:a,name:'Lab A',status:'applied-memory',save:'failed',errorCode:'PRIVATE-CANARY'},{id:b,name:'Lab B',status:'cancelled',save:'cancelled'}]});
 assert.match(result,/Berubah di memory/);assert.match(result,/Simpan gagal/);assert.match(result,/Simpan dibatalkan/);assert.ok(!result.includes('PRIVATE'));assert.match(result,/hasil dokumen lain tetap dipertahankan/);
 assert.match(ui.bulkProgressText({jobId:'conflict-job',done:true,documents:[{id:a,name:'Lab A',status:'applied-memory',save:'failed',errorCode:'conflict'}]}),/Konflik.*tidak diklaim tersimpan/);
});
class Field{
 textContent='';checked=false;disabled=false;hidden=false;open=false;multiple=false;selected=false;value='';type='';className='';children:Field[]=[];attributes=new Map<string,string>();onclick?:()=>unknown;onchange?:()=>unknown;oninput?:()=>unknown;oncancel?:(event:{preventDefault():void})=>void;onclose?:()=>void;
 constructor(readonly id:string,private doc:FakeDoc){}get options(){return this.children;}replaceChildren(...children:Field[]){this.children=children;}append(...children:Field[]){this.children.push(...children);}setAttribute(name:string,value:string){this.attributes.set(name,value);}getAttribute(name:string){return this.attributes.get(name)??null;}removeAttribute(name:string){this.attributes.delete(name);}showModal(){this.open=true;}close(){this.open=false;this.onclose?.();}focus(){this.doc.focused=this.id;}
}
class FakeDoc{fields=new Map<string,Field>();focused='';getElementById(id:string){let f=this.fields.get(id);if(!f){f=new Field(id,this);this.fields.set(id,f);}return f;}createElement(_tag:string){return new Field('',this);}}
function walk(node:Field):Field[]{return[node,...node.children.flatMap(walk)];}
type Runner=(action:string,input:any)=>Promise<any>;
function harness(run?:Runner){
 const doc=new FakeDoc(),calls:{action:string;input:any}[]=[];let refreshes=0;const old=(globalThis as any).window;
 (globalThis as any).window={workspace:{run:async(action:string,input:any)=>{calls.push({action,input:structuredClone(input)});if(run)return run(action,input);const value=action==='transfer.sources'?structuredClone(sources):action==='templates.list'?[{handle:a,id:d,name:'One root',roots:1}]:action==='bulk.preview'?{planId:'one-plan',expiresAt:60000,count:1,documents:[{id:a,name:'Lab A',count:1,containsPrivateData:false,fields:[{field:'host',state:'mixed',count:1}]}]}:action==='bulk.apply'?{jobId:'bulk-job'}:action==='bulk.progress'?{jobId:'bulk-job',done:true,documents:[{id:a,name:'Lab A',status:'applied-memory',save:'failed',errorCode:'PRIVATE-CANARY'}]}:{};return{ok:true,value};}}};
 const host={selected:()=>({id:a,expectedSeq:3,objectId:f,type:'folder',parentId:null}),refresh:async()=>{refreshes++;},revealSource:()=>{},opened:()=>{}};
 const controller=ui.initBulk(host,doc as unknown as Document);const field=(id:string)=>doc.getElementById(id==='obj-bulk'?id:'bulk-'+id);
 return{doc,calls,controller,field,refreshes:()=>refreshes,target:(key:string)=>walk(field('targets')).find(node=>node.getAttribute('data-target')===key)!,resultTarget:(key:string)=>walk(field('connect-results')).find(node=>node.value===key)!,restore:()=>{controller.dispose();(globalThis as any).window=old;}};
}
async function chooseField(h:ReturnType<typeof harness>,field:string,value:string){h.field('field-'+field).checked=true;h.field('field-'+field).onchange!();h.field('value-'+field).value=value;h.field('value-'+field).oninput?.();}
test('controller preserves explicit checkbox selections across search, sends only checked fields, consumes preview and renders partial per-doc results',async()=>{
 assert.equal(typeof ui.initBulk,'function');const h=harness();try{
  await h.controller.open();assert.equal(h.field('dialog').open,true);assert.equal(h.target(`${a}:${f}`).checked,true);assert.equal(h.field('apply').disabled,true);
  h.field('search').value='No visible matches';h.field('search').oninput!();await chooseField(h,'clipboardToRemote','false');await h.field('preview').onclick!();
  assert.deepEqual(h.calls.find(call=>call.action==='bulk.preview')?.input,{documents:[{id:a,expectedSeq:3,actions:[{kind:'update',objectId:c,patch:{set:{clipboardToRemote:false}}}]}],save:false});
  assert.match(h.field('summary').textContent,/Beragam/);assert.equal(h.field('apply').disabled,false);await h.field('apply').onclick!();
  assert.deepEqual(h.calls.find(call=>call.action==='bulk.apply')?.input,{planId:'one-plan'});assert.match(h.field('result').textContent,/Berubah di memory/);assert.match(h.field('result').textContent,/Simpan gagal/);assert.ok(!h.field('result').textContent.includes('PRIVATE'));assert.equal(h.field('apply').disabled,true);await h.field('apply').onclick!();assert.equal(h.calls.filter(call=>call.action==='bulk.apply').length,1);assert.equal(h.refreshes(),1);
  await h.field('cancel').onclick!();assert.equal(h.field('dialog').open,false);assert.equal(h.doc.focused,'obj-bulk');
 }finally{h.restore();}
});
test('stale preview is an accessible error and Escape before Apply closes without mutation',async()=>{
 const h=harness(async(action,input)=>action==='transfer.sources'?{ok:true,value:structuredClone(sources)}:action==='templates.list'?{ok:true,value:[]}:{ok:false,code:'stale',message:'Data berubah; muat ulang.'});try{
  await h.controller.open();await chooseField(h,'notes','new');await h.field('preview').onclick!();assert.equal(h.field('error').getAttribute('role'),'alert');assert.match(h.field('error').textContent,/muat ulang/);let prevented=false;h.field('dialog').oncancel!({preventDefault:()=>{prevented=true;}});assert.equal(prevented,true);assert.equal(h.field('dialog').open,false);assert.equal(h.calls.some(call=>call.action==='bulk.apply'||call.action==='bulk.cancel'),false);
 }finally{h.restore();}
});
test('Escape during a bulk job requests cancellation and keeps committed memory results visible',async()=>{
 let finish!:(value:any)=>void;const gate=new Promise<any>(resolve=>{finish=resolve;});const h=harness(async(action,input)=>action==='transfer.sources'?{ok:true,value:structuredClone(sources)}:action==='templates.list'?{ok:true,value:[]}:action==='bulk.preview'?{ok:true,value:{planId:'cancel-plan',expiresAt:60000,count:1,documents:[{id:a,name:'Lab A',count:1,containsPrivateData:false,fields:[]}]}}:action==='bulk.apply'?{ok:true,value:{jobId:'cancel-job'}}:action==='bulk.progress'?gate:{ok:true,value:{requested:true}});try{
  await h.controller.open();await chooseField(h,'notes','new');await h.field('preview').onclick!();const applying=h.field('apply').onclick!();for(let i=0;i<12;i++)await Promise.resolve();h.field('dialog').oncancel!({preventDefault:()=>{}});for(let i=0;i<12;i++)await Promise.resolve();assert.equal(h.field('dialog').open,true);assert.deepEqual(h.calls.find(call=>call.action==='bulk.cancel')?.input,{jobId:'cancel-job'});
  finish({ok:true,value:{jobId:'cancel-job',done:true,documents:[{id:a,name:'Lab A',status:'applied-memory',save:'cancelled'}]}});await applying;assert.match(h.field('result').textContent,/Berubah di memory/);assert.match(h.field('result').textContent,/Simpan dibatalkan/);assert.equal(h.field('apply').disabled,true);assert.equal(h.calls.some(call=>/rollback|cleanup/.test(call.action)),false);
 }finally{h.restore();}
});
test('connection jobs show observed target states, cancel pending work, retry only failures and retain old connected targets for explicit disconnect',async()=>{
 let cancelled=false,disconnected=false;const targetA=`${a}:${c}`,targetB=`${b}:${c}`;
 const h=harness(async(action,input)=>{
  const value=action==='transfer.sources'?structuredClone(sources):action==='templates.list'?[]:action==='connects.start'?{jobId:'conn-one'}:action==='connects.retry'?{jobId:'conn-two'}:action==='connects.cancel'?(cancelled=true,{requested:true}):action==='connects.disconnect'?(disconnected=true,{requested:true}):action==='connects.progress'?input.jobId==='conn-two'?{jobId:'conn-two',done:true,targets:[{target:targetB,documentHandle:b,objectId:c,expectedSeq:8,status:'connected'}]}:{jobId:'conn-one',done:cancelled,targets:[{target:targetA,documentHandle:a,objectId:c,expectedSeq:3,status:disconnected?'disconnected':'connected'},{target:targetB,documentHandle:b,objectId:c,expectedSeq:8,status:cancelled?'failed':'connecting',errorCode:'PRIVATE-CANARY'}]}:{};return{ok:true,value};
 });try{
  await h.controller.open();h.target(`${b}:${c}`).checked=true;h.target(`${b}:${c}`).onchange!();assert.equal(typeof h.field('connect-start').onclick,'function');await h.field('connect-start').onclick!();
  assert.deepEqual(h.calls.find(call=>call.action==='connects.start')?.input,{targets:[{documentHandle:a,objectId:c,expectedSeq:3},{documentHandle:b,objectId:c,expectedSeq:8}]});assert.match(walk(h.field('connect-results')).map(node=>node.textContent).join(' '),/Menghubungkan/);assert.equal(h.field('connect-disconnect').disabled,true);
  await h.field('cancel').onclick!();assert.deepEqual(h.calls.find(call=>call.action==='connects.cancel')?.input,{jobId:'conn-one'});assert.equal(h.field('dialog').open,true);h.field('connect-job').value='conn-one';h.field('connect-job').onchange!();await h.field('connect-retry').onclick!();assert.deepEqual(h.calls.find(call=>call.action==='connects.retry')?.input,{jobId:'conn-one'});
  const oldConnected=h.resultTarget(`conn-one/${targetA}`);assert.ok(oldConnected);oldConnected.checked=true;oldConnected.onchange!();await h.field('connect-disconnect').onclick!();assert.deepEqual(h.calls.find(call=>call.action==='connects.disconnect')?.input,{jobId:'conn-one',targets:[targetA]});assert.ok(!walk(h.field('connect-results')).some(node=>node.textContent.includes('PRIVATE')));assert.match(walk(h.field('connect-results')).map(node=>node.textContent).join(' '),/Terputus/);
 }finally{h.restore();}
});
test('clearing a document checkbox clears its earlier folder expansion as well as explicit child selections',async()=>{
 const h=harness();try{await h.controller.open();let all=walk(h.field('targets')).find(node=>node.getAttribute('data-document')===a)!;all.checked=true;all.onchange!();all=walk(h.field('targets')).find(node=>node.getAttribute('data-document')===a)!;all.checked=false;all.onchange!();await chooseField(h,'notes','new');await h.field('preview').onclick!();assert.equal(h.calls.some(call=>call.action==='bulk.preview'),false);assert.match(h.field('error').textContent,/Pilih target/);
 }finally{h.restore();}
});
test('create mode cannot connect the old edit selection hidden behind its destination checkboxes',async()=>{
 const h=harness();try{await h.controller.open();h.field('mode').value='create';h.field('mode').onchange!();assert.equal(h.field('connect-start').disabled,true);await h.field('connect-start').onclick!();assert.equal(h.calls.some(call=>call.action==='connects.start'),false);assert.match(h.field('error').textContent,/Ubah koneksi/);
 }finally{h.restore();}
});
