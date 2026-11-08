import {configCall,type ConfigHost} from './credentials-ui.js';
const el=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
/** One-use expression fields are separate from their public, typed input values. */
export function templateParameters(read:(id:string)=>string){
 const fields:Record<string,string>={},values:Record<string,string|number>={};
 for(const key of ['Name','Host','Port','UserName','Description']){const value=read(`tpl-expr-${key}`);if(value!=='')fields[key]=value;}
 const name=read('tpl-name');if(name!=='')values.Name=name;
 for(const key of ['Host','Port','UserName','Userdomain','Description']){const value=read(`tpl-token-${key}`);if(value!=='')values[key]=key==='Port'?Number(value):value;}
 return{...(Object.keys(fields).length?{fields}:{}),...(Object.keys(values).length?{values}:{})};
}
export function initTemplates(host:ConfigHost){
 const dialog=el<HTMLDialogElement>('templates-dialog');let busy=false;
 const selection=()=>{const s=host.selected();if(!s)throw Error('Pilih dokumen, folder atau koneksi pada pohon dahulu.');return s;};
 const template=()=>{const value=el<HTMLSelectElement>('tpl-list').value;if(!value)throw Error('Pilih template dahulu.');const t=JSON.parse(value);return{templateHandle:t.handle,templateId:t.id};};
 const name=()=>el<HTMLInputElement>('tpl-name').value;
 const parameters=()=>templateParameters(id=>el<HTMLInputElement>(id).value);
 async function reload(){const list=await configCall('templates.list');const select=el<HTMLSelectElement>('tpl-list'),prior=select.value;select.replaceChildren(...list.map((t:any)=>{const o=document.createElement('option');o.value=JSON.stringify({handle:t.handle,id:t.id});o.textContent=t.name;return o;}));if(Array.from(select.options).some(o=>o.value===prior))select.value=prior;el('tpl-status').textContent=`${list.length} template tersedia.`;}
 const task=(fn:()=>Promise<void>)=>async()=>{if(busy)return;busy=true;dialog.setAttribute('aria-busy','true');el('tpl-error').textContent='';try{await fn();}catch(e){el('tpl-error').textContent=e instanceof Error?e.message:'Operasi gagal.';}finally{busy=false;dialog.removeAttribute('aria-busy');}};
 el('templates-open').onclick=()=>{dialog.showModal();void task(reload)();};el('tpl-close').onclick=()=>{if(!busy)dialog.close();};dialog.oncancel=e=>{if(busy)e.preventDefault();};dialog.onclose=()=>el('templates-open').focus();
 el('tpl-capture').onclick=task(async()=>{const s=selection();if(!s.objectId)throw Error('Pilih folder atau koneksi untuk disalin.');await configCall('templates.capture',{id:s.id,expectedSeq:s.expectedSeq,objectId:s.objectId,name:name()||'Template baru',copyReferences:el<HTMLInputElement>('tpl-copy-references').checked});await host.refresh();await reload();});
 el('tpl-apply').onclick=task(async()=>{const s=selection();await configCall('templates.apply',{id:s.id,expectedSeq:s.expectedSeq,...template(),parentId:s.type==='folder'?s.objectId:s.parentId??null,...(!parameters().fields?.Name&&name()?{name:name()}:{}),...parameters()});await host.refresh();await reload();});
 el('tpl-adhoc').onclick=task(async()=>{const value=await configCall('templates.adHoc',{...template(),...parameters()});host.opened(value);dialog.close();});
 el('tpl-remove').onclick=task(async()=>{const t=template();const snapshots=await window.documents.views();if(!snapshots.ok)throw Error(snapshots.message);const doc=snapshots.snapshots.find(s=>s.id===t.templateHandle);if(!doc)throw Error('Sumber tidak terbuka.');await configCall('templates.remove',{id:doc.id,expectedSeq:doc.seq,templateId:t.templateId});await host.refresh();await reload();});
}
