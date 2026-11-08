import {createHash} from 'node:crypto';
import type {Clipboard} from './wire.js';
// UTF-8 bytes per direction. Keeps the base64 control line far below the helper's 64 KiB line limit.
export const CLIPBOARD_MAX_BYTES=32*1024;
export type ClipboardResult='sent'|'disabled'|'too-large'|'invalid'|'closed';
const base64=/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const unpaired=/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
export function encodeClipboard(text:string):string{
  if(text.includes('\0')||unpaired.test(text))throw new Error('clipboard invalid');
  const bytes=Buffer.from(text,'utf8');
  if(bytes.length>CLIPBOARD_MAX_BYTES)throw new Error('clipboard too-large');
  return bytes.toString('base64');
}
export function decodeClipboard(b64:string):string{
  if(typeof b64!=='string')throw new Error('clipboard invalid');
  if(b64.length>Math.ceil(CLIPBOARD_MAX_BYTES/3)*4)throw new Error('clipboard too-large');
  if(!base64.test(b64))throw new Error('clipboard invalid');
  const bytes=Buffer.from(b64,'base64');
  if(bytes.toString('base64')!==b64)throw new Error('clipboard invalid');
  if(bytes.length>CLIPBOARD_MAX_BYTES)throw new Error('clipboard too-large');
  if(bytes.includes(0))throw new Error('clipboard invalid');
  try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw new Error('clipboard invalid');}
}
// Electron's clipboard module is promise based.
// Shown in the credential prompt, which only the main process can write, so a renderer cannot hide what it enabled.
export function describeClipboard(c?:Clipboard):string{
  if(!c||(!c.toRemote&&!c.fromRemote))return 'Clipboard: nonaktif';
  return 'Clipboard teks: '+(c.toRemote&&c.fromRemote?'remote → lokal dan lokal → remote':c.toRemote?'lokal → remote':'remote → lokal');
}
type Os={readText():Promise<string>;writeText(text:string):Promise<void>};
type Sharing={clipboard:Clipboard;sendClipboard(text:string):ClipboardResult};
export type GateResult=ClipboardResult|'empty'|'unchanged';
// Only a digest is remembered, never the text of the user's clipboard.
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
// Main-process policy. Only the active session writes the OS clipboard, and only while the application window has focus;
// text a session wrote is not echoed back to it.
export function makeClipboardGate(os:Os,focused:()=>boolean=()=>true){
  let active='';const last=new Map<string,string>();
  return {
    activate(id:string){active=id;},
    async remote(id:string,text:string):Promise<boolean>{
      if(id!==active||!focused())return false;
      last.set(id,digest(text));
      try{await os.writeText(text);}catch(error){last.delete(id);throw error;}
      return true;
    },
    async local(id:string,session:Sharing):Promise<GateResult>{
      if(!session.clipboard.toRemote)return 'disabled';
      const text=await os.readText();if(!text)return 'empty';
      const key=digest(text);if(last.get(id)===key)return 'unchanged';
      const result=session.sendClipboard(text);
      if(result!=='closed')last.set(id,key);
      return result;
    },
    forget(id:string){last.delete(id);if(active===id)active='';}
  };
}
