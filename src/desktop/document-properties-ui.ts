import type {Json} from '../documents/model.js';
import {GROUPS,GROUP_REGISTRY,isGroup,isGroupValue,isPlainRecord,type Group} from '../documents/groups.js';
import {configCall,type ConfigHost} from './credentials-ui.js';
import {identityOptions} from './effective-view.js';
export type DocumentMetadata={name:string;meta:{createdAt:string|null;updatedAt:string|null;sort:{by:'name'|'type';dir:'asc'|'desc'}[]}};
const prefix='doc-properties-';
export function documentMetadataPatch(before:DocumentMetadata,read:(id:string)=>string):{name?:string;sort?:DocumentMetadata['meta']['sort']}{
 const name=read(prefix+'name'),sort:DocumentMetadata['meta']['sort']=[];
 for(const index of [1,2]){
  const by=read(prefix+'sort-by-'+index),dir=read(prefix+'sort-dir-'+index);
  if(!by)continue;
  if(!['name','type'].includes(by)||!['asc','desc'].includes(dir)||sort.some(s=>s.by===by)||(index===2&&sort.length===0))throw Error('Pilih paling banyak dua kriteria urut yang berbeda.');
  sort.push({by:by as 'name'|'type',dir:dir as 'asc'|'desc'});
 }
 return{...(name!==before.name?{name}:{}),...(JSON.stringify(sort)!==JSON.stringify(before.meta.sort)?{sort}:{})};
}
export function documentDateLabel(value:string|null):string{return value??'Tidak diketahui';}
export function documentDefaultChange(group:string,read:(id:string)=>string,checked:(id:string)=>boolean,selected:(id:string)=>string[]):Record<string,Json>{
 if(!isGroup(group))throw Error('Grup default tidak dikenal.');
 if(checked(prefix+'default-unset'))return{group,unset:true};
 if(group==='credentials'){
  const mode=read(prefix+'default-mode');
  if(mode==='none'||mode==='inline')return{group,value:{mode}};
  if(mode==='id'){
   const raw=read(prefix+'default-identity');if(!raw)throw Error('Pilih identitas pengganti secara eksplisit.');
   let choice:unknown;try{choice=JSON.parse(raw);}catch{throw Error('Pilihan identitas tidak valid.');}
   if(!isPlainRecord(choice)||Object.keys(choice).length!==2||!Object.hasOwn(choice,'vaultId')||!Object.hasOwn(choice,'credentialId'))throw Error('Pilihan identitas tidak valid.');
   const value={mode,...choice};if(!isGroupValue(group,value))throw Error('Pilihan identitas tidak valid.');return{group,value};
  }
  if(mode==='name'){
   const value={mode,name:read(prefix+'default-name'),scopeVaultIds:selected(prefix+'default-scopes')};
   if(!isGroupValue(group,value))throw Error('Isi nama dan pilih scope sumber identitas.');return{group,value};
  }
  throw Error('Mode kredensial default tidak valid.');
 }
 if(GROUP_REGISTRY[group].privacy==='private')return checked(prefix+'default-false')?{group,value:false}:{group};
 const kind=read(prefix+'default-value-kind');
 if(GROUP_REGISTRY[group].capability){if(kind!=='false')throw Error('Adaptor grup ini belum tersedia; gunakan false atau unset.');return{group,value:false};}
 let value:Json;
 if(kind==='string')value=read(prefix+'default-value');
 else if(kind==='number'){const raw=read(prefix+'default-value');if(raw.trim()===''||!Number.isFinite(Number(raw)))throw Error('Nilai angka tidak valid.');value=Number(raw);}
 else if(kind==='true'||kind==='false')value=kind==='true';
 else if(kind==='null')value=null;
 else throw Error('Jenis nilai default tidak valid.');
 return{group,value};
}
type PropertiesView=DocumentMetadata&{id:string;seq:number;defaults:Partial<Record<Group,Json>>;propertiesVersion:string};
type CredentialSource={documentId:string;name:string;credentials:{id:string;name:string;username:string;domain:string}[]};
export function initDocumentProperties(host:ConfigHost,doc:Document=document){
 const el=<T extends HTMLElement>(name:string)=>doc.getElementById(prefix+name) as T;
 const input=(name:string)=>el<HTMLInputElement>(name);const select=(name:string)=>el<HTMLSelectElement>(name);
 const dialog=el<HTMLDialogElement>('dialog');let current:PropertiesView|undefined,id:string|undefined,busy=false;
 const read=(id:string)=>(doc.getElementById(id) as HTMLInputElement).value;
 const checked=(id:string)=>(doc.getElementById(id) as HTMLInputElement).checked;
 const selected=(id:string)=>Array.from((doc.getElementById(id) as HTMLSelectElement).selectedOptions).map(o=>o.value);
 function options(name:string,items:{value:string;label:string}[],keep?:string){const target=select(name);target.replaceChildren(...items.map(item=>{const option=doc.createElement('option');option.value=item.value;option.textContent=item.label;return option;}));if(keep&&items.some(item=>item.value===keep))target.value=keep;}
 function ref(){if(!current)throw Error('Muat ulang properti dokumen dahulu.');return{id:current.id,expectedSeq:current.seq,expectedPropertiesVersion:current.propertiesVersion};}
 function renderMode(){
  const group=select('default-group').value,mode=select('default-mode').value;
  el('default-id-fields').hidden=mode!=='id';el('default-name-fields').hidden=mode!=='name';
  const privateValue=isGroup(group)&&group!=='credentials'&&GROUP_REGISTRY[group].privacy==='private';
  el('default-inline').hidden=!(privateValue||(group==='credentials'&&mode==='inline'));
  el('default-inline').textContent=group==='credentials'?'Edit kredensial default…':'Edit nilai privat…';
 }
 function renderDefault(){
  const group=select('default-group').value;if(!isGroup(group)||!current)return;
  const has=Object.hasOwn(current.defaults,group),value=current.defaults[group];
  el('default-current').textContent=has?`Default dokumen: ${JSON.stringify(value)}`:'Belum ada default dokumen untuk grup ini.';
  input('default-unset').checked=!has;input('default-false').checked=has&&isPlainRecord(value)&&value.hasValue===false;
  const privateValue=GROUP_REGISTRY[group].privacy==='private',capability=!!GROUP_REGISTRY[group].capability;
  el('default-public').hidden=privateValue;el('default-credential').hidden=group!=='credentials';el('default-protected').hidden=!privateValue||group==='credentials';
  el('default-capability').textContent=capability?'Adaptor grup ini belum tersedia. Default hanya dapat dihapus (unset) atau dinonaktifkan (false).':'';
  select('default-value-kind').disabled=capability;select('default-value-kind').value=capability?'false':value===null?'null':typeof value==='boolean'?String(value):typeof value==='number'?'number':'string';
  input('default-value').value=privateValue||capability?'':typeof value==='string'?value:value===undefined?'':JSON.stringify(value);
  input('default-value').disabled=capability||!['string','number'].includes(select('default-value-kind').value);
  const mode=isPlainRecord(value)&&['none','inline','id','name'].includes(String(value.mode))?String(value.mode):'none';select('default-mode').value=mode;
  select('default-identity').value='';input('default-name').value='';for(const option of Array.from(select('default-scopes').options))option.selected=false;
  renderMode();
 }
 function renderMetadata(){if(!current)return;input('name').value=current.name;el('created').textContent=documentDateLabel(current.meta.createdAt);el('updated').textContent=documentDateLabel(current.meta.updatedAt);for(const [offset,index]of [1,2].entries()){const criterion=current.meta.sort[offset];select('sort-by-'+index).value=criterion?.by??'';select('sort-dir-'+index).value=criterion?.dir??'asc';}}
 async function load(){
  if(!id)throw Error('Pilih dokumen pada pohon dahulu.');const value:PropertiesView=await configCall('properties.view',{id});
  if(value.id!==id)throw Error('Dokumen properti berubah; tutup lalu buka kembali.');current=value;renderMetadata();
  const sources:CredentialSource[]=await configCall('credentials.list');
  options('default-identity',identityOptions(sources.flatMap(s=>s.credentials.map(c=>({value:JSON.stringify({vaultId:s.documentId,credentialId:c.id}),label:`${s.name} / ${c.name} — ${c.username}${c.domain?' / '+c.domain:''}`})))));
  options('default-scopes',sources.map(s=>({value:s.documentId,label:s.name})));renderDefault();
 }
 async function task(run:()=>Promise<void>){if(busy)return;busy=true;dialog.setAttribute('aria-busy','true');el('error').textContent='';el('loading').textContent='Memproses…';try{await run();}catch(error){el('error').textContent=error instanceof Error?error.message:'Operasi gagal.';}finally{busy=false;dialog.removeAttribute('aria-busy');el('loading').textContent='';}}
 async function open(){if(busy)return;id=host.selected()?.id;current=undefined;dialog.showModal();await task(load);}
 async function changed(){await host.refresh();await load();}
 async function applyDefault(){
  if(!current)throw Error('Muat ulang properti dokumen dahulu.');const metadata=documentMetadataPatch(current,read);
  const result=await configCall('properties.default',{...ref(),...documentDefaultChange(select('default-group').value,read,checked,selected)});
  if(result?.cancelled)return;
  await changed();if(metadata.name!==undefined)input('name').value=metadata.name;if(metadata.sort!==undefined)for(const [offset,index]of [1,2].entries()){const criterion=metadata.sort[offset];select('sort-by-'+index).value=criterion?.by??'';select('sort-dir-'+index).value=criterion?.dir??'asc';}
 }
 options('default-group',GROUPS.map(group=>({value:group,label:group})));
 el('error').setAttribute('role','alert');el('loading').setAttribute('role','status');el('loading').setAttribute('aria-live','polite');
 el('open').onclick=()=>{void open();};el('close').onclick=()=>{if(!busy)dialog.close();};dialog.oncancel=e=>{if(busy)e.preventDefault();};dialog.onclose=()=>{id=undefined;current=undefined;const button=el<HTMLButtonElement>('open');if(button.disabled)doc.getElementById('doc-open')?.focus();else button.focus();};
 select('default-group').onchange=renderDefault;select('default-mode').onchange=renderMode;select('default-value-kind').onchange=()=>{input('default-value').disabled=!['string','number'].includes(select('default-value-kind').value);};
 el('save').onclick=()=>task(async()=>{if(!current)throw Error('Muat ulang properti dokumen dahulu.');const patch=documentMetadataPatch(current,read);if(Object.keys(patch).length===0)return;await configCall('properties.apply',{...ref(),patch});await changed();});
 el('apply-default').onclick=()=>task(applyDefault);el('default-inline').onclick=()=>task(async()=>{const group=select('default-group').value;if(!isGroup(group)||GROUP_REGISTRY[group].privacy!=='private')throw Error('Pilih grup privat dahulu.');input('default-unset').checked=false;input('default-false').checked=false;if(group==='credentials')select('default-mode').value='inline';await applyDefault();});
 el('reload').onclick=()=>task(load);
 return{open,reload:async()=>{if(dialog.open)await task(load);}};
}
