import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';import {fileURLToPath} from 'node:url';import {join,resolve} from 'node:path';import {spawnSync} from 'node:child_process';
import {verifyHash} from './native-support.mjs';
const app=fileURLToPath(new URL('../',import.meta.url)),workspace=resolve(app,'../..'),work=join(workspace,'work');
const arch=process.env.RDP_ARCH||process.arch,windows=process.platform==='win32';
if(!(['darwin','win32'].includes(process.platform))||!['arm64','x64'].includes(arch)||(windows&&arch!=='x64'))throw new Error('Supported targets: macOS arm64/x64, Windows x64');
const source=join(work,'native-source'),suffix=`${process.platform}-${arch}`,openssl=join(work,`openssl-${suffix}`),prefix=join(work,`freerdp-${suffix}`),build=join(work,`freerdp-build-${suffix}`);
const local=join(work,'native-tools/bin/cmake'),cmake=process.env.RDP_CMAKE||(existsSync(local)?local:'cmake');
function run(tool,args,cwd=workspace,env=process.env){const r=spawnSync(tool,args,{cwd,env,stdio:'inherit',shell:false});if(r.error)throw r.error;if(r.status!==0)throw new Error(`${tool} failed (${r.status})`);}
async function archive(name,url,hash){
 mkdirSync(source,{recursive:true});const file=join(source,name);
 if(!existsSync(file)){const r=await fetch(url,{signal:AbortSignal.timeout(120000)});if(!r.ok)throw new Error('archive download failed');const bytes=Buffer.from(await r.arrayBuffer());verifyHash(bytes,hash);writeFileSync(file,bytes);}
 verifyHash(readFileSync(file),hash);return file;
}
run(cmake,['--version']);run('perl',['-v']);run(windows?'nmake':'make',windows?['/?']:['--version']);run('tar',['--version']);
const sslFile=await archive('openssl-3.6.5.tar.gz','https://www.openssl.org/source/openssl-3.6.5.tar.gz','a2157c2830efdec3788939b00c9b0638306d3f0bbb76dc4832ee503bb397df98');
const rdpFile=await archive('freerdp-3.32.2.tar.gz','https://pub.freerdp.com/releases/freerdp-3.32.2.tar.gz','e95a505c0057e4d06a3b120477c421028769deba4db9c639ef3465d050f0955c');
const extracted=join(work,`bootstrap-source-${suffix}`);mkdirSync(extracted,{recursive:true});
const sslSource=join(extracted,'openssl-3.6.5'),rdpSource=join(extracted,'freerdp-3.32.2');
if(!existsSync(sslSource))run('tar',['-xzf',sslFile,'-C',extracted]);if(!existsSync(rdpSource))run('tar',['-xzf',rdpFile,'-C',extracted]);
// Each architecture owns an out-of-source OpenSSL build; existing source builds are left alone.
const sslBuild=join(work,`openssl-build-${suffix}`);mkdirSync(sslBuild,{recursive:true});
run('perl',[join(sslSource,'Configure'),windows?'VC-WIN64A':arch==='x64'?'darwin64-x86_64':'darwin64-arm64','no-shared','no-tests','no-asm',`--prefix=${openssl}`],sslBuild);
run(windows?'nmake':'make',windows?[]:['-j4'],sslBuild);run(windows?'nmake':'make',['install_sw'],sslBuild);
const options=['WITH_CLIENT=OFF','WITH_CLIENT_COMMON=ON','WITH_SERVER=OFF','WITH_X11=OFF','WITH_SDL=OFF','WITH_SDL3=OFF','WITH_FFMPEG=OFF','WITH_DSP_FFMPEG=OFF','WITH_VIDEO_FFMPEG=OFF','WITH_SWSCALE=OFF','WITH_OPENH264=OFF','WITH_OPUS=OFF','WITH_CUPS=OFF','WITH_PCSC=OFF','WITH_FUSE=OFF','CHANNEL_URBDRC=OFF','WITH_AAD=OFF','WITH_JSON_DISABLED=ON','BUILD_TESTING=OFF','CMAKE_EXPORT_NO_PACKAGE_REGISTRY=ON'];
const config=['-S',rdpSource,'-B',build,`-DCMAKE_INSTALL_PREFIX=${prefix}`,`-DOPENSSL_ROOT_DIR=${openssl}`,'-DCMAKE_BUILD_TYPE=Release',...options.map(v=>'-D'+v)];
if(windows)config.push('-A','x64');else config.push(`-DCMAKE_OSX_ARCHITECTURES=${arch==='x64'?'x86_64':'arm64'}`);
run(cmake,config);run(cmake,['--build',build,'--config','Release','--parallel','4']);run(cmake,['--install',build,'--config','Release']);
run(process.execPath,[join(app,'scripts/build-native.mjs')],app,{...process.env,RDP_ARCH:arch,RDP_CMAKE:cmake,RDP_FREERDP_PREFIX:prefix,RDP_OPENSSL_ROOT:openssl,RDP_NATIVE_BUILD:join(work,`bridge-build-${suffix}`)});
console.log('Bootstrap complete; fixture evidence only. Runtime replaces native/bin for the selected architecture.');
