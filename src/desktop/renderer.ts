import {mapPointer,type Frame,type Input,type State} from '../protocols/rdp/wire.js';import {keyInput} from '../protocols/rdp/view.js';
declare global {interface Window {rdp:{info():Promise<{fixture:boolean;platform:string;arch:string}>;open(target:unknown):Promise<string>;input(id:string,input:Input):Promise<void>;close(id:string):Promise<void>;onFrame(fn:(frame:Frame&{id:string})=>void):()=>void;onState(fn:(value:{id:string;state:State;reason?:string})=>void):()=>void}}}
const el=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const tabs=new Map<string,{canvas:HTMLCanvasElement;button:HTMLButtonElement;state:State;reason?:string;width:number;height:number;pressed:Set<string>}>();
let active='';
const labels:Record<State,string>={connecting:'Menghubungkan…',connected:'Terhubung',closed:'Sesi ditutup',failed:'Koneksi gagal'};
const reasons:Record<string,string>={certificate:'Sertifikat tidak dipercaya atau pin tidak sesuai.',authentication:'Autentikasi ditolak.',connection:'Host tidak dapat dihubungi atau sesi terputus.','helper-start':'Bridge native belum tersedia. Jalankan build native.','helper-exit':'Proses koneksi berhenti.','connection-timeout':'Koneksi melewati batas waktu.','resize-reconnect':'Ukuran desktop baru memerlukan koneksi ulang.','frame-protocol':'Data layar remote tidak valid.','helper-failure':'Proses koneksi melaporkan kesalahan.','control-protocol':'Kontrol koneksi tidak valid.'};
function tab(id:string){
  if(tabs.has(id))return tabs.get(id)!;
  const canvas=document.createElement('canvas'),button=document.createElement('button');canvas.tabIndex=0;canvas.setAttribute('aria-label','Layar desktop remote');canvas.hidden=true;button.textContent='Sesi RDP';button.onclick=()=>select(id);
  el('screen').append(canvas);el('tabs').append(button);const t={canvas,button,state:'connecting' as State,width:0,height:0,pressed:new Set<string>(),reason:undefined as string|undefined};tabs.set(id,t);
  function send(input:Input){if(active===id&&t.state==='connected')void window.rdp.input(id,input).catch(()=>{el('error').textContent='Input tidak dapat dikirim.';});}
  function pointer(e:PointerEvent){if(!t.width)return;const r=canvas.getBoundingClientRect();if(!canvas.hasPointerCapture(e.pointerId)&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom))return;const input=mapPointer(e.clientX,e.clientY,r,t);if(input.type==='pointer')input.buttons=e.buttons&7;send(input);}
  canvas.addEventListener('pointerdown',e=>{e.preventDefault();canvas.focus();canvas.setPointerCapture(e.pointerId);pointer(e);});canvas.addEventListener('pointermove',pointer);canvas.addEventListener('pointerup',e=>{pointer(e);if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);});canvas.addEventListener('contextmenu',e=>e.preventDefault());
  canvas.addEventListener('keydown',e=>{const input=keyInput(e.code,true);if(input){e.preventDefault();if(!e.repeat){t.pressed.add(e.code);send(input);}}});
  canvas.addEventListener('keyup',e=>{const input=keyInput(e.code,false);if(input){e.preventDefault();t.pressed.delete(e.code);send(input);}});
  canvas.addEventListener('blur',()=>{for(const code of t.pressed){const input=keyInput(code,false);if(input)send(input);}t.pressed.clear();});
  return t;
}
function select(id:string){active=id;for(const [key,t]of tabs){t.canvas.hidden=key!==id;t.button.classList.toggle('active',key===id);}el('empty').hidden=!!id;refresh();}
function refresh(){const t=tabs.get(active);el('status').textContent=t?labels[t.state]+(t.reason?' — '+(reasons[t.reason]||'Coba hubungkan kembali.'):''):'Belum ada sesi';el<HTMLButtonElement>('disconnect').disabled=!t||t.state==='closed'||t.state==='failed';el('dimensions').textContent=t?.width?`${t.width} × ${t.height}`:'Tidak ada layar remote';}
window.rdp.onFrame(f=>{const t=tab(f.id);t.width=f.width;t.height=f.height;t.canvas.width=f.width;t.canvas.height=f.height;t.canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(f.rgba),f.width,f.height),0,0);if(!active)select(f.id);refresh();});
window.rdp.onState(v=>{const t=tab(v.id);t.state=v.state;t.reason=v.reason;if(!active)select(v.id);refresh();});
el<HTMLFormElement>('connect').addEventListener('submit',async event=>{
  event.preventDefault();const button=el<HTMLButtonElement>('connect-button');button.disabled=true;el('error').textContent='';
  try{const host=el<HTMLInputElement>('host').value.trim(),id=await window.rdp.open({host,port:Number(el<HTMLInputElement>('port').value),username:el<HTMLInputElement>('username').value,certificateSha256:el<HTMLInputElement>('fingerprint').value.trim()});tab(id).button.textContent=host;select(id);}catch{el('error').textContent='Koneksi dibatalkan atau parameter tidak valid.';}finally{button.disabled=false;}
});
el('disconnect').onclick=async()=>{if(active)await window.rdp.close(active);};
void window.rdp.info().then(info=>{el('platform').textContent=`${info.platform} / ${info.arch}`;if(info.fixture){el('mode').textContent='Fixture lokal — bukan koneksi RDP';el<HTMLInputElement>('host').value='fixture.invalid';el<HTMLInputElement>('username').value='fixture';}});
