import {MAX_FRAME_AREA,WHEEL_LIMIT} from './wire.js';
import type {Input,State} from './wire.js';
const scans:Record<string,number>={Escape:1,Digit1:2,Digit2:3,Digit3:4,Digit4:5,Digit5:6,Digit6:7,Digit7:8,Digit8:9,Digit9:10,Digit0:11,Minus:12,Equal:13,Backspace:14,Tab:15,
  KeyQ:16,KeyW:17,KeyE:18,KeyR:19,KeyT:20,KeyY:21,KeyU:22,KeyI:23,KeyO:24,KeyP:25,BracketLeft:26,BracketRight:27,Enter:28,ControlLeft:29,
  KeyA:30,KeyS:31,KeyD:32,KeyF:33,KeyG:34,KeyH:35,KeyJ:36,KeyK:37,KeyL:38,Semicolon:39,Quote:40,Backquote:41,ShiftLeft:42,Backslash:43,
  KeyZ:44,KeyX:45,KeyC:46,KeyV:47,KeyB:48,KeyN:49,KeyM:50,Comma:51,Period:52,Slash:53,ShiftRight:54,AltLeft:56,Space:57,
  ControlRight:285,AltRight:312,ArrowUp:328,ArrowLeft:331,ArrowRight:333,ArrowDown:336,Home:327,End:335,PageUp:329,PageDown:337,Insert:338,Delete:339,MetaLeft:347,MetaRight:348,
  F1:59,F2:60,F3:61,F4:62,F5:63,F6:64,F7:65,F8:66,F9:67,F10:68,F11:87,F12:88,CapsLock:58,NumLock:69,
  Numpad7:71,Numpad8:72,Numpad9:73,Numpad4:75,Numpad5:76,Numpad6:77,Numpad1:79,Numpad2:80,Numpad3:81,Numpad0:82,NumpadDecimal:83,
  NumpadMultiply:55,NumpadSubtract:74,NumpadAdd:78,NumpadEnter:284,NumpadDivide:309};   // 284 and 309 carry the extended flag (0x100)
export const keyCodes:readonly string[]=Object.keys(scans);   // every physical key this client forwards
// shortcut: physical US layout for the probe; add layout/IME negotiation before P06 passes.
export function keyInput(code:string,down:boolean):Input|undefined{
  return scans[code]?{type:'key',scanCode:scans[code],down}:undefined;
}
// The Command key is the remote Windows key. It is held back until it is clear what it is for: with another key it is a chord, on its
// own and released inside the app it is a deliberate tap. Held while the window loses focus (Cmd+Tab) it is dropped, because a Win key
// tap opens the remote Start menu and the user only meant to leave the app.
const commandKeys=new Set(['MetaLeft','MetaRight']);
// The remote counts wheel movement in 1/120 notches. The browser reports pixels (Chromium counts 100 per notch of a mouse wheel), lines (Windows
// scrolls 3 per notch) or pages (taken as three notches); scrolling down is positive in the browser and negative on the wire, while sideways both
// sides count right as positive.
const wheelScale=(delta:number,mode:number)=>mode===1?delta*40:mode===2?delta*360:delta*6/5;
const wheelClamp=(units:number)=>Number.isFinite(units)?Math.max(-WHEEL_LIMIT,Math.min(WHEEL_LIMIT,units))+0:0;   // +0: never -0
export function wheelUnits(delta:number,mode:number):number{return wheelClamp(-wheelScale(delta,mode));}
export function hwheelUnits(delta:number,mode:number):number{return wheelClamp(wheelScale(delta,mode));}
export function makeInputState(send:(input:Input)=>void){
  const keys=new Set<string>(),waiting=new Set<string>();let last:Extract<Input,{type:'pointer'}>|undefined;const rest={wheel:0,hwheel:0};
  const turn=(type:'wheel'|'hwheel',x:number,y:number,units:number,ctrl:boolean)=>{
    const total=rest[type]+units,whole=Math.trunc(total);rest[type]=total-whole;
    if(!whole)return;
    const press=ctrl&&!keys.has('ControlLeft')&&!keys.has('ControlRight');
    if(press)send(keyInput('ControlLeft',true)!);
    send({type,x,y,delta:whole});
    if(press)send(keyInput('ControlLeft',false)!);
  };
  return {
    key(code:string,down:boolean){
      const input=keyInput(code,down);if(!input)return;
      if(down){
        if(keys.has(code)||waiting.has(code))return;
        if(commandKeys.has(code)){waiting.add(code);return;}
        for(const held of waiting){keys.add(held);send(keyInput(held,true)!);}
        waiting.clear();keys.add(code);send(input);return;
      }
      if(waiting.delete(code)){send(keyInput(code,true)!);send(input);return;}   // a tap
      if(commandKeys.has(code)&&!keys.has(code))return;                          // its press was dropped on blur: nothing to release
      keys.delete(code);send(input);
    },
    pointer(input:Extract<Input,{type:'pointer'}>){last=input;send(input);},
    // Trackpads report many tiny deltas: the part of a turn below one unit is carried to the next event (per axis), so nothing is lost and nothing is sent twice.
    // A pinch reaches the page as a wheel turn with Ctrl and no Ctrl key press, and the remote zooms only if it sees Ctrl held: so Ctrl is pressed around
    // the turn, unless the user already holds it (that press was sent when it happened).
    // ponytail: one press and release per turn; a hold with an idle timer if a Ctrl tap on the remote ever matters.
    wheel(x:number,y:number,delta:number,mode:number,ctrl=false){turn('wheel',x,y,wheelUnits(delta,mode),ctrl);},
    hwheel(x:number,y:number,delta:number,mode:number,ctrl=false){turn('hwheel',x,y,hwheelUnits(delta,mode),ctrl);},
    release(){if(last?.buttons){last={...last,buttons:0};send(last);}waiting.clear();for(const code of keys)send(keyInput(code,false)!);keys.clear();}
  };
}
export type Size={width:number;height:number};
// Viewport in CSS pixels -> the desktop size display control accepts: even width, 200..8192, and no larger than one frame.
export function desktopSize(width:number,height:number):Size|undefined{
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)return undefined;
  let w=Math.min(8192,Math.max(200,Math.floor(width))),h=Math.min(8192,Math.max(200,Math.floor(height)));
  if(w*h>MAX_FRAME_AREA){const k=Math.sqrt(MAX_FRAME_AREA/(w*h));w=Math.floor(w*k);h=Math.floor(h*k);}
  return {width:w-w%2,height:h};
}
// First connect negotiates at most 4096x2048; display control grows the desktop afterwards.
export function initialDesktop(viewport:Size):Partial<Size>{
  const size=desktopSize(viewport.width,viewport.height);
  return size?{width:Math.min(size.width,4096),height:Math.min(size.height,2048)}:{};
}
type Timers={set(fn:()=>void,ms:number):unknown;clear(handle:unknown):void};
const realTimers:Timers={set:(fn,ms)=>setTimeout(fn,ms),clear:handle=>clearTimeout(handle as ReturnType<typeof setTimeout>)};
// Debounces viewport changes into one resize request. baseline() reports the size of the frames the remote is sending;
// the last size asked for stays "in effect" until a frame of that size arrives, so a correction is never skipped
// while the server is still applying an earlier request.
export function makeResizeScheduler(send:(size:Size)=>void,timers:Timers=realTimers,delay=500){
  let current:Size|undefined,requested:Size|undefined,pending:Size|undefined,handle:unknown;
  const same=(a:Size|undefined,b:Size)=>!!a&&a.width===b.width&&a.height===b.height;
  const drop=()=>{if(handle!==undefined)timers.clear(handle);handle=undefined;pending=undefined;};
  return {
    baseline(size:Size){current=size;if(same(requested,size))requested=undefined;if(same(pending,size))drop();},
    observe(raw:Size){
      const next=desktopSize(raw.width,raw.height);if(!next)return;
      if(same(requested??current,next)){drop();return;}
      if(same(pending,next))return;
      drop();pending=next;handle=timers.set(()=>{handle=undefined;requested=pending;pending=undefined;if(requested)send(requested);},delay);
    },
    cancel:drop
  };
}
// Tabs are named after their host; a second tab to the same host is told apart by a number ("host (2)"), and a number that was freed is reused.
export function tabLabel(host:string,taken:readonly string[]):string{
  for(let n=1;;n++){const label=n===1?host:`${host} (${n})`;if(!taken.includes(label))return label;}
}
// A finished tab (closed or failed) can be closed. The tab shown afterwards is its right neighbour, else its left neighbour, else none ('');
// `ids` are in strip order, and an id that is not in the strip leaves nothing to choose.
export function tabAfterClose(ids:readonly string[],id:string):string{
  const i=ids.indexOf(id);
  return i<0?'':ids[i+1]??ids[i-1]??'';
}
// Servers give an account one session and attach a newer connection to it, ending the older one; the lab's Windows Server 2019 says only
// "disconnected" (error info 1) when it does. So a tab the server ended names the newest tab of this window that opened after it, to the same
// host, port and user, and is still alive. It is a hint, never a fact: reasons that are not takeovers (logoff, timeouts, denial) get none.
export type TabInfo={label:string;host:string;port:number;username:string;state:State;started:number};
export const takeoverWindowMs=5*60_000;   // ponytail: "just now" is five minutes, since the target's logon notice can wait for an OK; a longer wait loses the hint
const takeoverReasons=['other-connection','admin-disconnect','server-closed'];
export function takeoverHint(ended:TabInfo,reason:string,now:number,tabs:readonly TabInfo[]):string|undefined{   // tabs: every tab of the window, the ended one included
  if(!takeoverReasons.includes(reason))return undefined;
  const same=(a:TabInfo)=>a.host.toLowerCase()===ended.host.toLowerCase()&&a.port===ended.port&&a.username.toLowerCase()===ended.username.toLowerCase();
  const newest=tabs.filter(o=>same(o)&&(o.state==='connecting'||o.state==='connected')&&o.started>ended.started&&o.started<=now&&now-o.started<=takeoverWindowMs).sort((a,b)=>b.started-a.started)[0];
  return newest&&`Kemungkinan tab “${newest.label}”, yang baru menyambung ke host dan akun yang sama, mengambil alih sesi ini.`;
}
// Credentials are never kept, so only a finished session can be reopened (with a fresh password prompt).
export function reconnectable(state:State):boolean{return state==='closed'||state==='failed';}
// What the status line says after "<state> — ". FreeRDP gives everything after the security layer a fixed wait (FreeRDP_TcpAckTimeout, 9 s)
// and then fails with ERRCONNECT_ACTIVATION_TIMEOUT, which the helper reports as a plain connection failure; on a slow path that is the whole
// story, so it is told apart by its code. The wait itself is not changed here.
export const activationTimeout=0x0002001c;
const slowText='Jaringan atau server terlalu lambat: sesi tidak selesai dibentuk dalam batas waktu. Coba lagi saat jaringan lebih cepat.';
const reasons:Record<string,string>={certificate:'Sertifikat tidak dipercaya atau pin tidak sesuai.',authentication:'Autentikasi ditolak.',connection:'Sesi gagal dibentuk atau terputus.','helper-start':'Bridge native belum tersedia. Jalankan build native.','helper-exit':'Proses koneksi berhenti.','connection-timeout':'Koneksi melewati batas waktu.','resize-reconnect':'Ukuran desktop baru memerlukan koneksi ulang.','frame-protocol':'Data layar remote tidak valid.','helper-failure':'Proses koneksi melaporkan kesalahan.','control-protocol':'Kontrol koneksi tidak valid.',
  // Why the server ended a session (it says so itself, so these follow "Sesi ditutup" rather than "Koneksi gagal").
  'other-connection':'Koneksi lain dengan akun yang sama mengambil alih sesi ini.',logoff:'Server meng-logoff sesi ini.','admin-disconnect':'Sesi diputus dari sisi server (oleh administrator atau pengguna).',timeout:'Batas waktu server tercapai (idle atau logon).','server-denied':'Server menolak sesi ini (hak akses atau kredensial).','server-closed':'Server menutup sesi ini.'};
export function reasonText(reason:string,lastError?:number):string{
  if(reason==='connection'&&lastError===activationTimeout)return slowText;
  return reasons[reason]||'Coba hubungkan kembali.';
}
