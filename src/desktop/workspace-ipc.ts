import {isPlainRecord} from '../documents/groups.js';
import {redactCredentialError} from '../credentials/model.js';
export type WorkspaceAction={keys:readonly string[];changes?:boolean;run(input:Record<string,unknown>):unknown|Promise<unknown>};
export function registerWorkspaceIpc(deps:{ipc:{handle(name:string,fn:(event:any,action:unknown,input?:unknown)=>Promise<unknown>):void};check(event:any):void;actions:Record<string,WorkspaceAction>;refresh?():void}){
 let pending=false;
 deps.ipc.handle('workspace:run',async(event,action,input)=>{
  let held=false;try{
   deps.check(event);
   if(typeof action!=='string'||action.length>64||!Object.hasOwn(deps.actions,action))throw Object.assign(new Error(),{code:'invalid'});
   const spec=deps.actions[action]!,value=input??{};
   if(!isPlainRecord(value)||Object.keys(value).some(k=>!spec.keys.includes(k))||Buffer.byteLength(JSON.stringify(value),'utf8')>(action==='bulk.preview'?16*1024*1024:262144))throw Object.assign(new Error(),{code:'invalid'});
   if(spec.changes){if(pending)throw Object.assign(new Error(),{code:'busy'});pending=true;held=true;}
   const result=await spec.run(value);if(spec.changes)deps.refresh?.();return{ok:true,value:result};
  }catch(error){const safeTokenCodes=['missing-token','unknown-token','secret-token','token-limit'];const raw=(error as {code?:unknown})?.code;const code=typeof raw==='string'&&safeTokenCodes.includes(raw)?raw:redactCredentialError(error).code;return{ok:false,code,message:code==='missing-token'?'Nilai token publik belum diisi.':code==='unknown-token'?'Token tidak dikenal.':code==='secret-token'?'Token rahasia tidak boleh dipakai pada field publik.':code==='token-limit'?'Ekspresi atau hasil token melewati batas.':code==='stale'?'Data berubah; muat ulang sebelum menerapkan.':code==='cancelled'?'Dibatalkan.':code==='locked'?'Buka kunci sumber privat dahulu.':code==='busy'?'Dialog lain sedang terbuka.':'Operasi tidak dapat diselesaikan.'};}finally{if(held)pending=false;}
 });
}
