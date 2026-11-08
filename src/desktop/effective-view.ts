export type IdentityOption={value:string;label:string};
/** Object UUIDs are scoped by document UUID; duplicate open namespaces are not an implicit choice. */
export function sourceTarget<T extends {documentId:string;objectId:string}>(targets:readonly T[],source:{documentId?:string;objectId?:string}):T|undefined{
 if(!source.documentId||!source.objectId)return;
 const matches=targets.filter(target=>target.documentId===source.documentId&&target.objectId===source.objectId);
 return matches.length===1?matches[0]:undefined;
}
/** HTML selects the first option automatically; its empty value must never become a credential binding. */
export function identityOptions(choices:readonly IdentityOption[]):IdentityOption[]{return[{value:'',label:'Pilih identitas secara eksplisit…'},...choices.map(choice=>({...choice}))];}
export type MfaView={mode:'none'|'prompt'|'generate';field?:'username'|'password';pattern?:'ValueMfaCode'|'MfaCodeValue'};
export function mfaView(raw:unknown):MfaView{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return{mode:'none'};
 const value=raw as Record<string,unknown>,keys=Object.keys(value);
 if(value.mode==='none'&&keys.length===1)return{mode:'none'};
 if(keys.length===3&&keys.every(k=>['mode','field','pattern'].includes(k))&&(value.mode==='prompt'||value.mode==='generate')&&(value.field==='username'||value.field==='password')&&(value.pattern==='ValueMfaCode'||value.pattern==='MfaCodeValue'))return{mode:value.mode,field:value.field,pattern:value.pattern};
 return{mode:'none'};
}
