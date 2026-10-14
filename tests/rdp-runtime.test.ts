import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
// @ts-ignore JavaScript build utility is exercised without adding a runtime dependency.
import {stageRuntime,verifyHash} from '../../scripts/native-support.mjs';
test('runtime staging preserves DLLs beside the helper and rejects a missing executable',()=>{
 const dir=mkdtempSync(join(tmpdir(),'rdp-stage-'));try{
  const source=join(dir,'install'),dest=join(dir,'bin');mkdirSync(source);writeFileSync(join(source,'rdp-bridge.exe'),'fixture');writeFileSync(join(source,'winpr3.dll'),'dll');
  assert.throws(()=>stageRuntime(source,dest,'absent.exe'),/missing/);stageRuntime(source,dest,'rdp-bridge.exe');
  assert.equal(readFileSync(join(dest,'winpr3.dll'),'utf8'),'dll');assert.equal(readFileSync(join(dest,'rdp-bridge.exe'),'utf8'),'fixture');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('pinned archive verification rejects altered bytes',()=>{
 const bytes=Buffer.from('abc');assert.doesNotThrow(()=>verifyHash(bytes,'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'));
 assert.throws(()=>verifyHash(Buffer.from('abd'),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'),/hash/);
});
