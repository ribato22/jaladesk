import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {RdpProfiles,type ProfileLease} from './profile.js';
import {makeOwner,type Session} from './owner.js';
import type {RdpTarget,Secret,Sink} from './wire.js';

type Launch=(path:string,args:readonly string[],env:NodeJS.ProcessEnv)=>ChildProcessWithoutNullStreams;
const launch:Launch=(path,args,env)=>spawn(path,[...args],{env,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
const cancelled=()=>Object.assign(new Error('Connection cancelled'),{code:'cancelled'});
function start(lease:ProfileLease,helper:string,args:readonly string[],run:Launch,env:NodeJS.ProcessEnv,signal?:AbortSignal){
  if(signal?.aborted)throw cancelled();
  const child=run(helper,args,{...env,RW_RDP_CONFIG_PATH:lease.path});
  child.stdin.on('error',()=>{});lease.bind(child);
  if(signal?.aborted){child.kill('SIGKILL');throw cancelled();}return child;
}
export function createProfiledOwner(options:{root:string;helper:string;launch?:Launch}){
  const profiles=new RdpProfiles(options);
  return {async open(target:RdpTarget,secret:Secret,sink:Sink,context:{signal?:AbortSignal}={}):Promise<Session>{
    const {signal}=context,lease=await profiles.prepare(signal);let child:ChildProcessWithoutNullStreams|undefined,session:Session|undefined;
    const abort=()=>{if(session)void session.close().catch(()=>child?.kill('SIGKILL'));else child?.kill('SIGKILL');};
    signal?.addEventListener('abort',abort,{once:true});
    const remove=()=>signal?.removeEventListener('abort',abort);void lease.closed.then(remove,remove);
    try{
      const owner=makeOwner((path,args)=>{child=start(lease,path,args,options.launch??launch,process.env,signal);return child;},options.helper);
      session=await owner.open(target,secret,sink);
      if(signal?.aborted){await session.close();await lease.closed;throw cancelled();}
      const active=session;return {...active,async close(){await active.close();await lease.closed;}};
    }catch(error){
      remove();if(child)child.kill('SIGKILL');await lease.close();throw error;
    }
  }};
}
export async function spawnProfiledHelper(helper:string,args:readonly string[],options:{root:string;env?:NodeJS.ProcessEnv;signal?:AbortSignal}){
  const lease=await new RdpProfiles({root:options.root,helper}).prepare(options.signal);
  let child:ChildProcessWithoutNullStreams;
  try{child=start(lease,helper,args,launch,options.env??process.env,options.signal);}catch(error){await lease.close();throw error;}
  const stop=()=>child.kill('SIGKILL');options.signal?.addEventListener('abort',stop,{once:true});
  const remove=()=>options.signal?.removeEventListener('abort',stop);void lease.closed.then(remove,remove);
  if(options.signal?.aborted)stop();return {child,closed:lease.closed};
}
export async function closeProfiledSessions(sessions:Iterable<Session>,report:(message:string)=>void):Promise<void>{
  for(const result of await Promise.allSettled([...sessions].map(session=>session.close())))if(result.status==='rejected'){
    report(result.reason?.code==='cleanup-pending'?'RDP profile cleanup pending':'RDP profile cleanup incomplete');
  }
}
