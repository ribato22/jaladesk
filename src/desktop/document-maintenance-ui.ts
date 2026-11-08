import {configCall,type ConfigHost} from './credentials-ui.js';
import {isPlainRecord} from '../documents/groups.js';
export type MaintenanceSummary={kind:'cancelled'|'changed'|'warning'|'reopen-required';message:string};
const uncertainMessage='Status kunci dokumen belum dapat dipastikan; password mungkin sudah berubah. Jangan menimpa berkas. Pertahankan perubahan lokal yang belum tersimpan sebelum memeriksa atau membuka kembali dokumen secara manual.';
export function maintenanceResultSummary(value:unknown):MaintenanceSummary{
 if(!isPlainRecord(value))throw Error('Hasil pemeliharaan tidak valid; muat ulang status dokumen.');
 if(value.status==='cancelled')return{kind:'cancelled',message:'Ganti password dibatalkan.'};
 if(value.status==='reopen-required')return{kind:'reopen-required',message:uncertainMessage};
 if(value.status!=='changed')throw Error('Hasil pemeliharaan tidak valid; muat ulang status dokumen.');
 const message='Password dokumen sudah diganti. Revisi lama tetap memerlukan password lama.';
 if(value.warnings===undefined||Array.isArray(value.warnings)&&value.warnings.length===0)return{kind:'changed',message};
 const warnings=Array.isArray(value.warnings)?value.warnings:[];
 const detail=warnings.includes('cache-forget-failed')?' Penghapusan kunci yang diingat gagal; perubahan password tidak dibatalkan.':warnings.includes('lock-release-failed')?' Kunci file belum dapat dilepas. Pastikan semua penulis ditutup sebelum pemulihan lock secara manual.':' Ada peringatan pemeliharaan; periksa status dokumen sebelum melanjutkan.';
 return{kind:'warning',message:message+detail};
}
export type MaintenanceNotice={id:string;status:'changed'|'missing'|'unreadable'|'reopen-required';dirty:boolean;actions:string[]};
export function maintenanceNoticeSummary(notice:MaintenanceNotice):{message:string;actions:('reload'|'save-merge')[]}{
 if(notice.status==='reopen-required')return{message:uncertainMessage,actions:[]};
 const messages={changed:'Berkas berubah di luar aplikasi.',missing:'Berkas tidak ditemukan.',unreadable:'Berkas tidak dapat dibaca; periksa akses atau formatnya.'};
 if(!Object.hasOwn(messages,notice.status))throw Error('Pemberitahuan dokumen tidak valid.');
 const message=messages[notice.status]+(notice.dirty?' Ada perubahan lokal yang belum disimpan; tidak ada yang dibuang otomatis.':' Tidak ada perubahan lokal yang dibuang otomatis.');
 return{message,actions:(['reload','save-merge'] as const).filter(action=>notice.actions.includes(action))};
}
export function initDocumentMaintenance(host:ConfigHost,doc:Document=document){
 const el=<T extends HTMLElement>(id:string)=>doc.getElementById(id) as T;
 const button=el<HTMLButtonElement>('doc-password-open'),error=el('document-maintenance-error'),status=el('document-maintenance-status'),panel=el('document-maintenance-notices');
 let active=true,busy=false,revision=0;const reopen=new Set<string>(),buttons=new Set<HTMLButtonElement>();
 function setBusy(value:boolean){busy=value;button.disabled=value||!host.selected();for(const action of buttons)action.disabled=value;if(value)panel.setAttribute('aria-busy','true');else panel.removeAttribute('aria-busy');}
 function focus(){if(button.disabled)doc.getElementById('doc-open')?.focus();else button.focus();}
 function present(summary:MaintenanceSummary){if(summary.kind==='warning'||summary.kind==='reopen-required'){error.textContent=summary.message;status.textContent='';}else{error.textContent='';status.textContent=summary.message;}}
 async function task(run:()=>Promise<void>,after=focus){
  if(!active||busy)return;setBusy(true);error.textContent='';status.textContent='Memproses…';
  try{await run();}catch(cause){if(active){error.textContent=cause instanceof Error?cause.message:'Pemeliharaan dokumen gagal.';status.textContent='';}}
  finally{if(active){setBusy(false);after();}}
 }
 async function refresh(){
  if(!active)return;const at=++revision;
  try{
   const notices:MaintenanceNotice[]=await configCall('maintenance.notices');const views=await window.documents.views();
   if(!active||at!==revision)return;if(!views.ok)throw Error(views.message);
   const names=new Map(views.snapshots.map(s=>[s.id,s.name])),rows=new Map<string,MaintenanceNotice>();
   for(const notice of notices)if(names.has(notice.id))rows.set(notice.id,notice);
   for(const id of reopen)if(names.has(id))rows.set(id,{id,status:'reopen-required',dirty:true,actions:[]});else reopen.delete(id);
   const content:HTMLElement[]=[];buttons.clear();
   for(const notice of rows.values()){
    const summary=maintenanceNoticeSummary(notice),row=doc.createElement('div'),title=doc.createElement('strong'),message=doc.createElement('p');
    title.textContent=names.get(notice.id)!;message.textContent=summary.message;row.append(title,message);
    for(const action of summary.actions){const actionButton=doc.createElement('button');actionButton.type='button';actionButton.textContent=action==='reload'?'Muat ulang':'Simpan & Gabungkan';actionButton.disabled=busy;
     actionButton.onclick=()=>task(()=>noticeAction(notice.id,action),()=>{if(buttons.has(actionButton)&&!actionButton.disabled)actionButton.focus();else focus();});buttons.add(actionButton);row.append(actionButton);
    }
    content.push(row);
   }
   panel.replaceChildren(...content);
  }catch(cause){if(active&&at===revision)error.textContent=cause instanceof Error?cause.message:'Pemberitahuan dokumen tidak dapat dimuat.';}
 }
 async function noticeAction(id:string,action:'reload'|'save-merge'){
  if(action==='reload'){
   const result=await window.documents.reload(id);if(!active)return;
   if(!result.ok){if(result.code==='cancelled'){status.textContent='Muat ulang dibatalkan.';return;}throw Error(result.message);}
   status.textContent='Dokumen dimuat ulang setelah persetujuan.';
  }else{
   const result=await window.documents.save(id);if(!active)return;
   if(!result.ok){if(result.code==='cancelled'){status.textContent='Simpan & Gabungkan dibatalkan.';return;}throw Error(result.message);}
   if(!result.saved){const count=Number.isSafeInteger(result.conflicts)?result.conflicts:'beberapa';error.textContent=`Ada ${count} konflik; tidak ada yang ditulis. Buka Konflik untuk menyelesaikannya.`;status.textContent='';}
   else status.textContent=typeof result.note==='string'?result.note:result.delta.dirty?'Tersimpan; masih ada perubahan baru yang belum disimpan.':'Dokumen tersimpan; perubahan yang aman telah digabungkan.';
  }
  await host.refresh();await refresh();
 }
 async function changePassword(){
  const target=host.selected();await task(async()=>{
   if(!target)throw Error('Pilih dokumen pada pohon dahulu.');
   const view=await configCall('maintenance.view',{id:target.id});if(!active)return;
   if(view.id!==target.id||!Number.isSafeInteger(view.seq)||typeof view.maintenanceVersion!=='string'||!view.maintenanceVersion)throw Error('Status dokumen berubah; pilih dan periksa kembali.');
   if(view.requiresReopen){reopen.add(target.id);present(maintenanceResultSummary({status:'reopen-required'}));await refresh();return;}
   reopen.delete(target.id);
   const result=await configCall('maintenance.password',{id:target.id,expectedSeq:view.seq,expectedMaintenanceVersion:view.maintenanceVersion});if(!active)return;
   const summary=maintenanceResultSummary(result);present(summary);if(summary.kind==='reopen-required')reopen.add(target.id);
   if(summary.kind!=='cancelled'){await host.refresh();await refresh();}
  });
 }
 error.setAttribute('role','alert');status.setAttribute('role','status');status.setAttribute('aria-live','polite');panel.setAttribute('aria-live','polite');setBusy(false);
 button.onclick=()=>changePassword();const unsubscribe=window.documents.onRefresh(()=>{void refresh();});
 return{changePassword,refresh,dispose:()=>{if(!active)return;active=false;revision++;unsubscribe();buttons.clear();}};
}
