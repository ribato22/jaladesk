import {createHash} from 'node:crypto';import {cpSync,existsSync,mkdirSync} from 'node:fs';import {join} from 'node:path';import {spawnSync} from 'node:child_process';
export function verifyHash(bytes,expected){if(createHash('sha256').update(bytes).digest('hex')!==expected)throw new Error('archive hash mismatch');}
export function stageRuntime(source,dest,name){if(!existsSync(join(source,name)))throw new Error('native executable missing');mkdirSync(dest,{recursive:true});cpSync(source,dest,{recursive:true});}
export function verifyRuntime(binary){
 const env=process.platform==='win32'?{...process.env,PATH:join(process.env.SystemRoot||'C:\\Windows','System32')}:process.env;
 const r=spawnSync(binary,['--fixture'],{input:'{"type":"connect"}\n{"type":"close"}\n',timeout:30000,env});
 const expected=Buffer.from([16,0,0,0,2,0,0,0,1,0,0,0,255,0,0,255,0,255,0,255]);
 if(r.error||r.status!==0||!r.stdout?.equals(expected))throw new Error('staged native runtime failed its fixture self-check');
}
