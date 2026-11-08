import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDelta, modelOf, sortedChildren, type DocModel } from '../src/desktop/docmodel.js';
import { allExpanded, buildRows, documentKey, isSorted, keepSelection, moveTarget, navigate, objectKey, onlyDocuments, resolveDrop, ROW_HEIGHT, scrollTopFor, windowOf } from '../src/desktop/navigation.js';
import type { Snapshot } from '../src/documents/library.js';
import type { ObjectNode } from '../src/documents/model.js';
import type { SortCriterion } from '../src/documents/meta.js';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function node(n:number,name:string,over:Partial<ObjectNode>={}):ObjectNode{return{id:id(n),type:'connection',name,parentId:null,order:0,props:{protocol:'rdp'},...over};}
function fixture(objects:ObjectNode[],sort:SortCriterion[]=[]):DocModel{return modelOf({id:'root-c3',docId:id(900),name:'Fixture',revision:0,dirty:false,conflicts:0,seq:0,meta:{createdAt:null,updatedAt:null,sort},objects} satisfies Snapshot);}
function rootSort(model:DocModel,sort:SortCriterion[]):void{assert.equal(applyDelta(model,{id:model.id,docId:model.docId,name:model.name,revision:model.revision,dirty:model.dirty,conflicts:model.conflicts,from:model.seq,seq:model.seq+1,upsert:[],remove:[],meta:{createdAt:null,updatedAt:null,sort}}),'applied');}
const ids=(model:DocModel,parent:string|null=null)=>sortedChildren(model,parent).map(n=>n.id);

test('root type then name honors both directions, natural digits and deterministic order/UUID ties after metadata-only changes',()=>{
 const model=fixture([
  node(7,'srv1',{order:3}),node(5,'srv1',{order:10}),node(6,'srv1',{order:3}),node(8,'srv2',{order:5}),
  node(3,'srv10',{props:{protocol:'ssh'}}),node(4,'srv2',{order:60,props:{protocol:'ssh'}}),
  node(1,'group10',{type:'folder',order:90}),node(2,'group2',{type:'folder',order:80}),
 ]);
 const cases:{sort:SortCriterion[];want:number[]}[]=[
  {sort:[{by:'type',dir:'asc'},{by:'name',dir:'asc'}],want:[2,1,6,7,5,8,4,3]},
  {sort:[{by:'type',dir:'asc'},{by:'name',dir:'desc'}],want:[1,2,8,6,7,5,3,4]},
  {sort:[{by:'type',dir:'desc'},{by:'name',dir:'asc'}],want:[4,3,6,7,5,8,2,1]},
  {sort:[{by:'type',dir:'desc'},{by:'name',dir:'desc'}],want:[3,4,8,6,7,5,1,2]},
 ];
 for(const {sort,want}of cases){const before=sortedChildren(model,null);rootSort(model,sort);assert.notEqual(sortedChildren(model,null),before);assert.deepEqual(ids(model),want.map(id));assert.equal(isSorted(model,null),true);}
});
test('root name as first criterion takes precedence over type; case ties use second criterion and its own direction',()=>{
 const model=fixture([node(21,'alpha',{type:'folder',order:10}),node(22,'Alpha'),node(23,'beta',{props:{protocol:'ssh'},order:1}),node(24,'Beta')]);
 const cases:{sort:SortCriterion[];want:number[]}[]=[
  {sort:[{by:'name',dir:'asc'},{by:'type',dir:'asc'}],want:[21,22,24,23]},
  {sort:[{by:'name',dir:'asc'},{by:'type',dir:'desc'}],want:[22,21,23,24]},
  {sort:[{by:'name',dir:'desc'},{by:'type',dir:'asc'}],want:[24,23,21,22]},
  {sort:[{by:'name',dir:'desc'},{by:'type',dir:'desc'}],want:[23,24,22,21]},
 ];
 for(const {sort,want}of cases){rootSort(model,sort);assert.deepEqual(ids(model),want.map(id));}
});
test('metadata root changes leave folder sorts independent, preserve manual folders and disable only sibling reordering in sorted parents',()=>{
 const sorted=node(1,'Sorted',{type:'folder',props:{sort:[{by:'name',dir:'desc'}]}}),plain=node(2,'Plain',{type:'folder',order:1});
 const model=fixture([sorted,plain,node(3,'z',{order:2}),node(4,'a',{order:3}),node(5,'srv2',{parentId:id(1)}),node(6,'srv10',{parentId:id(1),order:1}),node(7,'b',{parentId:id(2)}),node(8,'a',{parentId:id(2),order:1})],[{by:'name',dir:'asc'}]);
 const sortedCache=sortedChildren(model,id(1)),plainCache=sortedChildren(model,id(2));assert.deepEqual(ids(model,id(1)),[id(6),id(5)]);assert.deepEqual(ids(model,id(2)),[id(7),id(8)]);
 rootSort(model,[{by:'name',dir:'desc'}]);assert.deepEqual(ids(model),[id(3),id(1),id(2),id(4)]);assert.equal(sortedChildren(model,id(1)),sortedCache);assert.equal(sortedChildren(model,id(2)),plainCache);
 assert.equal(moveTarget(model,id(1),'down'),undefined);assert.equal(moveTarget(model,id(3),'up'),undefined);assert.equal(moveTarget(model,id(5),'up'),undefined);assert.deepEqual(moveTarget(model,id(8),'up'),{parentId:id(2),index:0});assert.deepEqual(resolveDrop(new Map([[model.id,model]]),objectKey(model.id,id(4)),objectKey(model.id,id(3)),'before'),{refused:'sorted'});
 const rows=buildRows([model],allExpanded([model]));assert.deepEqual(rows.filter(r=>r.parentKey===objectKey(model.id,id(1))).map(r=>r.name),['srv10','srv2']);assert.deepEqual(rows.filter(r=>r.parentKey===objectKey(model.id,id(2))).map(r=>r.name),['b','a']);
 rootSort(model,[]);assert.equal(isSorted(model,null),false);assert.deepEqual(moveTarget(model,id(2),'up'),{parentId:null,index:0});assert.equal(isSorted(model,id(1)),true);
});
test('natural sorted root order survives search/favorites and virtualization while stable selection follows keyboard navigation after re-sort',()=>{
 const objects=Array.from({length:240},(_,i)=>node(240-i,`server ${240-i}`,{order:i})),model=fixture(objects,[{by:'name',dir:'asc'}]);
 let rows=buildRows([model],onlyDocuments([model]));assert.deepEqual(rows.slice(1,4).map(r=>r.name),['server 1','server 2','server 3']);assert.equal(rows.at(-1)!.name,'server 240');
 const visible=windowOf(rows.length,150*ROW_HEIGHT,10*ROW_HEIGHT,ROW_HEIGHT,2);assert.deepEqual(rows.slice(visible.start,visible.end).map(r=>r.name),Array.from({length:14},(_,i)=>`server ${148+i}`));
 const selected=objectKey(model.id,id(220)),at=rows.findIndex(r=>r.key===selected),top=scrollTopFor(at,0,10*ROW_HEIGHT),slice=windowOf(rows.length,top,10*ROW_HEIGHT);assert.ok(rows.slice(slice.start,slice.end).some(r=>r.key===selected));assert.ok(at*ROW_HEIGHT>=top&&(at+1)*ROW_HEIGHT<=top+10*ROW_HEIGHT);
 const favorites=new Map([[model.id,new Set([2,20,200,201,202,220,240,10].map(id))]]),filtered=buildRows([model],new Set(),{favorites,filter:{query:'SERVER 2',notes:false,onlyFavorites:true}});assert.deepEqual(filtered.slice(1).map(r=>r.name),['server 2','server 20','server 200','server 201','server 202','server 220','server 240']);assert.equal(filtered.find(r=>r.key===selected)!.favorite,true);assert.equal(keepSelection(filtered,selected),selected);assert.equal(keepSelection(filtered,objectKey(model.id,id(1))),documentKey(model.id));assert.deepEqual(filtered.slice(1).map(r=>[r.posInSet,r.setSize]),Array.from({length:7},(_,i)=>[i+1,7]));
 rootSort(model,[{by:'name',dir:'desc'}]);rows=buildRows([model],onlyDocuments([model]));assert.equal(keepSelection(rows,selected),selected);assert.deepEqual(navigate(rows,selected,'ArrowDown'),{focus:objectKey(model.id,id(219))});assert.deepEqual(navigate(rows,selected,'ArrowUp'),{focus:objectKey(model.id,id(221))});assert.deepEqual(navigate(rows,selected,'Home'),{focus:documentKey(model.id)});assert.deepEqual(navigate(rows,selected,'End'),{focus:objectKey(model.id,id(1))});assert.equal(moveTarget(model,id(220),'up'),undefined);assert.equal(moveTarget(model,id(220),'down'),undefined);
});
