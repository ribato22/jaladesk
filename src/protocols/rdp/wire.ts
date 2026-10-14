export type Frame = {width:number;height:number;rgba:Uint8Array};
export type Input = {type:'pointer';x:number;y:number;buttons:number} | {type:'key';scanCode:number;down:boolean} | {type:'resize';width:number;height:number} | {type:'close'};
export type RdpTarget = {host:string;port:number;username:string;certificateSha256?:string};
export type Secret = {password:string;domain:string};
export type State = 'connecting'|'connected'|'closed'|'failed';
export type Sink = {frame(frame:Frame):void;state(state:State,reason?:string):void};
export const FRAME_BUDGET = 128 * 1024 * 1024;
function dimensions(width:number,height:number) {
  if (!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>8192||height>8192) throw new Error('frame dimensions');
}
export function decodeFrame(packet:Uint8Array):Frame {
  if (packet.byteLength<12) throw new Error('frame length');
  const d=new DataView(packet.buffer,packet.byteOffset,packet.byteLength);
  const size=d.getUint32(0,true), width=d.getUint32(4,true), height=d.getUint32(8,true);
  if (size>FRAME_BUDGET) throw new Error('frame budget');
  dimensions(width,height);
  if(size!==8+width*height*4||packet.byteLength!==size+4) throw new Error('frame length');
  return {width,height,rgba:packet.subarray(12)};
}
export class FrameStream {
  private header=new Uint8Array(12);
  private filled=0;
  private packet:Uint8Array|undefined;
  push(bytes:Uint8Array):Frame[] {
    const out:Frame[]=[];let offset=0;
    while(offset<bytes.length) {
      if(!this.packet) {
        const boundary=this.filled<4?4:12;
        const n=Math.min(boundary-this.filled,bytes.length-offset);
        this.header.set(bytes.subarray(offset,offset+n),this.filled);this.filled+=n;offset+=n;
        if(this.filled===4) {
          const size=new DataView(this.header.buffer).getUint32(0,true);
          if(size>FRAME_BUDGET)throw new Error('frame budget');
          if(size<12)throw new Error('frame length');
        }
        if(this.filled!==12)continue;
        const d=new DataView(this.header.buffer),size=d.getUint32(0,true),w=d.getUint32(4,true),h=d.getUint32(8,true);
        dimensions(w,h);if(size!==8+w*h*4)throw new Error('frame length');
        this.packet=new Uint8Array(size+4);this.packet.set(this.header);
      }
      const n=Math.min(this.packet.length-this.filled,bytes.length-offset);
      this.packet.set(bytes.subarray(offset,offset+n),this.filled);this.filled+=n;offset+=n;
      if(this.filled===this.packet.length) {out.push(decodeFrame(this.packet));this.packet=undefined;this.filled=0;}
    }
    return out;
  }
  finish():void {if(this.filled)throw new Error('truncated frame');}
}
function object(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid object');
  return value as Record<string,unknown>;
}
function integer(value:unknown,min:number,max:number):number {
  if(typeof value!=='number'||!Number.isInteger(value)||value<min||value>max)throw new Error('invalid integer');return value;
}
export function validateTarget(value:unknown):RdpTarget {
  const v=object(value);
  if(typeof v.host!=='string'||v.host.length>253||!v.host.length||/[\s\x00-\x1f]/.test(v.host))throw new Error('invalid host');
  if(typeof v.username!=='string'||!v.username.length||v.username.length>256||/[\x00-\x1f]/.test(v.username))throw new Error('invalid username');
  const out:RdpTarget={host:v.host,port:integer(v.port,1,65535),username:v.username};
  if(v.certificateSha256!==undefined&&v.certificateSha256!=='') {
    if(typeof v.certificateSha256!=='string'||!/^[a-fA-F0-9]{64}$/.test(v.certificateSha256))throw new Error('invalid fingerprint');
    out.certificateSha256=v.certificateSha256.toLowerCase();
  }
  return out;
}
export function validateInput(value:unknown):Input {
  const v=object(value);
  switch(v.type) {
    case 'close':return {type:'close'};
    case 'pointer':return {type:'pointer',x:integer(v.x,0,8191),y:integer(v.y,0,8191),buttons:integer(v.buttons,0,7)};
    case 'key':if(typeof v.down!=='boolean')throw new Error('invalid key');return {type:'key',scanCode:integer(v.scanCode,1,511),down:v.down};
    case 'resize':return {type:'resize',width:integer(v.width,1,8192),height:integer(v.height,1,8192)};
    default:throw new Error('invalid input');
  }
}
export function mapPointer(x:number,y:number,rect:{left:number;top:number;width:number;height:number},frame:{width:number;height:number}):Input {
  dimensions(frame.width,frame.height);
  if(![x,y,rect.left,rect.top,rect.width,rect.height].every(Number.isFinite)||rect.width<=0||rect.height<=0)throw new Error('invalid geometry');
  return {type:'pointer',x:Math.max(0,Math.min(frame.width-1,Math.floor((x-rect.left)/rect.width*frame.width))),y:Math.max(0,Math.min(frame.height-1,Math.floor((y-rect.top)/rect.height*frame.height))),buttons:0};
}
