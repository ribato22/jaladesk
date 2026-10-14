import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {mkdirSync,copyFileSync,existsSync} from 'node:fs';
const app=fileURLToPath(new URL('../',import.meta.url)),workspace=resolve(app,'../..');
const local=join(workspace,'work/native-tools/bin/cmake');
const cmake=process.env.RDP_CMAKE || (existsSync(local)?local:'cmake');
const prefix=process.env.RDP_FREERDP_PREFIX || join(workspace,'work/freerdp-install');
const build=join(workspace,'work/bridge-build');
const args=['-S',join(app,'native/rdp'),'-B',build,`-DCMAKE_PREFIX_PATH=${prefix}`,`-DJSON_INCLUDE_DIR=${join(app,'native/third-party')}`,'-DCMAKE_EXPORT_NO_PACKAGE_REGISTRY=ON'];
if(process.env.RDP_OPENSSL_ROOT)args.push(`-DOPENSSL_ROOT_DIR=${process.env.RDP_OPENSSL_ROOT}`);
function run(args){const r=spawnSync(cmake,args,{stdio:'inherit'});if(r.error)throw r.error;if(r.status)process.exit(r.status);}
run(args);run(['--build',build,'--config','Release','--parallel','4']);
mkdirSync(join(app,'native/bin'),{recursive:true});
const name=process.platform==='win32'?'rdp-bridge.exe':'rdp-bridge';
const binary=process.platform==='win32'?join(build,'Release',name):join(build,name);
copyFileSync(binary,join(app,'native/bin',name));
console.log('Native bridge built for '+process.platform+' '+process.arch);
