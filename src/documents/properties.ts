// Selected document metadata is validated before the working copy changes.
import {validateDocument,type Doc2} from './model.js';
import {isDeepStrictEqual} from 'node:util';
import {validateGroups,isPlainRecord,GROUP_REGISTRY,projectGroup,type Group} from './groups.js';
export function patchDocument(doc:Doc2,patch:unknown,now:string):Doc2{
 if(!isPlainRecord(patch)||Object.keys(patch).some(k=>!['name','sort','defaults','unsetDefaults'].includes(k)))throw Error('invalid');
 const next=structuredClone(doc);
 if(Object.hasOwn(patch,'name')){if(typeof patch.name!=='string'||patch.name.trim().length===0||patch.name.length>256||/[\u0000-\u001f\u007f]/.test(patch.name))throw Error('invalid-name');next.name=patch.name;}
 if(Object.hasOwn(patch,'sort'))next.meta.sort=structuredClone(patch.sort) as Doc2['meta']['sort'];
 if(Object.hasOwn(patch,'defaults')){
  const groups=validateGroups(patch.defaults);
  for(const [group,value]of Object.entries(groups)){
   if(GROUP_REGISTRY[group as keyof typeof groups]!.privacy==='private'&&value!==false&&!(group==='credentials'&&isPlainRecord(value)&&['none','id','name'].includes(String(value.mode))))throw Error('trusted-private-input-required');
  }
  Object.assign(next.defaults.groups,structuredClone(groups));
 }
 if(Object.hasOwn(patch,'unsetDefaults')){
  if(!Array.isArray(patch.unsetDefaults)||patch.unsetDefaults.some(k=>typeof k!=='string'||!Object.hasOwn(GROUP_REGISTRY,k)))throw Error('invalid');
  for(const k of patch.unsetDefaults)delete next.defaults.groups[k as keyof typeof next.defaults.groups];
 }
 validateDocument(next);
 if(isDeepStrictEqual(next,doc))return doc;
 if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(now)||!Number.isFinite(Date.parse(now))||new Date(now).toISOString()!==now)throw Error('invalid-clock');
 next.meta.updatedAt=doc.meta.updatedAt&&doc.meta.updatedAt>now?doc.meta.updatedAt:now;
 return validateDocument(next) as Doc2;
}
