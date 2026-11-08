import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,stat,realpath,utimes} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createDocument,openDocument,saveDocument,realFs,type StoreFs} from '../src/documents/store.js';
import {seal} from '../src/documents/envelope.js';
const kdf={logN:14,r:8,p:1};
const latch=()=>{let release!:()=>void;const promise=new Promise<void>(r=>release=r);return{promise,release};};
test('every existing lock remains busy and cannot be stolen after its owner age is old',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'c3-lock-'));const path=join(await realpath(dir),'s.rwdoc');const h=await createDocument(path,Buffer.from('old'),'synthetic',{kdf});try{
  const lock=Buffer.from(JSON.stringify({pid:99999999,host:'unknown',t:0}));await writeFile(path+'.lock',lock);await assert.rejects(()=>saveDocument(h,Buffer.from('new'),{kdf,now:()=>Date.now()+120000,lockStaleMs:0}),(e:any)=>e.code==='busy');assert.deepEqual(await readFile(path+'.lock'),lock);assert.equal((await openDocument(path,'synthetic')).plaintext.toString(),'old');
 }finally{h.unlocked.dispose();await rm(dir,{recursive:true,force:true});}
});
test('a created document returns a committed warning when its own lock release failed',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'c3-create-warning-')),path=join(await realpath(dir),'s.rwdoc');let h:any;
 const fs:StoreFs={...realFs,unlink:async p=>{if(p===path+'.lock')throw Object.assign(Error('synthetic release'),{code:'EACCES'});await realFs.unlink(p);}};
 try{h=await createDocument(path,Buffer.from('created'),'synthetic',{kdf,fs});assert.deepEqual(h.warnings,['lock-release-failed']);const opened=await openDocument(path,'synthetic');assert.equal(opened.plaintext.toString(),'created');opened.handle.unlocked.dispose();}finally{h?.unlocked.dispose();await rm(dir,{recursive:true,force:true});}
});
test('opening a document never unlinks an active writer temp even if the clock or file age is old',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'c3-reader-temp-')),path=join(await realpath(dir),'s.rwdoc'),tmp=path+'.active-writer.tmp';const h=await createDocument(path,Buffer.from('committed'),'synthetic',{kdf});
 try{await writeFile(tmp,Buffer.from('synthetic encrypted temp'));await writeFile(path+'.lock',Buffer.from('synthetic active owner'));await utimes(tmp,new Date(0),new Date(0));const opened=await openDocument(path,'synthetic',{now:()=>Date.now()+120000});opened.handle.unlocked.dispose();assert.equal((await readFile(tmp)).toString(),'synthetic encrypted temp');}finally{h.unlocked.dispose();await rm(dir,{recursive:true,force:true});}
});
test('a multi-path lock failure releases only its own partial acquisition and never the other lock',async()=>{
 const module:any=await import('../src/documents/store.js');const dir=await mkdtemp(join(tmpdir(),'c3-multi-lock-')),a=join(await realpath(dir),'a'),b=join(await realpath(dir),'b');const other=Buffer.from('synthetic other lock');await writeFile(b+'.lock',other);
 try{await assert.rejects(()=>module.withDocumentLocks([b,a],{},async()=>assert.fail('must not enter')),(e:any)=>e.code==='busy');assert.equal(await stat(a+'.lock').then(()=>true,()=>false),false);assert.deepEqual(await readFile(b+'.lock'),other);}finally{await rm(dir,{recursive:true,force:true});}
});
test('release preserves a replacement lock and reports its warning instead of deleting somebody else ownership',async()=>{
 const module:any=await import('../src/documents/store.js');const dir=await mkdtemp(join(tmpdir(),'c3-release-owner-')),path=join(await realpath(dir),'s');let lease:any;const foreign=Buffer.from('synthetic replacement owner');
 try{await module.withDocumentLocks([path],{},async(map:Map<string,unknown>)=>{lease=map.get(path);await writeFile(path+'.lock',foreign);});assert.deepEqual(await readFile(path+'.lock'),foreign);assert.deepEqual(lease.warnings,['lock-release-failed']);}finally{await rm(dir,{recursive:true,force:true});}
});
test('an uncertain rekey requires reopen and cannot leave the old key handle writable',async()=>{
 const module:any=await import('../src/documents/store.js');const dir=await mkdtemp(join(tmpdir(),'c3-uncertain-')),path=join(await realpath(dir),'s.rwdoc');const h=await createDocument(path,Buffer.from('head'),'old',{kdf});let replaced=false;
 const fs:StoreFs={...realFs,rename:async(a,b)=>{await realFs.rename(a,b);if(b===path&&a.endsWith('.tmp')){replaced=true;throw Object.assign(Error('synthetic rename'),{code:'EIO'});}},readFile:async p=>{if(replaced&&p===path)throw Object.assign(Error('synthetic readback denied'),{code:'EACCES'});return realFs.readFile(p);}};
 try{await assert.rejects(()=>module.rekey(h,'old','new',{fs,kdf}),(e:any)=>e instanceof module.StoreCommitUncertainError&&e.reopenRequired===true);assert.throws(()=>h.unlocked.seal(Buffer.from('must reopen')));const opened=await openDocument(path,'new');assert.equal(opened.plaintext.toString(),'head');opened.handle.unlocked.dispose();}finally{h.unlocked.dispose();await rm(dir,{recursive:true,force:true});}
});
test('recovery replacement failure leaves the head in place and exclusive create never falls back to overwrite rename',async()=>{
 const module:any=await import('../src/documents/store.js');const dir=await mkdtemp(join(tmpdir(),'c3-fault-head-')),path=join(await realpath(dir),'s.rwdoc');const h=await createDocument(path,Buffer.from('revision'),'synthetic',{kdf});await saveDocument(h,Buffer.from('head'));const [revision]=await module.listRevisions(path),before=await readFile(path);
 try{const denied:StoreFs={...realFs,rename:async(a,b)=>{if(b===path)throw Object.assign(Error('synthetic rename denied'),{code:'EIO'});return realFs.rename(a,b);}};await assert.rejects(()=>module.recover(path,'synthetic',revision,{fs:denied,expectedDigest:h.digest}));assert.deepEqual(await readFile(path),before);
  const newPath=join(await realpath(dir),'unsupported.rwdoc');let renames=0;const noLink:StoreFs&{link:(from:string,to:string)=>Promise<void>}={...realFs,link:async()=>{throw Object.assign(Error('synthetic unsupported link'),{code:'ENOTSUP'});},rename:async(a,b)=>{renames++;return realFs.rename(a,b);}};await assert.rejects(()=>createDocument(newPath,Buffer.from('new'),'synthetic',{fs:noLink,kdf}),(e:any)=>e.code==='io');assert.equal(await stat(newPath).then(()=>true,()=>false),false);assert.equal(renames,0);
 }finally{h.unlocked.dispose();await rm(dir,{recursive:true,force:true});}
});
test('recovery cooperates with lock leases and reviewed head CAS instead of silently overwriting a writer',async()=>{
 const module:any=await import('../src/documents/store.js');const dir=await mkdtemp(join(tmpdir(),'c3-recover-')),path=join(await realpath(dir),'s.rwdoc');const h=await createDocument(path,Buffer.from('revision'),'synthetic',{kdf});let replacement:any;
 try{await saveDocument(h,Buffer.from('head'));const [revision]=await module.listRevisions(path);const before=await readFile(path);
  await module.withDocumentLocks([path],{},async(map:Map<string,unknown>)=>{
   await assert.rejects(()=>module.recover(path,'synthetic',revision), (e:any)=>e.code==='busy');assert.deepEqual(await readFile(path),before);
   await assert.rejects(()=>module.recover(path,'synthetic',revision,{lease:map.get(path),expectedDigest:'f'.repeat(64)}),(e:any)=>e.code==='conflict');
   replacement=await module.recover(path,'synthetic',revision,{lease:map.get(path),expectedDigest:h.digest});assert.equal(replacement.plaintext.toString(),'revision');
  });assert.equal((await openDocument(path,'synthetic')).plaintext.toString(),'revision');
 }finally{h.unlocked.dispose();replacement?.handle.unlocked.dispose();await rm(dir,{recursive:true,force:true});}
});
test('rekey changes only ciphertext key, returns a new handle and keeps old revisions on their old key',async()=>{
 const module:any=await import('../src/documents/store.js');assert.equal(typeof module.rekey,'function');const dir=await mkdtemp(join(tmpdir(),'c3-rekey-')),path=join(await realpath(dir),'s.rwdoc');const h=await createDocument(path,Buffer.from('head'),'old',{kdf});let next:any;
 try{next=await module.rekey(h,'old','new',{kdf});assert.deepEqual(next.warnings,[]);assert.notEqual(next.handle.fingerprint,h.fingerprint);await assert.rejects(()=>openDocument(path,'old'));assert.equal((await openDocument(path,'new')).plaintext.toString(),'head');await saveDocument(next.handle,Buffer.from('saved-next'));assert.equal((await openDocument(path,'new')).plaintext.toString(),'saved-next');const names=await module.listRevisions(path);assert.ok((await Promise.all(names.map(async(n:string)=>module.openRevision(path,'old',n).catch(()=>undefined)))).some(b=>b?.toString()==='head'));
 }finally{h.unlocked.dispose();next?.handle.unlocked.dispose();await rm(dir,{recursive:true,force:true});}
});
test('rekey reports committed warnings after a rename that happened then threw, and after a failed release',async()=>{
 const module:any=await import('../src/documents/store.js');assert.equal(typeof module.rekey,'function');
 for(const fault of ['after-rename','release']){const dir=await mkdtemp(join(tmpdir(),'c3-rekey-warning-')),path=join(await realpath(dir),'s.rwdoc');const h=await createDocument(path,Buffer.from('head'),'old',{kdf});let next:any,armed=true;
  const fs:StoreFs={...realFs,rename:async(a,b)=>{await realFs.rename(a,b);if(fault==='after-rename'&&armed&&b===path&&a.endsWith('.tmp')){armed=false;throw Object.assign(Error('synthetic IO'),{code:'EIO'});}},unlink:async p=>{if(fault==='release'&&p===path+'.lock')throw Object.assign(Error('synthetic release'),{code:'EACCES'});await realFs.unlink(p);}};
  try{next=await module.rekey(h,'old','new',{kdf,fs});assert.ok(next.warnings.includes(fault==='after-rename'?'commit-observed-after-error':'lock-release-failed'));assert.equal((await openDocument(path,'new')).plaintext.toString(),'head');await assert.rejects(()=>openDocument(path,'old'));}
  finally{h.unlocked.dispose();next?.handle.unlocked.dispose();await rm(dir,{recursive:true,force:true});}
 }
});
test('ordered store lock lease is reusable only inside its scope on the exact path and filesystem',async()=>{
 const module:any=await import('../src/documents/store.js');assert.equal(typeof module.withDocumentLocks,'function');
 const dir=await mkdtemp(join(tmpdir(),'c3-lease-'));const path=join(await realpath(dir),'s.rwdoc');const h=await createDocument(path,Buffer.from('old'),'synthetic',{kdf});let lease:any;
 try{await module.withDocumentLocks([path],{},async(leases:Map<string,unknown>)=>{lease=leases.get(path);assert.ok(lease);await saveDocument(h,Buffer.from('saved'),{lease} as any);await assert.rejects(()=>saveDocument(h,Buffer.from('foreign')),(e:any)=>e.code==='busy');await assert.rejects(()=>saveDocument(h,Buffer.from('forged'),{lease:{path}} as any),(e:any)=>e.code==='busy');await assert.rejects(()=>saveDocument({...h,path:path+'.foreign'},Buffer.from('wrong path'),{lease} as any),(e:any)=>e.code==='busy');await assert.rejects(()=>saveDocument(h,Buffer.from('wrong fs'),{lease,fs:{...realFs,readFile:async()=>{throw Error('must not read');}}} as any),(e:any)=>e.code==='busy');});assert.equal(await stat(path+'.lock').then(()=>true,()=>false),false);await assert.rejects(()=>saveDocument(h,Buffer.from('stale'),{lease} as any),(e:any)=>e.code==='busy');
 }finally{h.unlocked.dispose();await rm(dir,{recursive:true,force:true});}
});
test('exclusive create never overwrites a file that appears after its initial missing check',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'c3-create-'));const path=join(await realpath(dir),'s.rwdoc'),reached=latch(),resume=latch();let armed=true;
 const fs:StoreFs={...realFs,open:async(p,flags,mode)=>{const h=await realFs.open(p,flags,mode);return{writeFile:d=>h.writeFile(d),close:()=>h.close(),sync:async()=>{await h.sync();if(armed&&p.startsWith(path+'.')&&p.endsWith('.tmp')){armed=false;reached.release();await resume.promise;}}};}};
 const foreign=await seal(Buffer.from('other-writer'),'other',{kdf});const creating=createDocument(path,Buffer.from('mine'),'mine',{fs,kdf});await reached.promise;await writeFile(path,foreign.file);resume.release();
 try{await assert.rejects(()=>creating,(e:any)=>e.code==='exists');assert.deepEqual(await readFile(path),foreign.file);}finally{foreign.unlocked.dispose();await rm(dir,{recursive:true,force:true});}
});
