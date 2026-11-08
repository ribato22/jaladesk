import {lstat,readFile,writeFile,mkdir,mkdtemp,realpath,cp,copyFile,chmod,readdir,open,rm} from 'node:fs/promises';
import {join,basename,dirname,resolve,isAbsolute,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {command,inventory,need,hashFile,sourceDigest,verifyProducer,relocateMac,inspectNative,validateNativeGraph} from './native-package.mjs';
export const ASSETS=['index.html','password.html','settings.html','credential.html','credential-input.html','password.js','credential.js','preload.cjs','password-preload.cjs','settings-preload.cjs','credential-preload.cjs','credential-input-preload.cjs','style.css'];
const zipProgram=String.raw`
import sys,zipfile,pathlib,posixpath,stat,os,unicodedata,shutil
action,archive,folder,target=sys.argv[1:]
root=pathlib.Path(folder)
if action=='extract':
 if root.exists() or root.is_symlink(): raise ValueError('existing destination')
 with zipfile.ZipFile(archive) as z:
  entries=z.infolist()
  if len(entries)>20000 or sum(i.file_size for i in entries)>2*1024**3: raise ValueError('archive budget')
  seen=set();links={};records=[]
  for i in entries:
   name=i.orig_filename
   if not name or '\\' in name or '\0' in name or ':' in name or name.startswith('/'): raise ValueError('unsafe path')
   parts=name.rstrip('/').split('/')
   if any(p in ('','..','.') for p in parts): raise ValueError('unsafe component')
   key=unicodedata.normalize('NFC','/'.join(parts)).casefold()
   if key in seen: raise ValueError('duplicate member')
   seen.add(key);mode=i.external_attr>>16;kind=stat.S_IFMT(mode);path='/'.join(parts)
   if mode&0o7000 or kind not in (0,stat.S_IFREG,stat.S_IFDIR,stat.S_IFLNK): raise ValueError('special entry')
   if kind==stat.S_IFLNK:
    if target!='darwin-arm64' or i.file_size>4096: raise ValueError('link refused')
    link=z.read(i).decode('utf-8');resolved=posixpath.normpath(posixpath.join(posixpath.dirname(path),link))
    if not link or '\\' in link or '\0' in link or link.startswith('/') or resolved=='..' or resolved.startswith('../'): raise ValueError('escaping link')
    links[path]=link
   records.append((i,path,kind,mode))
  link_keys={unicodedata.normalize('NFC',link).casefold() for link in links}
  for _,path,_,_ in records:
   key=unicodedata.normalize('NFC',path).casefold()
   if any(key.startswith(link+'/') for link in link_keys): raise ValueError('member beneath link')
  root.mkdir(mode=0o700)
  for i,path,kind,mode in records:
   dest=root/path;dest.parent.mkdir(parents=True,exist_ok=True)
   if kind==stat.S_IFLNK: dest.symlink_to(links[path])
   elif i.is_dir() or kind==stat.S_IFDIR: dest.mkdir(exist_ok=True)
   else:
    with z.open(i) as src,open(dest,'xb') as out: shutil.copyfileobj(src,out,65536)
   if kind!=stat.S_IFLNK: os.chmod(dest,(mode&0o777) or (0o755 if dest.is_dir() else 0o644))
  for path in links:
   resolved=(root/path).resolve(strict=True)
   if not resolved.is_relative_to(root.resolve()): raise ValueError('resolved link escapes')
elif action=='create':
 if pathlib.Path(archive).exists(): raise ValueError('existing archive')
 with zipfile.ZipFile(archive,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=6,allowZip64=True) as z:
  for p in sorted(root.rglob('*')):
   name=root.name+'/'+p.relative_to(root).as_posix();st=p.lstat();i=zipfile.ZipInfo(name+('/' if p.is_dir() and not p.is_symlink() else ''));i.create_system=3;i.external_attr=st.st_mode<<16;i.compress_type=zipfile.ZIP_DEFLATED
   if p.is_symlink(): z.writestr(i,os.readlink(p).encode('utf-8'))
   elif p.is_dir(): z.writestr(i,b'')
   elif p.is_file():
    with open(p,'rb') as src,z.open(i,'w',force_zip64=True) as dest: shutil.copyfileobj(src,dest,65536)
   else: raise ValueError('special file')
else: raise ValueError('unknown action')
`;
export async function extractArchive(file,out,target){need(['darwin-arm64','win32-x64'].includes(target));command('python3',['-c',zipProgram,'extract',file,out,target]);}
export async function archivePackage(root,file,target){await inventory(root);command('python3',['-c',zipProgram,'create',file,root,target]);}
export async function payloadFiles(appRoot){
  for(const name of ASSETS)need((await lstat(join(appRoot,'src/desktop',name))).isFile());
  const source=await inventory(join(appRoot,'src')),compiled=await inventory(join(appRoot,'dist/src'));
  need(source.every(f=>f.type!=='symlink')&&compiled.every(f=>f.type!=='symlink'));
  const expected=new Set(source.filter(f=>f.type==='file'&&f.path.endsWith('.ts')&&!f.path.endsWith('.d.ts')).map(f=>f.path.slice(0,-3)+'.js'));
  const actual=compiled.filter(f=>f.type==='file');need(actual.length===expected.size&&actual.every(f=>expected.has(f.path))&&expected.has('desktop/main.js'));
  const staticFiles=source.filter(f=>f.type==='file'&&f.path.startsWith('desktop/')&&/\.(html|css|cjs|js|svg|png|ico|icns|woff2)$/.test(f.path)).map(f=>'src/'+f.path);
  return [...actual.map(f=>'dist/src/'+f.path),...staticFiles].sort();
}
export async function createManifest(root,metadata){
  need(['darwin-arm64','win32-x64'].includes(metadata?.target));
  let files=(await inventory(root)).filter(f=>!['PACKAGE-MANIFEST.json','PACKAGE-MANIFEST.sha256'].includes(f.path));
  if(metadata.target==='win32-x64'){need(files.every(f=>f.type!=='symlink'));files=files.map(({mode,...f})=>f);}
  return {...metadata,schema:1,files};
}
export async function validateLicenses(files){
  const names=['Electron.txt','Chromium.html','FreeRDP.txt','OpenSSL.txt','nlohmann-json.txt','LLVM.txt'];
  need(files&&typeof files==='object'&&Object.keys(files).length===names.length&&Object.keys(files).every(name=>names.includes(name)),'Unexpected license input');
  for(const name of names)need(await hashFile(files[name].path)===files[name].sha256,'License input missing or altered');
}
export async function compilePayload(appRoot){
  const before=await sourceDigest(appRoot),base=join(appRoot,'node_modules/typescript'),meta=JSON.parse(await readFile(join(base,'package.json'),'utf8'));
  need(meta.version==='7.0.2'&&typeof meta.bin?.tsc==='string'&&!isAbsolute(meta.bin.tsc));const entry=resolve(base,meta.bin.tsc);need(entry.startsWith(resolve(base)+'/'));
  command(process.execPath,[entry,'-p',join(appRoot,'tsconfig.json'),'--noEmitOnError'],{cwd:appRoot});need(before===await sourceDigest(appRoot),'Source changed during compilation');
  return {sourceDigest:before,typescriptVersion:meta.version,compilerEntrySha256:await hashFile(entry)};
}
export const appPayload=(root,target)=>target==='darwin-arm64'?join(root,'Remote Workspace RDP Internal.app/Contents/Resources/app'):join(root,'resources/app');
async function absent(path){try{await lstat(path);return false;}catch(e){if(e.code!=='ENOENT')throw e;return true;}}
async function signMacBundle(bundle,stage){
  const contents=await inventory(bundle);let serial=0;
  const sign=async path=>{
    const {spawnSync}=await import('node:child_process');const before=spawnSync('codesign',['-d','--entitlements',':-',path],{encoding:'utf8'});need(before.status===0,'Code metadata unavailable');
    const details=command('codesign',['-d','--verbose=2',path],{encoding:'utf8'});
    const args=['--force','--sign','-','--timestamp=none'];
    if(before.stdout?.trim()){const ent=join(stage,`entitlements-${serial++}.plist`);await writeFile(ent,before.stdout);args.push('--entitlements',ent);}
    // Existing hardened code must retain its policy; ad-hoc signing is not publisher trust.
    const info=spawnSync('codesign',['-d','--verbose=2',path],{encoding:'utf8'});if(info.stderr?.includes('runtime'))args.push('--options','runtime');
    command('codesign',[...args,path]);
  };
  for(const item of contents)if(item.type==='file'){
    const path=join(bundle,item.path),file=await open(path,'r'),head=Buffer.alloc(8);try{await file.read(head,0,8,0);}finally{await file.close();}
    if([0xfeedfacf,0xcafebabe,0xbebafeca].includes(head.readUInt32LE(0)))await sign(path);
  }
  const bundles=contents.filter(x=>x.type==='directory'&&/\.(app|framework)$/.test(x.path)).sort((a,b)=>b.path.split('/').length-a.path.split('/').length);
  for(const item of bundles)await sign(join(bundle,item.path));await sign(bundle);command('codesign',['--verify','--deep','--strict',bundle]);
}
export async function buildPackage(config){
  const {out,target,appRoot,runtime,producer,licenses}=config;need(typeof out==='string'&&isAbsolute(out)&&await absent(out),'Package destination must be absent');
  need(['darwin-arm64','win32-x64'].includes(target));need(resolve(await realpath(dirname(out)),basename(out))===resolve(out),'Canonical package destination required');
  need(!out.startsWith(resolve(appRoot)+'/'),'Package output cannot be inside source');
  await validateLicenses(licenses);await verifyProducer(appRoot,producer,target);need(runtime?.version==='44.7.2'&&await hashFile(runtime.path)===runtime.sha256,'Runtime input mismatch');
  const compilation=await compilePayload(appRoot),inputs=compilation.sourceDigest,payload=await payloadFiles(appRoot),stage=await mkdtemp(join(dirname(out),'.package-build-'));
  const extracted=join(stage,'runtime');await extractArchive(runtime.path,extracted,target);need((await readFile(join(extracted,'version'),'utf8')).trim()==='44.7.2');
  await inspectNative(join(extracted,target==='darwin-arm64'?'Electron.app/Contents/MacOS/Electron':'electron.exe'),target);
  await mkdir(out);const mac=target==='darwin-arm64',bundle=join(out,'Remote Workspace RDP Internal.app');
  if(mac){need(process.platform==='darwin');await cp(join(extracted,'Electron.app'),bundle,{recursive:true,dereference:false,verbatimSymlinks:true,errorOnExist:true,force:false});await rm(join(bundle,'Contents/Resources/default_app.asar'),{force:true});}
  else{
    for(const entry of await readdir(extracted))if(entry!=='resources')await cp(join(extracted,entry),join(out,entry==='electron.exe'?'RemoteWorkspace.exe':entry==='electron_wer.dll'?'RemoteWorkspace_wer.dll':entry),{recursive:true,dereference:false,errorOnExist:true,force:false});
    // The vendor default_app is not an application payload.
    await mkdir(join(out,'resources'));
  }
  const app=appPayload(out,target);await mkdir(app,{recursive:true});
  for(const path of payload){await mkdir(dirname(join(app,path)),{recursive:true});await copyFile(join(appRoot,path),join(app,path));}
  await writeFile(join(app,'package.json'),JSON.stringify({name:'remote-workspace-internal',productName:'Remote Workspace RDP Internal',version:'0.1.0-internal.3',type:'module',main:'dist/src/desktop/main.js'},null,2)+'\n');
  const native=join(app,'native/bin');await mkdir(native,{recursive:true});
  for(const f of producer.files){const path=join(native,basename(f.path));await copyFile(f.path,path);await chmod(path,0o755);need(await hashFile(path)===f.sha256);}
  const graph=mac?await relocateMac(native):validateNativeGraph(await Promise.all((await readdir(native)).sort().map(n=>inspectNative(join(native,n),target))),target);
  const licenseRoot=mac?join(bundle,'Contents/Resources/licenses'):join(out,'licenses');await mkdir(licenseRoot,{recursive:true});
  const licenseRecords=[];
  for(const [name,f] of Object.entries(licenses)){
    const source=name==='Electron.txt'?join(extracted,'LICENSE'):name==='Chromium.html'?join(extracted,'LICENSES.chromium.html'):f.path;
    const path=join(licenseRoot,name);await copyFile(source,path);licenseRecords.push({path:relative(out,path).split('\\').join('/'),sha256:await hashFile(path),source:name==='Electron.txt'||name==='Chromium.html'?'pinned target Electron archive':'pinned license input'});
  }
  await writeFile(join(out,'THIRD-PARTY-NOTICES.txt'),'Electron44.7.2 and Chromium: Electron.txt / Chromium.html. FreeRDP3.32.2 and WinPR: FreeRDP.txt (Apache2). OpenSSL3.6.5: OpenSSL.txt (Apache2). nlohmannJSON3.12.0: nlohmann-json.txt (MIT). LLVM/libc++/libunwind: LLVM.txt (Apache2 with LLVM exceptions). License paths and hashes are in PACKAGE-MANIFEST.json. No comprehensive legal audit is claimed.\n');
  await writeFile(join(out,'README-INTERNAL.txt'),'Remote Workspace RDP Internal 0.1.0-internal.3\nExtract the complete folder to a location owned by your user. Open the .app on macOS or RemoteWorkspace.exe on Windows. No Node/npm/Python is needed. Userdata uses the per-user RemoteWorkspaceInternal namespace; existing development data is not migrated. Keep the manifest and notices. This candidate is locally ad-hoc signed on macOS/unsigned on Windows, not publisher authenticated or notarized. If OS policy blocks it, stop and report the gate; do not weaken OS policy. Windows, GUI, actual macOS13/Intel and real OS-keystore acceptance are NOT_RUN. Product RDP NOT_PASSED.\n');
  if(mac){
    const plist=String.raw`import plistlib,pathlib,sys\nb=pathlib.Path(sys.argv[1])\nfor p in [b/'Contents/Info.plist',*b.glob('Contents/Frameworks/*.app/Contents/Info.plist')]:\n with open(p,'rb') as f:d=plistlib.load(f)\n suffix='' if p==b/'Contents/Info.plist' else '.helper.'+p.parents[1].stem.replace('Electron Helper','base').replace(' ','').replace('(','').replace(')','').lower()\n d.update(CFBundleDisplayName='Remote Workspace RDP Internal',CFBundleName='Remote Workspace RDP Internal',CFBundleIdentifier='local.remoteworkspace.rdp.internal'+suffix,CFBundleShortVersionString='0.1.0',CFBundleVersion='3')\n if not suffix:d['LSMinimumSystemVersion']='13.0'\n with open(p,'wb') as f:plistlib.dump(d,f,sort_keys=False)`.replaceAll('\\n','\n');
    command('python3',['-c',plist,bundle]);await signMacBundle(bundle,stage);
  }
  need(inputs===await sourceDigest(appRoot),'Source changed during packaging');await verifyProducer(appRoot,producer,target);need(await hashFile(runtime.path)===runtime.sha256);
  const builder={};for(const name of ['package-internal.mjs','native-package.mjs','verify-internal.mjs'])builder[name]=await hashFile(fileURLToPath(new URL(name,import.meta.url)));
  const metadata={target,version:'0.1.0-internal.3',sourceVersion:'0.1.0',sourceDigest:inputs,compilation,builder,nativeSourceDigest:producer.nativeSourceDigest,nativeProducerSha256:(await import('node:crypto')).createHash('sha256').update(JSON.stringify(producer)).digest('hex'),nativeBuild:producer.build??{},runtime:{name:'electron',version:'44.7.2',archiveSha256:runtime.sha256},minimumOS:mac?'13.0':'Windows11',nativeGraph:graph,licenses:licenseRecords,signing:mac?'local-ad-hoc-no-publisher-trust':'unsigned',WindowsActual:'NOT_RUN',GUI:'NOT_RUN',macOS13Actual:'NOT_RUN',productRDP:'NOT_PASSED',promotionAllowed:false};
  const manifest=await createManifest(out,metadata);await writeFile(join(out,'PACKAGE-MANIFEST.json'),JSON.stringify(manifest,null,2)+'\n');await writeFile(join(out,'PACKAGE-MANIFEST.sha256'),await hashFile(join(out,'PACKAGE-MANIFEST.json'))+'  PACKAGE-MANIFEST.json\n');return {root:out,manifest,stage};
}
async function cli(){
  try{
    need(process.argv.length===3);const config=JSON.parse(await readFile(resolve(process.argv[2]),'utf8')),zip=config.out+'.zip';need(await absent(zip)&&await absent(zip+'.sha256'));
    const result=await buildPackage(config),{verifyPackage}=await import('./verify-internal.mjs'),verified=await verifyPackage(result.root);
    await archivePackage(result.root,zip,config.target);const readback=join(result.stage,'zip-readback');await extractArchive(zip,readback,config.target);const copied=await verifyPackage(join(readback,basename(result.root)));need(copied.manifestSha256===verified.manifestSha256);
    const hash=await hashFile(zip);await writeFile(zip+'.sha256',hash+'  '+basename(zip)+'\n',{flag:'wx'});console.log(JSON.stringify({...verified,zip,zipSha256:hash,zipReadback:true}));
  }catch(error){console.error(JSON.stringify({error:error.message,stdout:error.stdout,stderr:error.stderr}));process.exitCode=1;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))void cli();
