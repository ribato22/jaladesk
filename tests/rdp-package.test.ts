import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,realpath} from 'node:fs/promises';import {spawnSync} from 'node:child_process';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {pathToFileURL} from 'node:url';
// @ts-ignore Build utility is exercised directly without a runtime dependency.
const pack=()=>import('../../scripts/package-internal.mjs');
// @ts-ignore Build utility is exercised directly without a runtime dependency.
const verify=()=>import('../../scripts/verify-internal.mjs');
async function scratch(){return realpath(await mkdtemp(join(tmpdir(),'rw-pack-')));}
async function zip(path:string,entries:{name:string;text?:string;mode?:number}[]){
  const p=spawnSync('python3',['-c',`import zipfile,json,sys\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n for e in json.loads(sys.argv[2]):\n  i=zipfile.ZipInfo(e['name']);i.create_system=3;i.external_attr=e.get('mode',0o100644)<<16;z.writestr(i,e.get('text',''))`,path,JSON.stringify(entries)]);assert.equal(p.status,0,p.stderr.toString());
}
test('archive extraction preserves executable files and refuses an existing output',async()=>{
  const {extractArchive}=await pack(),root=await scratch();
  try{const file=join(root,'valid.zip'),out=join(root,'out');await zip(file,[{name:'runtime/run',text:'synthetic',mode:0o100755}]);await extractArchive(file,out,'win32-x64');assert.equal(await readFile(join(out,'runtime/run'),'utf8'),'synthetic');await assert.rejects(extractArchive(file,out,'win32-x64'));}finally{await rm(root,{recursive:true,force:true});}
});
for(const entries of [[{name:'../escaped',text:'bad'}],[{name:'/absolute',text:'bad'}],[{name:'a\\b',text:'bad'}],[{name:'A.txt'},{name:'a.txt'}],[{name:'link',text:'../outside',mode:0o120777}],[{name:'device',mode:0o020600}],[{name:'link',text:'folder',mode:0o120777},{name:'link/file',text:'bad'}]])test('archive policy rejects unsafe members before escaped writes: '+entries.map(e=>e.name).join(','),async()=>{
  const {extractArchive}=await pack(),root=await scratch();try{const file=join(root,'bad.zip');await zip(file,entries);await assert.rejects(extractArchive(file,join(root,'out'),'darwin-arm64'));await assert.rejects(readFile(join(root,'escaped')));}finally{await rm(root,{recursive:true,force:true});}
});
test('archive policy retains internal framework links on Mac and refuses links for Windows',async()=>{
  const {extractArchive}=await pack(),root=await scratch();try{const file=join(root,'links.zip');await zip(file,[{name:'framework/A/file',text:'ok'},{name:'framework/Current',text:'A',mode:0o120777}]);await extractArchive(file,join(root,'mac'),'darwin-arm64');assert.equal(await readFile(join(root,'mac/framework/Current/file'),'utf8'),'ok');await assert.rejects(extractArchive(file,join(root,'win'),'win32-x64'));}finally{await rm(root,{recursive:true,force:true});}
});
test('case-variant members cannot write through a framework symlink ancestor',async()=>{
  const {extractArchive}=await pack(),root=await scratch();try{const file=join(root,'case-link.zip');await zip(file,[{name:'folder/one',text:'ok'},{name:'LINK',text:'folder',mode:0o120777},{name:'link/injected',text:'bad'}]);await assert.rejects(extractArchive(file,join(root,'out'),'darwin-arm64'));}finally{await rm(root,{recursive:true,force:true});}
});
test('archive member and expanded-byte budgets are enforced before extraction',async()=>{
  const {extractArchive}=await pack(),root=await scratch();
  try{
    const many=join(root,'many.zip');const p=spawnSync('python3',['-c',`import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n for n in range(20001):z.writestr(str(n),'')`,many]);assert.equal(p.status,0);await assert.rejects(extractArchive(many,join(root,'many'),'win32-x64'));
    const large=join(root,'large.zip');await zip(large,[{name:'large'}]);const bytes=await readFile(large);bytes.writeUInt32LE(0x80000001,22);bytes.writeUInt32LE(0x80000001,bytes.indexOf(Buffer.from('504b0102','hex'))+24);await writeFile(large,bytes);await assert.rejects(extractArchive(large,join(root,'large'),'win32-x64'));
  }finally{await rm(root,{recursive:true,force:true});}
});
test('manifest integrity rejects modified, additional, missing or escaping files',async()=>{
  const {createManifest}=await pack(),{verifyManifest}=await verify(),root=await scratch();
  try{
    await writeFile(join(root,'one'),'abc');const manifest=await createManifest(root,{target:'win32-x64',version:'0.1.0-internal.3'});await verifyManifest(root,manifest);
    await writeFile(join(root,'one'),'abd');await assert.rejects(verifyManifest(root,manifest));await writeFile(join(root,'one'),'abc');await writeFile(join(root,'extra'),'bad');await assert.rejects(verifyManifest(root,manifest));await rm(join(root,'extra'));await rm(join(root,'one'));await assert.rejects(verifyManifest(root,manifest));
    await symlink(root,join(root,'escape'));await assert.rejects(createManifest(root,{target:'win32-x64',version:'0.1.0-internal.3'}));
  }finally{await rm(root,{recursive:true,force:true});}
});
test('payload allowlist excludes work, tests and TS and rejects stale compiled modules or missing assets',async()=>{
  const {payloadFiles}=await pack(),root=await scratch();
  try{
    for(const dir of ['src/desktop','dist/src/desktop','dist/tests','work'])await mkdir(join(root,dir),{recursive:true});
    const assets=['index.html','password.html','settings.html','credential.html','credential-input.html','password.js','credential.js','preload.cjs','password-preload.cjs','settings-preload.cjs','credential-preload.cjs','credential-input-preload.cjs','style.css'];
    for(const f of assets)await writeFile(join(root,'src/desktop',f),'synthetic');await writeFile(join(root,'src/desktop/main.ts'),'source');await writeFile(join(root,'dist/src/desktop/main.js'),'compiled');await writeFile(join(root,'dist/tests/private.js'),'test canary');await writeFile(join(root,'work/private.rwdoc'),'dev canary');
    const files=await payloadFiles(root);assert.equal(files.length,14);assert.ok(files.includes('dist/src/desktop/main.js'));assert.equal(files.some((p:string)=>p.includes('work')||p.includes('tests')||p.endsWith('.ts')),false);
    await writeFile(join(root,'dist/src/desktop/stale.js'),'stale');await assert.rejects(payloadFiles(root));await rm(join(root,'dist/src/desktop/stale.js'));await rm(join(root,'src/desktop/index.html'));await assert.rejects(payloadFiles(root));
  }finally{await rm(root,{recursive:true,force:true});}
});
test('package construction never overwrites an existing destination',async()=>{
  const {buildPackage}=await pack(),root=await scratch();try{const out=join(root,'existing');await mkdir(out);await writeFile(join(out,'keep'),'owner');await assert.rejects(buildPackage({out,target:'win32-x64'}));assert.equal(await readFile(join(out,'keep'),'utf8'),'owner');}finally{await rm(root,{recursive:true,force:true});}
});
test('incomplete or altered license inputs fail before a package is built',async()=>{
  const {validateLicenses}=await pack(),root=await scratch();
  try{
    const files:Record<string,{path:string;sha256:string}>={};
    for(const name of ['Electron.txt','Chromium.html','FreeRDP.txt','OpenSSL.txt','nlohmann-json.txt','LLVM.txt']){const path=join(root,name);await writeFile(path,'abc');files[name]={path,sha256:'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'};}
    await validateLicenses(files);await assert.rejects(validateLicenses({...files,'../escape.txt':files['LLVM.txt']}));const renamed={...files};delete renamed['LLVM.txt'];renamed['../escape.txt']=files['LLVM.txt'];await assert.rejects(validateLicenses(renamed));await writeFile(files['FreeRDP.txt'].path,'modified');await assert.rejects(validateLicenses(files));await assert.rejects(validateLicenses({}));
  }finally{await rm(root,{recursive:true,force:true});}
});
test('package verification rejects missing application metadata even with matching file hashes',async()=>{
  const {createManifest}=await pack(),{verifyPackage}=await verify(),root=await scratch();
  try{const manifest=await createManifest(root,{target:'win32-x64',version:'0.1.0-internal.3'});await writeFile(join(root,'PACKAGE-MANIFEST.json'),JSON.stringify(manifest));await assert.rejects(verifyPackage(root));}finally{await rm(root,{recursive:true,force:true});}
});
test('package compilation refreshes an existing stale JS module from its current TS source',async()=>{
  const {compilePayload}=await pack(),root=await scratch();
  try{
    for(const dir of ['src/desktop','dist/src/desktop','native/rdp','native/third-party','node_modules'])await mkdir(join(root,dir),{recursive:true});
    await writeFile(join(root,'src/desktop/main.ts'),'export const value=2;');await writeFile(join(root,'dist/src/desktop/main.js'),'export const value=1;');await writeFile(join(root,'package.json'),'{"type":"module"}');await writeFile(join(root,'tsconfig.json'),JSON.stringify({compilerOptions:{rootDir:'.',outDir:'dist',types:[],target:'ES2022',module:'NodeNext'},include:['src/**/*.ts']}));
    await writeFile(join(root,'native/rdp/bridge.cpp'),'synthetic');await writeFile(join(root,'native/third-party/json.hpp'),'synthetic');await symlink(resolve('node_modules/typescript'),join(root,'node_modules/typescript'),'dir');
    const record=await compilePayload(root);assert.match(record.sourceDigest,/^[0-9a-f]{64}$/);assert.equal((await import(pathToFileURL(join(root,'dist/src/desktop/main.js')).href)).value,2);
  }finally{await rm(root,{recursive:true,force:true});}
});
