import {createManifest,ASSETS,appPayload} from './package-internal.mjs';
import {need,hashFile,inventory,inspectNative,validateNativeGraph,validateMacFloor,command} from './native-package.mjs';
import {lstat,readFile,readdir,open} from 'node:fs/promises';
import {join,resolve} from 'node:path';import {fileURLToPath} from 'node:url';
export async function verifyManifest(root,manifest){
  need(manifest?.schema===1&&Array.isArray(manifest.files));const actual=await createManifest(root,{target:manifest.target});
  need(JSON.stringify(actual.files)===JSON.stringify(manifest.files),'Package integrity mismatch');return true;
}
export async function verifyPackage(root){
  const stat=await lstat(join(root,'PACKAGE-MANIFEST.json'));need(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=8*1024**2);
  const manifest=JSON.parse(await readFile(join(root,'PACKAGE-MANIFEST.json'),'utf8')),sidecar=await readFile(join(root,'PACKAGE-MANIFEST.sha256'),'utf8');
  need(sidecar===await hashFile(join(root,'PACKAGE-MANIFEST.json'))+'  PACKAGE-MANIFEST.json\n');
  need(manifest.version==='0.1.0-internal.3'&&/^[0-9a-f]{64}$/.test(manifest.sourceDigest)&&manifest.runtime?.version==='44.7.2'&&manifest.promotionAllowed===false&&manifest.productRDP==='NOT_PASSED');
  await verifyManifest(root,manifest);const app=appPayload(root,manifest.target),pkg=JSON.parse(await readFile(join(app,'package.json'),'utf8'));
  await inspectNative(manifest.target==='darwin-arm64'?join(root,'Remote Workspace RDP Internal.app/Contents/MacOS/Electron'):join(root,'RemoteWorkspace.exe'),manifest.target);
  need(pkg.main==='dist/src/desktop/main.js'&&pkg.type==='module'&&pkg.version===manifest.version);
  for(const file of [...ASSETS.map(n=>'src/desktop/'+n),'dist/src/desktop/main.js','dist/src/protocols/rdp/profile.js','dist/src/protocols/rdp/profiled-owner.js'])need((await lstat(join(app,file))).isFile());
  const native=join(app,'native/bin'),infos=await Promise.all((await readdir(native)).sort().map(n=>inspectNative(join(native,n),manifest.target)));validateNativeGraph(infos,manifest.target);need(JSON.stringify(infos)===JSON.stringify(manifest.nativeGraph),'Native graph mismatch');
  const defaultApp=manifest.target==='darwin-arm64'?join(root,'Remote Workspace RDP Internal.app/Contents/Resources/default_app.asar'):join(root,'resources/default_app.asar');
  let exists=false;try{await lstat(defaultApp);exists=true;}catch(error){if(error.code!=='ENOENT')throw error;}need(!exists,'Vendor default application must be absent');
  need(Array.isArray(manifest.licenses)&&manifest.licenses.length===6);
  for(const license of manifest.licenses)need(manifest.files.some(f=>f.path===license.path&&f.sha256===license.sha256));
  if(manifest.target==='darwin-arm64'){
    need(process.platform==='darwin');const bundle=join(root,'Remote Workspace RDP Internal.app');
    for(const f of await inventory(bundle))if(f.type==='file'){
      const path=join(bundle,f.path),file=await open(path,'r'),head=Buffer.alloc(8);try{await file.read(head,0,8,0);}finally{await file.close();}
      if(head.readUInt32LE(0)===0xfeedfacf)validateMacFloor(await inspectNative(path,manifest.target));
    }
    need(command('plutil',['-extract','LSMinimumSystemVersion','raw','-o','-',join(bundle,'Contents/Info.plist')]).trim()==='13.0');command('codesign',['--verify','--deep','--strict',bundle]);
  }else need(manifest.WindowsActual==='NOT_RUN');
  return {schema:1,status:'PASS_SCOPED',target:manifest.target,version:manifest.version,manifestSha256:await hashFile(join(root,'PACKAGE-MANIFEST.json')),files:manifest.files.length,productRDP:'NOT_PASSED',promotionAllowed:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{need(process.argv.length===3);console.log(JSON.stringify(await verifyPackage(resolve(process.argv[2]))));}catch(error){console.error(error.message);process.exitCode=1;}
}
