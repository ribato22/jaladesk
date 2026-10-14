import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';import {resolve,join} from 'node:path';import {spawnSync} from 'node:child_process';
import {gateReady,requiredChecks} from '../dist/src/protocols/rdp/acceptance.js';
const app=fileURLToPath(new URL('../',import.meta.url)),file=join(app,'lab/rdp-acceptance.json');mkdirSync(join(app,'lab'),{recursive:true});
let report;
if(existsSync(file))report=JSON.parse(readFileSync(file,'utf8'));
else{report={gate:'RDP-embedding',platforms:['mac-arm64','mac-x86_64','windows-x64'].map(platform=>({platform,status:'not-run',evidence:[],checks:[]})),requiredChecks};writeFileSync(file,JSON.stringify(report,null,2)+'\n');}
if(process.argv.includes('--open')){
  const exe=(await import('electron')).default;const r=spawnSync(exe,[app],{stdio:'inherit',env:{...process.env,ELECTRON_CACHE:resolve(app,'../../work/electron-cache')}});if(r.error)throw r.error;
}
const ready=gateReady(report.platforms);console.log('RDP live gate: '+(ready?'passed':'NOT PASSED — live evidence required on every baseline platform'));
for(const row of report.platforms)console.log(row.platform+': '+row.status);
process.exit(ready?0:2);
