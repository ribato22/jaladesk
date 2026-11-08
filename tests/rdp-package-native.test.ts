import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,copyFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {existsSync} from 'node:fs';
// @ts-ignore Build utility is exercised directly without a runtime dependency.
const load=()=>import('../../scripts/native-package.mjs');
const mac=(name:string,deps:string[]=[])=>({name,arch:'arm64',minOS:'13.0',rpaths:['@loader_path'],dependencies:deps});
test('native graph admits only complete arm64 floor13 closure and OS dependencies',async()=>{
  const {validateNativeGraph}=await load();
  assert.doesNotThrow(()=>validateNativeGraph([mac('rdp-bridge',['@rpath/libtest.dylib','/usr/lib/libSystem.B.dylib']),mac('libtest.dylib')],'darwin-arm64'));
  for(const bad of [mac('rdp-bridge',['@rpath/missing.dylib']),{...mac('rdp-bridge'),minOS:'27.2'},{...mac('rdp-bridge'),arch:'x64'},{...mac('rdp-bridge'),rpaths:['/private/build/lib']},mac('rdp-bridge',['/tmp/private.dylib'])])assert.throws(()=>validateNativeGraph([bad],'darwin-arm64'));
});
test('Windows native graph rejects unknown and case-ambiguous dependencies',async()=>{
  const {validateNativeGraph}=await load();const helper={name:'rdp-bridge.exe',arch:'x64',dependencies:['KERNEL32.dll','ADVAPI32.dll','libc++.dll']},dll={name:'libc++.dll',arch:'x64',dependencies:['KERNEL32.dll']};
  assert.doesNotThrow(()=>validateNativeGraph([helper,dll],'win32-x64'));
  assert.throws(()=>validateNativeGraph([{...helper,dependencies:['missing.dll']}],'win32-x64'));
  assert.throws(()=>validateNativeGraph([helper,dll,{...dll,name:'LIBC++.DLL'}],'win32-x64'));
  assert.throws(()=>validateNativeGraph([helper,{...dll,arch:'arm64'}],'win32-x64'));
});
test('native producer rejects a source mutation or binary mutation before packaging',async()=>{
  const {nativeSourceDigest,verifyProducer,hashFile}=await load();const root=await mkdtemp(join(tmpdir(),'rw-producer-'));
  try{
    await mkdir(join(root,'native/rdp'),{recursive:true});await mkdir(join(root,'native/third-party'));await writeFile(join(root,'native/rdp/bridge.cpp'),'synthetic source');await writeFile(join(root,'native/third-party/json.hpp'),'synthetic header');const binary=join(root,'helper');await writeFile(binary,'synthetic binary');
    const producer={schema:1,target:'win32-x64',nativeSourceDigest:await nativeSourceDigest(root),files:[{path:binary,sha256:await hashFile(binary)}]};
    await verifyProducer(root,producer,'win32-x64');await writeFile(binary,'tampered');await assert.rejects(verifyProducer(root,producer,'win32-x64'));
    await writeFile(binary,'synthetic binary');await writeFile(join(root,'native/rdp/bridge.cpp'),'modified source');await assert.rejects(verifyProducer(root,producer,'win32-x64'));
  }finally{await rm(root,{recursive:true,force:true});}
});
test('MachO inspection handles parentheses in executable names without changing the file',{skip:process.platform!=='darwin'||!existsSync(resolve('native/bin/rdp-bridge'))},async()=>{
  const {inspectNative,hashFile}=await load(),dir=await mkdtemp(join(tmpdir(),'rw-macho-name-'));
  try{const path=join(dir,'helper (GPU)');await copyFile(resolve('native/bin/rdp-bridge'),path);const before=await hashFile(path),info=await inspectNative(path,'darwin-arm64');assert.equal(info.arch,'arm64');assert.match(info.minOS,/^\d+\.\d+/);assert.equal(await hashFile(path),before);}finally{await rm(dir,{recursive:true,force:true});}
});
