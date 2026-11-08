import test from 'node:test';import assert from 'node:assert/strict';
const path='../src/desktop/effective-view.js';
test('a fresh or ambiguous identity menu starts with no binding until the user selects an identity',async()=>{
 const {identityOptions}=await import(path);const choices=[{value:'first',label:'same name'},{value:'second',label:'same name'}];const output=identityOptions(choices);
 assert.equal(output[0].value,'');assert.equal(output.find((o:any)=>o.value==='second').label,'same name');assert.deepEqual(choices,[{value:'first',label:'same name'},{value:'second',label:'same name'}]);assert.equal(identityOptions([])[0].value,'');
});
test('saved MFA selection is preserved, while malformed or private-bearing input cannot enter its public editor',async()=>{
 const {mfaView}=await import(path);assert.deepEqual(mfaView({mode:'generate',field:'username',pattern:'MfaCodeValue'}),{mode:'generate',field:'username',pattern:'MfaCodeValue'});
 for(const raw of [undefined,{mode:'generate',field:'username',pattern:'MfaCodeValue',seed:'PRIVATE-CANARY'},{mode:'unknown'}]){const output=mfaView(raw);assert.equal(output.mode,'none');assert.ok(!JSON.stringify(output).includes('PRIVATE-CANARY'));}
});
test('EditSource selects the exact document UUID and object pair rather than the first repeated object UUID',async()=>{
 const {sourceTarget}=await import(path);
 const targets=[{id:'handle-first',documentId:'document-A',objectId:'same-object',key:'first'},{id:'handle-second',documentId:'document-B',objectId:'same-object',key:'second'}];
 assert.deepEqual(sourceTarget(targets,{documentId:'document-B',objectId:'same-object'}),targets[1]);
 assert.equal(sourceTarget(targets,{documentId:'handle-second',objectId:'same-object'}),undefined,'a runtime handle is not a document UUID');
 assert.equal(sourceTarget(targets,{documentId:'document-C',objectId:'same-object'}),undefined);
 assert.equal(sourceTarget(targets,{objectId:'same-object'}),undefined);
 assert.equal(sourceTarget(targets,{documentId:'document-B'}),undefined);
 assert.deepEqual(targets.map(t=>t.key),['first','second']);
});
test('EditSource does not silently choose between duplicate open document namespaces',async()=>{
 const {sourceTarget}=await import(path);
 const targets=[{id:'first',documentId:'same-doc',objectId:'same-object'},{id:'second',documentId:'same-doc',objectId:'same-object'}];
 assert.equal(sourceTarget(targets,{documentId:'same-doc',objectId:'same-object'}),undefined);
});
