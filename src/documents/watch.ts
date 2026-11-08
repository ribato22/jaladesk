// Observe ciphertext identity only; document replacement remains an explicit user decision.
import{watch as watchFs,createReadStream}from'node:fs';import{dirname,basename}from'node:path';import{createHash}from'node:crypto';import{MAX_PAYLOAD_BYTES,HEADER_BYTES,TAG_BYTES}from'./envelope.js';
const MAX_FILE_BYTES=MAX_PAYLOAD_BYTES+HEADER_BYTES+TAG_BYTES;
async function fileDigest(path:string){let size=0;const hash=createHash('sha256');for await(const chunk of createReadStream(path)){size+=chunk.length;if(size>MAX_FILE_BYTES)throw Object.assign(Error('Ciphertext too large'),{code:'EFBIG'});hash.update(chunk);}return hash.digest('hex');}
export type WatchNotice={id:string;status:'changed'|'missing'|'unreadable';dirty:boolean;actions:['reload','save-merge']};
export type WatchState={digest():string;dirty():boolean;writing?():boolean};
export type WatchDependencies={watch?:(parent:string,event:(name:string|null)=>void,error:()=>void)=>()=>void;read?:(path:string)=>Promise<Buffer>;schedule?:(callback:()=>void,ms:number)=>()=>void};
type Entry={path:string;state:WatchState;close:()=>void;cancel?:()=>void;last?:string};
export class DocumentWatcher{
 #entries=new Map<string,Entry>();#listeners=new Set<(notice:WatchNotice)=>void>();
 constructor(private readonly deps:WatchDependencies={}){}
 subscribe(listener:(notice:WatchNotice)=>void){this.#listeners.add(listener);return()=>{this.#listeners.delete(listener);};}
 start(id:string,path:string,state:WatchState){
  if(this.#entries.has(id))throw Object.assign(Error('Already watched'),{code:'watch-duplicate'});
  if(this.#entries.size>=100)throw Object.assign(Error('At most 100 watched files'),{code:'watch-limit'});
  const entry:Entry={path,state,close:()=>{}};this.#entries.set(id,entry);
  const emit=(status:WatchNotice['status'],mark:string)=>{if(this.#entries.get(id)!==entry||entry.last===mark)return;entry.last=mark;const notice:WatchNotice={id,status,dirty:state.dirty(),actions:['reload','save-merge']};for(const listener of this.#listeners)try{listener(notice);}catch{/* An observer cannot stop the other observers. */}};
  const inspect=async()=>{if(state.writing?.()){queue(null);return;}try{let digest:string;if(this.deps.read){const bytes=await this.deps.read(path);if(bytes.length>MAX_FILE_BYTES)throw Object.assign(Error('Ciphertext too large'),{code:'EFBIG'});digest=createHash('sha256').update(bytes).digest('hex');}else digest=await fileDigest(path);if(this.#entries.get(id)!==entry)return;if(state.writing?.()){queue(null);return;}if(digest!==state.digest())emit('changed',digest);else entry.last=undefined;}catch(error){if(this.#entries.get(id)!==entry)return;if(state.writing?.()){queue(null);return;}emit((error as{code?:string}).code==='ENOENT'?'missing':'unreadable',(error as{code?:string}).code==='ENOENT'?'missing':'unreadable');}};
  const queue=(name:string|null)=>{if(this.#entries.get(id)!==entry||name!==null&&name!==basename(path))return;entry.cancel?.();entry.cancel=(this.deps.schedule??((callback,ms)=>{const timer=setTimeout(callback,ms);return()=>clearTimeout(timer);} ))(()=>{entry.cancel=undefined;void inspect();},150);};
  const watch=this.deps.watch??((parent,event,error)=>{const watcher=watchFs(parent,(_type,name)=>event(name===null?null:String(name)));watcher.on('error',error);return()=>watcher.close();});
  try{entry.close=watch(dirname(path),queue,()=>emit('unreadable','watch-error'));}catch(error){this.#entries.delete(id);throw error;}
 }
 stop(id:string){const entry=this.#entries.get(id);if(!entry)return;this.#entries.delete(id);entry.cancel?.();entry.close();}
 close(){for(const id of this.#entries.keys())this.stop(id);this.#listeners.clear();}
}
