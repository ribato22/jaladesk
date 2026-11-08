import {randomUUID} from 'node:crypto';
import type {DocumentLibrary} from '../documents/library.js';
import {projectGroup,isPlainRecord,isGroup,isGroupValue,GROUP_REGISTRY,type Group,type CredentialSelection} from '../documents/groups.js';
import {UUID,type Json,type SecretRecord} from '../documents/model.js';
import {validateSecret} from '../documents/schema-v2.js';
import {patchDocument} from '../documents/properties.js';
import {editedCredential,type CredentialPrompt} from './credential-service.js';
import type {CredentialInput} from './credentials-ipc.js';
const invalid=(code='invalid'):never=>{throw Object.assign(new Error('Permintaan properti dokumen ditolak.'),{code});};
type Reference={id:string;expectedSeq:number;expectedPropertiesVersion:string};
export type DocumentPropertiesDeps={prompt(request:CredentialPrompt):Promise<CredentialInput|undefined>;confirmShared?(name:string):Promise<boolean>;now?():number};
const exact=(value:unknown,keys:readonly string[]):value is Record<string,unknown>=>isPlainRecord(value)&&Object.keys(value).every(key=>keys.includes(key));
export class DocumentPropertiesService {
 #versions=new Map<string,{generation:number;version:string}>();
 #pending=false;
 constructor(readonly library:DocumentLibrary,readonly deps:DocumentPropertiesDeps){}
 view(id:string){
  const state=this.library.privateDocument(id);
  if(state.doc.schemaVersion!==2||state.doc.kind==='overrides')return invalid('upgrade-required');
  const open=new Set(this.library.privateDocuments().map(d=>d.handle));for(const handle of this.#versions.keys())if(!open.has(handle))this.#versions.delete(handle);
  let held=this.#versions.get(id);if(!held||held.generation!==state.generation){held={generation:state.generation,version:randomUUID()};this.#versions.set(id,held);}
  const {createdAt,updatedAt,sort}=state.doc.meta;
  return{id,seq:state.seq,name:state.doc.name,meta:{createdAt,updatedAt,sort:structuredClone(sort)},defaults:Object.fromEntries(Object.entries(state.doc.defaults.groups).map(([group,value])=>[group,projectGroup(group as Group,value!)])),propertiesVersion:held.version};
 }
 #state(ref:Reference){
  if(typeof ref.id!=='string'||!UUID.test(ref.id)||!Number.isSafeInteger(ref.expectedSeq)||ref.expectedSeq<0||typeof ref.expectedPropertiesVersion!=='string'||!UUID.test(ref.expectedPropertiesVersion))return invalid();
  const state=this.library.privateDocument(ref.id),held=this.#versions.get(ref.id);
  if(state.seq!==ref.expectedSeq||!held||held.version!==ref.expectedPropertiesVersion||held.generation!==state.generation)return invalid('stale');
  if(state.doc.schemaVersion!==2||state.doc.kind==='overrides')return invalid('upgrade-required');
  return {...state,doc:state.doc};
 }
 #publicDefault(group:Group,value:unknown):asserts value is Json{
  if(!isGroupValue(group,value))return invalid();
  if(GROUP_REGISTRY[group].capability&&value!==false)return invalid('not-supported');
  if(group!=='credentials'){
   if(GROUP_REGISTRY[group].privacy==='private'&&value!==false)return invalid();
   return;
  }
  const selection=value as CredentialSelection;
  if(selection.mode==='inline'||selection.mode==='parent')return invalid();
  const source=(documentId:string)=>{
   const sources=this.library.privateDocuments().filter(d=>d.doc.id===documentId&&d.doc.kind!=='overrides');
   if(sources.length!==1)return invalid(sources.length?'ambiguous':'scope-denied');return sources[0]!;
  };
  if(selection.mode==='id'){
   const owner=source(selection.vaultId);
   if(!this.library.credentialViews(owner.handle).some(credential=>credential.id===selection.credentialId))return invalid('scope-denied');
  }
  if(selection.mode==='name'){
   let matches=0;
   for(const documentId of selection.scopeVaultIds){const owner=source(documentId);matches+=this.library.credentialViews(owner.handle).filter(credential=>credential.name.normalize('NFC')===selection.name.normalize('NFC')).length;}
   if(matches!==1)return invalid(matches?'ambiguous':'missing');
  }
 }
 apply(input:unknown){
  if(this.#pending)return invalid('busy');
  if(!exact(input,['id','expectedSeq','expectedPropertiesVersion','patch']))return invalid();
  const ref=input as Reference;this.#state(ref);
  if(isPlainRecord(input.patch)&&isPlainRecord(input.patch.defaults))for(const [group,value]of Object.entries(input.patch.defaults)){if(!isGroup(group))return invalid();this.#publicDefault(group,value);}
  return this.library.changePrivate(ref.id,ref.expectedSeq,doc=>{try{Object.assign(doc,patchDocument(doc,input.patch,new Date((this.deps.now??Date.now)()).toISOString()));}catch{return invalid();}});
 }
 async setDefaultGroup(input:unknown){
  if(this.#pending)return invalid('busy');this.#pending=true;
  try{
   if(!exact(input,['id','expectedSeq','expectedPropertiesVersion','group','value','unset'])||typeof input.group!=='string'||!isGroup(input.group)||(Object.hasOwn(input,'unset')&&input.unset!==true)||(input.unset===true&&Object.hasOwn(input,'value')))return invalid();
   const ref=input as Reference,state=this.#state(ref),group=input.group;
   const write=(change:{value?:Json;secret?:SecretRecord})=>{this.library.writeDefaultGroup(ref.id,ref.expectedSeq,{group,...change});return{seq:this.library.view(ref.id).seq};};
   if(input.unset===true)return write({});
   if(GROUP_REGISTRY[group].capability&&input.value!==false)return invalid('not-supported');
   const inline=group==='credentials'&&isPlainRecord(input.value)&&input.value.mode==='inline';
   const protectedInput=group!=='credentials'&&GROUP_REGISTRY[group].privacy==='private'&&input.value!==false;
   if(inline||protectedInput){
    if(inline?!exact(input.value,['mode']):Object.hasOwn(input,'value'))return invalid();
    if(state.doc.kind==='workspace'){
     if(!this.deps.confirmShared||!await this.deps.confirmShared(state.doc.name))return{cancelled:true as const};
     this.#state(ref);
    }
    if(inline){
     const current=state.doc.defaults.groups.credentials;
     const previous=isPlainRecord(current)&&current.mode==='inline'&&typeof current.secretId==='string'?state.doc.secrets[current.secretId]:undefined;
     const record=previous?.kind==='credential'?previous:undefined;
     const answer=await this.deps.prompt({purpose:record?'edit':'inline',label:state.doc.name,generation:state.generation,...(record?{username:record.username,domain:record.domain,hasPassword:record.password!==undefined,hasTotp:record.totp!==undefined}:{})});
     if(!answer)return{cancelled:true as const};this.#state(ref);
     return write({value:{mode:'inline'},secret:editedCredential(answer,record)});
    }
    const answer=await this.deps.prompt({purpose:'protected',label:`${state.doc.name} · ${group}`,generation:state.generation});
    if(!answer)return{cancelled:true as const};this.#state(ref);
    if(!exact(answer,['username','domain','passwordAction','protectedAction','protectedValue'])||answer.username!==''||answer.domain!==''||answer.passwordAction!=='remove')return invalid();
    if(answer.protectedAction==='remove'&&!Object.hasOwn(answer,'protectedValue'))return write({value:false});
    if(answer.protectedAction!=='replace'||!Object.hasOwn(answer,'protectedValue'))return invalid();
    let secret:SecretRecord;try{secret=validateSecret({kind:'protected-value',value:answer.protectedValue});}catch{return invalid();}
    return write({secret});
   }
   if(!Object.hasOwn(input,'value'))return invalid();this.#publicDefault(group,input.value);
   return write({value:input.value});
  }finally{this.#pending=false;}
 }
}
