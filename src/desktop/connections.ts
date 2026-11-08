import { randomUUID } from 'node:crypto';
import type { DocumentLibrary } from '../documents/library.js';
import {validateV2,type Doc,type Doc2,type ObjectNode} from '../documents/model.js';
import { resolveEffective, useEffectiveGroup, type ResolutionLayers } from '../documents/effective.js';
import { resolveCredential, normalizeIdentity, type ResolvedCredential } from '../credentials/resolve.js';
import { composeMfa, type MfaConfig } from '../credentials/totp.js';
import { checkStored, fromProps } from './connection-settings.js';
import { redactCredentialError } from '../credentials/model.js';
import { validateTarget, type RdpTarget, type Secret } from '../protocols/rdp/wire.js';

export type OpenStored = { documentHandle: string; objectId: string; expectedSeq: number; temporaryOptions?: Partial<Pick<RdpTarget,'host'|'port'|'certificateSha256'|'width'|'height'|'clipboard'>> };
export type StoredOpened = { sessionId: string; label: string; publicTarget: RdpTarget; color?: string };
type Ref = Pick<OpenStored,'documentHandle'|'objectId'>;
export class StoredConnectionError extends Error { constructor(readonly code: string) { super(`Stored connection ${code}`);this.name='StoredConnectionError'; } }
const fail=(code:string):never=>{throw new StoredConnectionError(code);};
const plain=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
export function storedRequest(value: unknown): OpenStored {
  if(!plain(value)||Object.keys(value).some(k=>!['documentHandle','objectId','expectedSeq','temporaryOptions'].includes(k))||!uuid(value.documentHandle)||!uuid(value.objectId)||!Number.isSafeInteger(value.expectedSeq)||(value.expectedSeq as number)<0) return fail('invalid');
  if(Object.hasOwn(value,'temporaryOptions')) {
    const options=value.temporaryOptions;
    if(!plain(options)||Object.keys(options).some(k=>!['host','port','certificateSha256','width','height','clipboard'].includes(k)))return fail('invalid');
  }
  return structuredClone(value) as OpenStored;
}
type Deps = {
  library: DocumentLibrary;
  open(target:RdpTarget,secret:Secret):Promise<string>;
  prompt(target:RdpTarget,prompt:{id:string;generation:number;currentGeneration():number}):Promise<{username:string;domain:string;password:string}|undefined>;
  approveScope(request:{connection:string;sources:{id:string;name:string}[];target:Pick<RdpTarget,'host'|'port'|'certificateSha256'|'clipboard'>}):Promise<boolean>;
  promptCode?():Promise<string|undefined>;
  now?():number;
  privateSources?(): {doc:Doc;generation:number;unlocked:boolean}[];
  layers?(ref:Ref):Omit<ResolutionLayers,'documentGeneration'>;
};

/** Owns references and scope grants, never resolved passwords. Every connect/reconnect begins with the current open documents. */
export class StoredConnections {
  readonly #refs=new Map<string,Ref>();
  readonly #grants=new Map<string,string>();
  readonly #pending=new Set<string>();
  readonly #temporary=new Map<string,{doc:Doc2;generation:number;seq:number}>();
  constructor(private readonly deps:Deps) {}
  #document(id:string){return this.#temporary.get(id)??this.deps.library.privateDocument(id);}
  #documents(){return [...this.deps.library.privateDocuments().map(d=>({doc:d.doc,generation:d.generation,unlocked:true})),...(this.deps.privateSources?.()??[]),...[...this.#temporary.values()].map(d=>({doc:d.doc,generation:d.generation,unlocked:true}))];}
  forget(id:string):void {const ref=this.#refs.get(id);this.#refs.delete(id);if(ref&&![...this.#refs.values()].some(r=>r.documentHandle===ref.documentHandle)){this.#temporary.delete(ref.documentHandle);this.#grants.delete(`${ref.documentHandle}:${ref.objectId}`);}}
  /** Main-only detached template path; no file, shared document or resolved password is retained. */
  async openTemporary(node:ObjectNode):Promise<StoredOpened>{
    if(this.#temporary.size>=1000)return fail('busy');
    const handle=randomUUID(),objectId=randomUUID();
    const doc=validateV2({schemaVersion:2,id:randomUUID(),kind:'workspace',name:'Ad hoc',revision:0,meta:{createdAt:null,updatedAt:null,sort:[]},defaults:{groups:{}},secrets:{},objects:{[objectId]:{...structuredClone(node),id:objectId,parentId:null,order:0}}});
    if(doc.objects[objectId]!.type!=='connection')return fail('invalid');
    this.#temporary.set(handle,{doc,generation:1,seq:0});
    try{return await this.openStored({documentHandle:handle,objectId,expectedSeq:0});}catch(error){this.#temporary.delete(handle);throw error;}
  }
  async reconnectStored(sessionId: string):Promise<StoredOpened> {
    const ref=this.#refs.get(sessionId);if(!ref)return fail('missing');
    return this.openStored({...ref,expectedSeq:this.#document(ref.documentHandle).seq});
  }
  async openStored(value: unknown):Promise<StoredOpened> {
    const request=storedRequest(value);
    const key=`${request.documentHandle}:${request.objectId}`;
    // Native input is serial even when an untrusted page bypasses its disabled Connect button.
    if(this.#pending.size>0)return fail('busy');
    this.#pending.add(key);
    try{return await this.#open(request,key);}finally{this.#pending.delete(key);}
  }
  async #open(request:OpenStored,key:string):Promise<StoredOpened> {
    const expiresAt=(this.deps.now?.()??Date.now())+120000;
    const state=this.#document(request.documentHandle),doc=state.doc;
    if(state.seq!==request.expectedSeq)return fail('stale');
    if(doc.schemaVersion!==2||doc.kind==='overrides')return fail('invalid');
    const node=Object.hasOwn(doc.objects,request.objectId)?doc.objects[request.objectId]:undefined;
    if(node?.type!=='connection'||node.props.protocol!=='rdp')return fail('not-supported');
    const currentLayers=()=>this.#temporary.has(request.documentHandle)?{}:(this.deps.layers?.(request)??{});
    const initialLayers=currentLayers(),layerStamp=JSON.stringify(initialLayers);
    const layers={...initialLayers,documentGeneration:state.generation};
    const result=resolveEffective(doc,node.id,layers);if(!result.ok)return fail(result.error.code);
    const effective=result.value;
    for(const group of ['preConnectTask','postDisconnectTask','keySequence','rdGateway','managementEndpoint','secureGateway'] as const) {
      const supported=useEffectiveGroup(effective,group);if(!supported.ok)return fail('not-supported');
    }
    if(checkStored({...node.props,username:node.props.username===undefined||node.props.username===''?'credential-pending':node.props.username}).length)return fail('invalid');
    const base=fromProps(node.props);
    if(base.certificateSha256&&request.temporaryOptions&&Object.hasOwn(request.temporaryOptions,'certificateSha256')&&!request.temporaryOptions.certificateSha256)return fail('invalid');
    const target: RdpTarget={host:base.host,port:base.port,username:base.username||'credential-pending',certificateSha256:base.certificateSha256,clipboard:{toRemote:base.clipboardToRemote,fromRemote:base.clipboardFromRemote},...request.temporaryOptions};
    validateTarget(target);
    let sourceGenerations:{id:string;generation:number}[]=[];
    const assertCurrent=()=>{
      if((this.deps.now?.()??Date.now())>=expiresAt)return fail('stale');
      if(JSON.stringify(currentLayers())!==layerStamp)return fail('stale');
      let now;try{now=this.#document(request.documentHandle);}catch{return fail('stale');}
      if(now.generation!==state.generation||now.seq!==state.seq)return fail('stale');
      for(const source of sourceGenerations) {
        const matches=this.#documents().filter(d=>d.doc.id===source.id);
        if(matches.length!==1||matches[0].generation!==source.generation||!matches[0].unlocked)return fail('stale');
      }
    };
    const documents=()=>this.#documents();
    const binding=effective.private.credentialBinding;
    let identity:ResolvedCredential;
    if(binding) {
      const selection=binding.selection;
      const scope=selection.mode==='id'?[selection.vaultId]:selection.mode==='name'?selection.scopeVaultIds:[];
      const sourceStates=documents();
      const usedSources=new Set([binding.ownerDocumentId,...scope]);
      if(sourceStates.some(d=>usedSources.has(d.doc.id)&&!d.unlocked))return fail('locked');
      sourceGenerations=sourceStates.filter(d=>usedSources.has(d.doc.id)).map(d=>({id:d.doc.id,generation:d.generation}));
      const approvedTarget={host:target.host,port:target.port,certificateSha256:target.certificateSha256,clipboard:target.clipboard};
      const signature=JSON.stringify([binding,approvedTarget,scope.map(id=>sourceStates.filter(d=>d.doc.id===id).map(d=>[d.doc.id,d.generation]))]);
      if(selection.mode!=='none'&&this.#grants.get(key)!==signature) {
        const approvalSources=scope.length?scope:[binding.ownerDocumentId];
        const sources=approvalSources.map(id=>{const matches=sourceStates.filter(d=>d.doc.id===id);if(matches.length!==1)return fail('missing');return{id,name:matches[0].doc.name};});
        if(!await this.deps.approveScope({connection:node.name,sources,target:structuredClone(approvedTarget)}))return fail('scope-denied');
        assertCurrent();
        if(JSON.stringify(scope.map(id=>documents().filter(d=>d.doc.id===id).map(d=>[d.doc.id,d.generation])))!==JSON.stringify(scope.map(id=>sourceStates.filter(d=>d.doc.id===id).map(d=>[d.doc.id,d.generation]))))return fail('stale');
        this.#grants.set(key,signature);
      }
      identity=resolveCredential(binding,{documents:documents(),scope:new Set(scope)});
      // A protocol's public username remains meaningful when credential lookup was explicitly disabled.
      if(selection.mode==='none')identity={...identity,username:base.username};
    } else {
      const entered=await this.deps.prompt(target,{id:randomUUID(),generation:state.generation,currentGeneration:()=>{try{return this.#document(request.documentHandle).generation;}catch{return -1;}}});
      assertCurrent();if(!entered)return fail('cancelled');
      identity={...entered,...normalizeIdentity(entered.username||base.username,entered.domain)};
    }
    assertCurrent();
    if(identity.privateKey||identity.passphrase)return fail('not-supported');
    let mfa:MfaConfig={mode:'none'};
    if(node.props.mfa!==undefined) {
      const raw=node.props.mfa;
      if(!plain(raw)||Object.keys(raw).some(k=>!['mode','field','pattern'].includes(k)))return fail('invalid');
      if(raw.mode==='none') {if(Object.keys(raw).length!==1)return fail('invalid');}
      else if((raw.mode==='prompt'||raw.mode==='generate')&&(raw.field==='username'||raw.field==='password')&&(raw.pattern==='ValueMfaCode'||raw.pattern==='MfaCodeValue')) {
        if(raw.mode==='generate') {if(!identity.totp)return fail('invalid');mfa={mode:'generate',field:raw.field,pattern:raw.pattern,totp:identity.totp};}
        else mfa={mode:'prompt',field:raw.field,pattern:raw.pattern};
      }
      else return fail('invalid');
    }
    let promptCode:string|undefined;
    if(mfa.mode==='prompt') {if(!this.deps.promptCode)return fail('not-supported');promptCode=await this.deps.promptCode();assertCurrent();if(promptCode===undefined)return fail('cancelled');}
    const unixSeconds=(this.deps.now?.()??Date.now())/1000;
    const composed=composeMfa(identity,mfa,{unixSeconds,...(promptCode===undefined?{}:{promptCode:{value:promptCode,expiresAt:unixSeconds+30}})});
    target.username=composed.username;
    validateTarget(target);
    const sessionId=await this.deps.open(target,{domain:identity.domain,password:composed.password??''});
    this.#refs.set(sessionId,{documentHandle:request.documentHandle,objectId:request.objectId});
    const color=effective.public.groups.color;
    return{sessionId,label:node.name,publicTarget:{...target,username:identity.username},...(typeof color==='string'?{color}:{})};
  }
}

export function registerStoredIpc(deps:{ipc:{handle(channel:string,listener:(event:any,payload?:unknown)=>unknown):void};check(event:any):void;service:Pick<StoredConnections,'openStored'|'reconnectStored'|'forget'>}):void {
  const messages:Record<string,string>={stale:'Dokumen atau sumber kredensial berubah; coba hubungkan lagi.',cancelled:'Dibatalkan.','scope-denied':'Sumber kredensial belum diizinkan.',missing:'Dokumen atau kredensial tidak tersedia.',locked:'Buka kunci sumber kredensial dahulu.',ambiguous:'Nama kredensial tidak unik. Pilih sumber yang tepat.','not-supported':'Kapabilitas ini belum didukung.',invalid:'Data koneksi tidak valid.',busy:'Koneksi ini sedang dibuka.'};
  const on=(channel:string,run:(payload:unknown)=>unknown)=>deps.ipc.handle(channel,async(event,payload)=>{
    try{deps.check(event);}catch{return{ok:false,code:'denied',message:'Akses ditolak.'};}
    try{return{ok:true,value:await run(payload)};}catch(error){const {code}=redactCredentialError(error);return{ok:false,code,message:messages[code]??'Koneksi tidak dapat dibuka.'};}
  });
  const sessionId=(payload:unknown):string=>typeof payload==='string'&&payload.length>0&&payload.length<=128?payload:fail('invalid');
  on('rdp:open-stored',payload=>deps.service.openStored(payload));
  on('rdp:reconnect-stored',payload=>deps.service.reconnectStored(sessionId(payload)));
  on('rdp:forget-stored',payload=>{deps.service.forget(sessionId(payload));});
}
