import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {existsSync} from 'node:fs';
const app=fileURLToPath(new URL('../',import.meta.url)),workspace=resolve(app,'../..');
const local=join(workspace,'work/native-tools/bin/ctest'),ctest=process.env.RDP_CTEST || (existsSync(local)?local:'ctest');
const r=spawnSync(ctest,['--test-dir',join(workspace,'work/bridge-build'),'-C','Release','--output-on-failure'],{stdio:'inherit'});
if(r.error)throw r.error;process.exit(r.status??1);
