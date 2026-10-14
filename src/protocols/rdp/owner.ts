import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {FrameStream,validateInput,validateTarget} from './wire.js';
import type {Frame} from './wire.js';
import type {RdpTarget,Secret,Sink,Input} from './wire.js';
export type Session={send(input:Input):void;close():Promise<void>};
export type HelperLauncher=(path:string,args:readonly string[])=>ChildProcessWithoutNullStreams;
export function makeOwner(launch:HelperLauncher,path:string) {
  return {async open(target:RdpTarget,secret:Secret,sink:Sink):Promise<Session>{
    target=validateTarget(target);
    if(typeof secret.password!=='string'||typeof secret.domain!=='string'||secret.password.length>4096||secret.domain.length>256)throw new Error('invalid credential');
    const child=launch(path,['--bridge-v1']);const stream=new FrameStream();
    let closing=false,failed=false,exited=false,status='',pending:Frame|undefined,scheduled=false;
    let resolveExit:()=>void=()=>{};
    const exit=new Promise<void>(resolve=>{resolveExit=resolve;});
    const deadline=setTimeout(()=>fail('connection-timeout'),30000);deadline.unref();
    function fail(reason:string) {
      if(closing||failed)return;failed=true;pending=undefined;clearTimeout(deadline);sink.state('failed',reason);child.kill();
    }
    sink.state('connecting');
    child.on('error',()=>fail('helper-start'));
    child.stdin.on('error',()=>fail('helper-input'));
    child.stdout.on('data',(bytes:Buffer)=>{
      if(closing||failed)return;
      try {for(const frame of stream.push(bytes))pending=frame;}catch{fail('frame-protocol');return;}
      if(!scheduled&&pending){scheduled=true;setImmediate(()=>{scheduled=false;const frame=pending;pending=undefined;if(frame&&!closing&&!failed)sink.frame(frame);});}
    });
    child.stderr.on('data',(bytes:Buffer)=>{
      if(closing||failed)return;
      status+=bytes.toString('utf8');if(Buffer.byteLength(status)>65536){fail('status-protocol');return;}
      let end:number;
      while((end=status.indexOf('\n'))>=0){
        const line=status.slice(0,end);status=status.slice(end+1);
        try {
          const v=JSON.parse(line);
          if(v.state==='connected'){clearTimeout(deadline);sink.state('connected');}
          else if(v.state==='failed'){
            const reasons=['authentication','certificate','connection','control-protocol','surface','resize-reconnect'];
            fail(reasons.includes(v.reason)?v.reason:'helper-failure');return;
          }else if(v.state!=='connecting'&&v.state!=='closed'){fail('status-protocol');return;}
        }catch{fail('status-protocol');return;}
      }
    });
    child.on('close',()=>{
      exited=true;clearTimeout(deadline);
      if(!closing&&!failed){try{stream.finish();}catch{fail('frame-protocol');}if(!failed)fail('helper-exit');}
      if(closing&&!failed)sink.state('closed');resolveExit();
    });
    child.stdin.write(JSON.stringify({type:'connect',target,secret})+'\n');
    const session:Session={
      send(value:Input){if(closing||failed||exited)return;const input=validateInput(value);if(input.type==='close'){void this.close();return;}if(child.stdin.writableLength>65536){fail('input-budget');return;}child.stdin.write(JSON.stringify(input)+'\n');},
      async close(){
        if(!closing){closing=true;pending=undefined;clearTimeout(deadline);if(!exited)child.stdin.end('{"type":"close"}\n');}
        if(exited)return;
        const kill=setTimeout(()=>child.kill('SIGKILL'),1500);kill.unref();await exit;clearTimeout(kill);
      }
    };return session;
  }};
}
export function ipcAllowed(source:{senderId:number;frameUrl:string;isMainFrame:boolean},id:number,url:string):boolean {
  return source.senderId===id&&source.isMainFrame&&source.frameUrl===url;
}
