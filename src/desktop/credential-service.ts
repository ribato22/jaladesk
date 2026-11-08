import {randomUUID} from 'node:crypto';
import { credentialRecord } from '../credentials/model.js';
import { analyzeCredentials } from '../credentials/hygiene.js';
import { totp } from '../credentials/totp.js';
import { resolveEffective, type ResolutionLayers } from '../documents/effective.js';
import { GROUPS, GROUP_REGISTRY, isGroup, isGroupValue, isPlainRecord, projectGroup, type Group, type CredentialSelection } from '../documents/groups.js';
import type { DocumentLibrary } from '../documents/library.js';
import type { Doc2, Json, ObjectNode, SecretRecord } from '../documents/model.js';
import { validateSecret } from '../documents/schema-v2.js';
import type { CredentialInput } from './credentials-ipc.js';

export type CredentialPrompt = {purpose:'create'|'edit'|'inline'|'protected';label:string;generation:number;username?:string;domain?:string;hasPassword?:boolean;hasTotp?:boolean};
export type CredentialServiceDeps = {
 prompt(request:CredentialPrompt):Promise<CredentialInput|undefined>;
 confirmShared?(name:string):Promise<boolean>; confirmRemove(name:string):Promise<boolean>; confirmCopy(name:string):Promise<boolean>;
 clipboard:{readText():string|Promise<string>;writeText(value:string):void|Promise<void>}; schedule?(callback:()=>void,milliseconds:number):unknown; now?():number;
 layers?(ref:{documentHandle:string;objectId:string;expectedSeq:number}):Omit<ResolutionLayers,'documentGeneration'>;
};
type Ref={id:string;expectedSeq:number;objectId:string;expectedCredentialVersion?:string};
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const invalid=(code='invalid'):never=>{throw Object.assign(new Error('Permintaan kredensial ditolak'),{code});};
const exact=(value:unknown,keys:string[]):value is Record<string,unknown>=>isPlainRecord(value)&&Object.keys(value).every(k=>keys.includes(k));
const nameValid=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=256&&!/[\u0000-\u001f\u007f]/.test(value);
const protectedGroup=(group:Group)=>GROUP_REGISTRY[group].privacy==='private'&&group!=='credentials';
export type PublicMfaConfig={mode:'none'}|{mode:'prompt'|'generate';field:'username'|'password';pattern:'ValueMfaCode'|'MfaCodeValue'};
function safeMfa(value:unknown):PublicMfaConfig|undefined {
 if(!exact(value,['mode','field','pattern']))return;
 if(value.mode==='none')return Object.keys(value).length===1?{mode:'none'}:undefined;
 if(!['prompt','generate'].includes(value.mode as string)||Object.keys(value).length!==3||!['username','password'].includes(value.field as string)||!['ValueMfaCode','MfaCodeValue'].includes(value.pattern as string))return;
 return {mode:value.mode as 'prompt'|'generate',field:value.field as 'username'|'password',pattern:value.pattern as 'ValueMfaCode'|'MfaCodeValue'};
}
function safeSelection(value:Json|undefined):Json|undefined {
 if(value===undefined)return;
 const s=value as CredentialSelection;return s.mode==='inline'?{mode:'inline',hasSecret:true}:structuredClone(value);
}
export function editedCredential(input:CredentialInput,previous?:Extract<SecretRecord,{kind:'credential'}>):Extract<SecretRecord,{kind:'credential'}>{
 if(!exact(input,['username','domain','passwordAction','password','totpAction','totp','privateKeyAction','privateKey','passphraseAction','passphrase'])||typeof input.username!=='string'||input.username.length>256||typeof input.domain!=='string'||input.domain.length>256||!['keep','replace','remove'].includes(input.passwordAction))return invalid();
 const record:Extract<SecretRecord,{kind:'credential'}>={...structuredClone(previous),kind:'credential',username:input.username,domain:input.domain};
 for(const [key,action] of [['password',input.passwordAction],['totp',input.totpAction??'keep'],['privateKey',input.privateKeyAction??'keep'],['passphrase',input.passphraseAction??'keep']] as const){
  if(!['keep','replace','remove'].includes(action as string))return invalid();
  if(action==='remove')delete record[key];
  if(action==='replace'){if(!Object.hasOwn(input,key))return invalid();(record as any)[key]=structuredClone(input[key]);}
  else if(Object.hasOwn(input,key))return invalid();
 }
 try{validateSecret(record);}catch{return invalid();}return record;
}
/** This service is main-only; every return value is a deliberately safe DTO. */
export class CredentialsService {
 #pending=false;
 #versions=new Map<string,{generation:number;version:string}>();
 constructor(readonly library:DocumentLibrary,readonly deps:CredentialServiceDeps){}
 #state(ref:Pick<Ref,'id'|'expectedSeq'>){
  if(typeof ref.id!=='string'||!ref.id||!Number.isSafeInteger(ref.expectedSeq)||ref.expectedSeq<0)return invalid();
  let state;try{state=this.library.privateDocument(ref.id);}catch{return invalid('missing');}
  if(state.seq!==ref.expectedSeq)return invalid('stale');
  if(state.doc.schemaVersion!==2||state.doc.kind==='overrides')return invalid();return {...state,doc:state.doc as Doc2};
 }
 #credentialState(ref:Pick<Ref,'id'|'expectedSeq'|'expectedCredentialVersion'>){if(!uuid(ref.expectedCredentialVersion))return invalid();const state=this.#state(ref),held=this.#versions.get(ref.id);if(!held||held.version!==ref.expectedCredentialVersion||held.generation!==state.generation)return invalid('stale');return state;}
 #credentialNode(ref:Ref){const state=this.#credentialState(ref),node=state.doc.objects[ref.objectId];if(!node)return invalid('missing');return {...state,node};}
 #version(handle:string,generation:number){const held=this.#versions.get(handle);if(held?.generation===generation)return held.version;const version=randomUUID();this.#versions.set(handle,{generation,version});return version;}
 #ref(raw:unknown,extra:string[]=[]):Ref {
  if(!exact(raw,['id','expectedSeq','objectId',...extra])||!uuid(raw.objectId))return invalid();return raw as Ref;
 }
 #node(ref:Ref){const state=this.#state(ref),node=state.doc.objects[ref.objectId];if(!node)return invalid('missing');return {...state,node};}
 #unchanged(ref:Pick<Ref,'id'|'expectedSeq'>,generation:number){const state=this.#state(ref);if(state.generation!==generation)return invalid('stale');return state;}
 async #exclusive<T>(run:()=>Promise<T>):Promise<T>{if(this.#pending)return invalid('busy');this.#pending=true;try{return await run();}finally{this.#pending=false;}}
 async #shared(doc:Doc2){if(doc.kind==='workspace'&&(!this.deps.confirmShared||!await this.deps.confirmShared(doc.name)))return false;return true;}
 list(){const docs=this.library.privateDocuments();for(const handle of this.#versions.keys())if(!docs.some(d=>d.handle===handle))this.#versions.delete(handle);return docs.filter(s=>s.doc.kind!=='overrides').map(s=>({handle:s.handle,documentId:s.doc.id,name:s.doc.name,kind:s.doc.kind,seq:s.seq,credentialVersion:this.#version(s.handle,s.generation),credentials:this.library.credentialViews(s.handle),folders:Object.values(s.doc.objects).filter(n=>n.type==='folder').map(n=>({id:n.id,name:n.name}))}));}
 edit(raw:unknown){return this.#exclusive(async()=>{
  if(!exact(raw,['id','expectedSeq','expectedCredentialVersion','objectId','name','parentId'])||!nameValid(raw.name)||(raw.objectId!==undefined&&!uuid(raw.objectId))||(raw.parentId!==undefined&&raw.parentId!==null&&!uuid(raw.parentId)))return invalid();
  const ref=raw as Pick<Ref,'id'|'expectedSeq'|'expectedCredentialVersion'>,state=this.#credentialState(ref),node=raw.objectId===undefined?undefined:state.doc.objects[raw.objectId as string];
  if(raw.objectId!==undefined&&node?.type!=='credential')return invalid('missing');
  if(raw.parentId&&state.doc.objects[raw.parentId as string]?.type!=='folder')return invalid();
  if(!await this.#shared(state.doc))return {cancelled:true as const};this.#unchanged(ref,state.generation);
  const previous=node?credentialRecord(state.doc,node):undefined;if(node&&!previous)return invalid('missing');
  const input=await this.deps.prompt({purpose:node?'edit':'create',label:raw.name,generation:state.generation,...(previous?{username:previous.username,domain:previous.domain,hasPassword:previous.password!==undefined,hasTotp:previous.totp!==undefined}:{})});
  if(!input)return {cancelled:true as const};this.#unchanged(ref,state.generation);
  const record=editedCredential(input,previous);const result=this.library.writeCredential(ref.id,{objectId:node?.id,name:raw.name,parentId:raw.parentId as string|null|undefined,record});return {objectId:result.objectId,seq:this.library.privateDocument(ref.id).seq};
 });}
 remove(raw:unknown){return this.#exclusive(async()=>{const ref=this.#ref(raw,['expectedCredentialVersion']),state=this.#credentialNode(ref);if(state.node.type!=='credential')return invalid();if(!await this.deps.confirmRemove(state.node.name))return {cancelled:true as const};this.#unchanged(ref,state.generation);this.library.removeCredential(ref.id,ref.objectId);return {removed:true as const,seq:this.library.privateDocument(ref.id).seq};});}
 async analyze(raw:unknown){
  if(!exact(raw,['id','expectedSeq','expectedCredentialVersion','objectIds','optIn'])||raw.optIn!==true||!Array.isArray(raw.objectIds)||raw.objectIds.length>10000||raw.objectIds.some(n=>!uuid(n))||new Set(raw.objectIds).size!==raw.objectIds.length)return invalid();
  const state=this.#credentialState(raw as Pick<Ref,'id'|'expectedSeq'|'expectedCredentialVersion'>),ids=raw.objectIds as string[];
  const entries=ids.map(id=>{const node=state.doc.objects[id];if(node?.type!=='credential')return invalid('missing');const record=credentialRecord(state.doc,node);return {id,status:record?(record.password?'available':'empty'):'missing',...(record?.password!==undefined?{password:record.password}:{})} as const;});
  const result=await analyzeCredentials(entries,{optIn:true,ids});this.#unchanged(raw as Pick<Ref,'id'|'expectedSeq'>,state.generation);return result;
 }
 candidates(raw:unknown){
  if(!exact(raw,['name','scopeVaultIds'])||!nameValid(raw.name)||!Array.isArray(raw.scopeVaultIds)||!raw.scopeVaultIds.length||raw.scopeVaultIds.length>100||raw.scopeVaultIds.some(v=>!uuid(v))||new Set(raw.scopeVaultIds).size!==raw.scopeVaultIds.length)return invalid();
  const docs=this.library.privateDocuments(),out:{vaultId:string;credentialId:string;documentName:string;name:string;username:string;domain:string}[]=[];
  for(const docId of raw.scopeVaultIds){const s=docs.find(s=>s.doc.id===docId&&s.doc.kind!=='overrides');if(!s)return invalid('scope-denied');for(const c of this.library.credentialViews(s.handle))if(c.name.normalize('NFC')===(raw.name as string).normalize('NFC'))out.push({vaultId:s.doc.id,credentialId:c.id,documentName:s.doc.name,name:c.name,username:c.username,domain:c.domain});}return out;
 }
 effective(raw:unknown){const ref=this.#ref(raw),state=this.#node(ref);if(!['folder','connection','template'].includes(state.node.type))return invalid();const result=resolveEffective(state.doc,ref.objectId,{...this.deps.layers?.({documentHandle:ref.id,objectId:ref.objectId,expectedSeq:ref.expectedSeq}),documentGeneration:state.generation});if(!result.ok)return invalid(result.error.code);
  const local=isPlainRecord(state.node.props.groups)?state.node.props.groups:{},inherit=isPlainRecord(state.node.props.inherit)?state.node.props.inherit:{};
  const mfa=safeMfa(state.node.props.mfa);
  return {seq:state.seq,...(mfa?{mfa}:{}),groups:GROUPS.map(group=>({group,inherit:inherit[group]===true,...(Object.hasOwn(local,group)?{local:group==='credentials'?safeSelection(local[group] as Json):projectGroup(group,local[group] as Json)}:{}),...(Object.hasOwn(result.value.public.groups,group)?{value:result.value.public.groups[group]}:{}),source:result.value.provenance[group]??{layer:'application'}}))};
 }
 publicEffective(raw:unknown){return this.effective(raw);}
 setMfa(raw:unknown){const ref=this.#ref(raw,['config']),state=this.#node(ref);if(state.node.type!=='connection'||!isPlainRecord(raw))return invalid();const config=safeMfa(raw.config);if(!config)return invalid();return this.library.changePrivate(ref.id,ref.expectedSeq,doc=>{doc.objects[ref.objectId]!.props.mfa=structuredClone(config);});}

 updateGroup(raw:unknown){return this.#exclusive(async()=>{
  const ref=this.#ref(raw,['group','inherit','value']);if(!isPlainRecord(raw)||typeof raw.group!=='string'||!isGroup(raw.group)||typeof raw.inherit!=='boolean')return invalid();const state=this.#node(ref);if(!['folder','connection','template'].includes(state.node.type))return invalid();const group=raw.group;
  if(raw.inherit){if(Object.hasOwn(raw,'value'))return invalid();this.#writeGroup(ref,{group,inherit:true});return {seq:this.library.privateDocument(ref.id).seq};}
  if(group==='credentials'&&isPlainRecord(raw.value)&&raw.value.mode==='inline'){
   if(!exact(raw.value,['mode']))return invalid();if(!await this.#shared(state.doc))return {cancelled:true as const};const local=isPlainRecord(state.node.props.groups)?state.node.props.groups.credentials:undefined;const existing=isPlainRecord(local)&&local.mode==='inline'&&typeof local.secretId==='string'?state.doc.secrets[local.secretId]:undefined;const prev=existing?.kind==='credential'?existing:undefined;const input=await this.deps.prompt({purpose:prev?'edit':'inline',label:state.node.name,generation:state.generation,...(prev?{username:prev.username,domain:prev.domain,hasPassword:prev.password!==undefined,hasTotp:prev.totp!==undefined}:{})});if(!input)return {cancelled:true as const};this.#unchanged(ref,state.generation);const current=isPlainRecord(state.node.props.groups)?state.node.props.groups.credentials:undefined;const previous=isPlainRecord(current)&&current.mode==='inline'&&typeof current.secretId==='string'?state.doc.secrets[current.secretId]:undefined;const secret=editedCredential(input,previous?.kind==='credential'?previous:undefined);this.#writeGroup(ref,{group,inherit:false,value:{mode:'inline'},secret});
  }else if(protectedGroup(group)&&raw.value!==false){
   if(Object.hasOwn(raw,'value'))return invalid();if(!await this.#shared(state.doc))return {cancelled:true as const};const input=await this.deps.prompt({purpose:'protected',label:`${state.node.name} · ${group}`,generation:state.generation});if(!input)return {cancelled:true as const};this.#unchanged(ref,state.generation);
   if(input.protectedAction==='remove')this.#writeGroup(ref,{group,inherit:false,value:false});else if(input.protectedAction==='replace'&&Object.hasOwn(input,'protectedValue')){let secret:SecretRecord;try{secret=validateSecret({kind:'protected-value',value:input.protectedValue});}catch{return invalid();}this.#writeGroup(ref,{group,inherit:false,secret});}else return invalid();
  }else{
   if(!Object.hasOwn(raw,'value')){this.#writeGroup(ref,{group,inherit:false});return {seq:this.library.privateDocument(ref.id).seq};}
   if(!isGroupValue(group,raw.value)||(group==='credentials'&&(raw.value as CredentialSelection).mode==='parent'))return invalid();
   if(group==='credentials'){const value=raw.value as CredentialSelection;if(value.mode==='id'){const s=this.library.privateDocuments().find(d=>d.doc.id===value.vaultId&&d.doc.kind!=='overrides');if(!s||!this.library.credentialViews(s.handle).some(c=>c.id===value.credentialId))return invalid('scope-denied');}if(value.mode==='name'){const choices=this.candidates({name:value.name,scopeVaultIds:value.scopeVaultIds});if(choices.length>1)return invalid('ambiguous');}}
   this.#writeGroup(ref,{group,inherit:false,value:raw.value});
  }return {seq:this.library.privateDocument(ref.id).seq};
 });}
 #writeGroup(ref:Ref,change:{group:Group;inherit:boolean;value?:unknown;secret?:SecretRecord}){const lib=this.library as DocumentLibrary&{writeGroup(id:string,input:{objectId:string;group:Group;inherit:boolean;value?:unknown;secret?:SecretRecord}):unknown};lib.writeGroup(ref.id,{objectId:ref.objectId,...change});}
 totpStatus(raw:unknown){const ref=this.#ref(raw,['expectedCredentialVersion']),state=this.#credentialNode(ref),record=credentialRecord(state.doc,state.node);if(!record)return invalid('missing');if(!record.totp)return {available:false};const now=(this.deps.now??Date.now)()/1000;return {available:true,period:record.totp.period,digits:record.totp.digits,remainingSeconds:record.totp.period-Math.floor(now)%record.totp.period};}
 copyTotp(raw:unknown){return this.#exclusive(async()=>{const ref=this.#ref(raw,['expectedCredentialVersion']),state=this.#credentialNode(ref),record=credentialRecord(state.doc,state.node);if(!record?.totp)return invalid('missing');if(!await this.deps.confirmCopy(state.node.name))return {cancelled:true as const};this.#unchanged(ref,state.generation);const code=totp(record.totp,(this.deps.now??Date.now)()/1000);try{await this.deps.clipboard.writeText(code);(this.deps.schedule??((callback,milliseconds)=>{const t=setTimeout(callback,milliseconds);t.unref();return t;}))(async()=>{try{if(await this.deps.clipboard.readText()===code)await this.deps.clipboard.writeText('');}catch{}},30000);}catch{return invalid();}return {copied:true as const,expiresInSeconds:30};});}
}
