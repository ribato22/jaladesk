import test from 'node:test';import assert from 'node:assert/strict';
import {modelOf,applyDelta,sortedChildren} from '../src/desktop/docmodel.js';
import {isSorted,buildRows,documentKey} from '../src/desktop/navigation.js';
test('root sort uses natural names, invalidates metadata-only deltas and keeps folder sort independent',()=>{
 const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
 const s:any={id:'handle',docId:id(9),name:'Doc',revision:1,dirty:false,conflicts:0,seq:0,meta:{createdAt:null,updatedAt:null,sort:[{by:'name',dir:'asc'}]},objects:[{id:id(1),type:'connection',name:'srv10',parentId:null,order:0,props:{}},{id:id(2),type:'connection',name:'srv2',parentId:null,order:1,props:{}}]};
 const model=modelOf(s);assert.deepEqual(sortedChildren(model,null).map(n=>n.name),['srv2','srv10']);assert.equal(isSorted(model,null),true);
 applyDelta(model,{...s,from:0,seq:1,upsert:[],remove:[],meta:{...s.meta,sort:[{by:'name',dir:'desc'}]}});assert.deepEqual(sortedChildren(model,null).map(n=>n.name),['srv10','srv2']);
 const rows=buildRows([model],new Set([documentKey(model.id)]));assert.deepEqual(rows.slice(1).map(r=>r.name),['srv10','srv2']);assert.equal(rows[0].key,documentKey(model.id));
});
