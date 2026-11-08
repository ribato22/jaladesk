import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DocumentLibrary, type TransferResult } from '../src/documents/library.js';
import { DocumentSession } from '../src/documents/session.js';
import { prepareTransfer } from '../src/documents/transfer.js';
import { listRevisions, realFs, recover, type StoreFs } from '../src/documents/store.js';
import type { Doc2 } from '../src/documents/model.js';
const kdf={logN:14,r:8,p:1},password='synthetic';
function latch(){let release!:()=>void;const promise=new Promise<void>(done=>{release=done;});return{promise,release};}
async function fixture(t:TestContext,fs:StoreFs=realFs){
 const dir=await mkdtemp(join(tmpdir(),'c3-transfer-races-')),lib=new DocumentLibrary({kdf,fs});t.after(async()=>{lib.closeAll();await rm(dir,{recursive:true,force:true});});const a=await lib.create(join(dir,'a.rwdoc'),'A',password),b=await lib.create(join(dir,'b.rwdoc'),'B',password),folderA=lib.add(a.id,{type:'folder',parentId:null,name:'Folder A'}).objectId,childA=lib.add(a.id,{type:'connection',parentId:folderA,name:'Connection A',props:{protocol:'rdp',host:'a.invalid'}}).objectId,folderB=lib.add(b.id,{type:'folder',parentId:null,name:'Folder B'}).objectId,childB=lib.add(b.id,{type:'connection',parentId:folderB,name:'Connection B',props:{protocol:'rdp',host:'b.invalid'}}).objectId;await lib.save(a.id);await lib.save(b.id);
 const request=(from:string,to:string,selected:string[],confirmMove:()=>Promise<boolean>)=>({source:lib.entryStamp(from),destination:lib.entryStamp(to),prepared:prepareTransfer(lib.privateDocument(from).doc as Doc2,lib.privateDocument(to).doc as Doc2,selected,{newId:randomUUID}),mode:'move' as const,confirmMove});
 return{lib,a:a.id,b:b.id,folderA,childA,folderB,childB,request};
}
async function disk(path:string,secret=password){const session=await DocumentSession.open(path,{password:secret},{kdf});try{return structuredClone(session.doc) as Doc2;}finally{session.dispose();}}
async function pausedOrFinished(paused:Promise<void>,running:Promise<TransferResult>){await Promise.race([paused,running.then(()=>assert.fail('Transfer finished before the controlled IO boundary'))]);}

test('opposing moves reject the second as busy before any destination edit and preserve both original subtrees on encrypted disk',async t=>{
 const paused=latch(),resume=latch();let destinationPath='',armed=false;const fs:StoreFs={...realFs,rename:async(from,to)=>{if(armed&&to===destinationPath){armed=false;paused.release();await resume.promise;}await realFs.rename(from,to);}};const f=await fixture(t,fs),aPath=f.lib.entryStamp(f.a).path,bPath=f.lib.entryStamp(f.b).path;destinationPath=bPath;const first=f.request(f.a,f.b,[f.folderA],async()=>true),opposed=f.request(f.b,f.a,[f.folderB],async()=>true),beforeA=await readFile(aPath);armed=true;
 const running=f.lib.transfer(first);try{await pausedOrFinished(paused.promise,running);await assert.rejects(()=>f.lib.transfer(opposed),(e:unknown)=>(e as {code?:string}).code==='busy');assert.deepEqual(await readFile(aPath),beforeA);assert.equal(f.lib.snapshot(f.a).objects.length,2);resume.release();const result=await running;assert.equal(result.stage,'complete');assert.equal(result.destination,'verified');assert.equal(result.sourceDisk,'removed-saved');}finally{resume.release();await running.catch(()=>{});}
 const a=await disk(aPath),b=await disk(bPath);assert.equal(Object.keys(a.objects).length,0);assert.deepEqual(Object.values(b.objects).map(n=>n.name).sort(),['Connection A','Connection B','Folder A','Folder B']);assert.equal(Object.keys(b.objects).length,4);
});
test('destination rekey and recovery both remain busy while the destination lease is held across source commit',async t=>{
 const paused=latch(),resume=latch();let sourcePath='',armed=false;const fs:StoreFs={...realFs,rename:async(from,to)=>{if(armed&&to===sourcePath){armed=false;paused.release();await resume.promise;}await realFs.rename(from,to);}};const f=await fixture(t,fs),aPath=f.lib.entryStamp(f.a).path,bPath=f.lib.entryStamp(f.b).path;sourcePath=aPath;let other:DocumentSession|undefined;const moving=f.lib.transfer(f.request(f.a,f.b,[f.folderA],async()=>{armed=true;return true;}));
 try{await pausedOrFinished(paused.promise,moving);other=await DocumentSession.open(bPath,{password},{kdf});const destinationBefore=await readFile(bPath),[revision]=await listRevisions(bPath);assert.ok(revision,'encrypted prior revision exists');await assert.rejects(()=>other!.changePassword(password,'synthetic-new-key'),(e:unknown)=>(e as {code?:string}).code==='busy');await assert.rejects(()=>recover(bPath,password,revision,{kdf,expectedDigest:other!.handle.digest}),(e:unknown)=>(e as {code?:string}).code==='busy');assert.deepEqual(await readFile(bPath),destinationBefore);resume.release();const result=await moving;assert.equal(result.stage,'complete');assert.equal(result.sourceDisk,'removed-saved');assert.equal(result.destination,'verified');}finally{resume.release();await moving.catch(()=>{});other?.dispose();}
 const destination=await disk(bPath);assert.deepEqual(Object.values(destination.objects).map(n=>n.name).sort(),['Connection A','Connection B','Folder A','Folder B']);assert.equal(Object.keys((await disk(aPath)).objects).length,0);await assert.rejects(()=>disk(bPath,'synthetic-new-key'));
});
for(const kind of ['ciphertext','key'] as const)test(`foreign source ${kind} change during move consent retains the source and its foreign state after the verified copy`,async t=>{
 const f=await fixture(t),aPath=f.lib.entryStamp(f.a).path,bPath=f.lib.entryStamp(f.b).path,before=await readFile(aPath);let foreignBytes:Buffer|undefined;
 const result=await f.lib.transfer(f.request(f.a,f.b,[f.folderA],async()=>{const writer=await DocumentSession.open(aPath,{password},{kdf});try{if(kind==='ciphertext'){writer.update(doc=>{doc.objects[f.childA].props.notes='foreign edit preserved';});await writer.save();}else await writer.changePassword(password,'synthetic-foreign-key');foreignBytes=await readFile(aPath);return true;}finally{writer.dispose();}}));
 assert.equal(result.destination,'verified');assert.equal(result.stage,'source-check');assert.equal(result.errorCode,'stale');assert.equal(result.sourceDisk,'retained');assert.equal(result.sourceMemory,'unchanged');assert.notDeepEqual(foreignBytes,before);assert.deepEqual(await readFile(aPath),foreignBytes);assert.equal(f.lib.snapshot(f.a).objects.length,2);const source=await disk(aPath,kind==='key'?'synthetic-foreign-key':password),destination=await disk(bPath);assert.equal(Object.keys(source.objects).length,2);assert.equal(source.objects[f.childA].props.notes,kind==='ciphertext'?'foreign edit preserved':undefined);assert.equal(Object.values(destination.objects).find(n=>n.name==='Connection A')!.props.notes,undefined);if(kind==='key')await assert.rejects(()=>disk(aPath,password));
});
