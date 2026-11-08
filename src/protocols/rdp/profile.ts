import cp from 'node:child_process';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open,readdir,realpath,rmdir,unlink} from 'node:fs/promises';
import {join} from 'node:path';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const unavailable=()=>new Error('RDP profile unavailable');
const cleanupError=()=>new Error('RDP profile cleanup incomplete');
const cleanupPending=()=>Object.assign(new Error('RDP profile cleanup pending'),{code:'cleanup-pending'});
const identity=(s:{dev:bigint;ino:bigint})=>`${s.dev}:${s.ino}`;
const check=(ok:unknown)=>{if(!ok)throw unavailable();};
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.sort().join(',');
const abort=(signal?:AbortSignal)=>{if(signal?.aborted)throw unavailable();};
function absent(pid:number){try{process.kill(pid,0);return false;}catch(error){return (error as NodeJS.ErrnoException).code==='ESRCH';}}
type Marker={schema:1;profileId:string;appInstanceId:string;ownerPid:number};
export type ProfileLease={readonly path:string;readonly closed:Promise<void>;bind(child:ChildProcessWithoutNullStreams):void;close():Promise<void>};

// A reporting deadline does not cancel filesystem IO. Keep the original promise alive and observed.
function reported<T>(pending:Promise<T>,ms:number,error:()=>Error):Promise<T>{
  let timer:ReturnType<typeof setTimeout>;
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(error()),ms);});
  return Promise.race([pending,timeout]).finally(()=>clearTimeout(timer));
}
async function marker(path:string){
  const before=await lstat(path,{bigint:true});check(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n&&before.size<=4096n);
  if(process.platform!=='win32')check(before.uid===BigInt(process.geteuid!())&&(before.mode&0o7777n)===0o600n);
  const file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{
    const st=await file.stat({bigint:true});check(identity(st)===identity(before)&&st.size<=4096n);
    const bytes=Buffer.alloc(4097),read=await file.read(bytes,0,bytes.length,0);check(read.bytesRead<=4096);
    const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,read.bytesRead));
    const value:unknown=JSON.parse(text);check(text===JSON.stringify(value));return value;
  }finally{await file.close();}
}
async function writeMarker(path:string,value:unknown){
  const file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);
  try{await file.writeFile(JSON.stringify(value));}finally{await file.close();}
}
function leaseMarker(v:unknown,name:string):v is Marker{
  return exact(v,['schema','profileId','appInstanceId','ownerPid'])&&v.schema===1&&v.profileId===name&&typeof v.appInstanceId==='string'&&uuid.test(v.appInstanceId)&&Number.isSafeInteger(v.ownerPid)&&Number(v.ownerPid)>0&&Number(v.ownerPid)<=0xffffffff;
}

export class RdpProfiles {
  private queue:Promise<unknown>=Promise.resolve();
  private readonly instance=randomUUID();
  constructor(private readonly options:{root:string;helper:string}){}
  private async policy(op:'create'|'inspect',path:string,signal?:AbortSignal){
    abort(signal);const requestId=randomUUID();
    await new Promise<void>((resolve,reject)=>{
      let child:ChildProcessWithoutNullStreams;
      try{child=cp.spawn(this.options.helper,['--profile-policy'],{stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true});}catch{reject(unavailable());return;}
      let out=Buffer.alloc(0),err=0,failed=false;
      const stop=()=>{failed=true;child.kill('SIGKILL');};
      const timer=setTimeout(stop,5000);signal?.addEventListener('abort',stop,{once:true});
      child.on('error',()=>{failed=true;});child.stdin.on('error',()=>{failed=true;});
      child.stdout.on('data',(b:Buffer)=>{if(out.length+b.length>4096){stop();return;}out=Buffer.concat([out,b]);});
      child.stderr.on('data',(b:Buffer)=>{err+=b.length;if(err>4096)stop();});
      child.once('close',(code,termination)=>{
        clearTimeout(timer);signal?.removeEventListener('abort',stop);
        try{
          check(!failed&&!signal?.aborted&&code===0&&termination===null&&err===0);
          const text=new TextDecoder('utf-8',{fatal:true}).decode(out),v:unknown=JSON.parse(text);
          check(text===JSON.stringify(v)+'\n');
          check(exact(v,['schema','op','requestId','owner','private'])&&v.schema===1&&v.op===op&&v.requestId===requestId&&v.owner===true&&v.private===true);resolve();
        }catch{reject(unavailable());}
      });
      child.stdin.end(JSON.stringify({schema:1,op,path,requestId})+'\n');
      if(signal?.aborted)stop();
    });
  }
  private async root(signal?:AbortSignal){
    const root=join(await realpath(this.options.root),'rdp-profiles-v1');abort(signal);
    let created=false;
    try{await lstat(root);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await this.policy('create',root,signal);created=true;}
    if(created){
      try{await writeMarker(join(root,'root.json'),{schema:1,kind:'rdp-profiles',rootId:randomUUID()});}
      catch{try{if((await readdir(root)).length===0)await rmdir(root);}catch{}throw unavailable();}
    }
    await this.policy('inspect',root,signal);const value=await marker(join(root,'root.json'));
    check(exact(value,['schema','kind','rootId'])&&value.schema===1&&value.kind==='rdp-profiles'&&typeof value.rootId==='string'&&uuid.test(value.rootId));
    return {path:root,id:identity(await lstat(root,{bigint:true})),marker:JSON.stringify(value)};
  }
  private async verify(root:{path:string;id:string;marker:string},path:string,id:string,value:Marker){
    check(identity(await lstat(root.path,{bigint:true}))===root.id&&JSON.stringify(await marker(join(root.path,'root.json')))===root.marker);
    await this.policy('inspect',root.path);const st=await lstat(path,{bigint:true});
    check(st.isDirectory()&&!st.isSymbolicLink()&&identity(st)===id);
    await this.policy('inspect',path);check(JSON.stringify(await marker(join(path,'lease.json')))===JSON.stringify(value));
  }
  private async remove(root:{path:string;id:string;marker:string},path:string,id:string,value:Marker,stale=false){
    await this.verify(root,path,id,value);
    const files:{path:string;id:string;dir:boolean}[]=[];
    const scan=async(dir:string,depth:number)=>{
      check(depth<=8);const before=await lstat(dir,{bigint:true});check(before.isDirectory()&&!before.isSymbolicLink());
      const entries=await readdir(dir);check(identity(await lstat(dir,{bigint:true}))===identity(before));
      for(const name of entries){
        check(files.length<1024);const next=join(dir,name),st=await lstat(next,{bigint:true});check(!st.isSymbolicLink()&&(st.isDirectory()||st.isFile()));
        if(st.isFile())check(st.nlink===1n);files.push({path:next,id:identity(st),dir:st.isDirectory()});if(st.isDirectory())await scan(next,depth+1);
      }
    };
    await scan(path,0);await this.verify(root,path,id,value);
    if(stale)check(absent(value.ownerPid));
    for(const entry of files.reverse()){
      const st=await lstat(entry.path,{bigint:true});check(identity(st)===entry.id&&!st.isSymbolicLink());
      if(entry.dir)await rmdir(entry.path);else if(entry.path!==join(path,'lease.json'))await unlink(entry.path);
    }
    await this.verify(root,path,id,value);await unlink(join(path,'lease.json'));await rmdir(path);
  }
  private async prepareNow(signal:AbortSignal):Promise<ProfileLease>{
    abort(signal);const root=await this.root(signal);abort(signal);
    const names=await readdir(root.path);check(names.length<=257);let swept=0;
    for(const name of names){
      abort(signal);if(!uuid.test(name)||swept===16)continue;
      const path=join(root.path,name);
      try{
        const v=await marker(join(path,'lease.json'));if(!leaseMarker(v,name))continue;
        if(!absent(v.ownerPid))continue;
        swept++;const st=await lstat(path,{bigint:true});await this.remove(root,path,identity(st),v,true);
      }catch{}
    }
    const entries=await readdir(root.path);check(entries.length<=256);
    // Unknown root entries are never deleted or used as spare capacity.
    check(entries.filter(n=>n!=='root.json').length<256);abort(signal);
    const profileId=randomUUID(),path=join(root.path,profileId);await this.policy('create',path,signal);
    const id=identity(await lstat(path,{bigint:true})),value:Marker={schema:1,profileId,appInstanceId:this.instance,ownerPid:process.pid};
    try{await writeMarker(join(path,'lease.json'),value);}catch{try{if((await readdir(path)).length===0)await rmdir(path);}catch{}throw unavailable();}
    let child:ChildProcessWithoutNullStreams|undefined,started=false,cleanup:Promise<void>|undefined;
    let done!:()=>void,fail!:(e:Error)=>void;
    const closed=new Promise<void>((yes,no)=>{done=yes;fail=no;});void closed.catch(()=>{});
    const release=()=>{
      if(!cleanup){
        cleanup=reported(this.remove(root,path,id,value).catch(()=>{throw cleanupError();}),5000,cleanupPending);
        cleanup.then(done,fail);
      }
      return closed;
    };
    const lease:ProfileLease={path,closed,
      bind(owned){check(!started&&!cleanup);started=true;child=owned;owned.once('close',()=>{void release();});},
      close(){if(child)return closed;return release();}
    };
    if(signal.aborted){await lease.close();throw unavailable();}return lease;
  }
  prepare(signal?:AbortSignal):Promise<ProfileLease>{
    const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(),10000);
    const combined=signal?AbortSignal.any([signal,deadline.signal]):deadline.signal;
    const pending=this.queue.then(()=>this.prepareNow(combined));this.queue=pending.catch(()=>{});
    return reported(pending,10000,unavailable).catch(()=>{throw unavailable();}).finally(()=>clearTimeout(timer));
  }
}
