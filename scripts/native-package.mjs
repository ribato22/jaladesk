import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat,open,readdir,readlink,realpath} from 'node:fs/promises';
import {basename,dirname,join,posix,relative,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export const OS_IMPORTS=['ADVAPI32.dll','CRYPT32.dll','KERNEL32.dll','RPCRT4.dll','SHELL32.dll','SHLWAPI.dll','USER32.dll','WS2_32.dll','api-ms-win-crt-convert-l1-1-0.dll','api-ms-win-crt-environment-l1-1-0.dll','api-ms-win-crt-filesystem-l1-1-0.dll','api-ms-win-crt-heap-l1-1-0.dll','api-ms-win-crt-locale-l1-1-0.dll','api-ms-win-crt-math-l1-1-0.dll','api-ms-win-crt-multibyte-l1-1-0.dll','api-ms-win-crt-private-l1-1-0.dll','api-ms-win-crt-runtime-l1-1-0.dll','api-ms-win-crt-stdio-l1-1-0.dll','api-ms-win-crt-string-l1-1-0.dll','api-ms-win-crt-time-l1-1-0.dll','api-ms-win-crt-utility-l1-1-0.dll','credui.dll','dbghelp.dll','ncrypt.dll','ntdll.dll','ole32.dll'];
export const need=(value,message='Invalid internal package')=>{if(!value)throw new Error(message);};
export const within=(root,path)=>{const r=relative(root,path);return r===''||(!r.startsWith('..'+posix.sep)&&r!=='..'&&!r.startsWith('/'));};
export function command(executable,args,options={}){
  const r=spawnSync(executable,args,{encoding:'utf8',maxBuffer:64*1024*1024,shell:false,...options});
  if(r.error||r.status!==0)throw Object.assign(new Error(`Package tool failed: ${basename(executable)} (${r.status??'start'})`),{stdout:r.stdout,stderr:r.stderr});return r.stdout;
}
export async function hashFile(path){const h=createHash('sha256');for await(const b of createReadStream(path))h.update(b);return h.digest('hex');}
export async function inventory(root){
  root=await realpath(root);const items=[];let bytes=0;
  async function walk(dir){
    for(const name of (await readdir(dir)).sort()){
      const path=join(dir,name),key=relative(root,path).split('\\').join('/'),st=await lstat(path);need(items.length<20000);
      const item={path:key,mode:st.mode&0o777};
      if(st.isSymbolicLink()){
        const target=await readlink(path);need(!target.startsWith('/')&&within(root,resolve(dirname(path),target))&&within(root,await realpath(path)));
        items.push({...item,type:'symlink',target});
      }else if(st.isDirectory()){items.push({...item,type:'directory'});await walk(path);}
      else{need(st.isFile());bytes+=st.size;need(bytes<=2*1024**3);items.push({...item,type:'file',bytes:st.size,sha256:await hashFile(path)});}
    }
  }
  await walk(root);return items.sort((a,b)=>a.path.localeCompare(b.path,'en'));
}
async function fingerprint(appRoot,paths){
  const h=createHash('sha256');
  for(const path of paths){
    const full=join(appRoot,path),st=await lstat(full);
    const entries=st.isDirectory()?(await inventory(full)).filter(v=>v.type==='file').map(v=>({path:path+'/'+v.path,sha256:v.sha256})):[{path,sha256:await hashFile(full)}];
    for(const entry of entries)h.update(entry.path+'\0'+entry.sha256+'\n');
  }
  return h.digest('hex');
}
export const nativeSourceDigest=root=>fingerprint(root,['native/rdp','native/third-party']);
export const sourceDigest=root=>fingerprint(root,['src','native/rdp','native/third-party','package.json','tsconfig.json']);
export async function verifyProducer(appRoot,p,target){
  need(p?.schema===1&&p.target===target&&p.nativeSourceDigest===await nativeSourceDigest(appRoot)&&Array.isArray(p.files)&&p.files.length>0);
  const names=new Set();for(const file of p.files){const name=basename(file.path).toLowerCase();need(!names.has(name));names.add(name);need(await hashFile(file.path)===file.sha256);}
}
const version=s=>{need(typeof s==='string'&&/^\d+\.\d+(\.\d+)?$/.test(s));const a=s.split('.').map(Number);return a[0]*1000000+a[1]*1000+(a[2]??0);};
export const validateMacFloor=info=>need(info.arch==='arm64'&&version(info.minOS)<=version('13.0'),'Runtime exceeds declared OS floor');
export function validateNativeGraph(infos,target){
  need(['darwin-arm64','win32-x64'].includes(target)&&Array.isArray(infos)&&infos.length>0);const win=target==='win32-x64',map=new Map();
  for(const v of infos){need(typeof v.name==='string'&&basename(v.name)===v.name&&!map.has(v.name.toLowerCase()));map.set(v.name.toLowerCase(),v);need(v.arch===(win?'x64':'arm64'));if(!win){validateMacFloor(v);need(Array.isArray(v.rpaths)&&v.rpaths.every(p=>p==='@loader_path'));}}
  const entry=win?'rdp-bridge.exe':'rdp-bridge';need(map.has(entry));const seen=new Set();
  function visit(key){if(seen.has(key))return;seen.add(key);const v=map.get(key);need(v&&Array.isArray(v.dependencies));
    for(const dep of v.dependencies){
      if(win&&OS_IMPORTS.some(n=>n.toLowerCase()===dep.toLowerCase()))continue;
      if(!win&&(dep.startsWith('/usr/lib/')||dep.startsWith('/System/Library/'))){need(posix.normalize(dep)===dep);continue;}
      const name=win?dep:dep.replace(/^@(rpath|loader_path)\//,'');need(name!==dep||win);need(!name.includes('/')&&!name.includes('\\')&&map.has(name.toLowerCase()));visit(name.toLowerCase());
    }
  }
  visit(entry);need(seen.size===map.size);return infos;
}
export async function inspectNative(file,target,tools={}){
  const fd=await open(file,'r'),head=Buffer.alloc(64);try{need((await fd.read(head,0,64,0)).bytesRead===64);if(target==='win32-x64'){
    need(head.toString('ascii',0,2)==='MZ');const offset=head.readUInt32LE(0x3c),pe=Buffer.alloc(26);need(offset>=64&&offset<1024*1024);need((await fd.read(pe,0,26,offset)).bytesRead===26&&pe.toString('ascii',0,4)==='PE\0\0'&&pe.readUInt16LE(4)===0x8664&&pe.readUInt16LE(24)===0x20b);
  }else need(head.readUInt32LE(0)===0xfeedfacf&&head.readUInt32LE(4)===0x100000c);}finally{await fd.close();}
  const name=basename(file);
  if(target==='win32-x64'){
    const root=resolve(fileURLToPath(new URL('../../../',import.meta.url)));const reader=tools.reader??join(root,'work/cross-win32-x64-llvm-20261006/toolchain/bin/llvm-readobj');
    return {name,arch:'x64',dependencies:[...command(reader,['--coff-imports',file]).matchAll(/^\s+Name: (.+)$/gm)].map(m=>m[1])};
  }
  // otool treats trailing parentheses as archive-member syntax; a read-only FD preserves real filenames.
  const input=await open(file,'r');let load,dependencies;
  try{const options={stdio:['ignore','pipe','pipe',input.fd]};load=command('otool',['-l','/dev/fd/3'],options);dependencies=command('otool',['-L','/dev/fd/3'],options);}finally{await input.close();}
  const minOS=[...load.matchAll(/\bminos\s+(\S+)|cmd LC_VERSION_MIN_MACOSX\n\s*cmdsize \d+\n\s*version (\S+)/g)].map(m=>m[1]??m[2]);need(minOS.length===1);
  return {name,arch:'arm64',minOS:minOS[0],rpaths:[...load.matchAll(/cmd LC_RPATH\n\s*cmdsize \d+\n\s*path (.*?) \(offset/g)].map(m=>m[1]),dependencies:dependencies.split('\n').slice(1).filter(Boolean).map(s=>s.trim().split(' (compatibility')[0])};
}
export async function relocateMac(dir){
  const files=(await readdir(dir)).sort();
  for(const name of files){
    const path=join(dir,name),info=await inspectNative(path,'darwin-arm64');
    for(const p of info.rpaths)command('install_name_tool',['-delete_rpath',p,path]);command('install_name_tool',['-add_rpath','@loader_path',path]);
    if(name.endsWith('.dylib'))command('install_name_tool',['-id','@rpath/'+name,path]);
    for(const dep of info.dependencies)if(!dep.startsWith('/usr/lib/')&&!dep.startsWith('/System/Library/')&&!dep.startsWith('@')){need(files.includes(basename(dep)));command('install_name_tool',['-change',dep,'@rpath/'+basename(dep),path]);}
    command('codesign',['--force','--sign','-','--timestamp=none',path]);command('codesign',['--verify','--strict',path]);
  }
  return validateNativeGraph(await Promise.all(files.map(f=>inspectNative(join(dir,f),'darwin-arm64'))),'darwin-arm64');
}
