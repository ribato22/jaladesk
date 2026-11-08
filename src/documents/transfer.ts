import{validateDocument,UUID,type Doc2,type ObjectNode}from'./model.js';
import{referencedSecretIds,remapNodeReferences,type ReferenceMaps}from'./references.js';
import{validateTemplateSnapshot,type TemplateSnapshot}from'./templates.js';
import{isPlainRecord}from'./groups.js';
import{projectNode}from'./projection.js';
import{isDeepStrictEqual}from'node:util';
import{compareSiblings}from'./order.js';
export type PreparedTransfer={document:Doc2;idMap:Record<string,string>;selectedIds:string[];preview:{count:number;containsSecrets:boolean;containsPrivateData:boolean;externalReferences:number;missingReferences:number;unavailableSources:number;sourceScopeDependencies:number;sourceReferencesAffected:number;sourceCanRemove:boolean;inheritanceMayChange:number;privateOverridesCopied:false}};
export type TransferOptions={newId:()=>string;parentId?:string|null;copySecrets?:boolean;availableDocuments?:readonly Doc2[]};
function readSnapshot(node:ObjectNode):TemplateSnapshot|undefined{
 if(node.type!=='template'||!Object.hasOwn(node.props,'snapshot'))return;
 const text=node.props.snapshot;if(typeof text!=='string'||text.length>65536)throw Error('invalid-template');
 try{return validateTemplateSnapshot(JSON.parse(text));}catch{throw Error('invalid-template');}
}
function remapKnownNode(node:ObjectNode,maps:ReferenceMaps,wholeDocument=false,frozenContext?:string):ObjectNode{
 const copy=frozenContext===maps.sourceDocumentId?structuredClone(node):remapNodeReferences(node,maps);
 if(wholeDocument&&isPlainRecord(copy.props.groups)){
  const selection=copy.props.groups.credentials;
  if(isPlainRecord(selection)&&selection.mode==='name'&&Array.isArray(selection.scopeVaultIds))selection.scopeVaultIds=selection.scopeVaultIds.map(owner=>owner===maps.sourceDocumentId?maps.targetDocumentId:owner);
 }
 const snapshot=readSnapshot(node);
 if(snapshot){const next=validateTemplateSnapshot({...snapshot,objects:snapshot.objects.map(inner=>remapKnownNode(inner,maps,wholeDocument,snapshot.sourceDocumentId))});if(!isDeepStrictEqual(snapshot,next))copy.props.snapshot=JSON.stringify(next);}
 return copy;
}
function reserveReferences(node:ObjectNode,used:Set<string>):void{
 if(!isPlainRecord(node.props.groups))return;
 for(const value of Object.values(node.props.groups))if(isPlainRecord(value)){
  const ids=value.mode==='name'&&Array.isArray(value.scopeVaultIds)?value.scopeVaultIds:value.mode==='id'?[value.vaultId,value.credentialId]:[value.documentId,value.objectId];
  for(const id of ids)if(typeof id==='string'&&UUID.test(id))used.add(id);
 }
}
export function prepareTransfer(source:Doc2,destination:Doc2,ids:readonly string[],options:TransferOptions):PreparedTransfer{
 validateDocument(source);validateDocument(destination);if(source.schemaVersion!==2||destination.schemaVersion!==2||source.kind==='overrides'||destination.kind==='overrides')throw Error('invalid-transfer');if(source.id===destination.id)throw Error('same-document');
 const parentId=options.parentId??null;if(parentId!==null&&destination.objects[parentId]?.type!=='folder')throw Error('parent-invalid');
 const chosen=new Set(ids);if(!chosen.size||chosen.size>10000||[...chosen].some(id=>!Object.hasOwn(source.objects,id)))throw Error('selection-invalid');
 const roots=[...chosen].filter(id=>{for(let p=source.objects[id]!.parentId;p!==null;p=source.objects[p]!.parentId)if(chosen.has(p))return false;return true;});
 const children=new Map<string,ObjectNode[]>();for(const n of Object.values(source.objects))if(n.parentId!==null){const siblings=children.get(n.parentId)??[];siblings.push(n);children.set(n.parentId,siblings);}for(const siblings of children.values())siblings.sort(compareSiblings);
 const selected:ObjectNode[]=[];for(const root of roots){const from=selected.length;selected.push(source.objects[root]!);for(let i=from;i<selected.length;i++)selected.push(...(children.get(selected[i]!.id)??[]));}
 if(selected.length>10000)throw Error('too-many');
 const secretIds=[...new Set(selected.flatMap(referencedSecretIds))],containsPrivateData=selected.some(n=>!isDeepStrictEqual(projectNode(n),n));if((secretIds.length||containsPrivateData)&&options.copySecrets!==true)throw Error('private-copy-consent-required');
 const used=new Set([source.id,destination.id,...Object.keys(source.objects),...Object.keys(destination.objects),...Object.keys(source.secrets),...Object.keys(destination.secrets)]);
 for(const doc of [source,destination]){for(const node of Object.values(doc.objects))reserveReferences(node,used);reserveReferences({id:doc.id,type:'folder',name:'defaults',parentId:null,order:0,props:{groups:doc.defaults.groups}},used);}
 for(const node of selected){const snapshot=readSnapshot(node);if(snapshot){used.add(snapshot.sourceDocumentId);for(const inner of snapshot.objects){used.add(inner.id);reserveReferences(inner,used);}}}
 const fresh=()=>{const id=options.newId();if(!UUID.test(id)||used.has(id))throw Error('id-collision');used.add(id);return id;};
 const idMap=Object.fromEntries(selected.map(n=>[n.id,fresh()])),secretMap=Object.fromEntries(secretIds.map(id=>[id,fresh()]));const document=structuredClone(destination);
 for(const id of secretIds){if(!Object.hasOwn(source.secrets,id))throw Error('missing-secret');document.secrets[secretMap[id]!]=structuredClone(source.secrets[id]!);}
 let last=-1;for(const n of Object.values(destination.objects))if(n.parentId===parentId)last=Math.max(last,n.order);if(!Number.isSafeInteger(last+roots.length))throw Error('invalid-order');
 let externalReferences=0,missingReferences=0,unavailableSources=0,sourceScopeDependencies=0;
 const opened=(owner:string)=>[source,destination,...(options.availableDocuments??[])].find(doc=>doc.id===owner&&doc.kind!=='overrides');
 const inspect=(node:ObjectNode,context?:TemplateSnapshot)=>{
  if(!isPlainRecord(node.props.groups))return;
  for(const value of Object.values(node.props.groups))if(isPlainRecord(value)){
   if(value.mode==='name'&&typeof value.name==='string'&&Array.isArray(value.scopeVaultIds)){
    let anyMatch=false,allOpen=true;
    for(const owner of value.scopeVaultIds as string[]){externalReferences++;if(owner===source.id)sourceScopeDependencies++;const doc=opened(owner);if(!doc){unavailableSources++;allOpen=false;}else if(Object.values(doc.objects).some(n=>n.type==='credential'&&n.name.normalize('NFC')===(value.name as string).normalize('NFC')))anyMatch=true;}
    if(allOpen&&!anyMatch)missingReferences++;continue;
   }
   const owner=value.mode==='id'?value.vaultId:value.documentId,target=value.mode==='id'?value.credentialId:value.objectId;
   if(typeof owner!=='string'||typeof target!=='string')continue;
   if(context&&owner===context.sourceDocumentId&&context.objects.some(n=>n.id===target))continue;
   if(owner===source.id&&Object.hasOwn(idMap,target))continue;
   externalReferences++;const doc=opened(owner);if(!doc)unavailableSources++;else if(!Object.hasOwn(doc.objects,target))missingReferences++;
  }
 };
 for(const node of selected){
  const copy=remapKnownNode(node,{objectIds:idMap,secretIds:secretMap,sourceDocumentId:source.id,targetDocumentId:destination.id});copy.id=idMap[node.id]!;copy.parentId=roots.includes(node.id)?parentId:idMap[node.parentId!]!;if(roots.includes(node.id))copy.order=last+1+roots.indexOf(node.id);document.objects[copy.id]=copy;
  inspect(node);const snapshot=readSnapshot(node);if(snapshot)for(const inner of snapshot.objects)inspect(inner,snapshot);
 }
 validateDocument(document);
 const selectedIds=new Set(selected.map(node=>node.id)),selectedNames=new Set(selected.filter(node=>node.type==='credential').map(node=>node.name.normalize('NFC')));let sourceReferencesAffected=0;
 const incoming=(node:ObjectNode,context?:TemplateSnapshot)=>{
  if(!isPlainRecord(node.props.groups))return;
  for(const value of Object.values(node.props.groups))if(isPlainRecord(value)){
   if(value.mode==='name'&&typeof value.name==='string'&&Array.isArray(value.scopeVaultIds)){
    if(value.scopeVaultIds.includes(source.id)&&selectedNames.has(value.name.normalize('NFC')))sourceReferencesAffected++;
    continue;
   }
   const owner=value.mode==='id'?value.vaultId:value.documentId,target=value.mode==='id'?value.credentialId:value.objectId;
   if(owner!==source.id||typeof target!=='string'||!selectedIds.has(target))continue;
   if(context&&owner===context.sourceDocumentId&&context.objects.some(inner=>inner.id===target))continue;
   sourceReferencesAffected++;
  }
 };
 incoming({id:source.id,type:'folder',name:'defaults',parentId:null,order:0,props:{groups:source.defaults.groups}});
 for(const node of Object.values(source.objects))if(!selectedIds.has(node.id)){incoming(node);const snapshot=readSnapshot(node);if(snapshot)for(const inner of snapshot.objects)incoming(inner,snapshot);}
 const remaining={...source.objects};for(const id of selectedIds)delete remaining[id];let sourceCanRemove=true;try{validateDocument({...source,objects:remaining});}catch{sourceCanRemove=false;}
 return{document,idMap,selectedIds:selected.map(n=>n.id),preview:{count:selected.length,containsSecrets:secretIds.length>0,containsPrivateData,externalReferences,missingReferences,unavailableSources,sourceScopeDependencies,sourceReferencesAffected,sourceCanRemove,inheritanceMayChange:roots.length,privateOverridesCopied:false}};
}
export function duplicateDocumentChoice(doc:Doc2,choice:'skip'|'cancel'|'copy',newId:()=>string):{status:'skipped'|'cancelled'|'copy';document?:Doc2}{
 validateDocument(doc);if(choice==='skip')return{status:'skipped'};if(choice==='cancel')return{status:'cancelled'};if(choice!=='copy'||doc.schemaVersion!==2||doc.kind==='overrides')throw Error('choice-invalid');
 const used=new Set([doc.id,...Object.keys(doc.objects),...Object.keys(doc.secrets)]);
 reserveReferences({id:doc.id,type:'folder',name:'defaults',parentId:null,order:0,props:{groups:doc.defaults.groups}},used);
 for(const node of Object.values(doc.objects)){reserveReferences(node,used);const snapshot=readSnapshot(node);if(snapshot){used.add(snapshot.sourceDocumentId);for(const inner of snapshot.objects){used.add(inner.id);reserveReferences(inner,used);}}}
 const fresh=()=>{const id=newId();if(!UUID.test(id)||used.has(id))throw Error('id-collision');used.add(id);return id;};
 const document=structuredClone(doc);document.id=fresh();document.revision=0;const objectIds=Object.fromEntries(Object.keys(doc.objects).map(id=>[id,fresh()])),secretIds=Object.fromEntries(Object.keys(doc.secrets).map(id=>[id,fresh()]));const maps={objectIds,secretIds,sourceDocumentId:doc.id,targetDocumentId:document.id};
 document.objects={};for(const node of Object.values(doc.objects)){const copy=remapKnownNode(node,maps,true);copy.id=objectIds[node.id]!;copy.parentId=node.parentId===null?null:objectIds[node.parentId]!;document.objects[copy.id]=copy;}
 document.secrets=Object.fromEntries(Object.entries(doc.secrets).map(([id,record])=>[secretIds[id]!,structuredClone(record)]));
 document.defaults.groups=remapKnownNode({id:document.id,type:'folder',name:'defaults',parentId:null,order:0,props:{groups:doc.defaults.groups}},maps,true).props.groups as Doc2['defaults']['groups'];validateDocument(document);return{status:'copy',document};
}
