import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {existsSync,rmSync} from 'node:fs';import {stageRuntime,verifyRuntime} from './native-support.mjs';
const app=fileURLToPath(new URL('../',import.meta.url)),workspace=resolve(app,'../..');
const local=join(workspace,'work/native-tools/bin/cmake');
const cmake=process.env.RDP_CMAKE || (existsSync(local)?local:'cmake');
const prefix=process.env.RDP_FREERDP_PREFIX || join(workspace,'work/freerdp-install');
const build=process.env.RDP_NATIVE_BUILD||join(workspace,'work/bridge-build'),stage=join(build,'stage');
// Release by default: an unoptimised build spends ~60 ms converting each 1080p frame (0.4 ms optimised).
const args=['-S',join(app,'native/rdp'),'-B',build,`-DCMAKE_BUILD_TYPE=${process.env.RDP_BUILD_TYPE||'Release'}`,`-DCMAKE_PREFIX_PATH=${prefix}`,`-DFREERDP_RUNTIME_DIR=${join(prefix,'bin')}`,`-DJSON_INCLUDE_DIR=${join(app,'native/third-party')}`,'-DCMAKE_EXPORT_NO_PACKAGE_REGISTRY=ON'];
if(process.env.RDP_OPENSSL_ROOT)args.push(`-DOPENSSL_ROOT_DIR=${process.env.RDP_OPENSSL_ROOT}`);
if(process.platform==='darwin'&&process.env.RDP_ARCH)args.push(`-DCMAKE_OSX_ARCHITECTURES=${process.env.RDP_ARCH==='x64'?'x86_64':process.env.RDP_ARCH}`);
function run(args){const r=spawnSync(cmake,args,{stdio:'inherit'});if(r.error)throw r.error;if(r.status)process.exit(r.status);}
run(args);run(['--build',build,'--config','Release','--parallel','4']);rmSync(stage,{recursive:true,force:true});run(['--install',build,'--config','Release','--prefix',stage]);
const name=process.platform==='win32'?'rdp-bridge.exe':'rdp-bridge';
verifyRuntime(join(stage,'bin',name));stageRuntime(join(stage,'bin'),join(app,'native/bin'),name);
console.log('Native bridge built and fixture checked for '+process.platform+' '+(process.env.RDP_ARCH||process.arch));
