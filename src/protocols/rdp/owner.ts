import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {FrameStream,validateInput,validateTarget} from './wire.js';
import {decodeClipboard,encodeClipboard} from './clipboard.js';
import type {ClipboardResult} from './clipboard.js';
import type {Clipboard,Frame} from './wire.js';
import type {RdpTarget,Secret,Sink,Input} from './wire.js';
export type Session={send(input:Input):void;close():Promise<void>;readonly clipboard:Clipboard;sendClipboard(text:string):ClipboardResult};
const STATUS_LINE_LIMIT=65536;
// Why the server ended a session (the helper reads it from the server's disconnect message): another connection took the session over,
// a logoff, a disconnect by an administrator or user on the server, a server time limit, a refusal, or no reason at all.
const serverReasons=['other-connection','logoff','admin-disconnect','timeout','server-denied','server-closed'];
export type HelperLauncher=(path:string,args:readonly string[])=>ChildProcessWithoutNullStreams;
export function makeOwner(launch:HelperLauncher,path:string) {
  return {async open(target:RdpTarget,secret:Secret,sink:Sink):Promise<Session>{
    target=validateTarget(target);
    const clipboard:Clipboard=Object.freeze({toRemote:target.clipboard?.toRemote??false,fromRemote:target.clipboard?.fromRemote??false});
    if(typeof secret.password!=='string'||typeof secret.domain!=='string'||secret.password.length>4096||secret.domain.length>256)throw new Error('invalid credential');
    const child=launch(path,['--bridge-v1']);const stream=new FrameStream();
    let closing=false,over=false,exited=false,status='',pending:Frame|undefined,scheduled=false;
    let resolveExit:()=>void=()=>{};
    const exit=new Promise<void>(resolve=>{resolveExit=resolve;});
    const deadline=setTimeout(()=>fail('connection-timeout'),30000);deadline.unref();
    // The one place a session ends on its own, failed or closed by the server; whatever the helper says afterwards is ignored.
    function finish(state:'failed'|'closed',reason:string,lastError?:number,authenticationGrace=false) {
      if(closing||over)return;over=true;pending=undefined;stream.reset();clearTimeout(deadline);sink.state(state,reason,lastError);if(authenticationGrace)void session.close().catch(()=>child.kill());else child.kill();
    }
    const fail=(reason:string,lastError?:number)=>finish('failed',reason,lastError);
    // A failing clipboard sink (for example an OS clipboard that refuses the write) must not end the session.
    const deliver=(text:string)=>{try{sink.clipboard?.(text);}catch{}};
    sink.state('connecting');
    child.on('error',()=>fail('helper-start'));
    child.stdin.on('error',()=>fail('helper-input'));
    child.stdout.on('data',(bytes:Buffer)=>{
      if(closing||over)return;
      try {for(const frame of stream.push(bytes))pending=frame;}catch{fail('frame-protocol');return;}
      if(!scheduled&&pending){scheduled=true;setImmediate(()=>{scheduled=false;const frame=pending;pending=undefined;if(frame&&!closing&&!over)sink.frame(frame);});}
    });
    child.stderr.on('data',(bytes:Buffer)=>{
      if(closing||over)return;
      status+=bytes.toString('utf8');
      let end:number;
      while((end=status.indexOf('\n'))>=0){
        const line=status.slice(0,end);status=status.slice(end+1);
        if(Buffer.byteLength(line)>STATUS_LINE_LIMIT){fail('status-protocol');return;}
        try {
          const v=JSON.parse(line);
          if(v.event!==undefined) {
            // Remote clipboard text: only the opted-in direction is delivered; anything malformed ends the session.
            if(v.event!=='clipboard'||typeof v.b64!=='string'||Object.keys(v).length!==2){fail('status-protocol');return;}
            if(!clipboard.fromRemote)continue;
            const text=decodeClipboard(v.b64);
            if(text)deliver(text);
            continue;
          }
          if(v.lastError!==undefined&&((v.state!=='failed'&&v.state!=='closed')||!Number.isInteger(v.lastError)||v.lastError<0||v.lastError>0xffffffff)){fail('status-protocol');return;}
          if(v.state==='connected'){clearTimeout(deadline);sink.state('connected');}
          else if(v.state==='failed'){
            const reasons=['authentication','certificate','connection','control-protocol','surface','resize-reconnect'];
            if(v.reason==='authentication')finish('failed','authentication',v.lastError,true);else fail(reasons.includes(v.reason)?v.reason:'helper-failure',v.lastError);return;
          }else if(v.state==='closed'){
            // Only the server can end a session the client did not ask to close (closing ignores later status lines); its reason is one of ours or none.
            finish('closed',serverReasons.includes(v.reason)?v.reason:'server-closed',v.lastError);return;
          }else if(v.state!=='connecting'){fail('status-protocol');return;}
        }catch{fail('status-protocol');return;}
      }
      if(Buffer.byteLength(status)>STATUS_LINE_LIMIT)fail('status-protocol');
    });
    child.on('close',()=>{
      exited=true;clearTimeout(deadline);
      if(!closing&&!over){try{stream.finish();}catch{fail('frame-protocol');}if(!over)fail('helper-exit');}
      if(closing&&!over)sink.state('closed');resolveExit();
    });
    child.stdin.write(JSON.stringify({type:'connect',target,secret})+'\n');
    const session:Session={
      clipboard,
      sendClipboard(text:string):ClipboardResult{
        if(closing||over||exited)return 'closed';
        if(!clipboard.toRemote)return 'disabled';
        let b64:string;try{b64=encodeClipboard(text);}catch(error){return (error as Error).message.endsWith('too-large')?'too-large':'invalid';}
        if(child.stdin.writableLength>65536){fail('input-budget');return 'closed';}
        child.stdin.write(JSON.stringify({type:'clipboard',b64})+'\n');return 'sent';
      },
      send(value:Input){if(closing||over||exited)return;const input=validateInput(value);if(input.type==='close'){void this.close();return;}if(child.stdin.writableLength>65536){fail('input-budget');return;}child.stdin.write(JSON.stringify(input)+'\n');},
      async close(){
        if(!closing){closing=true;pending=undefined;stream.reset();clearTimeout(deadline);if(!exited)child.stdin.end('{"type":"close"}\n');}
        if(exited)return;
        const kill=setTimeout(()=>child.kill('SIGKILL'),1500);kill.unref();await exit;clearTimeout(kill);
      }
    };return session;
  }};
}
export function ipcAllowed(source:{senderId:number;frameUrl:string;isMainFrame:boolean},id:number,url:string):boolean {
  return source.senderId===id&&source.isMainFrame&&source.frameUrl===url;
}
