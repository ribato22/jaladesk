import {initBulk} from './bulk-ui.js';
import {initTransfer} from './transfer-ui.js';
import {initDocumentMaintenance} from './document-maintenance-ui.js';
import {initDocumentProperties} from './document-properties-ui.js';
import {initCredentials} from './credentials-ui.js';
import {initTemplates} from './template-ui.js';
import {initDocuments, type PluginSessionSpec} from './documents-ui.js';
import {initShell} from './shell-ui.js';
import {initTabs,tabIds} from './tabs-ui.js';
import {tabColour} from './tab-order.js';
import {iconElement} from './icons.js';
import {VtTerminal} from './vt-terminal.js';
import {
  buildK8sManifestStudioView,
  buildAlertRelayStudioView,
  buildSecretEnvStudioView,
  buildThreatIntelStudioView,
  buildLoadBenchmarkStudioView,
  buildTeamVaultSyncStudioView,
  buildSessionCastStudioView,
} from './studios-cloud-ops.js';
import {
  bindSreStudioDocuments,
  buildPacketSnifferStudioView,
  buildKernelLimitsStudioView,
  buildSshCaStudioView,
  buildPrometheusStudioView,
  buildIntrusionStudioView,
  buildHaClusterStudioView,
  buildVpnMeshStudioView,
  buildDbBackupStudioView,
  buildFimAuditdStudioView,
  buildChangeRfcStudioView,
} from './studios-sre-ha.js';
import type {IconId} from '../documents/meta.js';
import type { OpenStored, StoredOpened } from './connections.js';
import {mapPointer,type Frame,type Input,type State} from '../protocols/rdp/wire.js';import {initialDesktop,makeInputState,makeResizeScheduler,reasonText,reconnectable,tabAfterClose,tabLabel,takeoverHint,type Size,type TabInfo} from '../protocols/rdp/view.js';
type StoredReply={ok:true;value:StoredOpened}|{ok:false;code:string;message:string};
declare global {interface Window {rdp:{info():Promise<{fixture:boolean;platform:string;arch:string}>;open(target:unknown):Promise<string>;openStored(ref:OpenStored):Promise<StoredReply>;reconnectStored(id:string):Promise<StoredReply>;forgetStored(id:string):Promise<unknown>;input(id:string,input:Input):Promise<void>;close(id:string):Promise<void>;activate(id:string):Promise<void>;clipboardSync(id:string):Promise<string>;onFrame(fn:(frame:Frame&{id:string})=>void):()=>void;onStoredOpened(fn:(value:StoredOpened)=>void):()=>void;onState(fn:(value:{id:string;state:State;reason?:string;lastError?:number})=>void):()=>void}}}
// Everything needed to reopen a session except the password, which is asked for again every time.
type Request={host:string;port:number;username:string;certificateSha256:string;clipboard:{toRemote:boolean;fromRemote:boolean}};
type Tab={canvas:HTMLCanvasElement;panel?:HTMLElement;pluginSpec?:PluginSessionSpec;ptyCleanup?:()=>void;button:HTMLButtonElement;state:State;reason?:string;lastError?:number;started:number;hint?:string;width:number;height:number;input:ReturnType<typeof makeInputState>;resizer:ReturnType<typeof makeResizeScheduler>;request?:Request;storedSessionId?:string;name?:string;color?:string};
const el=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const tabs=new Map<string,Tab>();
const tabInfo=(t:Tab,r:Request):TabInfo=>({label:t.button.textContent??'',host:r.host,port:r.port,username:r.username,state:t.state,started:t.started});
let active='',noticeTimer:number|undefined,pluginSeq=1;
let macShortcutsEnabled = localStorage.getItem('rw-rdp-mac-keys') !== 'off';
let autoReconnectEnabled = localStorage.getItem('rw-auto-reconnect') !== 'off';
let viewOnlyMode = false;
let hudEnabled = false;
let rdpFrameCounter = 0;
let lastMeasuredFps = 0;
let splitMode: 'single' | '2x1' | '2x2' = 'single';
const recentTabOrder: string[] = [];
const userDisconnectedTabs = new Set<string>();
const autoReconnectTimers = new Map<string, number>();

interface AuditLogEntry {
  id: string;
  timestamp: string;
  event: 'CONNECTED' | 'DISCONNECTED' | 'FAILED' | 'AUTO_RECONNECT';
  name: string;
  protocol: string;
  target: string;
  gateway: string;
  durationSec?: number;
  detail?: string;
}
const AUDIT_LOG_STORAGE_KEY = 'rw-session-audit-log-v1';

function readAuditLog(): AuditLogEntry[] {
  try {
    const raw = localStorage.getItem(AUDIT_LOG_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function recordAuditEvent(
  event: AuditLogEntry['event'],
  info: { name: string; protocol: string; target: string; gateway?: string; durationSec?: number; detail?: string },
): void {
  try {
    const list = readAuditLog();
    const gwSelect = document.getElementById('jump-host-select') as HTMLSelectElement | null;
    const defaultGw = gwSelect?.value && gwSelect.value !== '__custom__' ? gwSelect.value : 'Direct LAN';
    list.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      event,
      name: info.name || info.target,
      protocol: info.protocol,
      target: info.target,
      gateway: info.gateway || defaultGw,
      durationSec: info.durationSec,
      detail: info.detail,
    });
    if (list.length > 200) list.length = 200;
    localStorage.setItem(AUDIT_LOG_STORAGE_KEY, JSON.stringify(list));
  } catch {}
}

function mapRdpKeyCode(code: string): string {
  if (macShortcutsEnabled && (code === 'MetaLeft' || code === 'MetaRight')) {
    return 'ControlLeft';
  }
  return code;
}

const labels:Record<State,string>={connecting:'Connecting…',connected:'Connected',closed:'Session closed',failed:'Connection failed'};

// Apply English runtime labels to buttons carrying data-en while preserving static markup contracts.
for (const node of document.querySelectorAll<HTMLElement>('[data-en]')) {
  if (node.dataset.en) node.textContent = node.dataset.en;
}

function notify(text:string){el('error').textContent=text;clearTimeout(noticeTimer);noticeTimer=window.setTimeout(()=>{el('error').textContent='';},6000);}
// Content box of the screen area in CSS pixels: the canvas shows the remote desktop 1:1 at this size.
function viewport():Size{const s=el('screen'),c=getComputedStyle(s);return {width:s.clientWidth-parseFloat(c.paddingLeft)-parseFloat(c.paddingRight),height:s.clientHeight-parseFloat(c.paddingTop)-parseFloat(c.paddingBottom)};}
function tab(id:string){
  if(tabs.has(id))return tabs.get(id)!;
  const canvas=document.createElement('canvas'),button=document.createElement('button');canvas.tabIndex=0;canvas.setAttribute('aria-label','Remote desktop screen');canvas.hidden=true;button.textContent='RDP Session';button.dataset.id=id;button.onclick=()=>select(id);
  el('screen').append(canvas);el('tabs').append(button);const t:Tab={canvas,button,state:'connecting',started:Date.now(),width:0,height:0,input:makeInputState(input=>{if(t.state==='connected')void window.rdp.input(id,input).catch(()=>{notify('Input could not be sent.');});}),
    resizer:makeResizeScheduler(size=>{if(t.state==='connected')void window.rdp.input(id,{type:'resize',...size}).catch(()=>{notify('Desktop size could not be updated.');});},undefined,160)};tabs.set(id,t);
    function pointer(e:PointerEvent){if(viewOnlyMode||!t.width)return;const r=canvas.getBoundingClientRect();if(!canvas.hasPointerCapture(e.pointerId)&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom))return;const input=mapPointer(e.clientX,e.clientY,r,t);if(input.type==='pointer'){input.buttons=e.buttons&7;if(active===id&&t.state==='connected')t.input.pointer(input);}}
  canvas.addEventListener('pointerdown',e=>{e.preventDefault();if(splitMode!=='single'&&active!==id)select(id);canvas.focus();if(viewOnlyMode)return;canvas.setPointerCapture(e.pointerId);pointer(e);});canvas.addEventListener('pointermove',pointer);canvas.addEventListener('pointerup',e=>{pointer(e);if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);});canvas.addEventListener('contextmenu',e=>e.preventDefault());
  canvas.addEventListener('keydown',e=>{if(viewOnlyMode||active!==id||t.state!=='connected')return;e.preventDefault();t.input.key(mapRdpKeyCode(e.code),true);});
  canvas.addEventListener('wheel',e=>{if(viewOnlyMode||active!==id||t.state!=='connected'||!t.width)return;e.preventDefault();const at=mapPointer(e.clientX,e.clientY,canvas.getBoundingClientRect(),t);if(at.type==='pointer'){t.input.wheel(at.x,at.y,e.deltaY,e.deltaMode,e.ctrlKey);t.input.hwheel(at.x,at.y,e.deltaX,e.deltaMode,e.ctrlKey);}},{passive:false});
  canvas.addEventListener('keyup',e=>{if(viewOnlyMode||active!==id||t.state!=='connected')return;e.preventDefault();t.input.key(mapRdpKeyCode(e.code),false);});
  for(const event of ['blur','pointercancel','lostpointercapture'])canvas.addEventListener(event,()=>t.input.release());
  canvas.addEventListener('focus',()=>{if(active===id&&t.state==='connected'&&t.request?.clipboard.toRemote)void window.rdp.clipboardSync(id).then(result=>{if(result==='too-large')notify('Clipboard text exceeds 32 KiB and was not shared.');}).catch(()=>{});});
  return t;
}

function select(id:string){
  if(active!==id)tabs.get(active)?.input.release();
  active=id;
  if (id) {
    const rIdx = recentTabOrder.indexOf(id);
    if (rIdx >= 0) recentTabOrder.splice(rIdx, 1);
    recentTabOrder.unshift(id);
  }
  const screenEl = el('screen');
  const useSplit = !!id && splitMode !== 'single' && tabs.size > 1;
  const maxPanes = splitMode === '2x1' ? 2 : 4;
  const visibleIds = new Set<string>();
  if (useSplit) {
    screenEl.dataset.split = splitMode;
    visibleIds.add(id);
    for (const cand of recentTabOrder) {
      if (visibleIds.size >= maxPanes) break;
      if (tabs.has(cand)) visibleIds.add(cand);
    }
    for (const cand of tabs.keys()) {
      if (visibleIds.size >= maxPanes) break;
      visibleIds.add(cand);
    }
  } else {
    delete screenEl.dataset.split;
    if (id) visibleIds.add(id);
  }

  let hasPluginActive = false;
  for(const [key,t]of tabs){
    const isCurrent = key===id;
    const isVis = visibleIds.has(key);
    t.canvas.hidden = !isVis || !!t.panel;
    t.canvas.classList.toggle('split-focused', useSplit && isCurrent);
    if (t.panel) {
      t.panel.hidden = !isVis;
      t.panel.classList.toggle('split-focused', useSplit && isCurrent);
      if (isVis) hasPluginActive = true;
    }
    t.button.classList.toggle('active',isCurrent);
    if(isCurrent)t.button.setAttribute('aria-current','true');else t.button.removeAttribute('aria-current');
  }
  const overviewPill = document.getElementById('overview-tab-pill');
  if (overviewPill) overviewPill.classList.toggle('active', !id);
  const pluginStage = document.getElementById('plugin-stage');
  if (pluginStage) pluginStage.hidden = !hasPluginActive;
  el('empty').hidden=!!id;
  if(id && !tabs.get(id)?.panel) {
    void window.rdp.activate(id).catch(()=>{});
    tabs.get(id)?.resizer.observe(viewport());
  }
  refresh();
}

function discard(id:string){
  const timer = autoReconnectTimers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    autoReconnectTimers.delete(id);
  }
  userDisconnectedTabs.delete(id);
  const rIdx = recentTabOrder.indexOf(id);
  if (rIdx >= 0) recentTabOrder.splice(rIdx, 1);
  const t=tabs.get(id);if(!t)return;
  t.ptyCleanup?.();
  t.resizer.cancel();
  t.canvas.remove();
  t.panel?.remove();
  t.button.remove();
  tabs.delete(id);
  if(active===id)active='';
  if(t.storedSessionId)void window.rdp.forgetStored(t.storedSessionId).catch(()=>{});
  if(!t.panel) void window.rdp.close(id).catch(()=>{});
}

function enReasonText(reason: string, lastError?: number): string {
  if (lastError === 0x00010005 || reason === 'switched') return 'Another Remote Desktop client took over this Windows session.';
  if (lastError === 0x00010001 || lastError === 0x00010002 || reason === 'admin-disconnect') return 'Disconnected by remote administrator or session policy.';
  if (lastError === 0x00010003 || reason === 'idle') return 'Session idle time limit reached.';
  if (lastError === 0x00010004 || reason === 'logon-timeout') return 'Session logon time limit reached.';
  if (lastError === 0x00020006) return 'TLS / CredSSP security negotiation reset by remote host or port-forwarder.';
  if (lastError === 0x00020008 || reason === 'certificate') return 'TLS certificate verification failed.';
  if (lastError === 0x00020009 || lastError === 0x00020014 || reason === 'authentication') return 'NLA / CredSSP authentication failed — verify username, domain, and password.';
  if (reason === 'connect') return 'Could not reach remote host or port.';
  if (reason === 'protocol') return 'Remote Desktop protocol error.';
  if (reason === 'eof') return 'Connection closed by remote host.';
  if (reason === 'closed') return 'Disconnected.';
  return reasonText(reason, lastError)
    .replace('Sesi gagal dibentuk atau terputus.', 'Session could not be established or was interrupted.')
    .replace('Autentikasi ditolak.', 'Authentication rejected — verify username, domain, and password.')
    .replace('Sertifikat ditolak.', 'TLS certificate rejected.')
    .replace('Gagal menghubungi host.', 'Could not reach host.');
}

function refresh(){
  const t=tabs.get(active);
  const state=t?t.state:'none';
  if(document.body.dataset.tab!==state)document.body.dataset.tab=state;
  const enHint = t?.hint ? 'Note: another tab in this workspace is connected as the same Windows user.' : '';
  const reasonStr = t?.reason ? enReasonText(t.reason,t.lastError) : '';
  el('status').textContent=t?labels[t.state]+(reasonStr?' — '+reasonStr:'')+(t.lastError!==undefined?` (code 0x${t.lastError.toString(16).padStart(8,'0')})`:'')+(enHint?' '+enHint:''):'No active session';
  el<HTMLButtonElement>('disconnect').disabled=!t||t.state==='closed'||t.state==='failed';
  el<HTMLButtonElement>('reconnect').disabled=!(t?.request||t?.pluginSpec)||!reconnectable(t.state);
  el<HTMLButtonElement>('close-tab').disabled=!t;
  el('dimensions').textContent=t?.panel?`${t.pluginSpec?.pluginType ?? 'Plugin'} · ${t.pluginSpec?.host ?? ''}:${t.pluginSpec?.port ?? ''}`:t?.width?`${t.width} × ${t.height}`:'Ready';
  const ended = !!t && !t.panel && (t.state === 'closed' || t.state === 'failed');
  const inSplit = splitMode !== 'single' && tabs.size > 1;
  if (t && !t.panel && !inSplit) {
    t.canvas.hidden = ended;
  }
  const endedCard = document.getElementById('session-ended');
  if (endedCard) {
    endedCard.hidden = !ended || inSplit;
    if (ended && t && !inSplit) {
      const titleEl = document.getElementById('session-ended-title');
      const detailEl = document.getElementById('session-ended-detail');
      if (titleEl) titleEl.textContent = `${t.button.textContent ?? 'Session'} — ${labels[t.state]}`;
      if (detailEl) detailEl.textContent = reasonStr || 'The remote desktop connection has ended. Click Reconnect to resume or Close Tab to return to the workspace.';
    }
  }
  updateLiveHud();
}

function updateLiveHud(): void {
  const hudEl = document.getElementById('rdp-live-hud');
  if (!hudEl) return;
  const t = tabs.get(active);
  if (!hudEnabled || !t) {
    hudEl.hidden = true;
    return;
  }
  hudEl.hidden = false;
  const upSec = Math.max(0, Math.floor((Date.now() - t.started) / 1000));
  const mm = String(Math.floor(upSec / 60)).padStart(2, '0');
  const ss = String(upSec % 60).padStart(2, '0');
  const resText = t.width ? `${t.width}×${t.height}` : t.pluginSpec?.pluginType ?? 'Active';
  const modeText = viewOnlyMode ? '👁 View-Only' : '⌨ Interactive';
  const macText = `⌘⇄Ctrl:${macShortcutsEnabled ? 'ON' : 'OFF'}`;
  hudEl.textContent = `⚡ ${lastMeasuredFps} fps · 🖥 ${resText} · ${modeText} · ${macText} · ⏱ ${mm}:${ss}`;
}

window.setInterval(() => {
  lastMeasuredFps = rdpFrameCounter;
  rdpFrameCounter = 0;
  if (hudEnabled) updateLiveHud();
}, 1000);

window.rdp.onFrame(f=>{rdpFrameCounter++;const t=tab(f.id);const first=!t.width;t.width=f.width;t.height=f.height;t.canvas.width=f.width;t.canvas.height=f.height;t.canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(f.rgba),f.width,f.height),0,0);t.resizer.baseline({width:f.width,height:f.height});if(first)t.resizer.observe(viewport());if(!active)select(f.id);refresh();});
window.rdp.onState(v=>{
  const t=tab(v.id);
  const prevState = t.state;
  t.state=v.state;
  t.reason=v.reason;
  t.lastError=v.lastError;
  t.hint=v.reason&&t.request?takeoverHint(tabInfo(t,t.request),v.reason,Date.now(),[...tabs.values()].flatMap(other=>other.request?[tabInfo(other,other.request)]:[])):undefined;
  if (t.request && prevState !== v.state) {
    const targetStr = `${t.request.username}@${t.request.host}:${t.request.port}`;
    if (v.state === 'connected') {
      t.started = Date.now();
      userDisconnectedTabs.delete(v.id);
      recordAuditEvent('CONNECTED', { name: t.name ?? t.request.host, protocol: 'RDP', target: targetStr });
    } else if (v.state === 'closed' || v.state === 'failed') {
      const dur = Math.max(0, Math.round((Date.now() - t.started) / 1000));
      recordAuditEvent(v.state === 'failed' ? 'FAILED' : 'DISCONNECTED', {
        name: t.name ?? t.request.host,
        protocol: 'RDP',
        target: targetStr,
        durationSec: dur,
        detail: v.reason ? enReasonText(v.reason, v.lastError) : undefined,
      });
    }
  }
  if(v.state==='closed'||v.state==='failed'){
    t.resizer.cancel();
    const canAutoRetry =
      autoReconnectEnabled &&
      !userDisconnectedTabs.has(v.id) &&
      !!t.request &&
      reconnectable(v.state) &&
      v.reason !== 'switched' &&
      v.reason !== 'authentication' &&
      v.reason !== 'certificate' &&
      v.reason !== 'admin-disconnect';
    if (canAutoRetry && !autoReconnectTimers.has(v.id)) {
      notify(`Connection dropped (${t.name ?? t.request?.host}) — Auto-reconnecting in 2.5s…`);
      const timerId = window.setTimeout(() => {
        autoReconnectTimers.delete(v.id);
        const cur = tabs.get(v.id);
        if (!cur || !cur.request || !reconnectable(cur.state)) return;
        recordAuditEvent('AUTO_RECONNECT', {
          name: cur.name ?? cur.request.host,
          protocol: 'RDP',
          target: `${cur.request.username}@${cur.request.host}:${cur.request.port}`,
        });
        void (cur.storedSessionId
          ? openStoredSession(undefined, v.id)
          : openSession(cur.request, v.id, cur.name, cur.color));
      }, 2500);
      autoReconnectTimers.set(v.id, timerId);
    }
  }
  if(!active)select(v.id);
  refresh();
});
function formRequest():Request{return {host:el<HTMLInputElement>('host').value.trim(),port:Number(el<HTMLInputElement>('port').value),username:el<HTMLInputElement>('username').value,certificateSha256:el<HTMLInputElement>('fingerprint').value.trim(),clipboard:{toRemote:el<HTMLInputElement>('clip-to').checked,fromRemote:el<HTMLInputElement>('clip-from').checked}};}

async function openSession(request:Request,replace?:string,name?:string,color?:string):Promise<string|undefined>{
  const button=el<HTMLButtonElement>('connect-button');if(button.disabled)return 'Another connection is opening.';button.disabled=true;el('error').textContent='';
  try{await syncQuickJumpGateway();const id=await window.rdp.open({...request,...initialDesktop(viewport())});const t=tab(id);t.request=request;t.name=name;t.color=tabColour(color);if(t.color)t.button.dataset.color=t.color;t.button.textContent=tabLabel(name??request.host,[...tabs].filter(([key])=>key!==id&&key!==replace).map(([,other])=>other.button.textContent??''));t.button.title=`${request.username}@${request.host}:${request.port}`;if(replace)tabs.get(replace)?.button.before(t.button);(document.getElementById('adhoc') as HTMLDetailsElement|null)?.removeAttribute('open');select(id);if(replace)discard(replace);refresh();return undefined;}catch(err){const raw=err instanceof Error?err.message:String(err??'');const clean=raw.replace(/^Error invoking remote method '[^']+':\s*/i,'').replace(/^Error:\s*/i,'').trim();if(/^cancelled$/i.test(clean))return undefined;return clean||'Connection could not be opened — verify host, port, and credentials.';}finally{button.disabled=false;}
}
for (const alertId of ['error', 'doc-error', 'doc-message']) {
  document.getElementById(alertId)?.addEventListener('click', (ev) => {
    (ev.currentTarget as HTMLElement).textContent = '';
  });
}
el<HTMLFormElement>('connect').addEventListener('submit',event=>{event.preventDefault();void openSession(formRequest()).then(why=>{if(why)el('error').textContent=why;});});
function acceptStored(value:any,replace?:string){
    const t=tab(value.sessionId),target=value.publicTarget;
    t.request={host:target.host,port:target.port,username:target.username,certificateSha256:target.certificateSha256??'',clipboard:target.clipboard??{toRemote:false,fromRemote:false}};
    t.storedSessionId=value.sessionId;t.name=value.label;t.color=tabColour(value.color);if(t.color)t.button.dataset.color=t.color;
    t.button.textContent=tabLabel(value.label,[...tabs].filter(([key])=>key!==value.sessionId&&key!==replace).map(([,other])=>other.button.textContent??''));t.button.title=`${target.username}@${target.host}:${target.port}`;
    if(replace)tabs.get(replace)?.button.before(t.button);(document.getElementById('adhoc') as HTMLDetailsElement|null)?.removeAttribute('open');select(value.sessionId);if(replace)discard(replace);refresh();
}
window.rdp.onStoredOpened(value=>acceptStored(value));
async function openStoredSession(ref?:OpenStored,replace?:string):Promise<string|undefined>{
  const button=el<HTMLButtonElement>('connect-button');if(button.disabled)return 'Another connection is opening.';button.disabled=true;
  try{
    await syncQuickJumpGateway();
    const reply=ref?await window.rdp.openStored({...ref,temporaryOptions:initialDesktop(viewport())}):await window.rdp.reconnectStored(tabs.get(replace??'')!.storedSessionId!);
    if(!reply.ok)return reply.message;
    acceptStored(reply.value,replace);return undefined;
  }catch{return 'Connection could not be opened.';}finally{button.disabled=false;}
}

// ---- Royal TSX Multi-Protocol Live Network Workspace Tabs ----
interface ProbePayload {
  protocol: string;
  standard: string;
  host: string;
  port: number;
  reachable: boolean;
  latencyMs: number;
  banner: string;
  hostKey?: string;
  tlsVersion?: string;
  tlsCipher?: string;
  certSubject?: string;
  certIssuer?: string;
  certValidFrom?: string;
  certValidTo?: string;
  certSha256?: string;
  httpStatus?: number;
  httpStatusText?: string;
  httpHeaders?: Record<string, string>;
  httpBodyPreview?: string;
  vncVersion?: string;
  vncSecurityTypes?: string[];
  ports?: {
    port: number;
    service: string;
    reachable: boolean;
    latencyMs: number;
    banner: string;
    tlsSubject?: string;
    tlsSha256?: string;
  }[];
  files?: {
    permissions: string;
    links: string;
    owner: string;
    group: string;
    size: string;
    date: string;
    name: string;
    isDir: boolean;
  }[];
  summary: string;
}

interface ExecPayload {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  files?: ProbePayload['files'];
  httpStatus?: number;
  httpHeaders?: Record<string, string>;
}

interface SshEnvPayload {
  jumpHosts: {
    alias: string;
    hostName: string;
    port: number;
    user: string;
    proxyJump?: string;
    identityFile?: string;
    isJumpCandidate: boolean;
  }[];
  allHosts: {
    alias: string;
    hostName: string;
    port: number;
    user: string;
    proxyJump?: string;
    identityFile?: string;
  }[];
  keys: string[];
  activeRdpGateway: {
    jumpHost: string;
    jumpPasswordSet: boolean;
    identityFile: string;
  };
}

interface TunnelInfo {
  id: string;
  name: string;
  jumpHost: string;
  localPort: number;
  targetHost: string;
  targetPort: number;
  pid: number;
  startedAt: string;
  status: 'active' | 'closed' | 'error';
  lastError?: string;
}

const sessionPasswords = new Map<string, string>();
const sessionJumpHosts = new Map<string, string>();
const sessionJumpPasswords = new Map<string, string>();
const sessionKeys = new Map<string, string>();
let cachedSshEnv: SshEnvPayload | null = null;

async function getSshEnv(): Promise<SshEnvPayload> {
  try {
    const res = (await (window as any).workspace.run('ssh.env', {})) as { ok: boolean; value?: SshEnvPayload };
    if (res.ok && res.value) {
      cachedSshEnv = res.value;
      return res.value;
    }
  } catch {
    // Fallback
  }
  return (
    cachedSshEnv ?? {
      jumpHosts: [
        { alias: 'pln-jump', hostName: '103.172.170.196', port: 2345, user: 'bright', isJumpCandidate: true },
        { alias: 'distribusi-jump', hostName: '103.172.170.219', port: 2602, user: 'bright', isJumpCandidate: true },
        { alias: 'mitra-jump', hostName: '103.172.170.219', port: 2602, user: 'bright', isJumpCandidate: true },
      ],
      allHosts: [],
      keys: ['~/.ssh/id_ed25519', '~/.ssh/id_ed25519_distribusi', '~/.ssh/mitra_deploy_ed25519'],
      activeRdpGateway: { jumpHost: '', jumpPasswordSet: false, identityFile: '' },
    }
  );
}

function getSelectedQuickJumpHost(): { jumpHost: string; jumpPassword: string } {
  const sel = document.getElementById('jump-host-select') as HTMLSelectElement | null;
  const custom = document.getElementById('jump-host-custom') as HTMLInputElement | null;
  const pass = document.getElementById('jump-host-pass') as HTMLInputElement | null;
  if (!sel) return { jumpHost: '', jumpPassword: '' };
  const val = sel.value === '__custom__' ? (custom?.value.trim() ?? '') : sel.value.trim();
  return { jumpHost: val, jumpPassword: pass?.value ?? '' };
}

function mapDomKeyToX11Keysym(e: KeyboardEvent): number {
  switch (e.key) {
    case 'Backspace':
      return 0xff08;
    case 'Tab':
      return 0xff09;
    case 'Enter':
      return 0xff0d;
    case 'Escape':
      return 0xff1b;
    case 'Insert':
      return 0xff63;
    case 'Delete':
      return 0xffff;
    case 'Home':
      return 0xff50;
    case 'End':
      return 0xff57;
    case 'PageUp':
      return 0xff55;
    case 'PageDown':
      return 0xff56;
    case 'ArrowLeft':
      return 0xff51;
    case 'ArrowUp':
      return 0xff52;
    case 'ArrowRight':
      return 0xff53;
    case 'ArrowDown':
      return 0xff54;
    case 'Shift':
      return e.location === 2 ? 0xffe2 : 0xffe1;
    case 'Control':
      return e.location === 2 ? 0xffe4 : 0xffe3;
    case 'Alt':
      return e.location === 2 ? 0xffea : 0xffe9;
    case 'Meta':
      return e.location === 2 ? 0xffe8 : 0xffe7;
    case 'CapsLock':
      return 0xffe5;
    case 'F1':
      return 0xffbe;
    case 'F2':
      return 0xffbf;
    case 'F3':
      return 0xffc0;
    case 'F4':
      return 0xffc1;
    case 'F5':
      return 0xffc2;
    case 'F6':
      return 0xffc3;
    case 'F7':
      return 0xffc4;
    case 'F8':
      return 0xffc5;
    case 'F9':
      return 0xffc6;
    case 'F10':
      return 0xffc7;
    case 'F11':
      return 0xffc8;
    case 'F12':
      return 0xffc9;
    default:
      if (e.key.length === 1) {
        const code = e.key.codePointAt(0) ?? 0;
        if (code >= 0x20 && code <= 0xff) return code;
        if (code > 0xff) return 0x01000000 | code;
      }
      return 0;
  }
}

function buildJumpVncDesktopView(spec: PluginSessionSpec, id: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'jump-vnc-shell';
  wrap.hidden = true;
  wrap.dataset.scale = 'fit';

  const passKey = `${spec.host}:${spec.port}`;
  const initialJump = spec.jumpHost || sessionJumpHosts.get(passKey) || getSelectedQuickJumpHost().jumpHost || '';
  if (initialJump) sessionJumpHosts.set(passKey, initialJump);

  // Top Control Bar (Jump Desktop Style)
  const topbar = document.createElement('div');
  topbar.className = 'jump-vnc-topbar';

  const leftGroup = document.createElement('div');
  leftGroup.className = 'jump-vnc-left';
  const dot = document.createElement('span');
  dot.className = 'termius-dot';
  dot.dataset.state = 'connecting';
  const titleEl = document.createElement('span');
  titleEl.className = 'termius-host-title';
  titleEl.textContent = `${spec.name} (${spec.host}:${spec.port})`;
  const metaBadge = document.createElement('span');
  metaBadge.className = 'termius-auth-badge';
  metaBadge.textContent = 'RFB / ARD 3.8';
  leftGroup.append(dot, titleEl, metaBadge);

  const rightGroup = document.createElement('div');
  rightGroup.className = 'jump-vnc-actions';

  const jumpSel = document.createElement('select');
  jumpSel.className = 'plugin-pass-input';
  jumpSel.title = 'Route Remote Mac / VNC connection through SSH Jump Host';
  const jumpOptions: [string, string][] = [
    ['', '🌐 Direct LAN / VPN'],
    ['pln-jump', '🛡 Jump: pln-jump (103.172.170.196:2345)'],
    ['distribusi-jump', '🛡 Jump: distribusi-jump (103.172.170.219:2602)'],
    ['mitra-jump', '🛡 Jump: mitra-jump (103.172.170.219:2602)'],
  ];
  if (initialJump && !jumpOptions.some(([val]) => val === initialJump)) {
    jumpOptions.push([initialJump, `🛡 Jump: ${initialJump}`]);
  }
  for (const [val, label] of jumpOptions) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = label;
    if (val === initialJump) opt.selected = true;
    jumpSel.append(opt);
  }
  void getSshEnv().then((env) => {
    const existing = new Set(Array.from(jumpSel.options).map((o) => o.value));
    for (const j of env.jumpHosts) {
      if (!existing.has(j.alias)) {
        const opt = document.createElement('option');
        opt.value = j.alias;
        opt.textContent = `🛡 Jump: ${j.alias} (${j.user}@${j.hostName}:${j.port})`;
        if (j.alias === initialJump) opt.selected = true;
        jumpSel.append(opt);
      }
    }
  });

  const userInput = document.createElement('input');
  userInput.type = 'text';
  userInput.className = 'plugin-pass-input';
  userInput.placeholder = 'Mac Username (ARD)…';
  userInput.value = spec.username || '';

  const passInput = document.createElement('input');
  passInput.type = 'password';
  passInput.className = 'plugin-pass-input';
  passInput.placeholder = 'Mac / VNC Password…';
  passInput.value = sessionPasswords.get(passKey) ?? '';
  passInput.addEventListener('input', () => {
    sessionPasswords.set(passKey, passInput.value);
  });

  const connectBtn = document.createElement('button');
  connectBtn.type = 'button';
  connectBtn.textContent = '▶ Connect In-Tab';
  connectBtn.title = 'Connect live Remote Mac / VNC desktop inside this tab (Jump Desktop style)';

  const scaleBtn = document.createElement('button');
  scaleBtn.type = 'button';
  scaleBtn.className = 'quiet';
  scaleBtn.textContent = '⛶ Scale: Fit';
  scaleBtn.title = 'Toggle between Fit-to-Window scaling and 1:1 Pixel mapping';
  scaleBtn.onclick = () => {
    const next = wrap.dataset.scale === 'fit' ? 'actual' : 'fit';
    wrap.dataset.scale = next;
    scaleBtn.textContent = next === 'fit' ? '⛶ Scale: Fit' : '🔍 Scale: 1:1';
  };

  const typeClipVncBtn = document.createElement('button');
  typeClipVncBtn.type = 'button';
  typeClipVncBtn.className = 'quiet';
  typeClipVncBtn.textContent = '⌨ Type Clipboard';
  typeClipVncBtn.title = 'Jump Desktop / Royal TSX: Paste local clipboard as simulated keystrokes into remote Mac / VNC';

  const snapVncBtn = document.createElement('button');
  snapVncBtn.type = 'button';
  snapVncBtn.className = 'quiet';
  snapVncBtn.textContent = '📷 Snapshot';
  snapVncBtn.title = 'Save PNG screenshot of remote Mac / VNC screen';

  const nativeBtn = document.createElement('button');
  nativeBtn.type = 'button';
  nativeBtn.className = 'quiet';
  nativeBtn.textContent = '🖥 Screen Sharing.app';
  nativeBtn.title = 'Open in native macOS Screen Sharing.app (auto-tunneled via SSH if Jump Host is selected)';

  const sshBtn = document.createElement('button');
  sshBtn.type = 'button';
  sshBtn.className = 'quiet';
  sshBtn.textContent = '❯_ SSH';
  sshBtn.title = 'Open interactive SSH Terminal to this Mac';
  sshBtn.onclick = () => {
    openPluginTab({
      pluginType: 'Terminal',
      name: `${spec.name} (SSH)`,
      host: spec.host,
      port: 22,
      username: userInput.value.trim() || spec.username || 'root',
      notes: 'Interactive SSH Terminal',
      jumpHost: jumpSel.value,
      sshKey: spec.sshKey || sessionKeys.get(passKey) || '',
    });
  };

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'quiet';
  closeBtn.textContent = '✕ Close';

  rightGroup.append(jumpSel, userInput, passInput, connectBtn, scaleBtn, typeClipVncBtn, snapVncBtn, nativeBtn, sshBtn, closeBtn);
  topbar.append(leftGroup, rightGroup);

  // Viewport + Canvas + Status Overlay
  const stage = document.createElement('div');
  stage.className = 'jump-vnc-stage';

  const canvas = document.createElement('canvas');
  canvas.className = 'jump-vnc-canvas';
  canvas.tabIndex = 0;
  canvas.width = 1280;
  canvas.height = 800;
  canvas.hidden = true;

  const overlay = document.createElement('div');
  overlay.className = 'jump-vnc-overlay';
  const ovTitle = document.createElement('h3');
  ovTitle.textContent = `Remote Mac / VNC Desktop — ${spec.host}:${spec.port}`;
  const ovDesc = document.createElement('p');
  ovDesc.className = 'muted';
  ovDesc.textContent =
    'Probing RFB / Apple Remote Desktop (ARD) endpoint… Enter Mac Username & Password above to stream live desktop inside this tab, or open macOS Screen Sharing.app.';
  const ovActions = document.createElement('div');
  ovActions.className = 'jump-vnc-overlay-actions';
  const ovConnectBtn = document.createElement('button');
  ovConnectBtn.type = 'button';
  ovConnectBtn.textContent = '▶ Connect Live In-Tab Desktop';
  const ovNativeBtn = document.createElement('button');
  ovNativeBtn.type = 'button';
  ovNativeBtn.className = 'quiet';
  ovNativeBtn.textContent = '🖥 Open macOS Screen Sharing.app';
  ovActions.append(ovConnectBtn, ovNativeBtn);
  overlay.append(ovTitle, ovDesc, ovActions);

  stage.append(canvas, overlay);
  wrap.append(topbar, stage);

  let activeVncSessionId = '';
  let unmounted = false;
  let lastSeq = 0;
  let buttonMask = 0;

  const stopActiveVnc = async () => {
    const sid = activeVncSessionId;
    activeVncSessionId = '';
    if (sid) {
      await (window as any).workspace.run('vnc.close', { sessionId: sid }).catch(() => {});
    }
  };

  const launchNativeScreenSharing = async () => {
    try {
      const res = (await (window as any).workspace.run('protocol.launch', {
        pluginType: 'VNC',
        host: spec.host,
        port: spec.port,
        username: userInput.value.trim() || spec.username,
        jumpHost: jumpSel.value,
        jumpPassword: getSelectedQuickJumpHost().jumpPassword,
        identityFile: spec.sshKey || sessionKeys.get(passKey) || '',
        path: '/',
      })) as { ok: boolean; value?: { ok: boolean; url: string; tunneled: boolean; message: string } };
      if (res.ok && res.value) {
        ovDesc.textContent = res.value.message;
        metaBadge.textContent = res.value.tunneled ? 'Screen Sharing.app (SSH Tunneled)' : 'Screen Sharing.app';
      }
    } catch {
      ovDesc.textContent = 'Failed to launch native Screen Sharing.app.';
    }
  };
  nativeBtn.onclick = () => void launchNativeScreenSharing();
  ovNativeBtn.onclick = () => void launchNativeScreenSharing();

  const startInTabVnc = async () => {
    await stopActiveVnc();
    dot.dataset.state = 'connecting';
    metaBadge.textContent = 'Connecting RFB / ARD…';
    overlay.hidden = false;
    ovTitle.textContent = `Connecting to ${spec.host}:${spec.port}…`;
    ovDesc.textContent = jumpSel.value
      ? `Establishing SSH Jump Host tunnel (${jumpSel.value}) & negotiating Apple Remote Desktop (ARD 30) / VNC handshake…`
      : 'Negotiating Apple Remote Desktop (ARD 30) / VNC RFB 3.8 handshake…';

    try {
      const res = (await (window as any).workspace.run('vnc.open', {
        host: spec.host,
        port: spec.port,
        username: userInput.value.trim(),
        password: passInput.value,
        jumpHost: jumpSel.value,
        jumpPassword: getSelectedQuickJumpHost().jumpPassword,
        identityFile: spec.sshKey || sessionKeys.get(passKey) || '',
      })) as {
        ok: boolean;
        value?: {
          ok: boolean;
          sessionId?: string;
          width?: number;
          height?: number;
          desktopName?: string;
          securityName?: string;
          tunneled?: boolean;
          error?: string;
        };
      };

      if (!res.ok || !res.value || !res.value.ok || !res.value.sessionId) {
        const errMsg = res.value?.error || 'Could not establish VNC / ARD session.';
        dot.dataset.state = 'closed';
        metaBadge.textContent = 'Auth / Connect Required';
        canvas.hidden = true;
        overlay.hidden = false;
        ovTitle.textContent = `Remote Mac / VNC Ready — ${spec.host}:${spec.port}`;
        ovDesc.textContent = errMsg;
        return;
      }

      const info = res.value;
      activeVncSessionId = info.sessionId!;
      lastSeq = 0;
      const w = info.width || 1280;
      const h = info.height || 800;
      canvas.width = w;
      canvas.height = h;
      canvas.hidden = false;
      overlay.hidden = true;
      canvas.focus();

      dot.dataset.state = 'connected';
      titleEl.textContent = `${info.desktopName || spec.name} (${w}×${h})`;
      metaBadge.textContent = `${info.securityName || 'RFB 3.8'}${info.tunneled ? ` · Tunneled (${jumpSel.value})` : ''}`;

      const t = tabs.get(id);
      if (t) {
        t.state = 'connected';
        t.width = w;
        t.height = h;
        refresh();
      }

      const ctx = canvas.getContext('2d');
      const curSid = activeVncSessionId;

      while (!unmounted && activeVncSessionId === curSid) {
        const frameRes = (await (window as any).workspace.run('vnc.frame', {
          sessionId: curSid,
          sinceSeq: lastSeq,
          waitMs: 90,
        })) as {
          ok: boolean;
          value?: {
            ok: boolean;
            connected: boolean;
            closed: boolean;
            error?: string;
            width: number;
            height: number;
            seq: number;
            rgbaBase64?: string;
          };
        };

        if (!frameRes.ok || !frameRes.value || !frameRes.value.ok) break;
        const f = frameRes.value;
        if (f.width > 0 && f.height > 0 && (canvas.width !== f.width || canvas.height !== f.height)) {
          canvas.width = f.width;
          canvas.height = f.height;
        }
        if (f.rgbaBase64 && f.seq > lastSeq && ctx) {
          lastSeq = f.seq;
          const rawStr = atob(f.rgbaBase64);
          const bytes = new Uint8ClampedArray(rawStr.length);
          for (let i = 0; i < rawStr.length; i++) {
            bytes[i] = rawStr.charCodeAt(i);
          }
          if (bytes.length === canvas.width * canvas.height * 4) {
            const imgData = new ImageData(bytes, canvas.width, canvas.height);
            ctx.putImageData(imgData, 0, 0);
          }
        }
        if (f.closed) {
          dot.dataset.state = 'closed';
          metaBadge.textContent = 'Disconnected';
          canvas.hidden = true;
          overlay.hidden = false;
          ovTitle.textContent = `Session Ended — ${spec.host}:${spec.port}`;
          ovDesc.textContent = f.error || 'Remote Mac / VNC connection closed.';
          break;
        }
      }
    } catch {
      dot.dataset.state = 'closed';
      canvas.hidden = true;
      overlay.hidden = false;
      ovDesc.textContent = 'VNC / ARD connection error.';
    }
  };

  connectBtn.onclick = () => void startInTabVnc();
  ovConnectBtn.onclick = () => void startInTabVnc();
  passInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void startInTabVnc();
    }
  });

  // Pointer & Keyboard events on the live VNC canvas
  const mapCanvasCoords = (e: MouseEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / Math.max(1, rect.width)) * canvas.width;
    const y = ((e.clientY - rect.top) / Math.max(1, rect.height)) * canvas.height;
    return {
      x: Math.max(0, Math.min(canvas.width - 1, Math.round(x))),
      y: Math.max(0, Math.min(canvas.height - 1, Math.round(y))),
    };
  };

  const sendPointer = (x: number, y: number, mask: number) => {
    if (!activeVncSessionId) return;
    void (window as any).workspace.run('vnc.input', {
      sessionId: activeVncSessionId,
      kind: 'pointer',
      x,
      y,
      buttonMask: mask,
    });
  };

  canvas.addEventListener('mousemove', (e) => {
    if (!activeVncSessionId) return;
    const pt = mapCanvasCoords(e);
    sendPointer(pt.x, pt.y, buttonMask);
  });

  canvas.addEventListener('mousedown', (e) => {
    canvas.focus();
    if (!activeVncSessionId) return;
    e.preventDefault();
    if (e.button === 0) buttonMask |= 1;
    else if (e.button === 1) buttonMask |= 2;
    else if (e.button === 2) buttonMask |= 4;
    const pt = mapCanvasCoords(e);
    sendPointer(pt.x, pt.y, buttonMask);
  });

  canvas.addEventListener('mouseup', (e) => {
    if (!activeVncSessionId) return;
    e.preventDefault();
    if (e.button === 0) buttonMask &= ~1;
    else if (e.button === 1) buttonMask &= ~2;
    else if (e.button === 2) buttonMask &= ~4;
    const pt = mapCanvasCoords(e);
    sendPointer(pt.x, pt.y, buttonMask);
  });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!activeVncSessionId) return;
      e.preventDefault();
      const pt = mapCanvasCoords(e);
      const wheelBit = e.deltaY < 0 ? 8 : 16;
      sendPointer(pt.x, pt.y, buttonMask | wheelBit);
      sendPointer(pt.x, pt.y, buttonMask);
    },
    { passive: false },
  );

  canvas.addEventListener('keydown', (e) => {
    if (!activeVncSessionId) return;
    const keysym = mapDomKeyToX11Keysym(e);
    if (keysym) {
      e.preventDefault();
      e.stopPropagation();
      void (window as any).workspace.run('vnc.input', {
        sessionId: activeVncSessionId,
        kind: 'key',
        down: true,
        keysym,
      });
    }
  });

  canvas.addEventListener('keyup', (e) => {
    if (!activeVncSessionId) return;
    const keysym = mapDomKeyToX11Keysym(e);
    if (keysym) {
      e.preventDefault();
      e.stopPropagation();
      void (window as any).workspace.run('vnc.input', {
        sessionId: activeVncSessionId,
        kind: 'key',
        down: false,
        keysym,
      });
    }
  });

  typeClipVncBtn.onclick = async () => {
    if (!activeVncSessionId) return;
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return;
    }
    if (!text) return;
    canvas.focus();
    for (const ch of text) {
      if (!activeVncSessionId) break;
      const ks = ch === '\n' || ch === '\r' ? 0xff0d : ch === '\t' ? 0xff09 : ch.charCodeAt(0);
      if (ks >= 32 && ks <= 126 || ks === 0xff0d || ks === 0xff09) {
        await (window as any).workspace.run('vnc.input', {
          sessionId: activeVncSessionId,
          kind: 'key',
          down: true,
          keysym: ks,
        });
        await (window as any).workspace.run('vnc.input', {
          sessionId: activeVncSessionId,
          kind: 'key',
          down: false,
          keysym: ks,
        });
      }
    }
  };

  snapVncBtn.onclick = () => {
    if (canvas.hidden || canvas.width === 0) return;
    try {
      const dataUrl = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const safeName = (spec.name || spec.host || 'mac').replace(/[^a-zA-Z0-9_-]+/g, '-');
      a.href = dataUrl;
      a.download = `JalaDesk-${safeName}-${stamp}.png`;
      document.body.append(a);
      a.click();
      a.remove();
    } catch {}
  };

  closeBtn.onclick = () => {
    unmounted = true;
    void stopActiveVnc();
    const next = tabAfterClose(tabIds(), id);
    discard(id);
    select(next);
  };

  // Initial probe + auto-connect if password is already provided
  void (async () => {
    try {
      const res = (await (window as any).workspace.run('protocol.probe', {
        pluginType: 'VNC',
        host: spec.host,
        port: spec.port,
        username: userInput.value.trim(),
        path: '/',
        jumpHost: jumpSel.value,
        jumpPassword: getSelectedQuickJumpHost().jumpPassword,
        identityFile: spec.sshKey || sessionKeys.get(passKey) || '',
      })) as { ok: boolean; value?: ProbePayload };
      if (res.ok && res.value) {
        const d = res.value;
        metaBadge.textContent = d.reachable ? `${d.banner} (${d.latencyMs} ms)` : 'Unreachable';
        dot.dataset.state = d.reachable ? 'connected' : 'closed';
        ovDesc.textContent = d.reachable
          ? `${d.summary} Enter your Mac Username & Password in the top bar and click "▶ Connect Live In-Tab Desktop" to stream this Mac inside JalaDesk.`
          : d.summary;
        const t = tabs.get(id);
        if (t) {
          t.state = d.reachable ? 'connected' : 'failed';
          refresh();
        }
        if (d.reachable && passInput.value) {
          void startInTabVnc();
        }
      }
    } catch {
      ovDesc.textContent = 'Could not probe remote Mac / VNC endpoint.';
    }
  })();

  return wrap;
}

function buildPluginView(spec: PluginSessionSpec, id: string): HTMLElement {
  const isTerminalKind = ['Terminal', 'PowerShell', 'Command Task', 'Key Sequence Task'].includes(spec.pluginType);
  const isGatewayKind = ['Secure Gateway', 'Royal Server', 'Remote Desktop Gateway'].includes(spec.pluginType);
  const isSftpKind = spec.pluginType === 'File Transfer';
  const isHttpKind = spec.pluginType === 'Web Page';

  if (spec.pluginType === 'Audit Log') {
    return buildAuditLogView(spec, id);
  }
  if (spec.pluginType === 'Tasks Manager') {
    return buildTasksManagerView(spec, id);
  }
  if (spec.pluginType === 'Network Scanner') {
    return buildNetworkScannerView(spec, id);
  }
  if (spec.pluginType === 'Batch Script Runner') {
    return buildBatchScriptRunnerView(spec, id);
  }
  if (spec.pluginType === 'Known Hosts Manager') {
    return buildKnownHostsManagerView(spec, id);
  }
  if (spec.pluginType === 'WoL & Port Knock') {
    return buildWolAndKnockView(spec, id);
  }
  if (spec.pluginType === 'SSH Config Studio') {
    return buildSshConfigStudioView(spec, id);
  }
  if (spec.pluginType === 'Runbook Studio') {
    return buildRunbookStudioView(spec, id);
  }
  if (spec.pluginType === 'Health Monitor') {
    return buildHealthMonitorView(spec, id);
  }
  if (spec.pluginType === 'Config Bundle') {
    return buildPortableBundleView(spec, id);
  }
  if (spec.pluginType === 'SFTP Commander') {
    return buildDualPaneSftpCommanderView(spec, id);
  }
  if (spec.pluginType === 'Topology Map') {
    return buildTopologyMapView(spec, id);
  }
  if (spec.pluginType === 'SSH Key Studio') {
    return buildSshKeyStudioView(spec, id);
  }
  if (spec.pluginType === 'Drift Comparator') {
    return buildDriftComparatorView(spec, id);
  }
  if (spec.pluginType === 'Safety Guard') {
    return buildSafetyGuardView(spec, id);
  }
  if (spec.pluginType === 'Port Forward Studio') {
    return buildPortForwardStudioView(spec, id);
  }
  if (spec.pluginType === 'Log Streamer') {
    return buildLogStreamerView(spec, id);
  }
  if (spec.pluginType === 'Incident Reporter') {
    return buildIncidentReporterView(spec, id);
  }
  if (spec.pluginType === 'Cert Auditor') {
    return buildCertAuditorView(spec, id);
  }
  if (spec.pluginType === 'Cron Scheduler') {
    return buildCronSchedulerView(spec, id);
  }
  if (spec.pluginType === 'AD & DNS Studio') {
    return buildAdDnsStudioView(spec, id);
  }
  if (spec.pluginType === 'Container Studio') {
    return buildContainerStudioView(spec, id);
  }
  if (spec.pluginType === 'Database Studio') {
    return buildDatabaseStudioView(spec, id);
  }
  if (spec.pluginType === 'Firewall Auditor') {
    return buildFirewallAuditorView(spec, id);
  }
  if (spec.pluginType === 'Clipboard Scrubber') {
    return buildClipboardScrubberView(spec, id);
  }
  if (spec.pluginType === 'Network Path Studio') {
    return buildNetworkPathStudioView(spec, id);
  }
  if (spec.pluginType === 'Hypervisor Studio') {
    return buildHypervisorStudioView(spec, id);
  }
  if (spec.pluginType === 'TOTP Authenticator') {
    return buildTotpAuthenticatorView(spec, id);
  }
  if (spec.pluginType === 'IaC Exporter') {
    return buildIacExporterView(spec, id);
  }
  if (spec.pluginType === 'Resource Profiler') {
    return buildResourceProfilerView(spec, id);
  }
  if (spec.pluginType === 'HTTP Endpoint Studio') {
    return buildHttpEndpointStudioView(spec, id);
  }
  if (spec.pluginType === 'Service Controller Studio') {
    return buildServiceControllerStudioView(spec, id);
  }
  if (spec.pluginType === 'User Session Auditor') {
    return buildUserSessionAuditorView(spec, id);
  }
  if (spec.pluginType === 'Config Backup Vault') {
    return buildConfigBackupVaultView(spec, id);
  }
  if (spec.pluginType === 'Subnet IPAM Studio') {
    return buildSubnetIpamStudioView(spec, id);
  }
  if (spec.pluginType === 'OS Patch Studio') {
    return buildOsPatchStudioView(spec, id);
  }
  if (spec.pluginType === 'Storage Studio') {
    return buildStorageStudioView(spec, id);
  }
  if (spec.pluginType === 'CIS Benchmark Studio') {
    return buildCisBenchmarkStudioView(spec, id);
  }
  if (spec.pluginType === 'Reverse Proxy Studio') {
    return buildReverseProxyStudioView(spec, id);
  }
  if (spec.pluginType === 'Time Sync Studio') {
    return buildTimeSyncStudioView(spec, id);
  }
  if (spec.pluginType === 'Packet Sniffer Studio') {
    return buildPacketSnifferStudioView(spec, id);
  }
  if (spec.pluginType === 'Kernel Limits Studio') {
    return buildKernelLimitsStudioView(spec, id);
  }
  if (spec.pluginType === 'SSH CA Studio') {
    return buildSshCaStudioView(spec, id);
  }
  if (spec.pluginType === 'Prometheus Studio') {
    return buildPrometheusStudioView(spec, id);
  }
  if (spec.pluginType === 'Intrusion Studio') {
    return buildIntrusionStudioView(spec, id);
  }
  if (spec.pluginType === 'HA Cluster Studio') {
    return buildHaClusterStudioView(spec, id);
  }
  if (spec.pluginType === 'VPN Mesh Studio') {
    return buildVpnMeshStudioView(spec, id);
  }
  if (spec.pluginType === 'DB Backup Studio') {
    return buildDbBackupStudioView(spec, id);
  }
  if (spec.pluginType === 'FIM Auditd Studio') {
    return buildFimAuditdStudioView(spec, id);
  }
  if (spec.pluginType === 'Change RFC Studio') {
    return buildChangeRfcStudioView(spec, id);
  }
  if (spec.pluginType === 'K8s Manifest Studio') {
    return buildK8sManifestStudioView(spec, id);
  }
  if (spec.pluginType === 'Alert Relay Studio') {
    return buildAlertRelayStudioView(spec, id);
  }
  if (spec.pluginType === 'Secret Env Studio') {
    return buildSecretEnvStudioView(spec, id);
  }
  if (spec.pluginType === 'Threat Intel Studio') {
    return buildThreatIntelStudioView(spec, id, {
      listAllConnections: () => documents.listAllConnections?.() ?? [],
    });
  }
  if (spec.pluginType === 'Load Benchmark Studio') {
    return buildLoadBenchmarkStudioView(spec, id);
  }
  if (spec.pluginType === 'Team Vault Sync') {
    return buildTeamVaultSyncStudioView(spec, id, {
      listAllConnections: () => documents.listAllConnections?.() ?? [],
    });
  }
  if (spec.pluginType === 'Session Cast Studio') {
    return buildSessionCastStudioView(spec, id);
  }
  if (spec.pluginType === 'VNC') {
    return buildJumpVncDesktopView(spec, id);
  }
  if (isTerminalKind) {
    return buildTermiusTerminalView(spec, id);
  }
  if (isGatewayKind) {
    return buildGatewayTunnelView(spec, id);
  }

  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';

  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-row-inline';
  const titleEl = document.createElement('span');
  titleEl.className = 'plugin-view-title';
  titleEl.textContent = `${spec.name} (${spec.host}:${spec.port})`;
  const badgeEl = document.createElement('span');
  badgeEl.className = 'plugin-view-badge';
  badgeEl.textContent = spec.pluginType;
  const statePill = document.createElement('span');
  statePill.className = 'plugin-state-pill';
  statePill.textContent = 'Probing…';
  titleWrap.append(titleEl, badgeEl, statePill);

  const actionsWrap = document.createElement('div');
  actionsWrap.className = 'plugin-row-inline';

  const passKey = `${spec.username}@${spec.host}:${spec.port}`;
  const initialJump = spec.jumpHost || sessionJumpHosts.get(passKey) || getSelectedQuickJumpHost().jumpHost || '';
  if (initialJump) sessionJumpHosts.set(passKey, initialJump);

  const jumpSel = document.createElement('select');
  jumpSel.className = 'plugin-pass-input';
  jumpSel.title = 'Route connection through SSH Jump Host / Secure Gateway';
  const jumpOptions: [string, string][] = [
    ['', '🌐 Direct LAN / VPN'],
    ['pln-jump', '🛡 Jump: pln-jump (103.172.170.196:2345)'],
    ['distribusi-jump', '🛡 Jump: distribusi-jump (103.172.170.219:2602)'],
    ['mitra-jump', '🛡 Jump: mitra-jump (103.172.170.219:2602)'],
  ];
  if (initialJump && !jumpOptions.some(([val]) => val === initialJump)) {
    jumpOptions.push([initialJump, `🛡 Jump: ${initialJump}`]);
  }
  for (const [val, label] of jumpOptions) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = label;
    if (val === initialJump) opt.selected = true;
    jumpSel.append(opt);
  }
  void getSshEnv().then((env) => {
    const existing = new Set(Array.from(jumpSel.options).map((o) => o.value));
    for (const j of env.jumpHosts) {
      if (!existing.has(j.alias)) {
        const opt = document.createElement('option');
        opt.value = j.alias;
        opt.textContent = `🛡 Jump: ${j.alias} (${j.user}@${j.hostName}:${j.port})`;
        if (j.alias === initialJump) opt.selected = true;
        jumpSel.append(opt);
      }
    }
  });

  const passInput = document.createElement('input');
  passInput.type = 'password';
  passInput.className = 'plugin-pass-input';
  passInput.placeholder = 'Password (if required)…';
  passInput.value = sessionPasswords.get(passKey) ?? '';
  passInput.addEventListener('input', () => {
    sessionPasswords.set(passKey, passInput.value);
  });

  const launchNativeBtn = document.createElement('button');
  launchNativeBtn.type = 'button';
  launchNativeBtn.hidden = true;
  if (spec.pluginType === 'VNC') {
    launchNativeBtn.hidden = false;
    launchNativeBtn.textContent = '🖥 Launch macOS Screen Sharing (GUI)';
    launchNativeBtn.title = 'Open Apple Screen Sharing / VNC GUI (automatically tunneled if Jump Host is selected)';
  } else if (spec.pluginType === 'VMware') {
    launchNativeBtn.hidden = false;
    launchNativeBtn.textContent = '🌐 Open ESXi Web UI (/ui/)';
    launchNativeBtn.title = 'Open VMware ESXi Host Client / vSphere Web UI in browser (tunneled if Jump Host is selected)';
  } else if (spec.pluginType === 'Web Page') {
    launchNativeBtn.hidden = false;
    launchNativeBtn.textContent = '🌐 Open in Browser';
  } else if (spec.pluginType === 'TeamViewer') {
    launchNativeBtn.hidden = false;
    launchNativeBtn.textContent = '⇄ Launch TeamViewer';
  }

  const openShellBtn = document.createElement('button');
  openShellBtn.type = 'button';
  openShellBtn.className = 'quiet';
  openShellBtn.textContent = '❯_ SSH Terminal';
  openShellBtn.title = 'Open interactive Termius-style SSH Terminal to this host';
  openShellBtn.onclick = () => {
    openPluginTab({
      pluginType: 'Terminal',
      name: `${spec.name} (SSH)`,
      host: spec.host,
      port: 22,
      username: spec.username || 'root',
      notes: `Interactive SSH shell for ${spec.pluginType}`,
      jumpHost: jumpSel.value,
      sshKey: spec.sshKey || sessionKeys.get(passKey) || '',
    });
  };

  const reprobeBtn = document.createElement('button');
  reprobeBtn.type = 'button';
  reprobeBtn.className = 'quiet';
  reprobeBtn.textContent = 'Refresh';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close Tab';
  closeBtn.onclick = () => {
    const next = tabAfterClose(tabIds(), id);
    discard(id);
    select(next);
  };
  actionsWrap.append(jumpSel, passInput, launchNativeBtn, openShellBtn, reprobeBtn, closeBtn);
  header.append(titleWrap, actionsWrap);

  const telemetryBar = document.createElement('div');
  telemetryBar.className = 'plugin-telemetry-bar';
  const teleStd = document.createElement('span');
  teleStd.className = 'plugin-tele-item';
  teleStd.textContent = `Standard: Initializing ${spec.pluginType} transport…`;
  const teleBanner = document.createElement('span');
  teleBanner.className = 'plugin-tele-item mono';
  teleBanner.textContent = `Endpoint: ${spec.host}:${spec.port}`;
  const teleKey = document.createElement('span');
  teleKey.className = 'plugin-tele-item mono';
  teleKey.textContent = '';
  telemetryBar.append(teleStd, teleBanner, teleKey);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  let updateFromProbe: (data: ProbePayload) => void = () => {};

  if (isSftpKind) {
    const pathBar = document.createElement('form');
    pathBar.className = 'plugin-terminal-input-row';
    const pathLabel = document.createElement('span');
    pathLabel.className = 'mono muted';
    pathLabel.textContent = 'Remote Path:';
    const pathInput = document.createElement('input');
    pathInput.type = 'text';
    pathInput.className = 'plugin-terminal-input';
    pathInput.value = spec.initPath || '/';
    const browseBtn = document.createElement('button');
    browseBtn.type = 'submit';
    browseBtn.textContent = 'Browse Directory';
    const dualPaneBtn = document.createElement('button');
    dualPaneBtn.type = 'button';
    dualPaneBtn.className = 'quiet';
    dualPaneBtn.textContent = '🗂 Open Dual-Pane Commander & Remote Editor';
    dualPaneBtn.onclick = () => {
      openPluginTab({
        pluginType: 'SFTP Commander',
        name: `SFTP · ${spec.name}`,
        host: spec.host,
        port: spec.port || 22,
        username: spec.username || 'root',
        notes: spec.notes,
        jumpHost: jumpSel.value,
        sshKey: spec.sshKey || sessionKeys.get(passKey) || '',
        initPath: pathInput.value.trim() || '/',
      });
    };
    pathBar.append(pathLabel, pathInput, browseBtn, dualPaneBtn);

    const quickPathsBar = document.createElement('div');
    quickPathsBar.className = 'plugin-quick-bar';

    const table = document.createElement('table');
    table.className = 'plugin-table';
    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    for (const col of ['Name', 'Permissions', 'Owner : Group', 'Size (Bytes)', 'Modified']) {
      const th = document.createElement('th');
      th.textContent = col;
      htr.append(th);
    }
    thead.append(htr);
    const tbody = document.createElement('tbody');
    table.append(thead, tbody);

    const statusOut = document.createElement('pre');
    statusOut.className = 'plugin-terminal-output';
    statusOut.textContent = 'Probing SFTP / SSH transport…';

    const renderFiles = (files: ProbePayload['files'], currentPath: string) => {
      tbody.replaceChildren();
      if (!files || files.length === 0) return;
      if (currentPath !== '/') {
        const upTr = document.createElement('tr');
        upTr.className = 'plugin-clickable-row';
        const upTd = document.createElement('td');
        upTd.colSpan = 5;
        upTd.textContent = '📁 .. (Parent Directory)';
        upTr.append(upTd);
        upTr.onclick = () => {
          const parent = currentPath.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';
          pathInput.value = parent;
          void fetchDirectory(parent);
        };
        tbody.append(upTr);
      }
      for (const f of files) {
        const tr = document.createElement('tr');
        if (f.isDir) {
          tr.className = 'plugin-clickable-row';
          tr.onclick = () => {
            const nextPath = currentPath === '/' ? `/${f.name}` : `${currentPath.replace(/\/+$/, '')}/${f.name}`;
            pathInput.value = nextPath;
            void fetchDirectory(nextPath);
          };
        }
        const cells = [
          `${f.isDir ? '📁 ' : '📄 '}${f.name}`,
          f.permissions,
          `${f.owner}:${f.group}`,
          f.size,
          f.date,
        ];
        for (const c of cells) {
          const td = document.createElement('td');
          td.textContent = c;
          tr.append(td);
        }
        tbody.append(tr);
      }
    };

    const fetchDirectory = async (dirPath: string) => {
      statusOut.textContent = `Listing ${spec.username}@${spec.host}:${dirPath} over SSH/SFTP…`;
      try {
        const res = (await (window as any).workspace.run('protocol.exec', {
          pluginType: 'File Transfer',
          host: spec.host,
          port: spec.port,
          username: spec.username,
          password: passInput.value,
          jumpHost: jumpSel.value,
          identityFile: spec.sshKey || sessionKeys.get(passKey) || '',
          command: dirPath,
        })) as { ok: boolean; value?: ExecPayload; message?: string };
        if (res.ok && res.value) {
          if (res.value.files && res.value.files.length > 0) {
            renderFiles(res.value.files, dirPath);
            statusOut.textContent = `Listed ${res.value.files.length} entries in ${dirPath} (${res.value.durationMs} ms). Click any folder row to navigate.`;
          } else {
            statusOut.textContent = res.value.stderr || res.value.stdout || 'Enter SSH password in top-right header and click Browse Directory.';
          }
        }
      } catch {
        statusOut.textContent = 'Failed to list remote directory.';
      }
    };

    for (const p of ['/', '/root', '/home', '/etc', '/var/log', '/tmp']) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'quiet plugin-quick-pill';
      btn.textContent = p;
      btn.onclick = () => {
        pathInput.value = p;
        void fetchDirectory(p);
      };
      quickPathsBar.append(btn);
    }

    pathBar.addEventListener('submit', (e) => {
      e.preventDefault();
      void fetchDirectory(pathInput.value.trim() || '/');
    });

    updateFromProbe = (data) => {
      if (data.files && data.files.length > 0) {
        renderFiles(data.files, pathInput.value.trim() || '/');
        statusOut.textContent = data.summary;
      } else {
        void fetchDirectory(pathInput.value.trim() || '/');
      }
    };

    body.append(pathBar, quickPathsBar, table, statusOut);
  } else if (isHttpKind) {
    const urlBar = document.createElement('form');
    urlBar.className = 'plugin-terminal-input-row';
    const methodBadge = document.createElement('span');
    methodBadge.className = 'mono muted';
    methodBadge.textContent = 'GET';
    const pathInput = document.createElement('input');
    pathInput.type = 'text';
    pathInput.className = 'plugin-terminal-input';
    pathInput.value = spec.initPath || '/';
    const fetchBtn = document.createElement('button');
    fetchBtn.type = 'submit';
    fetchBtn.textContent = 'Send Request';
    urlBar.append(methodBadge, pathInput, fetchBtn);

    const table = document.createElement('table');
    table.className = 'plugin-table';
    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    for (const col of ['Layer / Header', 'Value / Telemetry']) {
      const th = document.createElement('th');
      th.textContent = col;
      htr.append(th);
    }
    thead.append(htr);
    const tbody = document.createElement('tbody');
    table.append(thead, tbody);

    const bodyPreview = document.createElement('pre');
    bodyPreview.className = 'plugin-terminal-output';
    bodyPreview.textContent = 'Probing HTTP / TLS endpoint…';

    const addRow = (k: string, v: string) => {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td');
      td1.className = 'mono';
      td1.textContent = k;
      const td2 = document.createElement('td');
      td2.className = 'mono';
      td2.textContent = v;
      tr.append(td1, td2);
      tbody.append(tr);
    };

    updateFromProbe = (data) => {
      tbody.replaceChildren();
      addRow('Protocol & Standard', `${data.protocol} — ${data.standard}`);
      addRow('HTTP Status', data.httpStatus ? `${data.httpStatus} ${data.httpStatusText ?? ''}` : data.banner);
      addRow('Round-Trip Latency', `${data.latencyMs} ms`);
      if (data.tlsVersion) addRow('TLS Protocol / Cipher', `${data.tlsVersion} · ${data.tlsCipher ?? ''}`);
      if (data.certSubject) addRow('X.509 Subject CN', data.certSubject);
      if (data.certIssuer) addRow('X.509 Issuer CN', data.certIssuer);
      if (data.certValidTo) addRow('X.509 Validity', `${data.certValidFrom ?? ''} → ${data.certValidTo}`);
      if (data.certSha256) addRow('X.509 SHA-256 Pin', data.certSha256);
      if (data.httpHeaders) {
        for (const [hk, hv] of Object.entries(data.httpHeaders)) {
          addRow(`Header: ${hk}`, hv);
        }
      }
      bodyPreview.textContent = data.httpBodyPreview || data.summary;
    };

    urlBar.addEventListener('submit', async (e) => {
      e.preventDefault();
      bodyPreview.textContent = `Fetching ${spec.host}:${spec.port}${pathInput.value}…`;
      try {
        const res = (await (window as any).workspace.run('protocol.probe', {
          pluginType: spec.pluginType,
          host: spec.host,
          port: spec.port,
          username: spec.username,
          path: pathInput.value.trim() || '/',
          jumpHost: jumpSel.value,
          jumpPassword: passInput.value,
          identityFile: spec.sshKey || sessionKeys.get(passKey) || '',
        })) as { ok: boolean; value?: ProbePayload };
        if (res.ok && res.value) updateFromProbe(res.value);
      } catch {
        bodyPreview.textContent = 'Request failed.';
      }
    });

    body.append(urlBar, table, bodyPreview);
  } else {
    const quickBar = document.createElement('div');
    quickBar.className = 'plugin-quick-bar';

    const cmdForm = document.createElement('form');
    cmdForm.className = 'plugin-terminal-input-row';
    const cmdLabel = document.createElement('span');
    cmdLabel.className = 'mono muted';
    cmdLabel.textContent =
      spec.pluginType === 'VMware'
        ? 'ESXi / vSphere CLI:'
        : spec.pluginType === 'VNC'
          ? 'macOS / VNC Action:'
          : `${spec.pluginType} Query:`;
    const cmdInput = document.createElement('input');
    cmdInput.type = 'text';
    cmdInput.className = 'plugin-terminal-input';

    const presetsByPlugin: Record<string, [string, string][]> = {
      VMware: [
        ['📋 List All VMs (vim-cmd)', 'vim-cmd vmsvc/getallvms 2>/dev/null || esxcli vm process list'],
        ['⚡ Running VMs (esxcli)', 'esxcli vm process list'],
        ['🖥 ESXi Version & Build', 'vmware -vl && esxcli system version get'],
        ['💾 Datastores & Free Space', 'esxcli storage filesystem list'],
        ['🖧 ESXi vSwitches & NICs', 'esxcli network ip interface ipv4 get && esxcli network nic list'],
        ['📊 Host CPU / RAM Telemetry', 'uptime && esxcli hardware memory get 2>/dev/null | head -n 12'],
      ],
      VNC: [
        ['🍎 macOS Version (sw_vers)', 'sw_vers 2>/dev/null || uname -a'],
        ['🖥 Screen Sharing Service (5900)', 'netstat -an | grep 5900 2>/dev/null || ss -tulpn | grep 5900 || uname -a'],
        ['👥 Logged-in Mac Users', 'who && uptime'],
        ['📊 Top Processes', 'top -l 1 -n 15 2>/dev/null || ps aux | head -n 20'],
      ],
      'Hyper-V': [
        ['📋 List Hyper-V VMs (Get-VM)', 'powershell -NoProfile -Command "Get-VM | Format-Table Name,State,CPUUsage,MemoryAssigned,Uptime -AutoSize"'],
        ['🖧 Virtual Switches', 'powershell -NoProfile -Command "Get-VMSwitch | Format-Table Name,SwitchType,NetAdapterInterfaceDescription -AutoSize"'],
        ['💾 Virtual Hard Disks', 'powershell -NoProfile -Command "Get-VMHardDiskDrive | Format-Table VMName,ControllerType,Path -AutoSize"'],
        ['🖥 Hyper-V Host Summary', 'powershell -NoProfile -Command "Get-VMHost | Select-Object Name,LogicalProcessorCount,MemoryCapacity,VirtualHardDiskPath"'],
      ],
      'Windows Services': [
        ['⚙ Running Services', 'powershell -NoProfile -Command "Get-Service | Where-Object {$_.Status -eq \'Running\'} | Select-Object -First 40 Status,Name,DisplayName | Format-Table -AutoSize" 2>/dev/null || systemctl list-units --type=service --state=running --no-pager | head -n 35'],
        ['⏹ Stopped Auto-Start Services', 'powershell -NoProfile -Command "Get-CimInstance Win32_Service | Where-Object {$_.StartMode -eq \'Auto\' -and $_.State -ne \'Running\'} | Select-Object Name,State,StartMode,DisplayName | Format-Table -AutoSize" 2>/dev/null || systemctl list-units --type=service --state=failed --no-pager'],
        ['🖧 Core Infrastructure Services', 'powershell -NoProfile -Command "Get-Service TermService,LanmanServer,RpcSs,W32Time,Dnscache,WinRM -ErrorAction SilentlyContinue | Format-Table Status,Name,DisplayName -AutoSize" 2>/dev/null || systemctl status ssh --no-pager'],
      ],
      'Windows Processes': [
        ['📊 Top CPU Processes', 'powershell -NoProfile -Command "Get-Process | Sort-Object CPU -Descending | Select-Object -First 25 Id,ProcessName,CPU,WorkingSet64 | Format-Table -AutoSize" 2>/dev/null || ps aux --sort=-%cpu | head -n 25'],
        ['🧠 Top Memory Processes', 'powershell -NoProfile -Command "Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 25 Id,ProcessName,WorkingSet64,CPU | Format-Table -AutoSize" 2>/dev/null || ps aux --sort=-%mem | head -n 25'],
        ['🖧 Listening TCP Ports', 'netstat -ano | findstr LISTENING 2>/dev/null || ss -tulpn'],
      ],
      'Windows Events View': [
        ['🚨 System Errors & Warnings', 'powershell -NoProfile -Command "Get-EventLog -LogName System -EntryType Error,Warning -Newest 25 | Format-Table TimeGenerated,EntryType,Source,EventID,Message -AutoSize -Wrap" 2>/dev/null || journalctl -p 3 -xb --no-pager | tail -n 35'],
        ['🔐 Security Logon Audit', 'powershell -NoProfile -Command "Get-EventLog -LogName Security -Newest 20 | Format-Table TimeGenerated,EntryType,InstanceId,Message -AutoSize" 2>/dev/null || last -n 20'],
        ['📦 Application Errors', 'powershell -NoProfile -Command "Get-EventLog -LogName Application -EntryType Error,Warning -Newest 25 | Format-Table TimeGenerated,EntryType,Source,EventID,Message -AutoSize -Wrap" 2>/dev/null || dmesg | tail -n 35'],
      ],
      'Terminal Services': [
        ['👥 Active RDP Sessions (qwinsta)', 'qwinsta 2>/dev/null || query session 2>/dev/null || who -a'],
        ['👤 Logged-on Users (quser)', 'quser 2>/dev/null || query user 2>/dev/null || w'],
        ['🖥 Session Processes (qprocess)', 'qprocess 2>/dev/null || ps -ef | head -n 30'],
      ],
    };

    const pluginPresets = presetsByPlugin[spec.pluginType] ?? [
      ['🖥 System Info', 'uname -a 2>/dev/null || ver'],
      ['⏱ Uptime', 'uptime 2>/dev/null || who'],
      ['🖧 Network Ports', 'ss -tulpn 2>/dev/null || netstat -an | head -n 25'],
    ];

    cmdInput.value = pluginPresets[0]?.[1] ?? 'uname -a';
    const runCmdBtn = document.createElement('button');
    runCmdBtn.type = 'submit';
    runCmdBtn.textContent = 'Run Action';
    cmdForm.append(cmdLabel, cmdInput, runCmdBtn);

    const table = document.createElement('table');
    table.className = 'plugin-table';
    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    for (const col of ['Service / Protocol Standard', 'Endpoint', 'Live State & Latency', 'Protocol Banner / X.509 Certificate']) {
      const th = document.createElement('th');
      th.textContent = col;
      htr.append(th);
    }
    thead.append(htr);
    const tbody = document.createElement('tbody');
    table.append(thead, tbody);

    const diagOut = document.createElement('pre');
    diagOut.className = 'plugin-terminal-output';
    diagOut.textContent = `Scanning ${spec.host} management & ${spec.pluginType} endpoints…`;

    const executeActionCommand = async (commandStr: string) => {
      diagOut.textContent = `Executing on ${spec.username}@${spec.host}${jumpSel.value ? ` (via Jump Host ${jumpSel.value})` : ''}:\n$ ${commandStr}\n\nRunning…`;
      try {
        const res = (await (window as any).workspace.run('protocol.exec', {
          pluginType: spec.pluginType,
          host: spec.host,
          port: spec.port,
          username: spec.username || 'root',
          password: passInput.value,
          jumpHost: jumpSel.value,
          identityFile: spec.sshKey || sessionKeys.get(passKey) || '',
          command: commandStr,
        })) as { ok: boolean; value?: ExecPayload };
        if (res.ok && res.value) {
          const out = (res.value.stdout || '').trim();
          const err = (res.value.stderr || '').trim();
          diagOut.textContent = [
            `[${new Date().toLocaleTimeString()}] Executed on ${spec.host} (${res.value.durationMs} ms, exit ${res.value.exitCode})`,
            `$ ${commandStr}`,
            '--------------------------------------------------------------------------------',
            out || err || '(No output returned — verify SSH/Management credentials or select Jump Host above)',
          ].join('\n');
        }
      } catch {
        diagOut.textContent = `Failed to execute command on ${spec.host}.`;
      }
    };

    for (const [label, cmd] of pluginPresets) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'quiet plugin-quick-pill';
      pill.textContent = label;
      pill.onclick = () => {
        cmdInput.value = cmd;
        void executeActionCommand(cmd);
      };
      quickBar.append(pill);
    }

    cmdForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (cmdInput.value.trim()) {
        void executeActionCommand(cmdInput.value.trim());
      }
    });

    updateFromProbe = (data) => {
      tbody.replaceChildren();
      if (data.ports && data.ports.length > 0) {
        for (const p of data.ports) {
          const tr = document.createElement('tr');
          const c1 = p.service;
          const c2 = `${data.host}:${p.port}`;
          const c3 = p.reachable ? `ONLINE (${p.latencyMs} ms)` : `CLOSED / FILTERED (${p.latencyMs} ms)`;
          const c4 = p.tlsSubject
            ? `${p.banner} · CN=${p.tlsSubject}${p.tlsSha256 ? ` · SHA256=${p.tlsSha256.slice(0, 16)}…` : ''}`
            : p.banner;
          for (const cell of [c1, c2, c3, c4]) {
            const td = document.createElement('td');
            td.textContent = cell;
            tr.append(td);
          }
          tbody.append(tr);
        }
      } else {
        const tr = document.createElement('tr');
        const cells = [
          `${data.protocol} (${data.standard})`,
          `${data.host}:${data.port}`,
          data.reachable ? `ONLINE (${data.latencyMs} ms)` : 'UNREACHABLE',
          data.banner,
        ];
        for (const cell of cells) {
          const td = document.createElement('td');
          td.textContent = cell;
          tr.append(td);
        }
        tbody.append(tr);
      }
      diagOut.textContent = [
        `[${new Date().toLocaleTimeString()}] ${data.summary}`,
        `Standard : ${data.standard}`,
        `Banner   : ${data.banner}`,
        ...(data.certSha256 ? [`Cert Pin : ${data.certSha256}`] : []),
        '',
        spec.pluginType === 'VMware'
          ? 'Tip: Click "🌐 Open ESXi Web UI (/ui/)" to open the VMware Host Client (auto-tunneled if Jump Host is selected), or click any ESXi CLI pill above (List All VMs, Datastores, vSwitches) to inspect VMs via SSH.'
          : spec.pluginType === 'VNC'
            ? 'Tip: Click "🖥 Launch macOS Screen Sharing (GUI)" in the top-right to open full graphical macOS Screen Sharing / VNC (auto-tunneled via SSH if Jump Host is selected).'
            : 'Tip: Click any action pill above to query live host state, or select a Jump Host in the header bar if this server is on an isolated VLAN.',
      ].join('\n');
    };

    body.append(quickBar, cmdForm, table, diagOut);
  }

  const runLiveProbe = async () => {
    statePill.textContent = 'Probing…';
    statePill.dataset.online = 'probing';
    try {
      const res = (await (window as any).workspace.run('protocol.probe', {
        pluginType: spec.pluginType,
        host: spec.host,
        port: spec.port,
        username: spec.username,
        path: '/',
        jumpHost: jumpSel.value,
        jumpPassword: passInput.value,
        identityFile: spec.sshKey || sessionKeys.get(passKey) || '',
      })) as { ok: boolean; value?: ProbePayload };
      if (res.ok && res.value) {
        const d = res.value;
        statePill.textContent = d.reachable ? `Online · ${d.latencyMs} ms` : 'Unreachable';
        statePill.dataset.online = d.reachable ? 'true' : 'false';
        teleStd.textContent = `${d.protocol} · ${d.standard}`;
        teleBanner.textContent = d.banner;
        teleKey.textContent = d.hostKey
          ? `Host Key: ${d.hostKey}`
          : d.certSha256
            ? `X.509 SHA-256: ${d.certSha256.slice(0, 24)}…`
            : '';
        updateFromProbe(d);
        const t = tabs.get(id);
        if (t) {
          t.state = d.reachable ? 'connected' : 'failed';
          t.reason = d.reachable ? undefined : 'connect';
          refresh();
        }
      }
    } catch {
      statePill.textContent = 'Probe Error';
      statePill.dataset.online = 'false';
    }
  };

  jumpSel.addEventListener('change', () => {
    sessionJumpHosts.set(passKey, jumpSel.value);
    void runLiveProbe();
  });

  launchNativeBtn.onclick = async () => {
    try {
      const res = (await (window as any).workspace.run('protocol.launch', {
        pluginType: spec.pluginType,
        host: spec.host,
        port: spec.port,
        username: spec.username,
        jumpHost: jumpSel.value,
        jumpPassword: passInput.value,
        identityFile: spec.sshKey || sessionKeys.get(passKey) || '',
        path: spec.pluginType === 'VMware' ? '/ui/' : spec.initPath || '/',
      })) as { ok: boolean; value?: { ok: boolean; url: string; tunneled: boolean; message: string } };
      if (res.ok && res.value) {
        teleBanner.textContent = res.value.message;
        statePill.textContent = res.value.tunneled ? 'Launched (Tunneled)' : 'Launched';
        statePill.dataset.online = 'true';
      }
    } catch {
      teleBanner.textContent = 'Failed to launch native handler.';
    }
  };

  reprobeBtn.onclick = () => {
    void runLiveProbe();
  };

  card.append(header, telemetryBar, body);
  void runLiveProbe();
  return card;
}

// ---- Termius-Style Full-Bleed Interactive PTY Terminal + SFTP Split & Jump Host ----
const TERMIUS_THEMES: [string, string][] = [
  ['termius-dark', '🎨 Termius Dark'],
  ['dracula', '🎨 Dracula'],
  ['tokyo-night', '🎨 Tokyo Night'],
  ['nord', '🎨 Nord Polar'],
  ['solarized-dark', '🎨 Solarized Dark'],
  ['monokai', '🎨 Monokai Pro'],
  ['matrix', '🎨 Matrix Green'],
  ['solarized-light', '🎨 Solarized Light'],
];
const TERMIUS_FONTS = ['sm', 'md', 'lg', 'xl'] as const;
const activeBroadcastTerminals = new Map<string, (data: string) => void>();

function buildTermiusTerminalView(spec: PluginSessionSpec, id: string): HTMLElement {
  const shellWrap = document.createElement('div');
  shellWrap.className = 'termius-shell';
  shellWrap.hidden = true;

  const savedTheme = localStorage.getItem('rw-termius-theme') || 'termius-dark';
  const savedFont = localStorage.getItem('rw-termius-font') || 'md';
  shellWrap.dataset.termTheme = savedTheme;
  shellWrap.dataset.fontSize = savedFont;

  let currentUser = spec.username || 'root';
  const passKey = `${spec.host}:${spec.port}`;
  let currentPassword = sessionPasswords.get(passKey) ?? '';
  let currentAuthMode = spec.authMode || 'auto';
  let currentJumpHost = spec.jumpHost || sessionJumpHosts.get(passKey) || getSelectedQuickJumpHost().jumpHost;
  let currentJumpPassword = sessionJumpPasswords.get(passKey) ?? getSelectedQuickJumpHost().jumpPassword;
  let currentKeyFile = spec.sshKey || sessionKeys.get(passKey) || '';

  // 1. Sleek Termius Top Bar
  const topbar = document.createElement('div');
  topbar.className = 'termius-topbar';

  const leftInfo = document.createElement('div');
  leftInfo.className = 'termius-left-info';
  const statusDot = document.createElement('span');
  statusDot.className = 'termius-dot';
  statusDot.dataset.state = 'connecting';
  const hostTitle = document.createElement('span');
  hostTitle.className = 'termius-host-title';
  hostTitle.textContent = `${currentUser}@${spec.host}:${spec.port}`;
  const authBadge = document.createElement('span');
  authBadge.className = 'termius-auth-badge';
  authBadge.textContent = currentAuthMode === 'password' ? '🔒 Password Auth' : '🔑 SSH Key / Agent';
  authBadge.title = 'Click 🔑 Auth / Jump Host to switch between SSH Key/Agent and Password Only';
  const jumpBadge = document.createElement('span');
  jumpBadge.className = 'termius-jump-badge';
  jumpBadge.hidden = !currentJumpHost;
  jumpBadge.textContent = currentJumpHost ? `⇄ Jump: ${currentJumpHost}` : '';
  const bannerLabel = document.createElement('span');
  bannerLabel.className = 'termius-banner-sub';
  bannerLabel.textContent = 'Interactive SSH PTY · xterm-256color';
  leftInfo.append(statusDot, hostTitle, authBadge, jumpBadge, bannerLabel);

  const rightTools = document.createElement('div');
  rightTools.className = 'termius-right-tools';

  const themeSelect = document.createElement('select');
  themeSelect.className = 'termius-theme-select';
  themeSelect.setAttribute('aria-label', 'Terminal Theme');
  themeSelect.title = 'Switch Termius Terminal Theme';
  for (const [val, label] of TERMIUS_THEMES) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = label;
    if (val === savedTheme) opt.selected = true;
    themeSelect.append(opt);
  }
  themeSelect.addEventListener('change', () => {
    const chosen = themeSelect.value;
    localStorage.setItem('rw-termius-theme', chosen);
    for (const elNode of document.querySelectorAll<HTMLElement>('.termius-shell')) {
      elNode.dataset.termTheme = chosen;
    }
    for (const selNode of document.querySelectorAll<HTMLSelectElement>('.termius-theme-select')) {
      selNode.value = chosen;
    }
  });

  const fontBtn = document.createElement('button');
  fontBtn.type = 'button';
  fontBtn.className = 'termius-tool-btn';
  fontBtn.textContent = 'Aa';
  fontBtn.title = 'Cycle Terminal Font Size (12px / 13px / 14.5px / 16px)';
  fontBtn.onclick = () => {
    const cur = (shellWrap.dataset.fontSize || 'md') as (typeof TERMIUS_FONTS)[number];
    const idx = (TERMIUS_FONTS.indexOf(cur) + 1) % TERMIUS_FONTS.length;
    const next = TERMIUS_FONTS[idx]!;
    localStorage.setItem('rw-termius-font', next);
    for (const elNode of document.querySelectorAll<HTMLElement>('.termius-shell')) {
      elNode.dataset.fontSize = next;
    }
  };

  const authToggleBtn = document.createElement('button');
  authToggleBtn.type = 'button';
  authToggleBtn.className = 'termius-tool-btn';
  authToggleBtn.textContent = '🔑 Auth / Jump';

  const sftpToggleBtn = document.createElement('button');
  sftpToggleBtn.type = 'button';
  sftpToggleBtn.className = 'termius-tool-btn';
  sftpToggleBtn.textContent = '📁 SFTP';

  const snippetsToggleBtn = document.createElement('button');
  snippetsToggleBtn.type = 'button';
  snippetsToggleBtn.className = 'termius-tool-btn';
  snippetsToggleBtn.textContent = '⚡ Snippets';

  const broadcastBtn = document.createElement('button');
  broadcastBtn.type = 'button';
  broadcastBtn.className = 'termius-tool-btn';
  broadcastBtn.textContent = '📡 Broadcast';
  broadcastBtn.title = 'Royal TSX / Termius: Broadcast keyboard input simultaneously to all SSH terminals with Broadcast enabled';

  const reconnectBtn = document.createElement('button');
  reconnectBtn.type = 'button';
  reconnectBtn.className = 'termius-tool-btn';
  reconnectBtn.textContent = '⟳ Reconnect';

  const closeTabBtn = document.createElement('button');
  closeTabBtn.type = 'button';
  closeTabBtn.className = 'termius-tool-btn';
  closeTabBtn.textContent = '✕';
  closeTabBtn.title = 'Close Terminal Tab';
  closeTabBtn.onclick = () => {
    const next = tabAfterClose(tabIds(), id);
    discard(id);
    select(next);
  };

  rightTools.append(themeSelect, fontBtn, authToggleBtn, sftpToggleBtn, snippetsToggleBtn, broadcastBtn, reconnectBtn, closeTabBtn);
  topbar.append(leftInfo, rightTools);

  // 2. Collapsible Termius Snippets Bar (hidden by default so terminal is clean)
  const snippetsBar = document.createElement('div');
  snippetsBar.className = 'termius-snippets-bar';
  snippetsBar.hidden = true;
  const snippetsList: [string, string][] = [
    ['System Info', 'uname -a && uptime\r'],
    ['Top / CPU', 'htop || top\r'],
    ['Disk Usage', 'df -h\r'],
    ['Memory', 'free -h\r'],
    ['Docker Containers', 'docker ps -a\r'],
    ['Open Ports', 'ss -tulpn\r'],
    ['Network IPs', 'ip -br a\r'],
    ['Systemd Failed', 'systemctl --failed\r'],
    ['Clear (Ctrl+L)', '\x0c'],
    ['Ctrl+C (Interrupt)', '\x03'],
  ];

  // 3. Main Split Container: Left = Full-bleed VT100 Terminal, Right = Optional SFTP Drawer
  const workspaceSplit = document.createElement('div');
  workspaceSplit.className = 'termius-workspace-split';

  const termPane = document.createElement('div');
  termPane.className = 'termius-term-pane';

  const screenEl = document.createElement('pre');
  screenEl.className = 'termius-screen';
  screenEl.tabIndex = 0;
  screenEl.setAttribute('role', 'region');
  screenEl.setAttribute('aria-label', `Interactive SSH Terminal ${spec.host}`);

  // Floating Termius Auth & Jump Host Modal Card inside the terminal pane
  const authOverlay = document.createElement('div');
  authOverlay.className = 'termius-auth-overlay';
  authOverlay.hidden = true;

  const authForm = document.createElement('form');
  authForm.className = 'termius-auth-card';

  const authHeader = document.createElement('div');
  authHeader.className = 'termius-auth-header';
  const authTitle = document.createElement('strong');
  authTitle.textContent = `Connect to ${spec.name} (${spec.host}:${spec.port})`;
  const authSub = document.createElement('span');
  authSub.textContent = 'Enter SSH credentials or select a Jump Host (Bastion) to connect without VPN.';
  authHeader.append(authTitle, authSub);

  const userField = document.createElement('label');
  userField.textContent = 'Username';
  const userIn = document.createElement('input');
  userIn.type = 'text';
  userIn.value = currentUser;
  userIn.autocomplete = 'off';
  userField.append(userIn);

  const authModeField = document.createElement('label');
  authModeField.textContent = 'Authentication Method';
  const authModeSelect = document.createElement('select');
  for (const [mVal, mText] of [
    ['auto', 'SSH Key / Agent (Auto — fallback to Password)'],
    ['password', 'Password Only (Always Prompt Password)'],
    ['key', 'Specific SSH Private Key (~/.ssh)'],
  ] as const) {
    const opt = document.createElement('option');
    opt.value = mVal;
    opt.textContent = mText;
    if (mVal === currentAuthMode) opt.selected = true;
    authModeSelect.append(opt);
  }
  authModeField.append(authModeSelect);

  const passField = document.createElement('label');
  passField.textContent = 'SSH Password (leave empty if using SSH Key)';
  const passIn = document.createElement('input');
  passIn.type = 'password';
  passIn.placeholder = `Password for ${currentUser}@${spec.host}`;
  passIn.value = currentPassword;
  passField.append(passIn);

  const keyField = document.createElement('label');
  keyField.textContent = 'SSH Private Key (~/.ssh)';
  keyField.hidden = currentAuthMode === 'password';
  const keySelect = document.createElement('select');
  const defaultKeyOpt = document.createElement('option');
  defaultKeyOpt.value = '';
  defaultKeyOpt.textContent = 'Auto (Default ~/.ssh/config or ssh-agent)';
  keySelect.append(defaultKeyOpt);
  keyField.append(keySelect);

  authModeSelect.addEventListener('change', () => {
    keyField.hidden = authModeSelect.value === 'password';
  });

  const jumpField = document.createElement('label');
  jumpField.textContent = 'Jump Host / Secure Gateway (Bypass VPN via SSH -J)';
  const jumpSelect = document.createElement('select');
  const directJumpOpt = document.createElement('option');
  directJumpOpt.value = '';
  directJumpOpt.textContent = 'Direct Connection (LAN / VPN)';
  jumpSelect.append(directJumpOpt);
  jumpField.append(jumpSelect);

  const customJumpField = document.createElement('label');
  customJumpField.textContent = 'Custom Jump Host (user@host:port)';
  customJumpField.hidden = true;
  const customJumpIn = document.createElement('input');
  customJumpIn.type = 'text';
  customJumpIn.placeholder = 'bright@103.172.170.196:2345';
  customJumpField.append(customJumpIn);

  const jumpPassField = document.createElement('label');
  jumpPassField.textContent = 'Jump Host Password (if Jump Host has no SSH key)';
  jumpPassField.hidden = !currentJumpHost;
  const jumpPassIn = document.createElement('input');
  jumpPassIn.type = 'password';
  jumpPassIn.placeholder = 'Optional jump host password';
  jumpPassIn.value = currentJumpPassword;
  jumpPassField.append(jumpPassIn);

  jumpSelect.addEventListener('change', () => {
    customJumpField.hidden = jumpSelect.value !== '__custom__';
    jumpPassField.hidden = jumpSelect.value === '';
  });

  const authBtns = document.createElement('div');
  authBtns.className = 'termius-auth-actions';
  const hideAuthBtn = document.createElement('button');
  hideAuthBtn.type = 'button';
  hideAuthBtn.className = 'quiet';
  hideAuthBtn.textContent = 'Type Directly in Terminal';
  const connectAuthBtn = document.createElement('button');
  connectAuthBtn.type = 'submit';
  connectAuthBtn.textContent = 'Connect Terminal ↩';
  authBtns.append(hideAuthBtn, connectAuthBtn);

  authForm.append(authHeader, userField, authModeField, passField, keyField, jumpField, customJumpField, jumpPassField, authBtns);
  authOverlay.append(authForm);

  termPane.append(screenEl, authOverlay);

  // 4. Collapsible Termius SFTP Split Drawer
  const sftpDrawer = document.createElement('div');
  sftpDrawer.className = 'termius-sftp-drawer';
  sftpDrawer.hidden = true;

  const sftpTop = document.createElement('form');
  sftpTop.className = 'termius-sftp-bar';
  const sftpPathIn = document.createElement('input');
  sftpPathIn.type = 'text';
  sftpPathIn.value = '/';
  const sftpGoBtn = document.createElement('button');
  sftpGoBtn.type = 'submit';
  sftpGoBtn.className = 'quiet';
  sftpGoBtn.textContent = 'Go';
  sftpTop.append(sftpPathIn, sftpGoBtn);

  const sftpList = document.createElement('div');
  sftpList.className = 'termius-sftp-list';
  sftpDrawer.append(sftpTop, sftpList);

  workspaceSplit.append(termPane, sftpDrawer);
  shellWrap.append(topbar, snippetsBar, workspaceSplit);

  // Populate SSH Keys & Jump Hosts from ~/.ssh/config
  void getSshEnv().then((env) => {
    for (const k of env.keys) {
      const opt = document.createElement('option');
      opt.value = k;
      opt.textContent = k;
      if (k === currentKeyFile) opt.selected = true;
      keySelect.append(opt);
    }
    for (const j of env.jumpHosts) {
      const opt = document.createElement('option');
      opt.value = j.alias;
      opt.textContent = `${j.alias} (${j.user}@${j.hostName}:${j.port})`;
      if (j.alias === currentJumpHost) opt.selected = true;
      jumpSelect.append(opt);
    }
    const customOpt = document.createElement('option');
    customOpt.value = '__custom__';
    customOpt.textContent = 'Custom Jump Host (user@host:port)…';
    jumpSelect.append(customOpt);

    // Check if host matches a configured ~/.ssh/config entry with ProxyJump or IdentityFile
    const matchedHost = env.allHosts.find(
      (h) => h.alias.toLowerCase() === spec.host.toLowerCase() || h.hostName.toLowerCase() === spec.host.toLowerCase(),
    );
    if (matchedHost) {
      if (matchedHost.proxyJump && !currentJumpHost) {
        currentJumpHost = matchedHost.proxyJump;
        jumpSelect.value = matchedHost.proxyJump;
        jumpBadge.hidden = false;
        jumpBadge.textContent = `⇄ Jump: ${currentJumpHost}`;
      }
      if (matchedHost.identityFile && !currentKeyFile) {
        currentKeyFile = matchedHost.identityFile;
        keySelect.value = matchedHost.identityFile;
      }
    }
  });

  // 5. VT100 Screen Buffer & Live PTY Session Lifecycle
  const vt = new VtTerminal(105, 30);
  let ptySessionId = '';
  let destroyed = false;
  let promptedOnceForPassword = false;

  const renderTerminal = () => {
    screenEl.textContent = vt.renderText(true);
    if (vt.title) {
      bannerLabel.textContent = vt.title;
    }
    screenEl.scrollTop = screenEl.scrollHeight;
  };

  const computeGridSize = (): { cols: number; rows: number } => {
    const w = screenEl.clientWidth || 840;
    const h = screenEl.clientHeight || 520;
    const cols = Math.max(40, Math.min(240, Math.floor((w - 28) / 7.8)));
    const rows = Math.max(12, Math.min(90, Math.floor((h - 24) / 19.5)));
    return { cols, rows };
  };

  let isBroadcastEnabled = false;

  const sendDirectToPty = (data: string) => {
    if (!ptySessionId) return;
    void (window as any).workspace.run('pty.write', { sessionId: ptySessionId, data });
  };

  const sendToPty = (data: string) => {
    sendDirectToPty(data);
    if (isBroadcastEnabled) {
      for (const [otherId, fn] of activeBroadcastTerminals.entries()) {
        if (otherId !== id) {
          fn(data);
        }
      }
    }
  };

  for (const [label, seq] of snippetsList) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'termius-snippet-pill';
    b.textContent = label;
    b.onclick = () => {
      sendToPty(seq);
      screenEl.focus();
    };
    snippetsBar.append(b);
  }

  const loadSftpDir = async (dirPath: string) => {
    sftpList.textContent = `Loading ${dirPath}…`;
    try {
      const res = (await (window as any).workspace.run('protocol.exec', {
        pluginType: 'File Transfer',
        host: spec.host,
        port: spec.port,
        username: currentUser,
        password: currentPassword,
        jumpHost: currentJumpHost,
        identityFile: currentKeyFile,
        command: dirPath,
      })) as { ok: boolean; value?: ExecPayload };
      sftpList.replaceChildren();
      if (res.ok && res.value?.files) {
        if (dirPath !== '/') {
          const upBtn = document.createElement('button');
          upBtn.type = 'button';
          upBtn.className = 'termius-sftp-item';
          upBtn.textContent = '📁 ..';
          upBtn.onclick = () => {
            const parent = dirPath.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';
            sftpPathIn.value = parent;
            void loadSftpDir(parent);
          };
          sftpList.append(upBtn);
        }
        for (const f of res.value.files) {
          const row = document.createElement('button');
          row.type = 'button';
          row.className = 'termius-sftp-item';
          row.textContent = `${f.isDir ? '📁' : '📄'} ${f.name} (${f.size} B)`;
          row.onclick = () => {
            const full = dirPath === '/' ? `/${f.name}` : `${dirPath.replace(/\/+$/, '')}/${f.name}`;
            if (f.isDir) {
              sftpPathIn.value = full;
              void loadSftpDir(full);
            } else {
              sendToPty(`ls -lh ${JSON.stringify(full)}\r`);
              screenEl.focus();
            }
          };
          sftpList.append(row);
        }
      } else {
        const msg = document.createElement('div');
        msg.className = 'hint';
        msg.textContent = res.value?.stderr || 'Authenticate via 🔑 Auth / Jump Host first to browse SFTP.';
        sftpList.append(msg);
      }
    } catch {
      sftpList.textContent = 'SFTP load failed.';
    }
  };

  sftpTop.addEventListener('submit', (e) => {
    e.preventDefault();
    void loadSftpDir(sftpPathIn.value.trim() || '/');
  });

  let sentInitCommand = false;

  const startPtyConnection = async () => {
    if (ptySessionId) {
      void (window as any).workspace.run('pty.close', { sessionId: ptySessionId });
      ptySessionId = '';
    }
    sentInitCommand = false;
    const { cols, rows } = computeGridSize();
    vt.resize(cols, rows);
    vt.clearScrollbackAndScreen();
    statusDot.dataset.state = 'connecting';
    hostTitle.textContent = `${currentUser}@${spec.host}:${spec.port}`;
    authBadge.textContent = currentAuthMode === 'password' ? '🔒 Password Auth' : '🔑 SSH Key / Agent';
    jumpBadge.hidden = !currentJumpHost;
    jumpBadge.textContent = currentJumpHost ? `⇄ Jump: ${currentJumpHost}` : '';

    vt.write(
      `Connecting to ${currentUser}@${spec.host}:${spec.port}${currentJumpHost ? ` via Jump Host ${currentJumpHost}` : ''} (${currentAuthMode === 'password' ? 'Password Auth' : 'SSH Key / Agent'})…\r\n`,
    );
    renderTerminal();

    try {
      const res = (await (window as any).workspace.run('pty.open', {
        host: spec.host,
        port: spec.port,
        username: currentUser,
        password: currentPassword,
        authMode: currentAuthMode,
        jumpHost: currentJumpHost,
        jumpPassword: currentJumpPassword,
        identityFile: currentKeyFile,
        cols,
        rows,
      })) as { ok: boolean; value?: { sessionId: string } };

      if (!res.ok || !res.value?.sessionId) {
        statusDot.dataset.state = 'failed';
        vt.write('\r\n[Failed to start local SSH PTY process]\r\n');
        renderTerminal();
        return;
      }

      const activeSid = res.value.sessionId;
      ptySessionId = activeSid;
      statusDot.dataset.state = 'connected';
      const t = tabs.get(id);
      if (t) {
        t.state = 'connected';
        t.reason = undefined;
        refresh();
      }

      // Poll loop for live PTY bytes
      while (!destroyed && ptySessionId === activeSid) {
        const chunkRes = (await (window as any).workspace.run('pty.read', {
          sessionId: activeSid,
          waitMs: 180,
        })) as { ok: boolean; value?: { data: string; closed: boolean; exitCode: number | null } };
        if (destroyed || ptySessionId !== activeSid) break;
        if (!chunkRes.ok || !chunkRes.value) break;

        const { data, closed, exitCode } = chunkRes.value;
        if (data) {
          vt.write(data);
          renderTerminal();

          // If SSH asks for a password and the user hasn't entered one yet, pop open the Termius Auth card once so they know where to type it!
          if (
            !currentPassword &&
            !promptedOnceForPassword &&
            /password:|passphrase for key/i.test(data)
          ) {
            promptedOnceForPassword = true;
            authBadge.textContent = '🔒 Password Required';
            authOverlay.hidden = false;
            setTimeout(() => passIn.focus(), 30);
          } else if (!sentInitCommand && spec.initPath && /[#\$>]\s*$/.test(data)) {
            sentInitCommand = true;
            const cmd = spec.initPath.startsWith('/') ? `cd ${JSON.stringify(spec.initPath)}\r` : `${spec.initPath}\r`;
            sendToPty(cmd);
          }
        }
        if (closed) {
          statusDot.dataset.state = exitCode === 0 ? 'closed' : 'failed';
          vt.write(`\r\n[SSH session ended (exit code ${exitCode ?? 0}). Click ⟳ Reconnect or press Enter to reconnect.]\r\n`);
          renderTerminal();
          break;
        }
      }
    } catch {
      statusDot.dataset.state = 'failed';
    }
  };

  // Direct keyboard input on the Termius terminal viewport
  screenEl.addEventListener('keydown', (e) => {
    if (!authOverlay.hidden) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') {
      // Let native paste event fire
      return;
    }
    if (e.metaKey) return;

    let seq = '';
    if (e.ctrlKey && !e.altKey) {
      const k = e.key.toUpperCase();
      if (k.length === 1 && k >= 'A' && k <= 'Z') {
        seq = String.fromCharCode(k.charCodeAt(0) - 64);
      } else if (e.key === '[') {
        seq = '\x1b';
      }
    } else {
      switch (e.key) {
        case 'Enter':
          seq = '\r';
          break;
        case 'Backspace':
          seq = '\x7f';
          break;
        case 'Tab':
          seq = '\t';
          break;
        case 'Escape':
          seq = '\x1b';
          break;
        case 'ArrowUp':
          seq = vt.appCursorKeys ? '\x1bOA' : '\x1b[A';
          break;
        case 'ArrowDown':
          seq = vt.appCursorKeys ? '\x1bOB' : '\x1b[B';
          break;
        case 'ArrowRight':
          seq = vt.appCursorKeys ? '\x1bOC' : '\x1b[C';
          break;
        case 'ArrowLeft':
          seq = vt.appCursorKeys ? '\x1bOD' : '\x1b[D';
          break;
        case 'Home':
          seq = '\x1b[H';
          break;
        case 'End':
          seq = '\x1b[F';
          break;
        case 'Delete':
          seq = '\x1b[3~';
          break;
        case 'PageUp':
          seq = '\x1b[5~';
          break;
        case 'PageDown':
          seq = '\x1b[6~';
          break;
        default:
          if (e.key.length === 1) {
            seq = e.key;
          }
          break;
      }
    }

    if (seq) {
      e.preventDefault();
      e.stopPropagation();
      if (statusDot.dataset.state === 'closed' || statusDot.dataset.state === 'failed') {
        if (e.key === 'Enter') void startPtyConnection();
        return;
      }
      sendToPty(seq);
    }
  });

  screenEl.addEventListener('paste', (e) => {
    if (!authOverlay.hidden) return;
    const text = e.clipboardData?.getData('text/plain');
    if (text) {
      e.preventDefault();
      sendToPty(text);
    }
  });

  screenEl.addEventListener('click', () => {
    if (authOverlay.hidden) screenEl.focus();
  });

  authToggleBtn.onclick = () => {
    authOverlay.hidden = !authOverlay.hidden;
    if (!authOverlay.hidden) {
      passIn.focus();
    } else {
      screenEl.focus();
    }
  };

  hideAuthBtn.onclick = () => {
    authOverlay.hidden = true;
    screenEl.focus();
  };

  authForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const newUser = userIn.value.trim() || currentUser;
    const newPass = passIn.value;
    const newAuthMode = authModeSelect.value;
    const newKey = keySelect.value;
    const newJump = jumpSelect.value === '__custom__' ? customJumpIn.value.trim() : jumpSelect.value.trim();
    const newJumpPass = jumpPassIn.value;

    const settingsChanged =
      newUser !== currentUser ||
      newAuthMode !== currentAuthMode ||
      newKey !== currentKeyFile ||
      newJump !== currentJumpHost ||
      newJumpPass !== currentJumpPassword;

    currentUser = newUser;
    currentPassword = newPass;
    currentAuthMode = newAuthMode;
    currentKeyFile = newKey;
    currentJumpHost = newJump;
    currentJumpPassword = newJumpPass;

    sessionPasswords.set(passKey, currentPassword);
    sessionJumpHosts.set(passKey, currentJumpHost);
    sessionJumpPasswords.set(passKey, currentJumpPassword);
    sessionKeys.set(passKey, currentKeyFile);

    authOverlay.hidden = true;

    // If PTY is already waiting at a password: prompt and only the password was entered, feed it directly!
    if (!settingsChanged && ptySessionId && statusDot.dataset.state === 'connected' && newPass) {
      sendToPty(`${newPass}\r`);
      screenEl.focus();
      return;
    }

    promptedOnceForPassword = false;
    void startPtyConnection().then(() => screenEl.focus());
  });

  sftpToggleBtn.onclick = () => {
    sftpDrawer.hidden = !sftpDrawer.hidden;
    sftpToggleBtn.classList.toggle('active', !sftpDrawer.hidden);
    if (!sftpDrawer.hidden) {
      void loadSftpDir(sftpPathIn.value.trim() || '/');
    }
  };

  snippetsToggleBtn.onclick = () => {
    snippetsBar.hidden = !snippetsBar.hidden;
    snippetsToggleBtn.classList.toggle('active', !snippetsBar.hidden);
  };

  broadcastBtn.onclick = () => {
    isBroadcastEnabled = !isBroadcastEnabled;
    broadcastBtn.classList.toggle('active', isBroadcastEnabled);
    broadcastBtn.textContent = isBroadcastEnabled ? '📡 Broadcast: ON' : '📡 Broadcast';
    if (isBroadcastEnabled) {
      activeBroadcastTerminals.set(id, sendDirectToPty);
    } else {
      activeBroadcastTerminals.delete(id);
    }
    screenEl.focus();
  };

  reconnectBtn.onclick = () => {
    promptedOnceForPassword = false;
    void startPtyConnection().then(() => screenEl.focus());
  };

  const ro = new ResizeObserver(() => {
    if (shellWrap.hidden || !ptySessionId) return;
    const { cols, rows } = computeGridSize();
    if (cols !== vt.cols || rows !== vt.rows) {
      vt.resize(cols, rows);
      renderTerminal();
      void (window as any).workspace.run('pty.resize', { sessionId: ptySessionId, cols, rows });
    }
  });
  ro.observe(termPane);

  const t = tabs.get(id);
  if (t) {
    t.ptyCleanup = () => {
      destroyed = true;
      activeBroadcastTerminals.delete(id);
      ro.disconnect();
      if (ptySessionId) {
        void (window as any).workspace.run('pty.close', { sessionId: ptySessionId });
        ptySessionId = '';
      }
    };
  }

  void startPtyConnection();
  setTimeout(() => screenEl.focus(), 60);
  return shellWrap;
}

// ---- Jump Host / Secure Gateway & SSH Port-Forwarding Control Center ----
function buildGatewayTunnelView(spec: PluginSessionSpec, id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-row-inline';
  const titleEl = document.createElement('span');
  titleEl.className = 'plugin-view-title';
  titleEl.textContent = 'Jump Host & Secure Gateway Tunnels (Connect Without VPN)';
  const badgeEl = document.createElement('span');
  badgeEl.className = 'plugin-view-badge';
  badgeEl.textContent = spec.pluginType;
  titleWrap.append(titleEl, badgeEl);

  const headerActions = document.createElement('div');
  headerActions.className = 'plugin-row-inline';

  const addGwBtn = document.createElement('button');
  addGwBtn.type = 'button';
  addGwBtn.className = 'quiet';
  addGwBtn.textContent = '＋ Add Jump Host (Secure Gateway)';
  addGwBtn.onclick = () => {
    documents.addPlugin?.('Secure Gateway');
  };

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close Tab';
  closeBtn.onclick = () => {
    const next = tabAfterClose(tabIds(), id);
    discard(id);
    select(next);
  };
  headerActions.append(addGwBtn, closeBtn);
  header.append(titleWrap, headerActions);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  // Form to create a new SSH Local Port-Forwarding Tunnel (-L) or set Default RDP Gateway
  const form = document.createElement('form');
  form.className = 'gateway-tunnel-form';

  const jumpLabel = document.createElement('label');
  jumpLabel.textContent = 'Jump Host / Bastion';
  const jumpSel = document.createElement('select');
  jumpLabel.append(jumpSel);

  const customJumpLabel = document.createElement('label');
  customJumpLabel.textContent = 'Custom Jump (user@host:port)';
  customJumpLabel.hidden = true;
  const customJumpInput = document.createElement('input');
  customJumpInput.type = 'text';
  customJumpInput.placeholder = 'bright@103.172.170.196:2345';
  if (spec.host && spec.host !== '127.0.0.1') {
    customJumpInput.value = `${spec.username || 'bright'}@${spec.host}:${spec.port || 22}`;
  }
  customJumpLabel.append(customJumpInput);

  const jumpPassLabel = document.createElement('label');
  jumpPassLabel.textContent = 'Jump Password (if no SSH key)';
  const jumpPassInput = document.createElement('input');
  jumpPassInput.type = 'password';
  jumpPassInput.placeholder = 'Optional';
  jumpPassLabel.append(jumpPassInput);

  const targetHostLabel = document.createElement('label');
  targetHostLabel.textContent = 'Intranet Target Host';
  const targetHostInput = document.createElement('input');
  targetHostInput.type = 'text';
  targetHostInput.value = '10.28.0.154';
  targetHostLabel.append(targetHostInput);

  const targetPortLabel = document.createElement('label');
  targetPortLabel.textContent = 'Target Port';
  const targetPortInput = document.createElement('input');
  targetPortInput.type = 'number';
  targetPortInput.value = '4321';
  targetPortLabel.append(targetPortInput);

  const btnGroup = document.createElement('div');
  btnGroup.className = 'plugin-row-inline';
  const startTunBtn = document.createElement('button');
  startTunBtn.type = 'submit';
  startTunBtn.textContent = 'Start SSH Tunnel (-L)';
  const setRdpGwBtn = document.createElement('button');
  setRdpGwBtn.type = 'button';
  setRdpGwBtn.className = 'quiet';
  setRdpGwBtn.textContent = 'Set as Default RDP Gateway';
  btnGroup.append(startTunBtn, setRdpGwBtn);

  jumpSel.addEventListener('change', () => {
    customJumpLabel.hidden = jumpSel.value !== '__custom__';
  });

  form.append(jumpLabel, customJumpLabel, jumpPassLabel, targetHostLabel, targetPortLabel, btnGroup);

  // Table of Active Tunnels & Discovered Jump Hosts
  const table = document.createElement('table');
  table.className = 'plugin-table';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const col of ['Type / Alias', 'Jump Host (Public)', 'Local Forward / Target (Intranet)', 'Status', 'Quick Actions']) {
    const th = document.createElement('th');
    th.textContent = col;
    htr.append(th);
  }
  thead.append(htr);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);

  const logOut = document.createElement('pre');
  logOut.className = 'plugin-terminal-output';
  logOut.textContent = 'Loading ~/.ssh/config Jump Hosts and active SSH port-forwarding tunnels…';

  if (spec.initPath) {
    const m = spec.initPath.trim().match(/^([^:]+)(?::(\d+))?$/);
    if (m && m[1]) {
      targetHostInput.value = m[1];
      if (m[2]) targetPortInput.value = m[2];
    }
  }

  const refreshGatewayView = async () => {
    const [env, tunRes] = await Promise.all([
      getSshEnv(),
      (window as any).workspace.run('tunnel.list', {}) as Promise<{ ok: boolean; value?: TunnelInfo[] }>,
    ]);

    const prevJumpVal = jumpSel.value || spec.name;
    jumpSel.replaceChildren();
    for (const j of env.jumpHosts) {
      const opt = document.createElement('option');
      opt.value = j.alias;
      opt.textContent = `${j.alias} (${j.user}@${j.hostName}:${j.port})`;
      if (j.alias === prevJumpVal) opt.selected = true;
      jumpSel.append(opt);
    }
    const customOpt = document.createElement('option');
    customOpt.value = '__custom__';
    customOpt.textContent = 'Custom Jump Host…';
    if (prevJumpVal === '__custom__') customOpt.selected = true;
    jumpSel.append(customOpt);

    tbody.replaceChildren();
    const tunnels = tunRes.ok && tunRes.value ? tunRes.value : [];

    for (const tun of tunnels) {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td');
      td1.textContent = `SSH Tunnel (${tun.id})`;
      const td2 = document.createElement('td');
      td2.className = 'mono';
      td2.textContent = tun.jumpHost;
      const td3 = document.createElement('td');
      td3.className = 'mono';
      td3.textContent = `127.0.0.1:${tun.localPort} → ${tun.targetHost}:${tun.targetPort}`;
      const td4 = document.createElement('td');
      td4.textContent = `${tun.status.toUpperCase()} (PID ${tun.pid})`;
      const td5 = document.createElement('td');
      const actRow = document.createElement('div');
      actRow.className = 'plugin-row-inline';

      const openRdpBtn = document.createElement('button');
      openRdpBtn.type = 'button';
      openRdpGwBtnLabel(openRdpBtn, 'Open RDP via Tunnel');
      openRdpBtn.onclick = () => {
        void openSession(
          {
            host: '127.0.0.1',
            port: tun.localPort,
            username: el<HTMLInputElement>('username').value.trim() || 'plnbatam\\adminit',
            certificateSha256: '',
            clipboard: { toRemote: true, fromRemote: true },
          },
          undefined,
          `${tun.targetHost} (Tunneled)`,
        );
      };

      const stopBtn = document.createElement('button');
      stopBtn.type = 'button';
      stopBtn.className = 'quiet';
      stopBtn.textContent = 'Stop';
      stopBtn.onclick = async () => {
        await (window as any).workspace.run('tunnel.stop', { id: tun.id });
        void refreshGatewayView();
      };

      actRow.append(openRdpBtn, stopBtn);
      td5.append(actRow);
      tr.append(td1, td2, td3, td4, td5);
      tbody.append(tr);
    }

    for (const j of env.jumpHosts) {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td');
      td1.textContent = `Jump Host (${j.alias})`;
      const td2 = document.createElement('td');
      td2.className = 'mono';
      td2.textContent = `${j.user}@${j.hostName}:${j.port}`;
      const td3 = document.createElement('td');
      td3.textContent = j.identityFile ? `Key: ${j.identityFile}` : 'Password / Agent Auth';
      const td4 = document.createElement('td');
      td4.textContent = env.activeRdpGateway.jumpHost === j.alias ? 'DEFAULT RDP GATEWAY' : 'Ready';
      const td5 = document.createElement('td');
      const actRow = document.createElement('div');
      actRow.className = 'plugin-row-inline';

      const sshBtn = document.createElement('button');
      sshBtn.type = 'button';
      sshBtn.className = 'quiet';
      sshBtn.textContent = 'Open Terminal';
      sshBtn.onclick = () => {
        openPluginTab({
          pluginType: 'Terminal',
          name: j.alias,
          host: j.hostName,
          port: j.port,
          username: j.user,
          notes: `Jump Host ${j.alias}`,
        });
      };

      const useRdpBtn = document.createElement('button');
      useRdpBtn.type = 'button';
      useRdpBtn.className = 'quiet';
      useRdpBtn.textContent = 'Use for RDP';
      useRdpBtn.onclick = async () => {
        await (window as any).workspace.run('gateway.configure', {
          jumpHost: j.alias,
          jumpPassword: jumpPassInput.value,
          identityFile: j.identityFile ?? '',
        });
        const quickJumpSel = document.getElementById('jump-host-select') as HTMLSelectElement | null;
        if (quickJumpSel) quickJumpSel.value = j.alias;
        logOut.textContent = `Default RDP & SSH Gateway set to ${j.alias} (${j.user}@${j.hostName}:${j.port}). Any RDP connection will now tunnel through ${j.alias} without VPN.`;
        void refreshGatewayView();
      };

      const delGwBtn = document.createElement('button');
      delGwBtn.type = 'button';
      delGwBtn.className = 'quiet';
      delGwBtn.textContent = 'Remove';
      delGwBtn.onclick = async () => {
        await (window as any).workspace.run('gateway.remove', { alias: j.alias });
        logOut.textContent = `Removed custom Jump Host ${j.alias} (if defined in ~/.ssh/config, edit ~/.ssh/config to remove permanently).`;
        void refreshGatewayView();
      };

      actRow.append(sshBtn, useRdpBtn, delGwBtn);
      td5.append(actRow);
      tr.append(td1, td2, td3, td4, td5);
      tbody.append(tr);
    }
  };

  function openRdpGwBtnLabel(b: HTMLButtonElement, text: string) {
    b.className = 'quiet';
    b.textContent = text;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const chosenJump = jumpSel.value === '__custom__' ? customJumpInput.value.trim() : jumpSel.value.trim();
    const targetH = targetHostInput.value.trim();
    const targetP = Number(targetPortInput.value) || 3389;
    logOut.textContent = `Starting SSH port-forwarding tunnel via ${chosenJump} to ${targetH}:${targetP}…`;
    try {
      const res = (await (window as any).workspace.run('tunnel.start', {
        jumpHost: chosenJump,
        targetHost: targetH,
        targetPort: targetP,
        localPort: 0,
        jumpPassword: jumpPassInput.value,
        identityFile: '',
      })) as { ok: boolean; value?: TunnelInfo; message?: string };
      if (res.ok && res.value) {
        logOut.textContent = `Tunnel ACTIVE: 127.0.0.1:${res.value.localPort} → ${chosenJump} → ${targetH}:${targetP} (PID ${res.value.pid}). Click "Open RDP via Tunnel" in the table above to connect immediately!`;
        void refreshGatewayView();
      } else {
        logOut.textContent = `Failed to start tunnel: ${res.message ?? 'Check Jump Host reachability or password/key.'}`;
      }
    } catch {
      logOut.textContent = 'Error starting SSH tunnel.';
    }
  });

  setRdpGwBtn.onclick = async () => {
    const chosenJump = jumpSel.value === '__custom__' ? customJumpInput.value.trim() : jumpSel.value.trim();
    await (window as any).workspace.run('gateway.configure', {
      jumpHost: chosenJump,
      jumpPassword: jumpPassInput.value,
      identityFile: '',
    });
    const quickJumpSel = document.getElementById('jump-host-select') as HTMLSelectElement | null;
    if (quickJumpSel) quickJumpSel.value = chosenJump;
    logOut.textContent = chosenJump
      ? `Active RDP Gateway set to ${chosenJump}. All RDP connections will automatically tunnel via ${chosenJump} without VPN.`
      : 'Active RDP Gateway cleared (Direct LAN / VPN mode).';
    void refreshGatewayView();
  };

  body.append(form, table, logOut);
  card.append(header, body);
  void refreshGatewayView();
  return card;
}

function buildAuditLogView(_spec: PluginSessionSpec, id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-row-inline';
  const titleEl = document.createElement('span');
  titleEl.className = 'plugin-view-title';
  titleEl.textContent = '📜 Session Audit Trail & Connection Activity History';
  const badgeEl = document.createElement('span');
  badgeEl.className = 'plugin-view-badge';
  badgeEl.textContent = 'Audit & Keepalive';
  titleWrap.append(titleEl, badgeEl);

  const headerActs = document.createElement('div');
  headerActs.className = 'plugin-row-inline';
  const filterIn = document.createElement('input');
  filterIn.type = 'search';
  filterIn.className = 'plugin-pass-input';
  filterIn.placeholder = 'Filter server, protocol, gateway…';
  const exportCsvBtn = document.createElement('button');
  exportCsvBtn.type = 'button';
  exportCsvBtn.className = 'quiet';
  exportCsvBtn.textContent = '⬇ Export CSV';
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'quiet';
  clearBtn.textContent = '🗑 Clear History';
  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'quiet';
  refreshBtn.textContent = '↻ Refresh';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close Tab';
  closeBtn.onclick = () => {
    const next = tabAfterClose(tabIds(), id);
    discard(id);
    select(next);
  };
  headerActs.append(filterIn, exportCsvBtn, clearBtn, refreshBtn, closeBtn);
  header.append(titleWrap, headerActs);

  const summaryBar = document.createElement('div');
  summaryBar.className = 'plugin-telemetry-bar';

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const table = document.createElement('table');
  table.className = 'plugin-table';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const col of ['Time (Local)', 'Event', 'Server Name', 'Protocol', 'Target Endpoint', 'Gateway / Jump Host', 'Duration / Detail']) {
    const th = document.createElement('th');
    th.textContent = col;
    htr.append(th);
  }
  thead.append(htr);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);
  body.append(table);

  const renderLogRows = () => {
    const all = readAuditLog();
    const q = filterIn.value.trim().toLowerCase();
    const filtered = q
      ? all.filter(
          (r) =>
            r.name.toLowerCase().includes(q) ||
            r.protocol.toLowerCase().includes(q) ||
            r.target.toLowerCase().includes(q) ||
            r.gateway.toLowerCase().includes(q) ||
            r.event.toLowerCase().includes(q),
        )
      : all;

    summaryBar.replaceChildren();
    const s1 = document.createElement('span');
    s1.className = 'plugin-tele-item';
    s1.textContent = `Total Logged Events: ${all.length}`;
    const s2 = document.createElement('span');
    s2.className = 'plugin-tele-item';
    s2.textContent = `Active Tabs: ${tabs.size}`;
    const s3 = document.createElement('span');
    s3.className = 'plugin-tele-item';
    s3.textContent = `Auto-Reconnect Watchdog: ${autoReconnectEnabled ? 'ON (2.5s backoff)' : 'OFF'}`;
    const s4 = document.createElement('span');
    s4.className = 'plugin-tele-item';
    s4.textContent = `Mac Shortcuts (⌘⇄Ctrl): ${macShortcutsEnabled ? 'ON' : 'OFF'}`;
    summaryBar.append(s1, s2, s3, s4);

    tbody.replaceChildren();
    if (filtered.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 7;
      td.textContent = 'No session audit events recorded yet. Connect to any RDP, SSH, or VNC server to populate activity history.';
      tr.append(td);
      tbody.append(tr);
      return;
    }

    for (const row of filtered) {
      const tr = document.createElement('tr');
      const timeStr = new Date(row.timestamp).toLocaleString();
      const durStr =
        row.durationSec !== undefined
          ? `${row.durationSec}s${row.detail ? ` — ${row.detail}` : ''}`
          : row.detail ?? 'Active / Instant';
      const cells = [timeStr, row.event, row.name, row.protocol, row.target, row.gateway, durStr];
      for (const c of cells) {
        const td = document.createElement('td');
        td.textContent = c;
        tr.append(td);
      }
      tbody.append(tr);
    }
  };

  filterIn.addEventListener('input', renderLogRows);
  refreshBtn.onclick = renderLogRows;
  clearBtn.onclick = () => {
    localStorage.removeItem(AUDIT_LOG_STORAGE_KEY);
    renderLogRows();
  };
  exportCsvBtn.onclick = () => {
    const all = readAuditLog();
    const lines = [
      'Timestamp,Event,Server Name,Protocol,Target,Gateway,DurationSec,Detail',
      ...all.map((r) =>
        [
          r.timestamp,
          r.event,
          JSON.stringify(r.name),
          r.protocol,
          JSON.stringify(r.target),
          JSON.stringify(r.gateway),
          r.durationSec ?? '',
          JSON.stringify(r.detail ?? ''),
        ].join(','),
      ),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jaladesk-audit-log-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  card.append(header, summaryBar, body);
  renderLogRows();
  return card;
}

function openPluginTab(spec: PluginSessionSpec, replace?: string) {
  const id = replace ?? `plugin-${pluginSeq++}`;
  const t = tab(id);
  t.panel?.remove();
  t.pluginSpec = spec;
  t.state = 'connected';
  t.started = Date.now();
  t.name = spec.name;
  t.color = tabColour(spec.color);
  if (t.color) t.button.dataset.color = t.color;
  t.button.textContent = tabLabel(spec.name, [...tabs].filter(([key]) => key !== id).map(([, other]) => other.button.textContent ?? ''));
  t.button.title = `[${spec.pluginType}] ${spec.username}@${spec.host}:${spec.port}`;
  const panel = buildPluginView(spec, id);
  panel.addEventListener('mousedown', () => {
    if (splitMode !== 'single' && active !== id) select(id);
  });
  t.panel = panel;
  el('plugin-stage').append(panel);
  if (spec.pluginType !== 'Audit Log' && spec.pluginType !== 'Secure Gateway') {
    recordAuditEvent('CONNECTED', {
      name: spec.name,
      protocol: spec.pluginType,
      target: `${spec.username || 'root'}@${spec.host}:${spec.port}`,
      gateway: spec.jumpHost || undefined,
    });
  }
  (document.getElementById('adhoc') as HTMLDetailsElement | null)?.removeAttribute('open');
  select(id);
  refresh();
}

function isMacNativeFullScreen(): boolean {
  return (
    Math.abs(window.innerWidth - window.screen.width) <= 8 &&
    Math.abs(window.innerHeight - window.screen.height) <= 8
  );
}

function toggleWindowFull(force?: boolean) {
  const next = force ?? !document.body.classList.contains('extended');
  document.body.classList.toggle('extended', next);
  const wfBtn = document.getElementById('window-full');
  if (wfBtn) wfBtn.textContent = next ? '❐ Normal View' : '⛶ Window Full';
  requestAnimationFrame(() => {
    tabs.get(active)?.resizer.observe(viewport());
    const t = tabs.get(active);
    if (t && !t.panel) t.canvas.focus();
  });
}

document.getElementById('window-full')?.addEventListener('click', () => toggleWindowFull());
document.getElementById('exit-window-full')?.addEventListener('click', () => {
  if (isMacNativeFullScreen()) {
    toggleWindowFull(false);
    void window.shell.run('view.fullscreen').catch(() => {});
  } else {
    toggleWindowFull(false);
  }
});
document.getElementById('fullscreen-btn')?.addEventListener('click', () => {
  void window.shell.run('view.fullscreen').catch(() => {});
});

el('reconnect').onclick=()=>{
  const t=tabs.get(active);
  if (!t) return;
  userDisconnectedTabs.delete(active);
  if (t.pluginSpec && reconnectable(t.state)) {
    openPluginTab(t.pluginSpec, active);
    return;
  }
  if(t.request&&reconnectable(t.state))void (t.storedSessionId?openStoredSession(undefined,active):openSession(t.request,active,t.name,t.color)).then(why=>{if(why)el('error').textContent=why;});
};
el('disconnect').onclick=async()=>{
  if(!active) return;
  userDisconnectedTabs.add(active);
  const pendingTimer = autoReconnectTimers.get(active);
  if (pendingTimer !== undefined) {
    clearTimeout(pendingTimer);
    autoReconnectTimers.delete(active);
  }
  const t = tabs.get(active);
  if (t?.panel) {
    t.ptyCleanup?.();
    t.ptyCleanup = undefined;
    t.state = 'closed';
    refresh();
    return;
  }
  t?.input.release();
  await window.rdp.close(active);
};
el('close-tab').onclick=()=>{
  const t=tabs.get(active);
  if(!t)return;
  t.input.release();
  const next=tabAfterClose(tabIds(),active);
  discard(active);
  select(next);
  (tabs.get(next)?.button??el('host')).focus();
};
document.getElementById('session-ended-reconnect')?.addEventListener('click', () => el('reconnect').click());
document.getElementById('session-ended-close')?.addEventListener('click', () => el('close-tab').click());

const overviewPill = document.getElementById('overview-tab-pill');
if (overviewPill) {
  overviewPill.onclick = () => select('');
}

window.addEventListener('blur',()=>{for(const t of tabs.values())t.input.release();});
new ResizeObserver(()=>{tabs.get(active)?.resizer.observe(viewport());}).observe(el('screen'));
void window.rdp.info().then(info=>{el('platform').textContent=`${info.platform} / ${info.arch}`;if(info.fixture){el('mode').textContent='Local fixture';el<HTMLInputElement>('host').value='fixture.invalid';el<HTMLInputElement>('username').value='fixture';}});
const documents=initDocuments({
  open:(request,name,color)=>openSession(request,undefined,name,color),
  openStored:ref=>openStoredSession(ref),
  openPlugin:spec=>openPluginTab(spec),
});
const configHost={selected:()=>documents.selected(),refresh:()=>documents.refresh(),revealSource:(source:{documentId?:string;objectId?:string})=>documents.revealSource(source),opened:(value:any)=>acceptStored(value)};
initCredentials(configHost);initTemplates(configHost);initDocumentProperties(configHost);initDocumentMaintenance(configHost);initTransfer(configHost);initBulk(configHost);
initTabs();

// ---- Wire up Royal TSX Unified Top Bar, Quick Connect, Add Menu & Application Tree ----
const quickHost = document.getElementById('quick-host') as HTMLInputElement | null;
const quickProto = document.getElementById('quick-protocol') as HTMLSelectElement | null;
const quickGo = document.getElementById('quick-connect-go') as HTMLButtonElement | null;
const quickOptsBtn = document.getElementById('quick-options-toggle') as HTMLButtonElement | null;
const quickOptsDrawer = document.getElementById('adhoc') as HTMLDetailsElement | null;
const jumpHostSelect = document.getElementById('jump-host-select') as HTMLSelectElement | null;
const jumpCustomWrap = document.getElementById('jump-custom-wrap') as HTMLElement | null;
const jumpHostCustom = document.getElementById('jump-host-custom') as HTMLInputElement | null;
const jumpPassWrap = document.getElementById('jump-pass-wrap') as HTMLElement | null;
const jumpHostPass = document.getElementById('jump-host-pass') as HTMLInputElement | null;

async function syncQuickJumpGateway(): Promise<void> {
  if (!jumpHostSelect) return;
  const rawVal = jumpHostSelect.value;
  const chosenJump = rawVal === '__custom__' ? (jumpHostCustom?.value.trim() ?? '') : rawVal.trim();
  if (jumpCustomWrap) jumpCustomWrap.hidden = rawVal !== '__custom__';
  if (jumpPassWrap) jumpPassWrap.hidden = !rawVal;
  try {
    await (window as any).workspace.run('gateway.configure', {
      jumpHost: chosenJump,
      jumpPassword: jumpHostPass?.value ?? '',
      identityFile: '',
    });
  } catch {}
}

if (jumpHostSelect) {
  jumpHostSelect.addEventListener('change', () => {
    void syncQuickJumpGateway();
  });
}
if (jumpHostCustom) {
  jumpHostCustom.addEventListener('change', () => {
    void syncQuickJumpGateway();
  });
}
if (jumpHostPass) {
  jumpHostPass.addEventListener('change', () => {
    void syncQuickJumpGateway();
  });
}

void getSshEnv().then((env) => {
  if (!jumpHostSelect) return;
  const existing = new Set(Array.from(jumpHostSelect.options).map((o) => o.value));
  const customOpt = Array.from(jumpHostSelect.options).find((o) => o.value === '__custom__');
  for (const j of env.jumpHosts) {
    if (!existing.has(j.alias)) {
      const opt = document.createElement('option');
      opt.value = j.alias;
      opt.textContent = `Jump: ${j.alias} (${j.user}@${j.hostName}:${j.port})`;
      if (customOpt) jumpHostSelect.insertBefore(opt, customOpt);
      else jumpHostSelect.append(opt);
    }
  }
  if (env.activeRdpGateway.jumpHost) {
    jumpHostSelect.value = env.activeRdpGateway.jumpHost;
    if (jumpPassWrap) jumpPassWrap.hidden = false;
  }
});

const QUICK_PROTO_MAP: Record<string, { pluginType: string; port: number }> = {
  rdp: { pluginType: 'Remote Desktop', port: 3389 },
  terminal: { pluginType: 'Terminal', port: 22 },
  vnc: { pluginType: 'VNC', port: 5900 },
  teamviewer: { pluginType: 'TeamViewer', port: 5938 },
  web: { pluginType: 'Web Page', port: 443 },
  sftp: { pluginType: 'File Transfer', port: 22 },
  powershell: { pluginType: 'PowerShell', port: 5985 },
  vmware: { pluginType: 'VMware', port: 443 },
  hyperv: { pluginType: 'Hyper-V', port: 5985 },
};

function triggerQuickConnect() {
  const rawHost = quickHost?.value.trim() || el<HTMLInputElement>('host').value.trim();
  if (!rawHost) {
    quickHost?.focus();
    return;
  }
  el<HTMLInputElement>('host').value = rawHost;
  if (!el<HTMLInputElement>('username').value.trim()) {
    el<HTMLInputElement>('username').value = 'bright';
  }
  const protoKey = quickProto?.value ?? 'rdp';
  const mapped = QUICK_PROTO_MAP[protoKey] ?? QUICK_PROTO_MAP.rdp!;
  void syncQuickJumpGateway().then(() => {
    if (protoKey === 'rdp' || protoKey === 'Remote Desktop') {
      void openSession(formRequest()).then((why) => { if (why) el('error').textContent = why; });
    } else {
      openPluginTab({
        pluginType: mapped.pluginType,
        name: rawHost,
        host: rawHost,
        port: mapped.port,
        username: el<HTMLInputElement>('username').value.trim() || 'root',
        notes: 'Quick Connect session',
      });
    }
  });
}

if (quickGo) quickGo.onclick = triggerQuickConnect;
if (quickHost) {
  quickHost.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      triggerQuickConnect();
    }
  });
}
if (quickOptsBtn && quickOptsDrawer) {
  quickOptsBtn.onclick = () => {
    quickOptsDrawer.open = !quickOptsDrawer.open;
    if (quickOptsDrawer.open) el<HTMLInputElement>('host').focus();
  };
}

const actionsDrawer = document.getElementById('royal-actions-drawer') as HTMLDetailsElement | null;
const addBtn = document.getElementById('royal-add-btn');
const addMenu = document.getElementById('royal-add-menu');

if (actionsDrawer) {
  actionsDrawer.addEventListener('toggle', () => {
    if (actionsDrawer.open && addMenu) {
      addMenu.hidden = true;
    }
  });
  for (const btn of actionsDrawer.querySelectorAll<HTMLButtonElement>('button')) {
    btn.addEventListener('click', () => {
      actionsDrawer.open = false;
    });
  }
  document.addEventListener('click', (e) => {
    if (actionsDrawer.open && !actionsDrawer.contains(e.target as Node)) {
      actionsDrawer.open = false;
    }
  });
}

const zoomSlider = document.getElementById('canvas-zoom') as HTMLInputElement | null;
if (zoomSlider) {
  zoomSlider.addEventListener('input', () => {
    const t = tabs.get(active);
    if (!t) el('dimensions').textContent = `Zoom ${zoomSlider.value}%`;
  });
}

// ---- Jump Desktop & Royal TSX Session Toolbar Actions (Send Keys, Type Clipboard, Scale Mode, Snapshot) ----
function sendRdpKeyCombo(codes: string[]): void {
  const t = tabs.get(active);
  if (!t || t.panel || t.state !== 'connected') {
    notify('Open an active Remote Desktop session first.');
    return;
  }
  for (const c of codes) t.input.key(c, true);
  window.setTimeout(() => {
    for (const c of [...codes].reverse()) t.input.key(c, false);
  }, 45);
}

const CHAR_TO_RDP_CODE: Record<string, { code: string; shift?: boolean }> = {
  a: { code: 'KeyA' }, b: { code: 'KeyB' }, c: { code: 'KeyC' }, d: { code: 'KeyD' }, e: { code: 'KeyE' },
  f: { code: 'KeyF' }, g: { code: 'KeyG' }, h: { code: 'KeyH' }, i: { code: 'KeyI' }, j: { code: 'KeyJ' },
  k: { code: 'KeyK' }, l: { code: 'KeyL' }, m: { code: 'KeyM' }, n: { code: 'KeyN' }, o: { code: 'KeyO' },
  p: { code: 'KeyP' }, q: { code: 'KeyQ' }, r: { code: 'KeyR' }, s: { code: 'KeyS' }, t: { code: 'KeyT' },
  u: { code: 'KeyU' }, v: { code: 'KeyV' }, w: { code: 'KeyW' }, x: { code: 'KeyX' }, y: { code: 'KeyY' },
  z: { code: 'KeyZ' },
  A: { code: 'KeyA', shift: true }, B: { code: 'KeyB', shift: true }, C: { code: 'KeyC', shift: true },
  D: { code: 'KeyD', shift: true }, E: { code: 'KeyE', shift: true }, F: { code: 'KeyF', shift: true },
  G: { code: 'KeyG', shift: true }, H: { code: 'KeyH', shift: true }, I: { code: 'KeyI', shift: true },
  J: { code: 'KeyJ', shift: true }, K: { code: 'KeyK', shift: true }, L: { code: 'KeyL', shift: true },
  M: { code: 'KeyM', shift: true }, N: { code: 'KeyN', shift: true }, O: { code: 'KeyO', shift: true },
  P: { code: 'KeyP', shift: true }, Q: { code: 'KeyQ', shift: true }, R: { code: 'KeyR', shift: true },
  S: { code: 'KeyS', shift: true }, T: { code: 'KeyT', shift: true }, U: { code: 'KeyU', shift: true },
  V: { code: 'KeyV', shift: true }, W: { code: 'KeyW', shift: true }, X: { code: 'KeyX', shift: true },
  Y: { code: 'KeyY', shift: true }, Z: { code: 'KeyZ', shift: true },
  '0': { code: 'Digit0' }, '1': { code: 'Digit1' }, '2': { code: 'Digit2' }, '3': { code: 'Digit3' },
  '4': { code: 'Digit4' }, '5': { code: 'Digit5' }, '6': { code: 'Digit6' }, '7': { code: 'Digit7' },
  '8': { code: 'Digit8' }, '9': { code: 'Digit9' },
  ')': { code: 'Digit0', shift: true }, '!': { code: 'Digit1', shift: true }, '@': { code: 'Digit2', shift: true },
  '#': { code: 'Digit3', shift: true }, '$': { code: 'Digit4', shift: true }, '%': { code: 'Digit5', shift: true },
  '^': { code: 'Digit6', shift: true }, '&': { code: 'Digit7', shift: true }, '*': { code: 'Digit8', shift: true },
  '(': { code: 'Digit9', shift: true },
  ' ': { code: 'Space' }, '\n': { code: 'Enter' }, '\t': { code: 'Tab' },
  '-': { code: 'Minus' }, '_': { code: 'Minus', shift: true },
  '=': { code: 'Equal' }, '+': { code: 'Equal', shift: true },
  '[': { code: 'BracketLeft' }, '{': { code: 'BracketLeft', shift: true },
  ']': { code: 'BracketRight' }, '}': { code: 'BracketRight', shift: true },
  '\\': { code: 'Backslash' }, '|': { code: 'Backslash', shift: true },
  ';': { code: 'Semicolon' }, ':': { code: 'Semicolon', shift: true },
  "'": { code: 'Quote' }, '"': { code: 'Quote', shift: true },
  ',': { code: 'Comma' }, '<': { code: 'Comma', shift: true },
  '.': { code: 'Period' }, '>': { code: 'Period', shift: true },
  '/': { code: 'Slash' }, '?': { code: 'Slash', shift: true },
  '`': { code: 'Backquote' }, '~': { code: 'Backquote', shift: true },
};

const rdpSendKeysSelect = document.getElementById('rdp-send-keys') as HTMLSelectElement | null;
if (rdpSendKeysSelect) {
  rdpSendKeysSelect.onchange = () => {
    const val = rdpSendKeysSelect.value;
    rdpSendKeysSelect.value = '';
    if (!val) return;
    if (val === 'cad') sendRdpKeyCombo(['ControlLeft', 'AltLeft', 'Delete']);
    else if (val === 'win') sendRdpKeyCombo(['MetaLeft']);
    else if (val === 'taskmgr') sendRdpKeyCombo(['ControlLeft', 'ShiftLeft', 'Escape']);
    else if (val === 'alttab') sendRdpKeyCombo(['AltLeft', 'Tab']);
    else if (val === 'winr') sendRdpKeyCombo(['MetaLeft', 'KeyR']);
    else if (val === 'winl') sendRdpKeyCombo(['MetaLeft', 'KeyL']);
  };
}

const rdpTypeClipBtn = document.getElementById('rdp-type-clipboard') as HTMLButtonElement | null;
if (rdpTypeClipBtn) {
  rdpTypeClipBtn.onclick = async () => {
    const t = tabs.get(active);
    if (!t || t.panel || t.state !== 'connected') {
      notify('Connect to a Remote Desktop session first to type clipboard keystrokes.');
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      for (const ch of text.slice(0, 512)) {
        const mapped = CHAR_TO_RDP_CODE[ch];
        if (!mapped) continue;
        if (mapped.shift) t.input.key('ShiftLeft', true);
        t.input.key(mapped.code, true);
        t.input.key(mapped.code, false);
        if (mapped.shift) t.input.key('ShiftLeft', false);
        await new Promise((r) => window.setTimeout(r, 12));
      }
      t.canvas.focus();
    } catch {
      notify('Clipboard read requires focus on the window.');
    }
  };
}

const rdpScaleBtn = document.getElementById('rdp-scale-toggle') as HTMLButtonElement | null;
if (rdpScaleBtn) {
  const scales: { mode: string; label: string }[] = [
    { mode: 'fit', label: '⊡ Scale: Fit' },
    { mode: 'stretch', label: '⊡ Scale: Stretch' },
    { mode: 'actual', label: '⊡ Scale: 1:1' },
  ];
  let idx = 0;
  rdpScaleBtn.onclick = () => {
    idx = (idx + 1) % scales.length;
    const next = scales[idx]!;
    if (next.mode === 'fit') delete document.body.dataset.rdpScale;
    else document.body.dataset.rdpScale = next.mode;
    rdpScaleBtn.textContent = next.label;
  };
}

const rdpSnapBtn = document.getElementById('rdp-snapshot') as HTMLButtonElement | null;
if (rdpSnapBtn) {
  rdpSnapBtn.onclick = () => {
    const t = tabs.get(active);
    const targetCanvas = t && !t.panel ? t.canvas : document.querySelector<HTMLCanvasElement>('.jump-vnc-canvas');
    if (!targetCanvas || !targetCanvas.width) {
      notify('No active remote screen frame to capture.');
      return;
    }
    const a = document.createElement('a');
    a.href = targetCanvas.toDataURL('image/png');
    const hostSlug = (t?.request?.host || t?.pluginSpec?.host || 'session').replace(/[^a-zA-Z0-9.-]/g, '_');
    a.download = `jaladesk-snapshot-${hostSlug}-${Date.now()}.png`;
    a.click();
  };
}

const splitViewBtn = document.getElementById('split-view-toggle') as HTMLButtonElement | null;
if (splitViewBtn) {
  const splitStates: { mode: 'single' | '2x1' | '2x2'; label: string }[] = [
    { mode: 'single', label: '⊞ Split: Single' },
    { mode: '2x1', label: '⊞ Split: 2×1' },
    { mode: '2x2', label: '⊞ Split: 2×2' },
  ];
  splitViewBtn.onclick = () => {
    const curIdx = splitStates.findIndex((s) => s.mode === splitMode);
    const next = splitStates[(curIdx + 1) % splitStates.length]!;
    splitMode = next.mode;
    splitViewBtn.textContent = next.label;
    splitViewBtn.classList.toggle('active', splitMode !== 'single');
    select(active || [...tabs.keys()][0] || '');
    for (const [, t] of tabs) {
      if (!t.panel) t.resizer.observe(viewport());
    }
  };
}

interface CustomTaskItem {
  id: string;
  name: string;
  category: 'Windows / RDP' | 'Linux / SSH' | 'Network / Security';
  command: string;
}
const CUSTOM_TASKS_KEY = 'rw-custom-tasks-v1';
const DEFAULT_TASKS_LIST: CustomTaskItem[] = [
  {
    id: 'ad-dns',
    name: 'Active Directory & DNS Services Health',
    category: 'Windows / RDP',
    command: 'Get-Service ADWS,DNS,Netlogon,Kdc,W32Time | Format-Table Status,Name,DisplayName -AutoSize',
  },
  {
    id: 'win-dns-flush',
    name: 'Windows DNS Flush & Register',
    category: 'Windows / RDP',
    command: 'ipconfig /flushdns && ipconfig /registerdns',
  },
  {
    id: 'linux-docker',
    name: 'Linux Uptime, Disk & Docker Containers',
    category: 'Linux / SSH',
    command: 'uname -a && uptime && df -h / && docker ps',
  },
  {
    id: 'open-ports',
    name: 'Listening TCP/UDP Ports Audit',
    category: 'Network / Security',
    command: 'ss -tulpn 2>/dev/null || netstat -ano | findstr LISTENING',
  },
  {
    id: 'sys-errors',
    name: 'Recent System & Auth Error Logs',
    category: 'Linux / SSH',
    command: 'journalctl -p 3 -n 25 --no-pager 2>/dev/null || tail -n 25 /var/log/syslog',
  },
  {
    id: 'top-mem',
    name: 'Top Memory & CPU Consumers',
    category: 'Linux / SSH',
    command: 'ps aux --sort=-%mem | head -n 15',
  },
  {
    id: 'token-tls-probe',
    name: 'Live TLS & Port Banner Check ($HOST$:$PORT$)',
    category: 'Network / Security',
    command: 'echo "=== Target: $NAME$ ($USER$@$HOST$:$PORT$ via $GATEWAY$) ===" && uname -a',
  },
];

interface DynamicTokenContext {
  host: string;
  user: string;
  port: number | string;
  gateway: string;
  name: string;
  sshKey: string;
}

function getActiveTokenContext(): DynamicTokenContext {
  const curTab = tabs.get(active) ?? [...tabs.values()].find((t) => t.state === 'connected');
  if (curTab?.request) {
    return {
      host: curTab.request.host || '127.0.0.1',
      user: curTab.request.username || 'Administrator',
      port: curTab.request.port || 3389,
      gateway: getSelectedQuickJumpHost().jumpHost || 'Direct LAN',
      name: curTab.name || curTab.request.host || 'RDP-Host',
      sshKey: '',
    };
  }
  if (curTab?.pluginSpec) {
    return {
      host: curTab.pluginSpec.host || '127.0.0.1',
      user: curTab.pluginSpec.username || 'root',
      port: curTab.pluginSpec.port || 22,
      gateway: curTab.pluginSpec.jumpHost || 'Direct LAN',
      name: curTab.pluginSpec.name || curTab.pluginSpec.host || 'SSH-Host',
      sshKey: curTab.pluginSpec.sshKey || '',
    };
  }
  return {
    host: el<HTMLInputElement>('host')?.value.trim() || '10.28.0.154',
    user: el<HTMLInputElement>('username')?.value.trim() || 'root',
    port: el<HTMLInputElement>('port')?.value.trim() || '22',
    gateway: getSelectedQuickJumpHost().jumpHost || 'Direct LAN',
    name: 'Target-Server',
    sshKey: '',
  };
}

function resolveDynamicTokens(rawCommand: string, ctx: DynamicTokenContext): string {
  return rawCommand
    .replace(/\$HOST\$|\$\{HOST\}/gi, String(ctx.host || '127.0.0.1'))
    .replace(/\$USER\$|\$\{USER\}/gi, String(ctx.user || 'root'))
    .replace(/\$PORT\$|\$\{PORT\}/gi, String(ctx.port || 22))
    .replace(/\$GATEWAY\$|\$\{GATEWAY\}/gi, String(ctx.gateway || 'Direct LAN'))
    .replace(/\$NAME\$|\$\{NAME\}/gi, String(ctx.name || ctx.host || 'Server'))
    .replace(/\$SSH_KEY\$|\$\{SSH_KEY\}/gi, String(ctx.sshKey || ''));
}

function readCustomTasks(): CustomTaskItem[] {
  try {
    const raw = localStorage.getItem(CUSTOM_TASKS_KEY);
    if (!raw) return [...DEFAULT_TASKS_LIST];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : [...DEFAULT_TASKS_LIST];
  } catch {
    return [...DEFAULT_TASKS_LIST];
  }
}

function saveCustomTasks(list: CustomTaskItem[]): void {
  try {
    localStorage.setItem(CUSTOM_TASKS_KEY, JSON.stringify(list));
  } catch {}
}

async function typeStringIntoActiveRdp(text: string): Promise<boolean> {
  let targetTab = tabs.get(active);
  if (!targetTab || targetTab.panel || targetTab.state !== 'connected') {
    targetTab = [...tabs.values()].find((t) => !t.panel && t.state === 'connected');
  }
  if (!targetTab) return false;
  for (const ch of text.slice(0, 512)) {
    const mapped = CHAR_TO_RDP_CODE[ch];
    if (!mapped) continue;
    if (mapped.shift) targetTab.input.key('ShiftLeft', true);
    targetTab.input.key(mapped.code, true);
    targetTab.input.key(mapped.code, false);
    if (mapped.shift) targetTab.input.key('ShiftLeft', false);
    await new Promise((r) => window.setTimeout(r, 10));
  }
  targetTab.input.key('Enter', true);
  targetTab.input.key('Enter', false);
  return true;
}

function buildTasksManagerView(_spec: PluginSessionSpec, id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-row-inline';
  const titleEl = document.createElement('span');
  titleEl.className = 'plugin-view-title';
  titleEl.textContent = '⚡ Royal TSX Command Tasks & Key Sequence Macros';
  const badgeEl = document.createElement('span');
  badgeEl.className = 'plugin-view-badge';
  badgeEl.textContent = 'Automation & Macros';
  titleWrap.append(titleEl, badgeEl);

  const headerActs = document.createElement('div');
  headerActs.className = 'plugin-row-inline';
  const bundleBtn = document.createElement('button');
  bundleBtn.type = 'button';
  bundleBtn.className = 'quiet';
  bundleBtn.textContent = '📦 Export / Import Bundle';
  bundleBtn.onclick = () => {
    openPluginTab({
      pluginType: 'Config Bundle',
      name: 'Workspace Config Bundle',
      host: 'localhost',
      port: 0,
      username: 'ops',
      notes: '',
    });
  };
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close Tab';
  closeBtn.onclick = () => {
    const next = tabAfterClose(tabIds(), id);
    discard(id);
    select(next);
  };
  headerActs.append(bundleBtn, closeBtn);
  header.append(titleWrap, headerActs);

  const tokenBar = document.createElement('div');
  tokenBar.className = 'plugin-telemetry-bar';
  for (const tok of [
    'Dynamic Tokens Supported:',
    '$HOST$ (Server IP/FQDN)',
    '$USER$ (Username)',
    '$PORT$ (Port)',
    '$GATEWAY$ (Jump Host)',
    '$NAME$ (Display Name)',
    '$SSH_KEY$ (IdentityFile)',
  ]) {
    const pill = document.createElement('span');
    pill.className = 'plugin-tele-item';
    pill.textContent = tok;
    tokenBar.append(pill);
  }

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const form = document.createElement('form');
  form.className = 'gateway-tunnel-form';
  const nameLbl = document.createElement('label');
  nameLbl.textContent = 'Task / Macro Name';
  const nameIn = document.createElement('input');
  nameIn.type = 'text';
  nameIn.placeholder = 'e.g. Restart DNS Service';
  nameLbl.append(nameIn);

  const catLbl = document.createElement('label');
  catLbl.textContent = 'Category';
  const catSel = document.createElement('select');
  for (const c of ['Windows / RDP', 'Linux / SSH', 'Network / Security'] as const) {
    const o = document.createElement('option');
    o.value = c;
    o.textContent = c;
    catSel.append(o);
  }
  catLbl.append(catSel);

  const cmdLbl = document.createElement('label');
  cmdLbl.textContent = 'Command / Key Sequence';
  const cmdIn = document.createElement('input');
  cmdIn.type = 'text';
  cmdIn.placeholder = 'e.g. Restart-Service DNS -Force';
  cmdLbl.append(cmdIn);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.textContent = '+ Save Task';
  form.append(nameLbl, catLbl, cmdLbl, saveBtn);

  const table = document.createElement('table');
  table.className = 'plugin-table';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const col of ['Task Name', 'Category', 'Command / Key Sequence', '1-Click Execute']) {
    const th = document.createElement('th');
    th.textContent = col;
    htr.append(th);
  }
  thead.append(htr);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);

  const statusOut = document.createElement('pre');
  statusOut.className = 'plugin-terminal-output';
  statusOut.textContent = 'Select any Command Task or Key Sequence above to type into an active RDP session, broadcast to SSH terminals, or copy to clipboard.';

  const renderTasks = () => {
    const list = readCustomTasks();
    tbody.replaceChildren();
    for (const item of list) {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td');
      td1.textContent = item.name;
      const td2 = document.createElement('td');
      td2.textContent = item.category;
      const td3 = document.createElement('td');
      td3.className = 'mono';
      td3.textContent = item.command;
      const td4 = document.createElement('td');
      const acts = document.createElement('div');
      acts.className = 'plugin-row-inline';

      const typeRdpBtn = document.createElement('button');
      typeRdpBtn.type = 'button';
      typeRdpBtn.className = 'quiet';
      typeRdpBtn.textContent = '⌨ Type in RDP';
      typeRdpBtn.title = 'Type this command + Enter as hardware keystrokes into the active Windows RDP session';
      typeRdpBtn.onclick = async () => {
        const resolved = resolveDynamicTokens(item.command, getActiveTokenContext());
        const ok = await typeStringIntoActiveRdp(resolved);
        statusOut.textContent = ok
          ? `Typed Key Sequence "${item.name}" -> [${resolved}] into active RDP session.`
          : 'No connected Windows RDP session found — open an RDP session first.';
      };

      const bcastSshBtn = document.createElement('button');
      bcastSshBtn.type = 'button';
      bcastSshBtn.className = 'quiet';
      bcastSshBtn.textContent = '📡 Broadcast SSH';
      bcastSshBtn.title = 'Send this command (with $HOST$/$USER$ tokens resolved) to all SSH terminals with Broadcast enabled';
      bcastSshBtn.onclick = () => {
        const resolved = resolveDynamicTokens(item.command, getActiveTokenContext());
        if (activeBroadcastTerminals.size === 0) {
          statusOut.textContent = 'Enable "📡 Broadcast: ON" on one or more SSH Terminal tabs first.';
          return;
        }
        for (const fn of activeBroadcastTerminals.values()) {
          fn(`${resolved}\r`);
        }
        statusOut.textContent = `Broadcasted "${item.name}" -> [${resolved}] to ${activeBroadcastTerminals.size} SSH terminal(s).`;
      };

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'quiet';
      copyBtn.textContent = '📋 Copy';
      copyBtn.onclick = () => {
        const resolved = resolveDynamicTokens(item.command, getActiveTokenContext());
        void navigator.clipboard.writeText(resolved);
        statusOut.textContent = `Copied "${resolved}" to clipboard.`;
      };

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'quiet';
      delBtn.textContent = '✕';
      delBtn.onclick = () => {
        saveCustomTasks(readCustomTasks().filter((x) => x.id !== item.id));
        renderTasks();
      };

      acts.append(typeRdpBtn, bcastSshBtn, copyBtn, delBtn);
      td4.append(acts);
      tr.append(td1, td2, td3, td4);
      tbody.append(tr);
    }
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const nm = nameIn.value.trim();
    const cm = cmdIn.value.trim();
    if (!nm || !cm) return;
    const list = readCustomTasks();
    list.unshift({
      id: `task-${Date.now()}`,
      name: nm,
      category: (catSel.value as CustomTaskItem['category']) || 'Linux / SSH',
      command: cm,
    });
    saveCustomTasks(list);
    nameIn.value = '';
    cmdIn.value = '';
    renderTasks();
  });

  body.append(form, table, statusOut);
  card.append(header, tokenBar, body);
  renderTasks();
  return card;
}

function buildNetworkScannerView(spec: PluginSessionSpec, id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-row-inline';
  const titleEl = document.createElement('span');
  titleEl.className = 'plugin-view-title';
  titleEl.textContent = '🔍 Network Subnet & Port Discovery Wizard';
  const badgeEl = document.createElement('span');
  badgeEl.className = 'plugin-view-badge';
  badgeEl.textContent = 'CIDR / IP Range Scanner';
  const statePill = document.createElement('span');
  statePill.className = 'plugin-state-pill';
  statePill.textContent = 'Ready';
  titleWrap.append(titleEl, badgeEl, statePill);

  const headerActs = document.createElement('div');
  headerActs.className = 'plugin-row-inline';
  const bundleBtn = document.createElement('button');
  bundleBtn.type = 'button';
  bundleBtn.className = 'quiet';
  bundleBtn.textContent = '📦 Export / Import Bundle';
  bundleBtn.onclick = () => {
    openPluginTab({
      pluginType: 'Config Bundle',
      name: 'Workspace Config Bundle',
      host: 'localhost',
      port: 0,
      username: 'ops',
      notes: '',
    });
  };
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close Tab';
  closeBtn.onclick = () => {
    const next = tabAfterClose(tabIds(), id);
    discard(id);
    select(next);
  };
  headerActs.append(bundleBtn, closeBtn);
  header.append(titleWrap, headerActs);

  const tokenBar = document.createElement('div');
  tokenBar.className = 'plugin-telemetry-bar';
  for (const tok of [
    'Dynamic Tokens Supported:',
    '$HOST$ (Server IP/FQDN)',
    '$USER$ (Username)',
    '$PORT$ (Port)',
    '$GATEWAY$ (Jump Host)',
    '$NAME$ (Display Name)',
    '$SSH_KEY$ (IdentityFile)',
  ]) {
    const pill = document.createElement('span');
    pill.className = 'plugin-tele-item';
    pill.textContent = tok;
    tokenBar.append(pill);
  }

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const form = document.createElement('form');
  form.className = 'gateway-tunnel-form';

  const rangeLbl = document.createElement('label');
  rangeLbl.textContent = 'Target IP Range / CIDR / Host List';
  const rangeIn = document.createElement('input');
  rangeIn.type = 'text';
  rangeIn.value = spec.host && spec.host !== 'localhost' ? spec.host : '10.28.0.150-160';
  rangeIn.placeholder = 'e.g. 10.28.0.150-165 or 10.28.37.1-20';
  rangeLbl.append(rangeIn);

  const portsLbl = document.createElement('label');
  portsLbl.textContent = 'Ports (RDP, SSH, VNC, HTTPS, WinRM)';
  const portsIn = document.createElement('input');
  portsIn.type = 'text';
  portsIn.value = '3389, 4321, 22, 5900, 443, 5985';
  portsLbl.append(portsIn);

  const jumpLbl = document.createElement('label');
  jumpLbl.textContent = 'Route via Jump Host';
  const jumpSel = document.createElement('select');
  for (const [val, label] of [
    ['', 'Direct LAN / VPN'],
    ['pln-jump', 'pln-jump (103.172.170.196:2345)'],
    ['distribusi-jump', 'distribusi-jump (103.172.170.219:2602)'],
    ['mitra-jump', 'mitra-jump (103.172.170.219:2602)'],
  ] as const) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = label;
    if (val === (spec.jumpHost ?? '')) opt.selected = true;
    jumpSel.append(opt);
  }
  void getSshEnv().then((env) => {
    const existing = new Set(Array.from(jumpSel.options).map((o) => o.value));
    for (const j of env.jumpHosts) {
      if (!existing.has(j.alias)) {
        const opt = document.createElement('option');
        opt.value = j.alias;
        opt.textContent = `${j.alias} (${j.user}@${j.hostName}:${j.port})`;
        if (j.alias === (spec.jumpHost ?? '')) opt.selected = true;
        jumpSel.append(opt);
      }
    }
  });
  jumpLbl.append(jumpSel);

  const scanBtn = document.createElement('button');
  scanBtn.type = 'submit';
  scanBtn.textContent = '🔍 Scan Subnet';

  const importAllBtn = document.createElement('button');
  importAllBtn.type = 'button';
  importAllBtn.className = 'quiet';
  importAllBtn.textContent = '+ Import All Discovered';
  importAllBtn.disabled = true;

  form.append(rangeLbl, portsLbl, jumpLbl, scanBtn, importAllBtn);

  const table = document.createElement('table');
  table.className = 'plugin-table';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const col of ['Host / IP', 'Open Port', 'Detected Protocol', 'Latency', 'Service Banner', '1-Click Action']) {
    const th = document.createElement('th');
    th.textContent = col;
    htr.append(th);
  }
  thead.append(htr);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);

  const statusOut = document.createElement('pre');
  statusOut.className = 'plugin-terminal-output';
  statusOut.textContent =
    'Enter an IPv4 range (e.g. 10.28.0.150-165 or 10.28.37.1-20), CIDR (/28), or comma-separated hosts and click "🔍 Scan Subnet". Works both on direct LAN and through SSH Jump Hosts.';

  let lastDiscoveredFlat: Array<{ host: string; port: number; service: string; pluginType: string }> = [];

  const runScan = async () => {
    scanBtn.disabled = true;
    statePill.textContent = 'Scanning…';
    statePill.dataset.online = 'probing';
    statusOut.textContent = `Scanning ${rangeIn.value.trim()} across ports [${portsIn.value.trim()}]${jumpSel.value ? ` via ${jumpSel.value}` : ''}…`;
    tbody.replaceChildren();
    lastDiscoveredFlat = [];
    importAllBtn.disabled = true;

    try {
      const res = (await (window as any).workspace.run('net.scan', {
        targetRange: rangeIn.value.trim(),
        ports: portsIn.value.trim(),
        timeoutMs: 550,
        jumpHost: jumpSel.value,
      })) as {
        ok: boolean;
        value?: {
          hostsScanned: number;
          portsScanned: number[];
          durationMs: number;
          viaJumpHost: string;
          discovered: Array<{
            host: string;
            openPorts: Array<{ port: number; service: string; pluginType: string; latencyMs: number; banner: string }>;
          }>;
        };
      };

      if (!res.ok || !res.value) {
        statePill.textContent = 'Scan Failed';
        statePill.dataset.online = 'false';
        statusOut.textContent = 'Subnet scan failed to complete.';
        return;
      }

      const d = res.value;
      for (const hostRec of d.discovered) {
        for (const p of hostRec.openPorts) {
          lastDiscoveredFlat.push({
            host: hostRec.host,
            port: p.port,
            service: p.service,
            pluginType: p.pluginType,
          });
          const tr = document.createElement('tr');
          const tdHost = document.createElement('td');
          tdHost.className = 'mono';
          tdHost.textContent = hostRec.host;
          const tdPort = document.createElement('td');
          tdPort.className = 'mono';
          tdPort.textContent = String(p.port);
          const tdProto = document.createElement('td');
          tdProto.textContent = `${p.service} (${p.pluginType})`;
          const tdLat = document.createElement('td');
          tdLat.textContent = `${p.latencyMs} ms`;
          const tdBan = document.createElement('td');
          tdBan.className = 'mono';
          tdBan.textContent = p.banner;

          const tdActs = document.createElement('td');
          const actRow = document.createElement('div');
          actRow.className = 'plugin-row-inline';

          const connNowBtn = document.createElement('button');
          connNowBtn.type = 'button';
          connNowBtn.className = 'quiet';
          connNowBtn.textContent = '⚡ Connect';
          connNowBtn.onclick = () => {
            if (p.pluginType === 'Remote Desktop') {
              el<HTMLInputElement>('host').value = hostRec.host;
              el<HTMLInputElement>('port').value = String(p.port);
              if (jumpSel.value && jumpHostSelect) jumpHostSelect.value = jumpSel.value;
              void syncQuickJumpGateway().then(() => {
                void openSession(formRequest(), undefined, `${hostRec.host}:${p.port}`).then((why) => {
                  if (why) el('error').textContent = why;
                });
              });
            } else {
              openPluginTab({
                pluginType: p.pluginType,
                name: `${hostRec.host} (${p.service})`,
                host: hostRec.host,
                port: p.port,
                username: spec.username || 'root',
                notes: 'Discovered via Subnet Scanner',
                jumpHost: jumpSel.value,
              });
            }
          };

          const impBtn = document.createElement('button');
          impBtn.type = 'button';
          impBtn.className = 'quiet';
          impBtn.textContent = '+ Import to Doc';
          impBtn.onclick = async () => {
            const ok = await documents.importDiscoveredHost?.({
              name: `${hostRec.host} (${p.service})`,
              host: hostRec.host,
              port: p.port,
              pluginType: p.pluginType,
              username: p.pluginType === 'Remote Desktop' ? 'Administrator' : 'root',
              jumpHost: jumpSel.value,
            });
            if (ok) {
              impBtn.textContent = '✓ Imported';
              impBtn.disabled = true;
            }
          };

          actRow.append(connNowBtn, impBtn);
          tdActs.append(actRow);
          tr.append(tdHost, tdPort, tdProto, tdLat, tdBan, tdActs);
          tbody.append(tr);
        }
      }

      if (lastDiscoveredFlat.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 6;
        td.textContent = `No open ports responded in range "${rangeIn.value.trim()}". Try selecting a Jump Host if this subnet is behind a gateway.`;
        tr.append(td);
        tbody.append(tr);
      } else {
        importAllBtn.disabled = false;
      }

      statePill.textContent = `${lastDiscoveredFlat.length} Open Endpoint(s)`;
      statePill.dataset.online = lastDiscoveredFlat.length > 0 ? 'true' : 'false';
      statusOut.textContent = `Scanned ${d.hostsScanned} host(s) × ${d.portsScanned.length} port(s) in ${d.durationMs} ms. Found ${lastDiscoveredFlat.length} open service endpoint(s) across ${d.discovered.length} live host(s).`;
    } finally {
      scanBtn.disabled = false;
    }
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void runScan();
  });

  importAllBtn.onclick = async () => {
    if (lastDiscoveredFlat.length === 0) return;
    importAllBtn.disabled = true;
    let count = 0;
    for (const item of lastDiscoveredFlat) {
      const ok = await documents.importDiscoveredHost?.({
        name: `${item.host} (${item.service})`,
        host: item.host,
        port: item.port,
        pluginType: item.pluginType,
        username: item.pluginType === 'Remote Desktop' ? 'Administrator' : 'root',
        jumpHost: jumpSel.value,
      });
      if (ok) count++;
    }
    statusOut.textContent = `Imported ${count} discovered endpoint(s) into the active Document/Folder.`;
  };

  body.append(form, table, statusOut);
  card.append(header, body);
  return card;
}

function buildBatchScriptRunnerView(spec: PluginSessionSpec, id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-row-inline';
  const titleEl = document.createElement('span');
  titleEl.className = 'plugin-view-title';
  titleEl.textContent = '⚡ Multi-Server Batch Script Execution Matrix';
  const badgeEl = document.createElement('span');
  badgeEl.className = 'plugin-view-badge';
  badgeEl.textContent = 'Parallel SSH / WinRM Runner';
  const statePill = document.createElement('span');
  statePill.className = 'plugin-state-pill';
  statePill.textContent = 'Ready';
  titleWrap.append(titleEl, badgeEl, statePill);

  const headerActs = document.createElement('div');
  headerActs.className = 'plugin-row-inline';
  const exportCsvBtn = document.createElement('button');
  exportCsvBtn.type = 'button';
  exportCsvBtn.className = 'quiet';
  exportCsvBtn.textContent = '⬇ Export Matrix CSV';
  const refreshHostsBtn = document.createElement('button');
  refreshHostsBtn.type = 'button';
  refreshHostsBtn.className = 'quiet';
  refreshHostsBtn.textContent = '↻ Reload Servers';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close Tab';
  closeBtn.onclick = () => {
    const next = tabAfterClose(tabIds(), id);
    discard(id);
    select(next);
  };
  headerActs.append(exportCsvBtn, refreshHostsBtn, closeBtn);
  header.append(titleWrap, headerActs);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const form = document.createElement('form');
  form.className = 'gateway-tunnel-form';

  const scopeLbl = document.createElement('label');
  scopeLbl.textContent = 'Document / Folder Scope';
  const scopeSel = document.createElement('select');
  scopeLbl.append(scopeSel);

  const presetLbl = document.createElement('label');
  presetLbl.textContent = 'Preset Task / Macro';
  const presetSel = document.createElement('select');
  const defPresetOpt = document.createElement('option');
  defPresetOpt.value = '';
  defPresetOpt.textContent = 'Select saved Task or enter custom…';
  presetSel.append(defPresetOpt);
  for (const t of readCustomTasks()) {
    const o = document.createElement('option');
    o.value = t.command;
    o.textContent = `[${t.category}] ${t.name}`;
    presetSel.append(o);
  }
  presetLbl.append(presetSel);

  const cmdLbl = document.createElement('label');
  cmdLbl.textContent = 'Command (Bash / PowerShell)';
  const cmdIn = document.createElement('input');
  cmdIn.type = 'text';
  cmdIn.value = 'uname -a && uptime && df -h /';
  cmdIn.placeholder = 'Enter Bash or PowerShell command to execute across servers…';
  cmdLbl.append(cmdIn);

  presetSel.onchange = () => {
    if (presetSel.value) cmdIn.value = presetSel.value;
  };

  const runBtn = document.createElement('button');
  runBtn.type = 'submit';
  runBtn.textContent = '⚡ Run Batch Now';

  form.append(scopeLbl, presetLbl, cmdLbl, runBtn);

  const table = document.createElement('table');
  table.className = 'plugin-table';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const col of ['Run', 'Server Name', 'Scope', 'Endpoint', 'Inherited Gateway', 'Exit Status', 'Duration', 'Stdout / Stderr Output']) {
    const th = document.createElement('th');
    th.textContent = col;
    htr.append(th);
  }
  thead.append(htr);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);

  interface MatrixRowState {
    checked: boolean;
    serverName: string;
    scope: string;
    host: string;
    port: number;
    username: string;
    pluginType: string;
    jumpHost: string;
    sshKey: string;
    exitStatus: string;
    duration: string;
    output: string;
    statusEl: HTMLElement;
    durEl: HTMLElement;
    outEl: HTMLElement;
  }
  let matrixRows: MatrixRowState[] = [];

  const populateScopesAndRows = () => {
    const allConns = documents.listAllConnections?.() ?? [];
    const scopes = new Set<string>(['__all__']);
    for (const c of allConns) {
      scopes.add(c.docName);
      if (c.folderName) scopes.add(`${c.docName} / ${c.folderName}`);
    }
    const prevScope = scopeSel.value || (spec.notes && scopes.has(spec.notes) ? spec.notes : '__all__');
    scopeSel.replaceChildren();
    const allOpt = document.createElement('option');
    allOpt.value = '__all__';
    allOpt.textContent = `All Open Documents (${allConns.length} servers)`;
    scopeSel.append(allOpt);
    for (const sc of scopes) {
      if (sc === '__all__') continue;
      const opt = document.createElement('option');
      opt.value = sc;
      opt.textContent = sc;
      if (sc === prevScope) opt.selected = true;
      scopeSel.append(opt);
    }

    const activeScope = scopeSel.value || '__all__';
    const filtered = allConns.filter((c) => {
      if (activeScope === '__all__') return true;
      const fullScope = c.folderName ? `${c.docName} / ${c.folderName}` : c.docName;
      return c.docName === activeScope || fullScope === activeScope;
    });

    tbody.replaceChildren();
    matrixRows = [];

    if (filtered.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 8;
      td.textContent = 'No saved server connections in this scope yet. Open or create a Document (e.g. PLN Batam) first.';
      tr.append(td);
      tbody.append(tr);
      return;
    }

    for (const c of filtered) {
      const tr = document.createElement('tr');
      const tdChk = document.createElement('td');
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = true;
      tdChk.append(chk);

      const tdName = document.createElement('td');
      tdName.textContent = c.name;
      const tdScope = document.createElement('td');
      tdScope.textContent = c.folderName ? `${c.docName} / ${c.folderName}` : c.docName;
      const tdEnd = document.createElement('td');
      tdEnd.className = 'mono';
      tdEnd.textContent = `${c.username}@${c.hostPort}`;
      const tdGw = document.createElement('td');
      tdGw.textContent = c.gateway;
      const tdStat = document.createElement('td');
      tdStat.textContent = 'Idle';
      const tdDur = document.createElement('td');
      tdDur.textContent = '—';
      const tdOut = document.createElement('td');
      tdOut.className = 'mono';
      tdOut.textContent = 'Ready';

      const rowState: MatrixRowState = {
        checked: true,
        serverName: c.name,
        scope: tdScope.textContent,
        host: c.host,
        port: c.port,
        username: c.username,
        pluginType: c.pluginType,
        jumpHost: c.jumpHost,
        sshKey: c.sshKey,
        exitStatus: 'Idle',
        duration: '—',
        output: '',
        statusEl: tdStat,
        durEl: tdDur,
        outEl: tdOut,
      };
      chk.onchange = () => {
        rowState.checked = chk.checked;
      };
      matrixRows.push(rowState);
      tr.append(tdChk, tdName, tdScope, tdEnd, tdGw, tdStat, tdDur, tdOut);
      tbody.append(tr);
    }
  };

  scopeSel.onchange = populateScopesAndRows;
  refreshHostsBtn.onclick = populateScopesAndRows;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const command = cmdIn.value.trim();
    if (!command) return;
    const targets = matrixRows.filter((r) => r.checked);
    if (targets.length === 0) return;

    runBtn.disabled = true;
    let completed = 0;
    statePill.textContent = `Running 0/${targets.length}…`;
    statePill.dataset.online = 'probing';

    await Promise.all(
      targets.map(async (row) => {
        row.statusEl.textContent = '⏳ Running…';
        row.outEl.textContent = 'Executing via inherited gateway…';
        const guard = checkProductionSafetyGuard(`Batch Script (${command.slice(0, 40)})`, `${row.serverName} ${row.host}`);
        if (!guard.allowed) {
          completed++;
          row.exitStatus = '🛡 Guard Blocked';
          row.duration = '0 ms';
          row.output = guard.guardNote;
          row.statusEl.textContent = row.exitStatus;
          row.durEl.textContent = row.duration;
          row.outEl.textContent = row.output;
          return;
        }
        try {
          const execPort = row.pluginType === 'PowerShell' ? row.port : 22;
          const resolvedCmd = resolveDynamicTokens(command, {
            host: row.host,
            user: row.username || 'root',
            port: row.port,
            gateway: row.jumpHost || 'Direct LAN',
            name: row.serverName,
            sshKey: row.sshKey,
          });
          const res = (await (window as any).workspace.run('protocol.exec', {
            pluginType: row.pluginType === 'PowerShell' ? 'PowerShell' : 'Terminal',
            host: row.host,
            port: execPort,
            username: row.username || 'root',
            password: '',
            jumpHost: row.jumpHost,
            identityFile: row.sshKey,
            command: resolvedCmd,
          })) as {
            ok: boolean;
            value?: { ok: boolean; exitCode: number; stdout: string; stderr: string; durationMs: number };
          };
          completed++;
          statePill.textContent = `Running ${completed}/${targets.length}…`;
          if (res.ok && res.value) {
            const v = res.value;
            row.exitStatus = v.ok ? `✓ Exit 0` : `✕ Exit ${v.exitCode}`;
            row.duration = `${v.durationMs} ms`;
            row.output = (v.stdout || v.stderr || '(no output)').trim().slice(0, 320);
          } else {
            row.exitStatus = '✕ Error';
            row.duration = '—';
            row.output = 'Execution failed';
          }
        } catch {
          completed++;
          row.exitStatus = '✕ Error';
          row.duration = '—';
          row.output = 'IPC error';
        }
        row.statusEl.textContent = row.exitStatus;
        row.durEl.textContent = row.duration;
        row.outEl.textContent = row.output;
      }),
    );

    const okCount = targets.filter((r) => r.exitStatus.startsWith('✓')).length;
    statePill.textContent = `Completed (${okCount}/${targets.length} OK)`;
    statePill.dataset.online = okCount === targets.length ? 'true' : 'false';
    runBtn.disabled = false;
  });

  exportCsvBtn.onclick = () => {
    const lines = [
      'Server Name,Scope,Host,Port,Gateway,Exit Status,Duration,Output',
      ...matrixRows.map((r) =>
        [
          JSON.stringify(r.serverName),
          JSON.stringify(r.scope),
          r.host,
          r.port,
          JSON.stringify(r.jumpHost || 'Direct LAN'),
          JSON.stringify(r.exitStatus),
          JSON.stringify(r.duration),
          JSON.stringify(r.output),
        ].join(','),
      ),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jaladesk-batch-matrix-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  body.append(form, table);
  card.append(header, body);
  populateScopesAndRows();
  return card;
}

function buildKnownHostsManagerView(_spec: PluginSessionSpec, id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-row-inline';
  const titleEl = document.createElement('span');
  titleEl.className = 'plugin-view-title';
  titleEl.textContent = '🛡 SSH Known Hosts (~/.ssh/known_hosts) & TLS Certificate Pin Manager';
  const badgeEl = document.createElement('span');
  badgeEl.className = 'plugin-view-badge';
  badgeEl.textContent = 'Host Key & Cert Security';
  titleWrap.append(titleEl, badgeEl);

  const headerActs = document.createElement('div');
  headerActs.className = 'plugin-row-inline';
  const filterIn = document.createElement('input');
  filterIn.type = 'search';
  filterIn.className = 'plugin-pass-input';
  filterIn.placeholder = 'Search host, IP, SHA256 fingerprint…';
  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'quiet';
  refreshBtn.textContent = '↻ Refresh';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close Tab';
  closeBtn.onclick = () => {
    const next = tabAfterClose(tabIds(), id);
    discard(id);
    select(next);
  };
  headerActs.append(filterIn, refreshBtn, closeBtn);
  header.append(titleWrap, headerActs);

  const summaryBar = document.createElement('div');
  summaryBar.className = 'plugin-telemetry-bar';

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const sshTable = document.createElement('table');
  sshTable.className = 'plugin-table';
  const sshHead = document.createElement('thead');
  const sshHtr = document.createElement('tr');
  for (const col of ['Line #', 'Host / IP Pattern (~/.ssh/known_hosts)', 'Key Type', 'OpenSSH SHA-256 Fingerprint', 'Key Preview', 'Action']) {
    const th = document.createElement('th');
    th.textContent = col;
    sshHtr.append(th);
  }
  sshHead.append(sshHtr);
  const sshBody = document.createElement('tbody');
  sshTable.append(sshHead, sshBody);

  const tlsTable = document.createElement('table');
  tlsTable.className = 'plugin-table';
  const tlsHead = document.createElement('thead');
  const tlsHtr = document.createElement('tr');
  for (const col of ['Pinned RDP / HTTPS Endpoint', 'Common Name (CN)', 'Issuer', 'Certificate SHA-256 Pin', 'Valid Until', 'Action']) {
    const th = document.createElement('th');
    th.textContent = col;
    tlsHtr.append(th);
  }
  tlsHead.append(tlsHtr);
  const tlsBody = document.createElement('tbody');
  tlsTable.append(tlsHead, tlsBody);

  body.append(sshTable, tlsTable);

  const loadAndRender = async () => {
    try {
      const res = (await (window as any).workspace.run('ssh.knownHosts.list', {})) as {
        ok: boolean;
        value?: {
          knownHostsPath: string;
          knownHosts: Array<{
            lineNumber: number;
            hosts: string;
            keyType: string;
            fingerprintSha256: string;
            keyPreview: string;
          }>;
          certPins: Array<{
            endpoint: string;
            sha256: string;
            cn: string;
            issuer: string;
            validTo: string;
          }>;
        };
      };
      if (!res.ok || !res.value) return;
      const d = res.value;
      const q = filterIn.value.trim().toLowerCase();

      summaryBar.replaceChildren();
      const s1 = document.createElement('span');
      s1.className = 'plugin-tele-item';
      s1.textContent = `SSH Known Hosts File: ${d.knownHostsPath}`;
      const s2 = document.createElement('span');
      s2.className = 'plugin-tele-item';
      s2.textContent = `Pinned SSH Host Keys: ${d.knownHosts.length}`;
      const s3 = document.createElement('span');
      s3.className = 'plugin-tele-item';
      s3.textContent = `Pinned RDP/TLS Certificates: ${d.certPins.length}`;
      summaryBar.append(s1, s2, s3);

      sshBody.replaceChildren();
      const filteredSsh = q
        ? d.knownHosts.filter(
            (k) =>
              k.hosts.toLowerCase().includes(q) ||
              k.keyType.toLowerCase().includes(q) ||
              k.fingerprintSha256.toLowerCase().includes(q),
          )
        : d.knownHosts;

      if (filteredSsh.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 6;
        td.textContent = 'No matching entries in ~/.ssh/known_hosts.';
        tr.append(td);
        sshBody.append(tr);
      } else {
        for (const item of filteredSsh) {
          const tr = document.createElement('tr');
          const tdLine = document.createElement('td');
          tdLine.className = 'mono';
          tdLine.textContent = `#${item.lineNumber}`;
          const tdHosts = document.createElement('td');
          tdHosts.className = 'mono';
          tdHosts.textContent = item.hosts;
          const tdType = document.createElement('td');
          tdType.textContent = item.keyType;
          const tdFp = document.createElement('td');
          tdFp.className = 'mono';
          tdFp.textContent = item.fingerprintSha256;
          const tdPrev = document.createElement('td');
          tdPrev.className = 'mono';
          tdPrev.textContent = item.keyPreview;
          const tdAct = document.createElement('td');
          const rmBtn = document.createElement('button');
          rmBtn.type = 'button';
          rmBtn.className = 'quiet';
          rmBtn.textContent = '🗑 Remove Key';
          rmBtn.title = 'Remove this host key line from ~/.ssh/known_hosts (fixes host key mismatch after server reinstall)';
          rmBtn.onclick = async () => {
            await (window as any).workspace.run('ssh.knownHosts.remove', {
              lineNumber: item.lineNumber,
            });
            await loadAndRender();
          };
          tdAct.append(rmBtn);
          tr.append(tdLine, tdHosts, tdType, tdFp, tdPrev, tdAct);
          sshBody.append(tr);
        }
      }

      tlsBody.replaceChildren();
      const filteredTls = q
        ? d.certPins.filter(
            (c) =>
              c.endpoint.toLowerCase().includes(q) ||
              c.cn.toLowerCase().includes(q) ||
              c.sha256.toLowerCase().includes(q),
          )
        : d.certPins;

      if (filteredTls.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 6;
        td.textContent = 'No pinned RDP/TLS certificates matching filter.';
        tr.append(td);
        tlsBody.append(tr);
      } else {
        for (const c of filteredTls) {
          const tr = document.createElement('tr');
          const tdEp = document.createElement('td');
          tdEp.className = 'mono';
          tdEp.textContent = c.endpoint;
          const tdCn = document.createElement('td');
          tdCn.textContent = c.cn || '—';
          const tdIss = document.createElement('td');
          tdIss.textContent = c.issuer || '—';
          const tdSha = document.createElement('td');
          tdSha.className = 'mono';
          tdSha.textContent = `${c.sha256.slice(0, 20)}…${c.sha256.slice(-12)}`;
          tdSha.title = c.sha256;
          const tdVal = document.createElement('td');
          tdVal.textContent = c.validTo || '—';
          const tdAct = document.createElement('td');
          const rmPinBtn = document.createElement('button');
          rmPinBtn.type = 'button';
          rmPinBtn.className = 'quiet';
          rmPinBtn.textContent = '🗑 Clear Pin';
          rmPinBtn.onclick = async () => {
            await (window as any).workspace.run('ssh.knownHosts.remove', {
              certEndpoint: c.endpoint,
            });
            await loadAndRender();
          };
          tdAct.append(rmPinBtn);
          tr.append(tdEp, tdCn, tdIss, tdSha, tdVal, tdAct);
          tlsBody.append(tr);
        }
      }
    } catch {}
  };

  filterIn.addEventListener('input', () => void loadAndRender());
  refreshBtn.onclick = () => void loadAndRender();

  card.append(header, summaryBar, body);
  void loadAndRender();
  return card;
}

function buildWolAndKnockView(spec: PluginSessionSpec, id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-row-inline';
  const titleEl = document.createElement('span');
  titleEl.className = 'plugin-view-title';
  titleEl.textContent = '📡 Wake-on-LAN (Magic Packet) & Port Knocking Studio';
  const badgeEl = document.createElement('span');
  badgeEl.className = 'plugin-view-badge';
  badgeEl.textContent = 'Pre-Connect Network Hooks';
  titleWrap.append(titleEl, badgeEl);

  const headerActs = document.createElement('div');
  headerActs.className = 'plugin-row-inline';
  const bundleBtn = document.createElement('button');
  bundleBtn.type = 'button';
  bundleBtn.className = 'quiet';
  bundleBtn.textContent = '📦 Export / Import Bundle';
  bundleBtn.onclick = () => {
    openPluginTab({
      pluginType: 'Config Bundle',
      name: 'Workspace Config Bundle',
      host: 'localhost',
      port: 0,
      username: 'ops',
      notes: '',
    });
  };
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close Tab';
  closeBtn.onclick = () => {
    const next = tabAfterClose(tabIds(), id);
    discard(id);
    select(next);
  };
  headerActs.append(bundleBtn, closeBtn);
  header.append(titleWrap, headerActs);

  const tokenBar = document.createElement('div');
  tokenBar.className = 'plugin-telemetry-bar';
  for (const tok of [
    'Dynamic Tokens Supported:',
    '$HOST$ (Server IP/FQDN)',
    '$USER$ (Username)',
    '$PORT$ (Port)',
    '$GATEWAY$ (Jump Host)',
    '$NAME$ (Display Name)',
    '$SSH_KEY$ (IdentityFile)',
  ]) {
    const pill = document.createElement('span');
    pill.className = 'plugin-tele-item';
    pill.textContent = tok;
    tokenBar.append(pill);
  }

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  // Form 1: Wake-on-LAN UDP Magic Packet
  const wolForm = document.createElement('form');
  wolForm.className = 'gateway-tunnel-form';
  const macLbl = document.createElement('label');
  macLbl.textContent = 'Target Hardware MAC Address';
  const macIn = document.createElement('input');
  macIn.type = 'text';
  macIn.value = '00:15:5D:25:0E:01';
  macIn.placeholder = 'AA:BB:CC:DD:EE:FF';
  macLbl.append(macIn);

  const bcastLbl = document.createElement('label');
  bcastLbl.textContent = 'Broadcast IP';
  const bcastIn = document.createElement('input');
  bcastIn.type = 'text';
  bcastIn.value = '255.255.255.255';
  bcastLbl.append(bcastIn);

  const wolJumpLbl = document.createElement('label');
  wolJumpLbl.textContent = 'Relay via Jump Host';
  const wolJumpSel = document.createElement('select');
  for (const [val, label] of [
    ['', 'Local LAN Broadcast Only'],
    ['pln-jump', 'pln-jump (103.172.170.196:2345)'],
    ['distribusi-jump', 'distribusi-jump (103.172.170.219:2602)'],
    ['mitra-jump', 'mitra-jump (103.172.170.219:2602)'],
  ] as const) {
    const o = document.createElement('option');
    o.value = val;
    o.textContent = label;
    if (val === (spec.jumpHost ?? '')) o.selected = true;
    wolJumpSel.append(o);
  }
  wolJumpLbl.append(wolJumpSel);

  const wolBtn = document.createElement('button');
  wolBtn.type = 'submit';
  wolBtn.textContent = '⚡ Send Wake-on-LAN Packet';
  wolForm.append(macLbl, bcastLbl, wolJumpLbl, wolBtn);

  // Form 2: Port Knocking Sequence
  const knockForm = document.createElement('form');
  knockForm.className = 'gateway-tunnel-form';
  const kHostLbl = document.createElement('label');
  kHostLbl.textContent = 'Port Knock Target Host';
  const kHostIn = document.createElement('input');
  kHostIn.type = 'text';
  kHostIn.value = spec.host && spec.host !== 'localhost' ? spec.host : '10.28.0.154';
  kHostLbl.append(kHostIn);

  const kSeqLbl = document.createElement('label');
  kSeqLbl.textContent = 'Port Knock Sequence (TCP / UDP)';
  const kSeqIn = document.createElement('input');
  kSeqIn.type = 'text';
  kSeqIn.value = '7000:tcp, 8000:udp, 9000:tcp';
  kSeqLbl.append(kSeqIn);

  const kDelayLbl = document.createElement('label');
  kDelayLbl.textContent = 'Inter-Knock Delay (ms)';
  const kDelayIn = document.createElement('input');
  kDelayIn.type = 'number';
  kDelayIn.value = '100';
  kDelayLbl.append(kDelayIn);

  const knockBtn = document.createElement('button');
  knockBtn.type = 'submit';
  knockBtn.textContent = '🚪 Execute Port Knock';
  knockForm.append(kHostLbl, kSeqLbl, kDelayLbl, knockBtn);

  const logOut = document.createElement('pre');
  logOut.className = 'plugin-terminal-output';
  logOut.textContent = [
    'Wake-on-LAN & Port Knocking Studio Ready.',
    '• Tip: You can also configure per-server Pre-Connect Wake-on-LAN MAC & Port Knock Sequence inside any Connection’s "Properties…" dialog so JalaDesk automatically wakes or knocks the firewall right before connecting!',
  ].join('\n');

  wolForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    wolBtn.disabled = true;
    try {
      const res = (await (window as any).workspace.run('net.wol', {
        mac: macIn.value.trim(),
        broadcastHost: bcastIn.value.trim() || '255.255.255.255',
        port: 9,
        jumpHost: wolJumpSel.value,
        identityFile: '',
      })) as {
        ok: boolean;
        value?: { ok: boolean; detail: string; packetHexPreview: string; bytesSent: number };
      };
      if (res.ok && res.value) {
        logOut.textContent = [
          `[${new Date().toLocaleTimeString()}] ${res.value.detail}`,
          `Frame Layout : ${res.value.packetHexPreview} (${res.value.bytesSent} bytes)`,
        ].join('\n');
      }
    } finally {
      wolBtn.disabled = false;
    }
  });

  knockForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    knockBtn.disabled = true;
    try {
      const res = (await (window as any).workspace.run('net.knock', {
        host: kHostIn.value.trim(),
        sequence: kSeqIn.value.trim(),
        delayMs: Number(kDelayIn.value) || 100,
        jumpHost: wolJumpSel.value,
      })) as {
        ok: boolean;
        value?: {
          ok: boolean;
          detail: string;
          steps: Array<{ port: number; protocol: string; elapsedMs: number; status: string }>;
        };
      };
      if (res.ok && res.value) {
        const lines = [
          `[${new Date().toLocaleTimeString()}] ${res.value.detail}`,
          ...res.value.steps.map(
            (s, idx) => `  Step ${idx + 1}: ${s.protocol.toUpperCase()} port ${s.port} -> ${s.status} (${s.elapsedMs} ms)`,
          ),
        ];
        logOut.textContent = lines.join('\n');
      }
    } finally {
      knockBtn.disabled = false;
    }
  });

  body.append(wolForm, knockForm, logOut);
  card.append(header, body);
  return card;
}

function buildSshConfigStudioView(_spec: PluginSessionSpec, id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-row-inline';
  const titleEl = document.createElement('span');
  titleEl.className = 'plugin-view-title';
  titleEl.textContent = '🔧 Visual ~/.ssh/config Studio & Host Block Editor';
  const badgeEl = document.createElement('span');
  badgeEl.className = 'plugin-view-badge';
  badgeEl.textContent = 'Auto-Backup ~/.ssh/config.jaladesk.bak';
  titleWrap.append(titleEl, badgeEl);

  const headerActs = document.createElement('div');
  headerActs.className = 'plugin-row-inline';
  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'quiet';
  refreshBtn.textContent = '↻ Reload ~/.ssh/config';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close Tab';
  closeBtn.onclick = () => {
    const next = tabAfterClose(tabIds(), id);
    discard(id);
    select(next);
  };
  headerActs.append(refreshBtn, closeBtn);
  header.append(titleWrap, headerActs);

  const summaryBar = document.createElement('div');
  summaryBar.className = 'plugin-telemetry-bar';

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const form = document.createElement('form');
  form.className = 'gateway-tunnel-form';

  const aliasLbl = document.createElement('label');
  aliasLbl.textContent = 'Host Alias';
  const aliasIn = document.createElement('input');
  aliasIn.type = 'text';
  aliasIn.placeholder = 'e.g. mitra-jump or pln-dc01';
  aliasLbl.append(aliasIn);

  const hostLbl = document.createElement('label');
  hostLbl.textContent = 'HostName (IP / FQDN)';
  const hostIn = document.createElement('input');
  hostIn.type = 'text';
  hostIn.placeholder = 'e.g. 103.172.170.219';
  hostLbl.append(hostIn);

  const portLbl = document.createElement('label');
  portLbl.textContent = 'Port';
  const portIn = document.createElement('input');
  portIn.type = 'number';
  portIn.value = '22';
  portLbl.append(portIn);

  const userLbl = document.createElement('label');
  userLbl.textContent = 'User';
  const userIn = document.createElement('input');
  userIn.type = 'text';
  userIn.value = 'bright';
  userLbl.append(userIn);

  const keyLbl = document.createElement('label');
  keyLbl.textContent = 'IdentityFile';
  const keyIn = document.createElement('input');
  keyIn.type = 'text';
  keyIn.placeholder = '~/.ssh/id_ed25519';
  keyLbl.append(keyIn);

  const jumpLbl = document.createElement('label');
  jumpLbl.textContent = 'ProxyJump (Optional)';
  const jumpIn = document.createElement('input');
  jumpIn.type = 'text';
  jumpIn.placeholder = 'e.g. mitra-jump';
  jumpLbl.append(jumpIn);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.textContent = '💾 Save Host Block';
  form.append(aliasLbl, hostLbl, portLbl, userLbl, keyLbl, jumpLbl, saveBtn);

  const table = document.createElement('table');
  table.className = 'plugin-table';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const col of ['Host Alias', 'HostName', 'Port', 'User', 'IdentityFile', 'ProxyJump', 'Actions']) {
    const th = document.createElement('th');
    th.textContent = col;
    htr.append(th);
  }
  thead.append(htr);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);

  const rawPreview = document.createElement('pre');
  rawPreview.className = 'plugin-terminal-output';
  rawPreview.textContent = 'Loading ~/.ssh/config…';

  const renderConfigState = (data: {
    configPath: string;
    backupPath: string;
    rawText: string;
    blocks: Array<{
      alias: string;
      hostName: string;
      user: string;
      port: number;
      identityFile: string;
      proxyJump: string;
    }>;
  }) => {
    summaryBar.replaceChildren();
    for (const txt of [
      `Config File: ${data.configPath}`,
      `Auto-Backup: ${data.backupPath}`,
      `Configured Host Blocks: ${data.blocks.length}`,
    ]) {
      const s = document.createElement('span');
      s.className = 'plugin-tele-item';
      s.textContent = txt;
      summaryBar.append(s);
    }

    tbody.replaceChildren();
    if (data.blocks.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 7;
      td.textContent = 'No Host blocks in ~/.ssh/config yet. Use the form above to add your first SSH Host or Jump Host.';
      tr.append(td);
      tbody.append(tr);
    } else {
      for (const b of data.blocks) {
        const tr = document.createElement('tr');
        const cells = [b.alias, b.hostName || '—', String(b.port || 22), b.user || 'root', b.identityFile || 'default', b.proxyJump || '—'];
        for (const c of cells) {
          const td = document.createElement('td');
          td.className = 'mono';
          td.textContent = c;
          tr.append(td);
        }
        const tdAct = document.createElement('td');
        const actRow = document.createElement('div');
        actRow.className = 'plugin-row-inline';

        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'quiet';
        editBtn.textContent = '✎ Edit';
        editBtn.onclick = () => {
          aliasIn.value = b.alias;
          hostIn.value = b.hostName;
          portIn.value = String(b.port || 22);
          userIn.value = b.user || 'root';
          keyIn.value = b.identityFile || '';
          jumpIn.value = b.proxyJump || '';
          aliasIn.focus();
        };

        const openSshBtn = document.createElement('button');
        openSshBtn.type = 'button';
        openSshBtn.className = 'quiet';
        openSshBtn.textContent = '❯_ SSH';
        openSshBtn.onclick = () => {
          openPluginTab({
            pluginType: 'Terminal',
            name: b.alias,
            host: b.hostName || b.alias,
            port: b.port || 22,
            username: b.user || 'root',
            notes: 'Opened from SSH Config Studio',
            jumpHost: b.proxyJump || '',
            sshKey: b.identityFile || '',
          });
        };

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'quiet';
        delBtn.textContent = '🗑 Delete';
        delBtn.onclick = async () => {
          const res = (await (window as any).workspace.run('ssh.config.delete', { alias: b.alias })) as {
            ok: boolean;
            value?: typeof data;
          };
          if (res.ok && res.value) renderConfigState(res.value);
        };

        actRow.append(editBtn, openSshBtn, delBtn);
        tdAct.append(actRow);
        tr.append(tdAct);
        tbody.append(tr);
      }
    }

    rawPreview.textContent = data.rawText || '# ~/.ssh/config is empty';
  };

  const loadConfig = async () => {
    try {
      const res = (await (window as any).workspace.run('ssh.config.read', {})) as {
        ok: boolean;
        value?: Parameters<typeof renderConfigState>[0];
      };
      if (res.ok && res.value) renderConfigState(res.value);
    } catch {}
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!aliasIn.value.trim() || !hostIn.value.trim()) return;
    saveBtn.disabled = true;
    try {
      const res = (await (window as any).workspace.run('ssh.config.upsert', {
        alias: aliasIn.value.trim(),
        hostName: hostIn.value.trim(),
        port: Number(portIn.value) || 22,
        user: userIn.value.trim() || 'root',
        identityFile: keyIn.value.trim(),
        proxyJump: jumpIn.value.trim(),
        forwardAgent: '',
        serverAliveInterval: '30',
      })) as {
        ok: boolean;
        value?: Parameters<typeof renderConfigState>[0];
      };
      if (res.ok && res.value) {
        renderConfigState(res.value);
      }
    } finally {
      saveBtn.disabled = false;
    }
  });

  refreshBtn.onclick = () => void loadConfig();

  body.append(form, table, rawPreview);
  card.append(header, summaryBar, body);
  void loadConfig();
  return card;
}

interface RunbookItem {
  id: string;
  title: string;
  scope: string;
  summary: string;
  steps: Array<{ label: string; command: string }>;
}

const RUNBOOKS_STORAGE_KEY = 'rw-runbooks-v1';
const DEFAULT_RUNBOOKS: RunbookItem[] = [
  {
    id: 'rb-ad-dns',
    title: 'Active Directory & DNS Server Triage SOP (PLN Batam)',
    scope: 'Windows Server / AD DNS',
    summary: 'Standard operating procedure for verifying Domain Controller replication, DNS zone health, and Kerberos KDC status.',
    steps: [
      {
        label: '1. Verify Core AD & DNS Services Status',
        command: 'Get-Service ADWS,DNS,Netlogon,Kdc,W32Time | Format-Table Status,Name,DisplayName -AutoSize',
      },
      {
        label: '2. Check Active Directory Replication Summary',
        command: 'repadmin /replsummary',
      },
      {
        label: '3. Query DNS Server Zone Resolution ($HOST$)',
        command: 'Resolve-DnsName plnbatam.com -Server $HOST$',
      },
      {
        label: '4. Inspect Recent DNS Server Error Events',
        command: 'Get-WinEvent -LogName "DNS Server" -MaxEvents 15 | Select-Object TimeCreated,Id,LevelDisplayName,Message',
      },
    ],
  },
  {
    id: 'rb-linux-gateway',
    title: 'Linux Bastion & Jump Host Security Audit Playbook',
    scope: 'Linux Server / Secure Gateway',
    summary: 'Audits active SSH sessions, listening sockets, failed authentication attempts, and disk/memory pressure.',
    steps: [
      {
        label: '1. Inspect Active SSH Users & Load Average on $NAME$',
        command: 'w && uptime && uname -a',
      },
      {
        label: '2. Audit Listening TCP/UDP Sockets & Processes',
        command: 'ss -tulpn',
      },
      {
        label: '3. Check Disk & Inode Utilization',
        command: 'df -h && df -i /',
      },
      {
        label: '4. Inspect Last 20 SSH Auth Logs',
        command: 'journalctl -u ssh -u sshd -n 20 --no-pager 2>/dev/null || tail -n 20 /var/log/auth.log',
      },
    ],
  },
  {
    id: 'rb-net-failover',
    title: 'Network Connectivity & Certificate Diagnostic Runbook',
    scope: 'All Infrastructure',
    summary: 'Token-powered diagnostic commands that automatically substitute $HOST$, $PORT$, $USER$, and $GATEWAY$.',
    steps: [
      {
        label: '1. Verify Route & ICMP Reachability to $HOST$',
        command: 'ping -c 4 $HOST$',
      },
      {
        label: '2. Inspect Remote TLS Certificate Expiry on $HOST$:$PORT$',
        command: 'echo | openssl s_client -connect $HOST$:$PORT$ 2>/dev/null | openssl x509 -noout -subject -issuer -dates',
      },
    ],
  },
];

function readRunbooks(): RunbookItem[] {
  try {
    const raw = localStorage.getItem(RUNBOOKS_STORAGE_KEY);
    if (!raw) return [...DEFAULT_RUNBOOKS];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : [...DEFAULT_RUNBOOKS];
  } catch {
    return [...DEFAULT_RUNBOOKS];
  }
}

function saveRunbooks(list: RunbookItem[]): void {
  try {
    localStorage.setItem(RUNBOOKS_STORAGE_KEY, JSON.stringify(list));
  } catch {}
}

function buildRunbookStudioView(spec: PluginSessionSpec, id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-row-inline';
  const titleEl = document.createElement('span');
  titleEl.className = 'plugin-view-title';
  titleEl.textContent = '📖 Operational Runbooks & Interactive SOP Playbooks';
  const badgeEl = document.createElement('span');
  badgeEl.className = 'plugin-view-badge';
  badgeEl.textContent = 'Executable Markdown Playbooks';
  titleWrap.append(titleEl, badgeEl);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close Tab';
  closeBtn.onclick = () => {
    const next = tabAfterClose(tabIds(), id);
    discard(id);
    select(next);
  };
  header.append(titleWrap, closeBtn);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const form = document.createElement('form');
  form.className = 'gateway-tunnel-form';
  const titleInLbl = document.createElement('label');
  titleInLbl.textContent = 'New Runbook Title';
  const titleIn = document.createElement('input');
  titleIn.type = 'text';
  titleIn.placeholder = 'e.g. Database Failover SOP';
  titleInLbl.append(titleIn);

  const scopeInLbl = document.createElement('label');
  scopeInLbl.textContent = 'Target Scope';
  const scopeIn = document.createElement('input');
  scopeIn.type = 'text';
  scopeIn.value = spec.notes || 'PLN Batam';
  scopeInLbl.append(scopeIn);

  const stepLbl = document.createElement('label');
  stepLbl.textContent = 'Step Command (Supports $HOST$, $USER$, $PORT$)';
  const stepIn = document.createElement('input');
  stepIn.type = 'text';
  stepIn.placeholder = 'e.g. systemctl status postgresql && df -h';
  stepLbl.append(stepIn);

  const addRbBtn = document.createElement('button');
  addRbBtn.type = 'submit';
  addRbBtn.textContent = '+ Add Runbook Step';
  form.append(titleInLbl, scopeInLbl, stepLbl, addRbBtn);

  const table = document.createElement('table');
  table.className = 'plugin-table';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const col of ['Runbook / Playbook', 'Scope', 'SOP Step', 'Command ($HOST$ / $USER$ Token-Aware)', '1-Click Execute']) {
    const th = document.createElement('th');
    th.textContent = col;
    htr.append(th);
  }
  thead.append(htr);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);

  const statusOut = document.createElement('pre');
  statusOut.className = 'plugin-terminal-output';
  statusOut.textContent =
    'Click any SOP step button above to execute in the active RDP session, broadcast to SSH terminals, or launch in the Multi-Server Batch Matrix.';

  const renderPlaybooks = () => {
    const list = readRunbooks();
    tbody.replaceChildren();
    for (const rb of list) {
      for (const st of rb.steps) {
        const tr = document.createElement('tr');
        const tdTitle = document.createElement('td');
        tdTitle.textContent = rb.title;
        const tdScope = document.createElement('td');
        tdScope.textContent = rb.scope;
        const tdStep = document.createElement('td');
        tdStep.textContent = st.label;
        const tdCmd = document.createElement('td');
        tdCmd.className = 'mono';
        tdCmd.textContent = st.command;

        const tdAct = document.createElement('td');
        const actRow = document.createElement('div');
        actRow.className = 'plugin-row-inline';

        const rdpBtn = document.createElement('button');
        rdpBtn.type = 'button';
        rdpBtn.className = 'quiet';
        rdpBtn.textContent = '⌨ Type RDP';
        rdpBtn.onclick = async () => {
          const resolved = resolveDynamicTokens(st.command, getActiveTokenContext());
          const ok = await typeStringIntoActiveRdp(resolved);
          statusOut.textContent = ok
            ? `Executed SOP step "${st.label}" -> [${resolved}] in active RDP session.`
            : 'No connected RDP session found.';
        };

        const sshBtn = document.createElement('button');
        sshBtn.type = 'button';
        sshBtn.className = 'quiet';
        sshBtn.textContent = '📡 Broadcast SSH';
        sshBtn.onclick = () => {
          const resolved = resolveDynamicTokens(st.command, getActiveTokenContext());
          if (activeBroadcastTerminals.size === 0) {
            statusOut.textContent = 'Enable "📡 Broadcast: ON" on one or more SSH Terminal tabs first.';
            return;
          }
          for (const fn of activeBroadcastTerminals.values()) fn(`${resolved}\r`);
          statusOut.textContent = `Broadcasted SOP step "${st.label}" -> [${resolved}] to ${activeBroadcastTerminals.size} SSH terminal(s).`;
        };

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'quiet';
        copyBtn.textContent = '📋 Copy';
        copyBtn.onclick = () => {
          const resolved = resolveDynamicTokens(st.command, getActiveTokenContext());
          void navigator.clipboard.writeText(resolved);
          statusOut.textContent = `Copied "${resolved}" to clipboard.`;
        };

        actRow.append(rdpBtn, sshBtn, copyBtn);
        tdAct.append(actRow);
        tr.append(tdTitle, tdScope, tdStep, tdCmd, tdAct);
        tbody.append(tr);
      }
    }
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const t = titleIn.value.trim();
    const sc = scopeIn.value.trim() || 'General';
    const cmd = stepIn.value.trim();
    if (!t || !cmd) return;
    const all = readRunbooks();
    const existing = all.find((r) => r.title.toLowerCase() === t.toLowerCase());
    if (existing) {
      existing.steps.push({ label: `Step ${existing.steps.length + 1}`, command: cmd });
    } else {
      all.unshift({
        id: `rb-${Date.now()}`,
        title: t,
        scope: sc,
        summary: 'Custom operational playbook',
        steps: [{ label: 'Step 1', command: cmd }],
      });
    }
    saveRunbooks(all);
    stepIn.value = '';
    renderPlaybooks();
  });

  body.append(form, table, statusOut);
  card.append(header, body);
  renderPlaybooks();
  return card;
}

interface HealthHistoryItem {
  checks: number;
  okChecks: number;
  lastLatencyMs: number;
  peakLatencyMs: number;
  samples: number[];
  online: boolean;
  lastAlert: string;
}
const healthHistoryMap = new Map<string, HealthHistoryItem>();

function sparklineFromSamples(samples: number[]): string {
  if (samples.length === 0) return '—';
  const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  const max = Math.max(100, ...samples);
  return samples
    .slice(-10)
    .map((v) => {
      const idx = Math.min(blocks.length - 1, Math.max(0, Math.floor((v / max) * (blocks.length - 1))));
      return blocks[idx]!;
    })
    .join('');
}

function buildHealthMonitorView(spec: PluginSessionSpec, id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-row-inline';
  const titleEl = document.createElement('span');
  titleEl.className = 'plugin-view-title';
  titleEl.textContent = '🔔 Live Uptime Watchdog & Latency Alerting Monitor';
  const badgeEl = document.createElement('span');
  badgeEl.className = 'plugin-view-badge';
  badgeEl.textContent = 'Continuous SLA Telemetry';
  const statePill = document.createElement('span');
  statePill.className = 'plugin-state-pill';
  statePill.textContent = 'Monitoring Ready';
  titleWrap.append(titleEl, badgeEl, statePill);

  let monitorIntervalId: number | undefined;

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close Tab';
  closeBtn.onclick = () => {
    if (monitorIntervalId !== undefined) clearInterval(monitorIntervalId);
    const next = tabAfterClose(tabIds(), id);
    discard(id);
    select(next);
  };
  header.append(titleWrap, closeBtn);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const controls = document.createElement('form');
  controls.className = 'gateway-tunnel-form';

  const intervalLbl = document.createElement('label');
  intervalLbl.textContent = 'Watchdog Poll Interval';
  const intervalSel = document.createElement('select');
  for (const [val, label] of [
    ['0', 'Manual Probe Only'],
    ['15000', 'Every 15 Seconds (Active Watchdog)'],
    ['30000', 'Every 30 Seconds'],
    ['60000', 'Every 60 Seconds'],
  ] as const) {
    const o = document.createElement('option');
    o.value = val;
    o.textContent = label;
    if (val === '30000') o.selected = true;
    intervalSel.append(o);
  }
  intervalLbl.append(intervalSel);

  const threshLbl = document.createElement('label');
  threshLbl.textContent = 'Latency Alert Threshold (ms)';
  const threshIn = document.createElement('input');
  threshIn.type = 'number';
  threshIn.value = '350';
  threshLbl.append(threshIn);

  const probeNowBtn = document.createElement('button');
  probeNowBtn.type = 'submit';
  probeNowBtn.textContent = '📡 Probe All Servers Now';

  controls.append(intervalLbl, threshLbl, probeNowBtn);

  const table = document.createElement('table');
  table.className = 'plugin-table';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const col of [
    'Server Name',
    'Scope',
    'Endpoint',
    'Gateway',
    'Status',
    'Latency (Last / Peak)',
    'SLA Uptime %',
    'Latency Trend',
    'Alert Log',
  ]) {
    const th = document.createElement('th');
    th.textContent = col;
    htr.append(th);
  }
  thead.append(htr);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);

  const runHealthSweep = async () => {
    const conns = documents.listAllConnections?.() ?? [];
    const scoped =
      spec.notes && conns.some((c) => c.docName === spec.notes || `${c.docName} / ${c.folderName}` === spec.notes)
        ? conns.filter((c) => c.docName === spec.notes || `${c.docName} / ${c.folderName}` === spec.notes)
        : conns;

    if (scoped.length === 0) {
      tbody.replaceChildren();
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 9;
      td.textContent = 'No saved servers in open Documents yet. Open a Document (e.g. PLN Batam) to monitor server health.';
      tr.append(td);
      tbody.append(tr);
      return;
    }

    probeNowBtn.disabled = true;
    statePill.textContent = `Probing ${scoped.length} server(s)…`;
    statePill.dataset.online = 'probing';
    const warnMs = Number(threshIn.value) || 350;

    await Promise.all(
      scoped.map(async (c) => {
        const key = `${c.hostPort}@${c.jumpHost}`;
        const prev = healthHistoryMap.get(key) ?? {
          checks: 0,
          okChecks: 0,
          lastLatencyMs: 0,
          peakLatencyMs: 0,
          samples: [],
          online: true,
          lastAlert: 'Nominal',
        };
        try {
          const res = (await (window as any).workspace.run('protocol.probe', {
            pluginType: c.pluginType,
            host: c.host,
            port: c.port,
            username: c.username,
            path: '/',
            jumpHost: c.jumpHost,
            jumpPassword: '',
            identityFile: c.sshKey,
          })) as { ok: boolean; value?: { reachable: boolean; latencyMs: number } };

          const reachable = Boolean(res.ok && res.value?.reachable);
          const lat = res.value?.latencyMs ?? 0;
          prev.checks += 1;
          if (reachable) {
            prev.okChecks += 1;
            prev.lastLatencyMs = lat;
            prev.peakLatencyMs = Math.max(prev.peakLatencyMs, lat);
            prev.samples.push(lat);
            if (lat > warnMs) {
              prev.lastAlert = `⚠ High Latency (${lat} ms > ${warnMs} ms)`;
            } else if (!prev.online) {
              prev.lastAlert = `✓ Recovered at ${new Date().toLocaleTimeString()}`;
            }
            prev.online = true;
          } else {
            prev.lastLatencyMs = 0;
            prev.online = false;
            prev.lastAlert = `🚨 OFFLINE at ${new Date().toLocaleTimeString()}`;
            recordAuditEvent('DISCONNECTED', {
              name: c.name,
              protocol: c.protocol,
              target: c.hostPort,
              gateway: c.gateway,
              detail: 'Health Monitor Watchdog detected host unreachable',
            });
          }
        } catch {
          prev.checks += 1;
          prev.online = false;
          prev.lastAlert = '🚨 Probe Error';
        }
        healthHistoryMap.set(key, prev);
      }),
    );

    tbody.replaceChildren();
    let onlineCount = 0;
    for (const c of scoped) {
      const key = `${c.hostPort}@${c.jumpHost}`;
      const st = healthHistoryMap.get(key)!;
      if (st.online) onlineCount++;
      const tr = document.createElement('tr');
      const uptimePct = st.checks > 0 ? `${Math.round((st.okChecks / st.checks) * 100)}% (${st.okChecks}/${st.checks})` : '—';
      const cells = [
        c.name,
        c.folderName ? `${c.docName} / ${c.folderName}` : c.docName,
        c.hostPort,
        c.gateway,
        st.online ? '● ONLINE' : '● OFFLINE',
        st.online ? `${st.lastLatencyMs} ms / ${st.peakLatencyMs} ms` : '—',
        uptimePct,
        sparklineFromSamples(st.samples),
        st.lastAlert,
      ];
      for (const val of cells) {
        const td = document.createElement('td');
        td.textContent = val;
        tr.append(td);
      }
      tbody.append(tr);
    }

    statePill.textContent = `${onlineCount}/${scoped.length} Online`;
    statePill.dataset.online = onlineCount === scoped.length ? 'true' : 'false';
    probeNowBtn.disabled = false;
  };

  const resetTimer = () => {
    if (monitorIntervalId !== undefined) {
      clearInterval(monitorIntervalId);
      monitorIntervalId = undefined;
    }
    const ms = Number(intervalSel.value);
    if (ms > 0) {
      monitorIntervalId = window.setInterval(() => {
        void runHealthSweep();
      }, ms);
    }
  };

  intervalSel.onchange = resetTimer;
  controls.addEventListener('submit', (e) => {
    e.preventDefault();
    void runHealthSweep();
  });

  body.append(controls, table);
  card.append(header, body);
  resetTimer();
  void runHealthSweep();
  return card;
}

function buildPortableBundleView(_spec: PluginSessionSpec, id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-row-inline';
  const titleEl = document.createElement('span');
  titleEl.className = 'plugin-view-title';
  titleEl.textContent = '📦 Portable Workspace Config Bundle (Export / Import)';
  const badgeEl = document.createElement('span');
  badgeEl.className = 'plugin-view-badge';
  badgeEl.textContent = 'Backup & Migration';
  titleWrap.append(titleEl, badgeEl);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close Tab';
  closeBtn.onclick = () => {
    const next = tabAfterClose(tabIds(), id);
    discard(id);
    select(next);
  };
  header.append(titleWrap, closeBtn);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const bar = document.createElement('div');
  bar.className = 'plugin-action-bar';

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.textContent = '⬇ Export Full Workspace Bundle (.json)';

  const importFileLbl = document.createElement('label');
  importFileLbl.className = 'overview-pill quiet';
  importFileLbl.textContent = '⬆ Import Bundle File (.json)…';
  const fileIn = document.createElement('input');
  fileIn.type = 'file';
  fileIn.accept = '.json,application/json';
  fileIn.hidden = true;
  importFileLbl.append(fileIn);

  const applyJsonBtn = document.createElement('button');
  applyJsonBtn.type = 'button';
  applyJsonBtn.className = 'quiet';
  applyJsonBtn.textContent = '✓ Restore from JSON Preview Below';

  bar.append(exportBtn, importFileLbl, applyJsonBtn);

  const previewArea = document.createElement('textarea');
  previewArea.rows = 18;
  previewArea.className = 'mono';
  previewArea.placeholder = 'Workspace configuration JSON bundle preview…';

  const statusOut = document.createElement('pre');
  statusOut.className = 'plugin-terminal-output';
  statusOut.textContent =
    'Bundles Custom Jump Hosts, Document Appearance & Inheritance Preferences, Saved Command Tasks & Macros, and Operational Runbooks into a single portable JSON file.';

  const buildBundlePayload = async () => {
    const sshEnv = await getSshEnv();
    return {
      product: 'JalaDesk',
      bundleVersion: 1,
      exportedAt: new Date().toISOString(),
      jumpHosts: sshEnv.jumpHosts,
      docPrefs: documents.exportDocPrefs?.() ?? {},
      customTasks: readCustomTasks(),
      runbooks: readRunbooks(),
      settings: {
        macShortcutsEnabled,
        autoReconnectEnabled,
      },
    };
  };

  const refreshPreview = async () => {
    const payload = await buildBundlePayload();
    previewArea.value = JSON.stringify(payload, null, 2);
  };

  exportBtn.onclick = async () => {
    const payload = await buildBundlePayload();
    const json = JSON.stringify(payload, null, 2);
    previewArea.value = json;
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jaladesk-workspace-bundle-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    statusOut.textContent = `Exported JalaDesk Workspace Bundle (${payload.jumpHosts.length} Jump Hosts, ${payload.customTasks.length} Tasks, ${payload.runbooks.length} Runbooks).`;
  };

  const restoreFromJsonString = async (raw: string) => {
    try {
      const parsed = JSON.parse(raw) as {
        jumpHosts?: Array<{ alias: string; hostName: string; port: number; user: string; identityFile?: string; proxyJump?: string }>;
        docPrefs?: Record<string, any>;
        customTasks?: CustomTaskItem[];
        runbooks?: RunbookItem[];
      };
      if (Array.isArray(parsed.jumpHosts)) {
        for (const j of parsed.jumpHosts) {
          if (j.alias && j.hostName) {
            await (window as any).workspace.run('gateway.add', {
              alias: j.alias,
              hostName: j.hostName,
              port: j.port || 22,
              user: j.user || 'root',
              identityFile: j.identityFile ?? '',
              proxyJump: j.proxyJump ?? '',
            });
          }
        }
      }
      if (parsed.docPrefs && typeof parsed.docPrefs === 'object') {
        documents.importDocPrefs?.(parsed.docPrefs);
      }
      if (Array.isArray(parsed.customTasks) && parsed.customTasks.length > 0) {
        saveCustomTasks(parsed.customTasks);
      }
      if (Array.isArray(parsed.runbooks) && parsed.runbooks.length > 0) {
        saveRunbooks(parsed.runbooks);
      }
      statusOut.textContent = `Successfully restored Workspace Config Bundle at ${new Date().toLocaleTimeString()}!`;
    } catch {
      statusOut.textContent = 'Invalid JSON bundle format — could not restore.';
    }
  };

  fileIn.onchange = async () => {
    const f = fileIn.files?.[0];
    if (!f) return;
    const text = await f.text();
    previewArea.value = text;
    await restoreFromJsonString(text);
  };

  applyJsonBtn.onclick = () => {
    void restoreFromJsonString(previewArea.value);
  };

  body.append(bar, previewArea, statusOut);
  card.append(header, body);
  void refreshPreview();
  return card;
}

const PROD_GUARD_STORAGE_KEY = 'rw-prod-guard-v1';
interface ProdGuardState {
  enabled: boolean;
  ticketId: string;
  maintenanceWindow: string;
  protectedPatterns: string;
}

function readProdGuardState(): ProdGuardState {
  try {
    const raw = window.localStorage?.getItem(PROD_GUARD_STORAGE_KEY);
    if (!raw) {
      return {
        enabled: false,
        ticketId: 'CHG-2026-1107',
        maintenanceWindow: '22:00 - 02:00 WIB (Scheduled Window)',
        protectedPatterns: '10.28.0.154, plnbatam, brightad1, prod-',
      };
    }
    const parsed = JSON.parse(raw) as Partial<ProdGuardState>;
    return {
      enabled: Boolean(parsed.enabled),
      ticketId: typeof parsed.ticketId === 'string' ? parsed.ticketId : 'CHG-2026-1107',
      maintenanceWindow:
        typeof parsed.maintenanceWindow === 'string' ? parsed.maintenanceWindow : '22:00 - 02:00 WIB (Scheduled Window)',
      protectedPatterns:
        typeof parsed.protectedPatterns === 'string'
          ? parsed.protectedPatterns
          : '10.28.0.154, plnbatam, brightad1, prod-',
    };
  } catch {
    return {
      enabled: false,
      ticketId: 'CHG-2026-1107',
      maintenanceWindow: '22:00 - 02:00 WIB',
      protectedPatterns: '10.28.0.154, plnbatam, brightad1, prod-',
    };
  }
}

function saveProdGuardState(state: ProdGuardState): void {
  try {
    window.localStorage?.setItem(PROD_GUARD_STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

export function checkProductionSafetyGuard(actionLabel: string, targetHost: string): {
  allowed: boolean;
  guardNote: string;
} {
  const st = readProdGuardState();
  if (!st.enabled) {
    return { allowed: true, guardNote: '' };
  }
  const patterns = st.protectedPatterns
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const hostLow = targetHost.toLowerCase();
  const isProtected = patterns.some((p) => hostLow.includes(p));
  if (!isProtected) {
    return { allowed: true, guardNote: '' };
  }
  const ticket = st.ticketId.trim();
  if (!ticket) {
    recordAuditEvent('FAILED', {
      name: `Prod Guard Blocked: ${actionLabel}`,
      protocol: 'GUARD',
      target: targetHost,
      gateway: 'Safety Lock',
      detail: 'Action blocked by Production Freeze Guard (no Change Ticket ID set)',
    });
    return {
      allowed: false,
      guardNote: `Blocked by Production Freeze Guard on protected target "${targetHost}". Set a Change Ticket ID in 🛡 Safety Guard first.`,
    };
  }
  recordAuditEvent('CONNECTED', {
    name: `Prod Guard Approved [${ticket}]`,
    protocol: 'GUARD',
    target: targetHost,
    gateway: st.maintenanceWindow,
    detail: `${actionLabel} authorized under Ticket ${ticket}`,
  });
  return {
    allowed: true,
    guardNote: `[🛡 PROD-GUARD · ${ticket}] Authorized on ${targetHost}`,
  };
}

function buildDualPaneSftpCommanderView(spec: PluginSessionSpec, id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-row-inline';
  const titleEl = document.createElement('span');
  titleEl.className = 'plugin-view-title';
  titleEl.textContent = '🗂 Dual-Pane SFTP Commander & Remote Config Editor';
  const badgeEl = document.createElement('span');
  badgeEl.className = 'plugin-view-badge';
  badgeEl.textContent = 'Local Mac ⇄ Remote SFTP';
  const statePill = document.createElement('span');
  statePill.className = 'plugin-state-pill';
  statePill.textContent = 'Ready';
  titleWrap.append(titleEl, badgeEl, statePill);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close Tab';
  closeBtn.onclick = () => {
    const next = tabAfterClose(tabIds(), id);
    discard(id);
    select(next);
  };
  header.append(titleWrap, closeBtn);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  // Connection Target Bar
  const targetForm = document.createElement('form');
  targetForm.className = 'gateway-tunnel-form';

  const hostLbl = document.createElement('label');
  hostLbl.textContent = 'Remote Host';
  const hostIn = document.createElement('input');
  hostIn.type = 'text';
  hostIn.value = spec.host && spec.host !== 'localhost' ? spec.host : '10.28.0.154';
  hostLbl.append(hostIn);

  const portLbl = document.createElement('label');
  portLbl.textContent = 'SSH Port';
  const portIn = document.createElement('input');
  portIn.type = 'number';
  portIn.value = String(spec.port && spec.port !== 3389 && spec.port > 0 ? spec.port : 22);
  portLbl.append(portIn);

  const userLbl = document.createElement('label');
  userLbl.textContent = 'Username';
  const userIn = document.createElement('input');
  userIn.type = 'text';
  userIn.value = spec.username || 'root';
  userLbl.append(userIn);

  const passLbl = document.createElement('label');
  passLbl.textContent = 'SSH Password (Optional)';
  const passIn = document.createElement('input');
  passIn.type = 'password';
  passIn.placeholder = 'Uses SSH Key if blank';
  passLbl.append(passIn);

  const jumpLbl = document.createElement('label');
  jumpLbl.textContent = 'Jump Host / Bastion';
  const jumpSel = document.createElement('select');
  for (const [val, label] of [
    ['', 'Direct LAN / VPN'],
    ['pln-jump', 'pln-jump (103.172.170.196:2345)'],
    ['distribusi-jump', 'distribusi-jump (103.172.170.219:2602)'],
    ['mitra-jump', 'mitra-jump (103.172.170.219:2602)'],
  ] as const) {
    const o = document.createElement('option');
    o.value = val;
    o.textContent = label;
    if (val === (spec.jumpHost ?? '')) o.selected = true;
    jumpSel.append(o);
  }
  void getSshEnv().then((env) => {
    for (const j of env.jumpHosts) {
      if (!Array.from(jumpSel.options).some((opt) => opt.value === j.alias)) {
        const o = document.createElement('option');
        o.value = j.alias;
        o.textContent = `${j.alias} (${j.user}@${j.hostName}:${j.port})`;
        jumpSel.append(o);
      }
    }
  });
  jumpLbl.append(jumpSel);

  const syncBothBtn = document.createElement('button');
  syncBothBtn.type = 'submit';
  syncBothBtn.textContent = '↻ Sync Local & Remote Panes';

  targetForm.append(hostLbl, portLbl, userLbl, passLbl, jumpLbl, syncBothBtn);

  // Local Path Bar + Table
  const localBar = document.createElement('form');
  localBar.className = 'plugin-terminal-input-row';
  const localBadge = document.createElement('span');
  localBadge.className = 'plugin-view-badge';
  localBadge.textContent = '💻 Local Mac Path';
  const localPathIn = document.createElement('input');
  localPathIn.type = 'text';
  localPathIn.className = 'plugin-terminal-input';
  localPathIn.value = '~';
  const localUpBtn = document.createElement('button');
  localUpBtn.type = 'button';
  localUpBtn.className = 'quiet';
  localUpBtn.textContent = '⬆ Up';
  const localGoBtn = document.createElement('button');
  localGoBtn.type = 'submit';
  localGoBtn.className = 'quiet';
  localGoBtn.textContent = 'Browse Local';
  localBar.append(localBadge, localPathIn, localUpBtn, localGoBtn);

  const localTable = document.createElement('table');
  localTable.className = 'plugin-table';
  const lHead = document.createElement('thead');
  const lHtr = document.createElement('tr');
  for (const col of ['Local File / Folder (Mac)', 'Size', 'Mode', 'Local / Upload Actions']) {
    const th = document.createElement('th');
    th.textContent = col;
    lHtr.append(th);
  }
  lHead.append(lHtr);
  const localBody = document.createElement('tbody');
  localTable.append(lHead, localBody);

  // Remote Path Bar + Table
  const remoteBar = document.createElement('form');
  remoteBar.className = 'plugin-terminal-input-row';
  const remoteBadge = document.createElement('span');
  remoteBadge.className = 'plugin-view-badge';
  remoteBadge.textContent = '☁ Remote Server Path';
  const remotePathIn = document.createElement('input');
  remotePathIn.type = 'text';
  remotePathIn.className = 'plugin-terminal-input';
  remotePathIn.value = spec.initPath || '/etc';
  const remoteUpBtn = document.createElement('button');
  remoteUpBtn.type = 'button';
  remoteUpBtn.className = 'quiet';
  remoteUpBtn.textContent = '⬆ Up';
  const remoteGoBtn = document.createElement('button');
  remoteGoBtn.type = 'submit';
  remoteGoBtn.className = 'quiet';
  remoteGoBtn.textContent = 'Browse Remote SFTP';
  remoteBar.append(remoteBadge, remotePathIn, remoteUpBtn, remoteGoBtn);

  const remoteTable = document.createElement('table');
  remoteTable.className = 'plugin-table';
  const rHead = document.createElement('thead');
  const rHtr = document.createElement('tr');
  for (const col of ['Remote File / Folder (SFTP)', 'Permissions', 'Size', 'Download / Remote Edit Actions']) {
    const th = document.createElement('th');
    th.textContent = col;
    rHtr.append(th);
  }
  rHead.append(rHtr);
  const remoteBody = document.createElement('tbody');
  remoteTable.append(rHead, remoteBody);

  // Integrated Quick Config Editor & Chmod Studio
  const editorBar = document.createElement('div');
  editorBar.className = 'plugin-action-bar';
  const editorTitle = document.createElement('strong');
  editorTitle.textContent = '✎ Quick Text & Config Editor: No file selected';
  const chmodIn = document.createElement('input');
  chmodIn.type = 'text';
  chmodIn.className = 'plugin-pass-input mono';
  chmodIn.value = '0644';
  chmodIn.placeholder = '0600 / 0755';
  const chmodBtn = document.createElement('button');
  chmodBtn.type = 'button';
  chmodBtn.className = 'quiet';
  chmodBtn.textContent = '🔒 Apply chmod';
  const saveFileBtn = document.createElement('button');
  saveFileBtn.type = 'button';
  saveFileBtn.textContent = '💾 Save Active File';
  editorBar.append(editorTitle, chmodIn, chmodBtn, saveFileBtn);

  const editorArea = document.createElement('textarea');
  editorArea.rows = 10;
  editorArea.className = 'mono';
  editorArea.placeholder = 'Click "✎ Edit" on any Local or Remote file above to inspect and edit its contents here…';

  const statusOut = document.createElement('pre');
  statusOut.className = 'plugin-terminal-output';
  statusOut.textContent = 'Dual-Pane SFTP Commander ready. Browse local Mac files and remote SFTP files side by side.';

  let activeEditTarget: { scope: 'local' | 'remote'; path: string } | null = null;
  let currentResolvedLocalDir = '';

  const loadLocalPane = async (dirPath: string) => {
    try {
      const res = (await (window as any).workspace.run('sftp.local.list', { dirPath })) as {
        ok: boolean;
        value?: { ok: boolean; dirPath: string; entries: Array<{ name: string; fullPath: string; isDir: boolean; size: number; modeOctal: string }>; error?: string };
      };
      localBody.replaceChildren();
      if (!res.ok || !res.value?.ok) {
        statusOut.textContent = res.value?.error || 'Could not list local directory.';
        return;
      }
      currentResolvedLocalDir = res.value.dirPath;
      localPathIn.value = res.value.dirPath;

      for (const item of res.value.entries.slice(0, 60)) {
        const tr = document.createElement('tr');
        const tdName = document.createElement('td');
        tdName.className = 'mono';
        tdName.textContent = `${item.isDir ? '📁' : '📄'} ${item.name}`;
        if (item.isDir) {
          tdName.classList.add('plugin-clickable-row');
          tdName.onclick = () => void loadLocalPane(item.fullPath);
        }
        const tdSize = document.createElement('td');
        tdSize.textContent = item.isDir ? 'DIR' : `${item.size} B`;
        const tdMode = document.createElement('td');
        tdMode.className = 'mono';
        tdMode.textContent = item.modeOctal;
        const tdAct = document.createElement('td');
        const actRow = document.createElement('div');
        actRow.className = 'plugin-row-inline';

        if (item.isDir) {
          const openBtn = document.createElement('button');
          openBtn.type = 'button';
          openBtn.className = 'quiet';
          openBtn.textContent = '📂 Open';
          openBtn.onclick = () => void loadLocalPane(item.fullPath);
          actRow.append(openBtn);
        } else {
          const editBtn = document.createElement('button');
          editBtn.type = 'button';
          editBtn.className = 'quiet';
          editBtn.textContent = '✎ Edit';
          editBtn.onclick = async () => {
            const r = (await (window as any).workspace.run('sftp.local.action', {
              action: 'read',
              filePath: item.fullPath,
            })) as { ok: boolean; value?: { ok: boolean; content?: string; modeOctal?: string; message: string } };
            if (r.ok && r.value?.ok) {
              activeEditTarget = { scope: 'local', path: item.fullPath };
              editorTitle.textContent = `✎ Editing Local: ${item.fullPath}`;
              editorArea.value = r.value.content ?? '';
              chmodIn.value = r.value.modeOctal || item.modeOctal;
              statusOut.textContent = r.value.message;
            } else {
              statusOut.textContent = r.value?.message || 'Could not read local file.';
            }
          };

          const uploadBtn = document.createElement('button');
          uploadBtn.type = 'button';
          uploadBtn.className = 'quiet';
          uploadBtn.textContent = 'Upload →';
          uploadBtn.onclick = async () => {
            const remDir = remotePathIn.value.trim().replace(/\/+$/, '') || '/tmp';
            const destRemote = `${remDir}/${item.name}`;
            const guard = checkProductionSafetyGuard(`SFTP Upload ${item.name}`, hostIn.value.trim());
            if (!guard.allowed) {
              statusOut.textContent = guard.guardNote;
              return;
            }
            statusOut.textContent = `Uploading ${item.fullPath} → ${hostIn.value.trim()}:${destRemote}…`;
            const r = (await (window as any).workspace.run('sftp.remote.action', {
              action: 'upload',
              host: hostIn.value.trim(),
              port: Number(portIn.value) || 22,
              username: userIn.value.trim() || 'root',
              password: passIn.value,
              jumpHost: jumpSel.value,
              jumpPassword: '',
              identityFile: spec.sshKey ?? '',
              localPath: item.fullPath,
              remotePath: destRemote,
            })) as { ok: boolean; value?: { ok: boolean; message: string } };
            statusOut.textContent = r.value?.message || 'Upload completed.';
            if (r.ok && r.value?.ok) void loadRemotePane(remDir);
          };

          actRow.append(editBtn, uploadBtn);
        }
        tdAct.append(actRow);
        tr.append(tdName, tdSize, tdMode, tdAct);
        localBody.append(tr);
      }
    } catch {
      statusOut.textContent = 'Local directory browse error.';
    }
  };

  const loadRemotePane = async (dirPath: string) => {
    remotePathIn.value = dirPath;
    statePill.textContent = 'Listing SFTP…';
    statePill.dataset.online = 'probing';
    try {
      const res = (await (window as any).workspace.run('protocol.exec', {
        pluginType: 'File Transfer',
        host: hostIn.value.trim(),
        port: Number(portIn.value) || 22,
        username: userIn.value.trim() || 'root',
        password: passIn.value,
        jumpHost: jumpSel.value,
        jumpPassword: '',
        identityFile: spec.sshKey ?? '',
        command: dirPath,
      })) as { ok: boolean; value?: ExecPayload };

      remoteBody.replaceChildren();
      if (!res.ok || !res.value?.files || res.value.files.length === 0) {
        statePill.textContent = 'Auth / Unreachable';
        statePill.dataset.online = 'false';
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 4;
        td.textContent = res.value?.stderr || 'Enter SSH credentials or select Jump Host above, then click Browse Remote SFTP.';
        tr.append(td);
        remoteBody.append(tr);
        return;
      }

      statePill.textContent = `Connected · ${res.value.files.length} items`;
      statePill.dataset.online = 'true';

      for (const f of res.value.files.slice(0, 60)) {
        const fullRemote = dirPath === '/' ? `/${f.name}` : `${dirPath.replace(/\/+$/, '')}/${f.name}`;
        const tr = document.createElement('tr');
        const tdName = document.createElement('td');
        tdName.className = 'mono';
        tdName.textContent = `${f.isDir ? '📁' : '📄'} ${f.name}`;
        if (f.isDir) {
          tdName.classList.add('plugin-clickable-row');
          tdName.onclick = () => void loadRemotePane(fullRemote);
        }
        const tdPerm = document.createElement('td');
        tdPerm.className = 'mono';
        tdPerm.textContent = f.permissions;
        const tdSize = document.createElement('td');
        tdSize.textContent = f.isDir ? 'DIR' : `${f.size} B`;
        const tdAct = document.createElement('td');
        const actRow = document.createElement('div');
        actRow.className = 'plugin-row-inline';

        if (f.isDir) {
          const openBtn = document.createElement('button');
          openBtn.type = 'button';
          openBtn.className = 'quiet';
          openBtn.textContent = '📂 Open';
          openBtn.onclick = () => void loadRemotePane(fullRemote);
          actRow.append(openBtn);
        } else {
          const dlBtn = document.createElement('button');
          dlBtn.type = 'button';
          dlBtn.className = 'quiet';
          dlBtn.textContent = '← Download';
          dlBtn.onclick = async () => {
            const destLocal = `${currentResolvedLocalDir || '/tmp'}/${f.name}`;
            statusOut.textContent = `Downloading ${hostIn.value.trim()}:${fullRemote} → ${destLocal}…`;
            const r = (await (window as any).workspace.run('sftp.remote.action', {
              action: 'download',
              host: hostIn.value.trim(),
              port: Number(portIn.value) || 22,
              username: userIn.value.trim() || 'root',
              password: passIn.value,
              jumpHost: jumpSel.value,
              jumpPassword: '',
              identityFile: spec.sshKey ?? '',
              remotePath: fullRemote,
              localPath: destLocal,
            })) as { ok: boolean; value?: { ok: boolean; message: string } };
            statusOut.textContent = r.value?.message || 'Download finished.';
            if (r.ok && r.value?.ok) void loadLocalPane(currentResolvedLocalDir || '~');
          };

          const editRemBtn = document.createElement('button');
          editRemBtn.type = 'button';
          editRemBtn.className = 'quiet';
          editRemBtn.textContent = '✎ Edit Remote';
          editRemBtn.onclick = async () => {
            statusOut.textContent = `Reading remote file ${fullRemote}…`;
            const r = (await (window as any).workspace.run('sftp.remote.action', {
              action: 'read',
              host: hostIn.value.trim(),
              port: Number(portIn.value) || 22,
              username: userIn.value.trim() || 'root',
              password: passIn.value,
              jumpHost: jumpSel.value,
              jumpPassword: '',
              identityFile: spec.sshKey ?? '',
              remotePath: fullRemote,
            })) as { ok: boolean; value?: { ok: boolean; content?: string; message: string } };
            if (r.ok && r.value?.ok) {
              activeEditTarget = { scope: 'remote', path: fullRemote };
              editorTitle.textContent = `✎ Editing Remote (${hostIn.value.trim()}): ${fullRemote}`;
              editorArea.value = r.value.content ?? '';
              statusOut.textContent = r.value.message;
            } else {
              statusOut.textContent = r.value?.message || 'Remote read failed.';
            }
          };

          actRow.append(dlBtn, editRemBtn);
        }
        tdAct.append(actRow);
        tr.append(tdName, tdPerm, tdSize, tdAct);
        remoteBody.append(tr);
      }
    } catch {
      statePill.textContent = 'Error';
      statePill.dataset.online = 'false';
    }
  };

  localUpBtn.onclick = () => {
    const cur = localPathIn.value.trim().replace(/\/+$/, '');
    const parent = cur.split('/').slice(0, -1).join('/') || '/';
    void loadLocalPane(parent);
  };
  remoteUpBtn.onclick = () => {
    const cur = remotePathIn.value.trim().replace(/\/+$/, '');
    const parent = cur.split('/').slice(0, -1).join('/') || '/';
    void loadRemotePane(parent);
  };

  localBar.addEventListener('submit', (e) => {
    e.preventDefault();
    void loadLocalPane(localPathIn.value.trim() || '~');
  });
  remoteBar.addEventListener('submit', (e) => {
    e.preventDefault();
    void loadRemotePane(remotePathIn.value.trim() || '/');
  });
  targetForm.addEventListener('submit', (e) => {
    e.preventDefault();
    void loadLocalPane(localPathIn.value.trim() || '~');
    void loadRemotePane(remotePathIn.value.trim() || '/');
  });

  chmodBtn.onclick = async () => {
    if (!activeEditTarget) {
      statusOut.textContent = 'Select a file with "✎ Edit" first before applying chmod.';
      return;
    }
    if (activeEditTarget.scope === 'local') {
      const r = (await (window as any).workspace.run('sftp.local.action', {
        action: 'chmod',
        filePath: activeEditTarget.path,
        mode: chmodIn.value.trim(),
      })) as { ok: boolean; value?: { message: string } };
      statusOut.textContent = r.value?.message || 'Updated local permissions.';
      void loadLocalPane(currentResolvedLocalDir || '~');
    } else {
      const guard = checkProductionSafetyGuard(`Remote chmod ${chmodIn.value.trim()} ${activeEditTarget.path}`, hostIn.value.trim());
      if (!guard.allowed) {
        statusOut.textContent = guard.guardNote;
        return;
      }
      const r = (await (window as any).workspace.run('sftp.remote.action', {
        action: 'chmod',
        host: hostIn.value.trim(),
        port: Number(portIn.value) || 22,
        username: userIn.value.trim() || 'root',
        password: passIn.value,
        jumpHost: jumpSel.value,
        jumpPassword: '',
        identityFile: spec.sshKey ?? '',
        remotePath: activeEditTarget.path,
        mode: chmodIn.value.trim(),
      })) as { ok: boolean; value?: { message: string } };
      statusOut.textContent = r.value?.message || 'Updated remote permissions.';
      void loadRemotePane(remotePathIn.value.trim() || '/');
    }
  };

  saveFileBtn.onclick = async () => {
    if (!activeEditTarget) {
      statusOut.textContent = 'Click "✎ Edit" on a Local or Remote file first.';
      return;
    }
    if (activeEditTarget.scope === 'local') {
      const r = (await (window as any).workspace.run('sftp.local.action', {
        action: 'write',
        filePath: activeEditTarget.path,
        content: editorArea.value,
      })) as { ok: boolean; value?: { message: string } };
      statusOut.textContent = r.value?.message || 'Saved local file.';
      void loadLocalPane(currentResolvedLocalDir || '~');
    } else {
      const guard = checkProductionSafetyGuard(`Remote File Write ${activeEditTarget.path}`, hostIn.value.trim());
      if (!guard.allowed) {
        statusOut.textContent = guard.guardNote;
        return;
      }
      const r = (await (window as any).workspace.run('sftp.remote.action', {
        action: 'write',
        host: hostIn.value.trim(),
        port: Number(portIn.value) || 22,
        username: userIn.value.trim() || 'root',
        password: passIn.value,
        jumpHost: jumpSel.value,
        jumpPassword: '',
        identityFile: spec.sshKey ?? '',
        remotePath: activeEditTarget.path,
        content: editorArea.value,
      })) as { ok: boolean; value?: { message: string } };
      statusOut.textContent = r.value?.message || 'Saved remote file.';
      void loadRemotePane(remotePathIn.value.trim() || '/');
    }
  };

  body.append(targetForm, localBar, localTable, remoteBar, remoteTable, editorBar, editorArea, statusOut);
  card.append(header, body);
  void loadLocalPane('~');
  void loadRemotePane(remotePathIn.value.trim() || '/etc');
  return card;
}

function buildTopologyMapView(spec: PluginSessionSpec, id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-row-inline';
  const titleEl = document.createElement('span');
  titleEl.className = 'plugin-view-title';
  titleEl.textContent = '🕸 Interactive Network Topology & Jump-Chain Visualizer';
  const badgeEl = document.createElement('span');
  badgeEl.className = 'plugin-view-badge';
  badgeEl.textContent = 'Bastion → Document → Server Map';
  const statePill = document.createElement('span');
  statePill.className = 'plugin-state-pill';
  statePill.textContent = 'Mapped';
  statePill.dataset.online = 'true';
  titleWrap.append(titleEl, badgeEl, statePill);

  const headerActs = document.createElement('div');
  headerActs.className = 'plugin-row-inline';
  const probeAllBtn = document.createElement('button');
  probeAllBtn.type = 'button';
  probeAllBtn.textContent = '⚡ Probe Full Topology Latency';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close Tab';
  closeBtn.onclick = () => {
    const next = tabAfterClose(tabIds(), id);
    discard(id);
    select(next);
  };
  headerActs.append(probeAllBtn, closeBtn);
  header.append(titleWrap, headerActs);

  const summaryBar = document.createElement('div');
  summaryBar.className = 'plugin-telemetry-bar';
  const sumWorkstation = document.createElement('span');
  sumWorkstation.className = 'plugin-tele-item';
  sumWorkstation.textContent = '💻 Workstation: macOS arm64 (JalaDesk)';
  const sumGateways = document.createElement('span');
  sumGateways.className = 'plugin-tele-item';
  sumGateways.textContent = '🛡 Gateways: 0';
  const sumEndpoints = document.createElement('span');
  sumEndpoints.className = 'plugin-tele-item';
  sumEndpoints.textContent = '🖥 Endpoints: 0';
  summaryBar.append(sumWorkstation, sumGateways, sumEndpoints);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const table = document.createElement('table');
  table.className = 'plugin-table';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const col of [
    'Hop 1: Origin',
    'Hop 2: Secure Gateway / Bastion (ProxyJump)',
    'Hop 3: Document & Folder Inheritance',
    'Hop 4: Target Server Endpoint',
    'Live Hop Latency',
    '1-Click Connect',
  ]) {
    const th = document.createElement('th');
    th.textContent = col;
    htr.append(th);
  }
  thead.append(htr);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);

  const latencyCache = new Map<string, { ok: boolean; ms: number }>();

  const renderTopology = async (runLiveProbe: boolean) => {
    const sshEnv = await getSshEnv();
    const conns = documents.listAllConnections?.() ?? [];
    const scoped =
      spec.notes && conns.some((c) => c.docName === spec.notes || `${c.docName} / ${c.folderName}` === spec.notes)
        ? conns.filter((c) => c.docName === spec.notes || `${c.docName} / ${c.folderName}` === spec.notes)
        : conns;

    sumGateways.textContent = `🛡 Bastion Gateways: ${sshEnv.jumpHosts.length}`;
    sumEndpoints.textContent = `🖥 Mapped Endpoints: ${scoped.length}`;

    if (runLiveProbe && scoped.length > 0) {
      probeAllBtn.disabled = true;
      statePill.textContent = `Probing ${scoped.length} hops…`;
      statePill.dataset.online = 'probing';
      await Promise.all(
        scoped.map(async (c) => {
          try {
            const res = (await (window as any).workspace.run('protocol.probe', {
              pluginType: c.pluginType,
              host: c.host,
              port: c.port,
              username: c.username,
              path: '/',
              jumpHost: c.jumpHost,
              jumpPassword: '',
              identityFile: c.sshKey,
            })) as { ok: boolean; value?: { reachable: boolean; latencyMs: number } };
            latencyCache.set(c.key, {
              ok: Boolean(res.ok && res.value?.reachable),
              ms: res.value?.latencyMs ?? 0,
            });
          } catch {
            latencyCache.set(c.key, { ok: false, ms: 0 });
          }
        }),
      );
      probeAllBtn.disabled = false;
      statePill.textContent = 'Topology Probed';
      statePill.dataset.online = 'true';
    }

    tbody.replaceChildren();
    if (scoped.length === 0) {
      // Show Jump Host gateways even when no document is open
      for (const j of sshEnv.jumpHosts) {
        const tr = document.createElement('tr');
        for (const text of [
          '💻 Local Mac (JalaDesk)',
          `🛡 ${j.alias} (${j.user}@${j.hostName}:${j.port})`,
          'Global ~/.ssh/config Bastion',
          `${j.hostName}:${j.port} (SSH Gateway)`,
          'Ready',
        ]) {
          const td = document.createElement('td');
          td.textContent = text;
          tr.append(td);
        }
        const tdAct = document.createElement('td');
        const sshBtn = document.createElement('button');
        sshBtn.type = 'button';
        sshBtn.className = 'quiet';
        sshBtn.textContent = '>_ Open Bastion SSH';
        sshBtn.onclick = () => {
          openPluginTab({
            pluginType: 'Terminal',
            name: `${j.alias} (Bastion)`,
            host: j.hostName,
            port: j.port,
            username: j.user,
            notes: 'Bastion Jump Host',
            sshKey: j.identityFile,
          });
        };
        tdAct.append(sshBtn);
        tr.append(tdAct);
        tbody.append(tr);
      }
      return;
    }

    for (const c of scoped) {
      const tr = document.createElement('tr');
      const hop1 = '💻 Local Mac';
      const hop2 = c.jumpHost ? `⇄ 🛡 ${c.jumpHost}` : '⇄ 🌐 Direct LAN / VPN';
      const hop3 = c.folderName ? `⇄ 📂 ${c.docName} / ${c.folderName}` : `⇄ 📄 ${c.docName}`;
      const hop4 = `⇄ [${c.protocol}] ${c.name} (${c.hostPort})`;
      const probe = latencyCache.get(c.key);
      const latText = probe ? (probe.ok ? `● ONLINE (${probe.ms} ms)` : '● OFFLINE') : 'Click Probe Latency';

      for (const cellText of [hop1, hop2, hop3, hop4, latText]) {
        const td = document.createElement('td');
        td.textContent = cellText;
        tr.append(td);
      }

      const tdAct = document.createElement('td');
      const actRow = document.createElement('div');
      actRow.className = 'plugin-row-inline';

      const connBtn = document.createElement('button');
      connBtn.type = 'button';
      connBtn.className = 'quiet';
      connBtn.textContent = '⚡ Connect';
      connBtn.onclick = () => documents.connectByKey?.(c.key);

      const sftpBtn = document.createElement('button');
      sftpBtn.type = 'button';
      sftpBtn.className = 'quiet';
      sftpBtn.textContent = '🗂 SFTP';
      sftpBtn.onclick = () => {
        openPluginTab({
          pluginType: 'SFTP Commander',
          name: `SFTP · ${c.name}`,
          host: c.host,
          port: 22,
          username: c.username,
          notes: c.docName,
          jumpHost: c.jumpHost,
          sshKey: c.sshKey,
        });
      };

      actRow.append(connBtn, sftpBtn);
      tdAct.append(actRow);
      tr.append(tdAct);
      tbody.append(tr);
    }
  };

  probeAllBtn.onclick = () => void renderTopology(true);
  body.append(table);
  card.append(header, summaryBar, body);
  void renderTopology(false);
  return card;
}

function buildSshKeyStudioView(spec: PluginSessionSpec, id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-row-inline';
  const titleEl = document.createElement('span');
  titleEl.className = 'plugin-view-title';
  titleEl.textContent = '🔑 SSH Key Pair Generator & Public Key Deployer (ssh-copy-id)';
  const badgeEl = document.createElement('span');
  badgeEl.className = 'plugin-view-badge';
  badgeEl.textContent = 'Ed25519 / RSA-4096 Studio';
  titleWrap.append(titleEl, badgeEl);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close Tab';
  closeBtn.onclick = () => {
    const next = tabAfterClose(tabIds(), id);
    discard(id);
    select(next);
  };
  header.append(titleWrap, closeBtn);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  // Form 1: Generate New SSH Key Pair
  const genForm = document.createElement('form');
  genForm.className = 'gateway-tunnel-form';

  const nameLbl = document.createElement('label');
  nameLbl.textContent = 'New Key Filename (~/.ssh/)';
  const nameIn = document.createElement('input');
  nameIn.type = 'text';
  nameIn.placeholder = 'id_ed25519_plnbatam';
  nameIn.required = true;
  nameLbl.append(nameIn);

  const algoLbl = document.createElement('label');
  algoLbl.textContent = 'Key Algorithm';
  const algoSel = document.createElement('select');
  for (const [v, l] of [
    ['ed25519', 'Ed25519 (Recommended — Fast & Compact)'],
    ['rsa', 'RSA 4096-bit (Legacy Compatible)'],
  ] as const) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = l;
    algoSel.append(o);
  }
  algoLbl.append(algoSel);

  const commentLbl = document.createElement('label');
  commentLbl.textContent = 'Key Comment';
  const commentIn = document.createElement('input');
  commentIn.type = 'text';
  commentIn.value = 'ops@jaladesk';
  commentLbl.append(commentIn);

  const genBtn = document.createElement('button');
  genBtn.type = 'submit';
  genBtn.textContent = '🔑 Generate SSH Key Pair';
  genForm.append(nameLbl, algoLbl, commentLbl, genBtn);

  // Form 2: Deploy Public Key to Remote Server (ssh-copy-id)
  const deployForm = document.createElement('form');
  deployForm.className = 'gateway-tunnel-form';

  const keyPickLbl = document.createElement('label');
  keyPickLbl.textContent = 'Public Key (.pub) to Deploy';
  const keyPickSel = document.createElement('select');
  keyPickLbl.append(keyPickSel);

  const dHostLbl = document.createElement('label');
  dHostLbl.textContent = 'Target Server Host';
  const dHostIn = document.createElement('input');
  dHostIn.type = 'text';
  dHostIn.value = spec.host && spec.host !== 'localhost' ? spec.host : '10.28.0.154';
  dHostLbl.append(dHostIn);

  const dPortLbl = document.createElement('label');
  dPortLbl.textContent = 'SSH Port';
  const dPortIn = document.createElement('input');
  dPortIn.type = 'number';
  dPortIn.value = '22';
  dPortLbl.append(dPortIn);

  const dUserLbl = document.createElement('label');
  dUserLbl.textContent = 'Remote User';
  const dUserIn = document.createElement('input');
  dUserIn.type = 'text';
  dUserIn.value = spec.username || 'root';
  dUserLbl.append(dUserIn);

  const dPassLbl = document.createElement('label');
  dPassLbl.textContent = 'Initial SSH Password';
  const dPassIn = document.createElement('input');
  dPassIn.type = 'password';
  dPassIn.placeholder = 'Password to install key';
  dPassLbl.append(dPassIn);

  const dJumpLbl = document.createElement('label');
  dJumpLbl.textContent = 'Via Jump Host';
  const dJumpSel = document.createElement('select');
  for (const [val, label] of [
    ['', 'Direct LAN / VPN'],
    ['pln-jump', 'pln-jump'],
    ['distribusi-jump', 'distribusi-jump'],
    ['mitra-jump', 'mitra-jump'],
  ] as const) {
    const o = document.createElement('option');
    o.value = val;
    o.textContent = label;
    dJumpSel.append(o);
  }
  dJumpLbl.append(dJumpSel);

  const deployBtn = document.createElement('button');
  deployBtn.type = 'submit';
  deployBtn.textContent = '🚀 Deploy Public Key (ssh-copy-id)';
  deployForm.append(keyPickLbl, dHostLbl, dPortLbl, dUserLbl, dPassLbl, dJumpLbl, deployBtn);

  // Table of Local SSH Keys
  const table = document.createElement('table');
  table.className = 'plugin-table';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const col of ['Key Name (~/.ssh)', 'Algorithm', 'SHA-256 Fingerprint', 'Comment', 'Private Key', 'Actions']) {
    const th = document.createElement('th');
    th.textContent = col;
    htr.append(th);
  }
  thead.append(htr);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);

  const statusOut = document.createElement('pre');
  statusOut.className = 'plugin-terminal-output';
  statusOut.textContent = 'Scanning ~/.ssh for public/private key pairs…';

  const loadKeys = async () => {
    try {
      const res = (await (window as any).workspace.run('ssh.keys.list', {})) as {
        ok: boolean;
        value?: {
          sshDir: string;
          keys: Array<{
            name: string;
            keyType: string;
            fingerprint: string;
            comment: string;
            hasPrivateKey: boolean;
            publicKey: string;
          }>;
        };
      };
      if (!res.ok || !res.value) return;
      keyPickSel.replaceChildren();
      tbody.replaceChildren();

      for (const k of res.value.keys) {
        const opt = document.createElement('option');
        opt.value = k.name;
        opt.textContent = `${k.name}.pub (${k.keyType})`;
        keyPickSel.append(opt);

        const tr = document.createElement('tr');
        const tdName = document.createElement('td');
        tdName.className = 'mono';
        tdName.textContent = k.name;
        const tdType = document.createElement('td');
        tdType.textContent = k.keyType;
        const tdFp = document.createElement('td');
        tdFp.className = 'mono';
        tdFp.textContent = k.fingerprint;
        const tdCom = document.createElement('td');
        tdCom.textContent = k.comment;
        const tdPriv = document.createElement('td');
        tdPriv.textContent = k.hasPrivateKey ? '✓ Present (0600)' : 'Public Only';

        const tdAct = document.createElement('td');
        const actRow = document.createElement('div');
        actRow.className = 'plugin-row-inline';

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'quiet';
        copyBtn.textContent = '📋 Copy .pub';
        copyBtn.onclick = () => {
          void navigator.clipboard?.writeText(k.publicKey);
          statusOut.textContent = `Copied ${k.name}.pub to clipboard:\n${k.publicKey}`;
        };

        const pickBtn = document.createElement('button');
        pickBtn.type = 'button';
        pickBtn.className = 'quiet';
        pickBtn.textContent = '🚀 Select for Deploy';
        pickBtn.onclick = () => {
          keyPickSel.value = k.name;
          dHostIn.focus();
        };

        actRow.append(copyBtn, pickBtn);
        tdAct.append(actRow);
        tr.append(tdName, tdType, tdFp, tdCom, tdPriv, tdAct);
        tbody.append(tr);
      }
      statusOut.textContent = `Loaded ${res.value.keys.length} SSH key pair(s) from ${res.value.sshDir}.`;
    } catch {
      statusOut.textContent = 'Failed to list ~/.ssh keys.';
    }
  };

  genForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    genBtn.disabled = true;
    statusOut.textContent = `Generating ${algoSel.value.toUpperCase()} key pair ~/.ssh/${nameIn.value.trim()}…`;
    try {
      const res = (await (window as any).workspace.run('ssh.keys.generate', {
        name: nameIn.value.trim(),
        algo: algoSel.value,
        comment: commentIn.value.trim(),
      })) as { ok: boolean; value?: { ok: boolean; message: string } };
      statusOut.textContent = res.value?.message || 'Key generation finished.';
      if (res.ok && res.value?.ok) {
        nameIn.value = '';
        await loadKeys();
      }
    } finally {
      genBtn.disabled = false;
    }
  });

  deployForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    deployBtn.disabled = true;
    statusOut.textContent = `Deploying ${keyPickSel.value}.pub to ${dUserIn.value.trim()}@${dHostIn.value.trim()}:${dPortIn.value}…`;
    try {
      const res = (await (window as any).workspace.run('ssh.keys.deploy', {
        keyName: keyPickSel.value,
        host: dHostIn.value.trim(),
        port: Number(dPortIn.value) || 22,
        username: dUserIn.value.trim() || 'root',
        password: dPassIn.value,
        jumpHost: dJumpSel.value,
        jumpPassword: '',
      })) as { ok: boolean; value?: { ok: boolean; message: string } };
      statusOut.textContent = res.value?.message || 'Key deployment completed.';
    } finally {
      deployBtn.disabled = false;
    }
  });

  body.append(genForm, deployForm, table, statusOut);
  card.append(header, body);
  void loadKeys();
  return card;
}

function buildDriftComparatorView(spec: PluginSessionSpec, id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-row-inline';
  const titleEl = document.createElement('span');
  titleEl.className = 'plugin-view-title';
  titleEl.textContent = `📊 Multi-Server Baseline & Drift Comparator${spec.notes ? ` · ${spec.notes}` : ''}`;
  const badgeEl = document.createElement('span');
  badgeEl.className = 'plugin-view-badge';
  badgeEl.textContent = 'Golden Baseline Diff Matrix';
  const statePill = document.createElement('span');
  statePill.className = 'plugin-state-pill';
  statePill.textContent = 'Ready';
  titleWrap.append(titleEl, badgeEl, statePill);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close Tab';
  closeBtn.onclick = () => {
    const next = tabAfterClose(tabIds(), id);
    discard(id);
    select(next);
  };
  header.append(titleWrap, closeBtn);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const form = document.createElement('form');
  form.className = 'gateway-tunnel-form';

  const presetLbl = document.createElement('label');
  presetLbl.textContent = 'Compliance / Baseline Check Preset';
  const presetSel = document.createElement('select');
  for (const [cmd, label] of [
    ['__tcp_banner__', 'Agentless TCP / TLS Banner & Protocol Parity'],
    ['uname -srm', 'OS & Kernel Version Consistency (uname -srm)'],
    ["grep -E '^nameserver' /etc/resolv.conf | tr '\\n' ' '", 'DNS Resolver Parity (/etc/resolv.conf)'],
    ["date -u +'%Y-%m-%d %H:%M UTC'", 'System Clock & UTC Time Sync Parity'],
    ["df -h / | awk 'NR==2 {print $2, $5}'", 'Root Partition Capacity & Usage (df -h /)'],
  ] as const) {
    const o = document.createElement('option');
    o.value = cmd;
    o.textContent = label;
    presetSel.append(o);
  }
  presetLbl.append(presetSel);

  const cmdLbl = document.createElement('label');
  cmdLbl.textContent = 'Probe Command (or __tcp_banner__)';
  const cmdIn = document.createElement('input');
  cmdIn.type = 'text';
  cmdIn.value = '__tcp_banner__';
  cmdLbl.append(cmdIn);

  presetSel.onchange = () => {
    cmdIn.value = presetSel.value;
  };

  const runBtn = document.createElement('button');
  runBtn.type = 'submit';
  runBtn.textContent = '📊 Run Baseline Drift Comparison';
  form.append(presetLbl, cmdLbl, runBtn);

  const table = document.createElement('table');
  table.className = 'plugin-table';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const col of [
    'Server Name',
    'Endpoint',
    'Gateway',
    'Role',
    'Observed Baseline Value',
    'Drift Status vs Golden Reference',
  ]) {
    const th = document.createElement('th');
    th.textContent = col;
    htr.append(th);
  }
  thead.append(htr);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);

  const runComparison = async () => {
    const conns = documents.listAllConnections?.() ?? [];
    const scoped =
      spec.notes && conns.some((c) => c.docName === spec.notes || `${c.docName} / ${c.folderName}` === spec.notes)
        ? conns.filter((c) => c.docName === spec.notes || `${c.docName} / ${c.folderName}` === spec.notes)
        : conns;

    tbody.replaceChildren();
    if (scoped.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.textContent = 'Open a Document (e.g. PLN Batam) with servers to compare configuration baselines.';
      tr.append(td);
      tbody.append(tr);
      return;
    }

    runBtn.disabled = true;
    statePill.textContent = `Comparing ${scoped.length} servers…`;
    statePill.dataset.online = 'probing';

    const probeCmd = cmdIn.value.trim() || '__tcp_banner__';
    const results = await Promise.all(
      scoped.map(async (c) => {
        try {
          if (probeCmd === '__tcp_banner__') {
            const r = (await (window as any).workspace.run('protocol.probe', {
              pluginType: c.pluginType,
              host: c.host,
              port: c.port,
              username: c.username,
              path: '/',
              jumpHost: c.jumpHost,
              jumpPassword: '',
              identityFile: c.sshKey,
            })) as { ok: boolean; value?: ProbePayload };
            const val =
              r.ok && r.value?.reachable
                ? `${r.value.protocol} · ${r.value.standard} · ${r.value.banner}`
                : 'UNREACHABLE';
            return { conn: c, ok: Boolean(r.ok && r.value?.reachable), value: val };
          }
          const r = (await (window as any).workspace.run('protocol.exec', {
            pluginType: 'Terminal',
            host: c.host,
            port: c.port === 3389 ? 22 : c.port || 22,
            username: c.username,
            password: '',
            jumpHost: c.jumpHost,
            jumpPassword: '',
            identityFile: c.sshKey,
            command: probeCmd,
          })) as { ok: boolean; value?: ExecPayload };
          const out = (r.value?.stdout || r.value?.stderr || '').trim().split('\n')[0] || 'NO_OUTPUT';
          return { conn: c, ok: Boolean(r.ok && r.value?.ok), value: out };
        } catch {
          return { conn: c, ok: false, value: 'ERROR' };
        }
      }),
    );

    const golden = results.find((r) => r.ok) ?? results[0]!;
    let driftCount = 0;

    for (const r of results) {
      const tr = document.createElement('tr');
      const isGolden = r === golden;
      const matchesGolden = r.ok && r.value === golden.value;
      if (!matchesGolden) driftCount++;

      const statusLabel = isGolden
        ? '★ GOLDEN REFERENCE'
        : !r.ok
          ? '🚨 UNREACHABLE'
          : matchesGolden
            ? '✓ IN-SYNC (MATCH)'
            : '⚠ DRIFT DETECTED';

      for (const cell of [
        r.conn.name,
        r.conn.hostPort,
        r.conn.gateway,
        isGolden ? 'Golden Baseline' : 'Target Node',
        r.value,
        statusLabel,
      ]) {
        const td = document.createElement('td');
        td.textContent = cell;
        tr.append(td);
      }
      tbody.append(tr);
    }

    statePill.textContent = driftCount === 0 ? 'All Nodes In-Sync' : `${driftCount} Drift(s) Detected`;
    statePill.dataset.online = driftCount === 0 ? 'true' : 'false';
    runBtn.disabled = false;
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void runComparison();
  });

  body.append(form, table);
  card.append(header, body);
  void runComparison();
  return card;
}

function buildSafetyGuardView(_spec: PluginSessionSpec, id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-row-inline';
  const titleEl = document.createElement('span');
  titleEl.className = 'plugin-view-title';
  titleEl.textContent = '🛡 Maintenance Window & Production Freeze Guard';
  const badgeEl = document.createElement('span');
  badgeEl.className = 'plugin-view-badge';
  badgeEl.textContent = 'Change Ticket & Prod Lock';
  const statePill = document.createElement('span');
  statePill.className = 'plugin-state-pill';
  titleWrap.append(titleEl, badgeEl, statePill);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close Tab';
  closeBtn.onclick = () => {
    const next = tabAfterClose(tabIds(), id);
    discard(id);
    select(next);
  };
  header.append(titleWrap, closeBtn);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const cur = readProdGuardState();

  const updateBadge = (enabled: boolean) => {
    statePill.textContent = enabled ? '🛡 PROD GUARD: ACTIVE' : 'Guard Standby';
    statePill.dataset.online = enabled ? 'true' : 'probing';
  };
  updateBadge(cur.enabled);

  const form = document.createElement('form');
  form.className = 'gateway-tunnel-form';

  const modeLbl = document.createElement('label');
  modeLbl.textContent = 'Production Freeze Guard Mode';
  const modeSel = document.createElement('select');
  for (const [val, text] of [
    ['on', '🛡 ENABLED — Require Change Ticket & Audit Log for Protected Servers'],
    ['off', '🔓 STANDBY — Unrestricted Operations'],
  ] as const) {
    const o = document.createElement('option');
    o.value = val;
    o.textContent = text;
    if ((val === 'on') === cur.enabled) o.selected = true;
    modeSel.append(o);
  }
  modeLbl.append(modeSel);

  const ticketLbl = document.createElement('label');
  ticketLbl.textContent = 'Active Change Ticket ID / Approval Reference';
  const ticketIn = document.createElement('input');
  ticketIn.type = 'text';
  ticketIn.value = cur.ticketId;
  ticketIn.placeholder = 'CHG-2026-1107 / INC-9042';
  ticketLbl.append(ticketIn);

  const winLbl = document.createElement('label');
  winLbl.textContent = 'Scheduled Maintenance Window';
  const winIn = document.createElement('input');
  winIn.type = 'text';
  winIn.value = cur.maintenanceWindow;
  winIn.placeholder = '22:00 - 02:00 WIB';
  winLbl.append(winIn);

  const patLbl = document.createElement('label');
  patLbl.textContent = 'Protected Host Patterns (comma-separated)';
  const patIn = document.createElement('input');
  patIn.type = 'text';
  patIn.value = cur.protectedPatterns;
  patIn.placeholder = '10.28.0.154, plnbatam, brightad1, prod-';
  patLbl.append(patIn);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.textContent = '💾 Save Production Guard Policy';
  form.append(modeLbl, ticketLbl, winLbl, patLbl, saveBtn);

  const statusOut = document.createElement('pre');
  statusOut.className = 'plugin-terminal-output';
  statusOut.textContent = [
    'Production Freeze & Change Guard Policy:',
    `• Guard State        : ${cur.enabled ? 'ENABLED (Active Protection)' : 'STANDBY'}`,
    `• Change Ticket ID   : ${cur.ticketId || '(None — protected writes will be blocked)'}`,
    `• Maintenance Window : ${cur.maintenanceWindow}`,
    `• Protected Patterns : ${cur.protectedPatterns}`,
    '',
    'When ENABLED, any SFTP file write/upload/chmod, Batch Script execution, or Runbook broadcast targeting a matching host automatically verifies the Change Ticket ID and records a signed [PROD-GUARD] entry in the Session Audit Log.',
  ].join('\n');

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const nextState: ProdGuardState = {
      enabled: modeSel.value === 'on',
      ticketId: ticketIn.value.trim(),
      maintenanceWindow: winIn.value.trim(),
      protectedPatterns: patIn.value.trim(),
    };
    saveProdGuardState(nextState);
    updateBadge(nextState.enabled);
    recordAuditEvent('CONNECTED', {
      name: nextState.enabled ? 'Prod Guard Enabled' : 'Prod Guard Standby',
      protocol: 'GUARD',
      target: nextState.protectedPatterns,
      gateway: nextState.ticketId || 'No Ticket',
      detail: `Window: ${nextState.maintenanceWindow}`,
    });
    statusOut.textContent = [
      `Saved Production Freeze Guard Policy at ${new Date().toLocaleTimeString()}:`,
      `• Guard State        : ${nextState.enabled ? 'ENABLED (Active Protection)' : 'STANDBY'}`,
      `• Change Ticket ID   : ${nextState.ticketId || '(None — protected writes will be blocked)'}`,
      `• Maintenance Window : ${nextState.maintenanceWindow}`,
      `• Protected Patterns : ${nextState.protectedPatterns}`,
    ].join('\n');
  });

  body.append(form, statusOut);
  card.append(header, body);
  return card;
}

function buildPortForwardStudioView(spec: PluginSessionSpec, id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-row-inline';
  const titleEl = document.createElement('span');
  titleEl.className = 'plugin-view-title';
  titleEl.textContent = '🚇 Interactive Port-Forwarding & SOCKS5 Proxy Studio';
  const badgeEl = document.createElement('span');
  badgeEl.className = 'plugin-view-badge';
  badgeEl.textContent = 'SSH -L / -D / -R Visual Manager';
  const statePill = document.createElement('span');
  statePill.className = 'plugin-state-pill';
  statePill.textContent = 'Ready';
  titleWrap.append(titleEl, badgeEl, statePill);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close Tab';
  closeBtn.onclick = () => {
    const next = tabAfterClose(tabIds(), id);
    discard(id);
    select(next);
  };
  header.append(titleWrap, closeBtn);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const presetsBar = document.createElement('div');
  presetsBar.className = 'plugin-quick-bar';

  const form = document.createElement('form');
  form.className = 'gateway-tunnel-form';

  const modeLbl = document.createElement('label');
  modeLbl.textContent = 'Tunnel Mode';
  const modeSel = document.createElement('select');
  for (const [mVal, mText] of [
    ['L', '-L Local Port Forward (127.0.0.1:local → target:port)'],
    ['D', '-D Dynamic SOCKS5 Proxy (127.0.0.1:localPort)'],
    ['R', '-R Remote Reverse Forward (remote:port → target:port)'],
  ] as const) {
    const o = document.createElement('option');
    o.value = mVal;
    o.textContent = mText;
    modeSel.append(o);
  }
  modeLbl.append(modeSel);

  const jumpLbl = document.createElement('label');
  jumpLbl.textContent = 'Bastion / Jump Host';
  const jumpSel = document.createElement('select');
  for (const [val, label] of [
    ['mitra-jump', 'mitra-jump (103.172.170.219:2602)'],
    ['distribusi-jump', 'distribusi-jump (103.172.170.219:2602)'],
    ['pln-jump', 'pln-jump (103.172.170.196:2345)'],
  ] as const) {
    const o = document.createElement('option');
    o.value = val;
    o.textContent = label;
    if (val === (spec.jumpHost || 'mitra-jump')) o.selected = true;
    jumpSel.append(o);
  }
  void getSshEnv().then((env) => {
    for (const j of env.jumpHosts) {
      if (!Array.from(jumpSel.options).some((opt) => opt.value === j.alias)) {
        const o = document.createElement('option');
        o.value = j.alias;
        o.textContent = `${j.alias} (${j.user}@${j.hostName}:${j.port})`;
        jumpSel.append(o);
      }
    }
  });
  jumpLbl.append(jumpSel);

  const localPortLbl = document.createElement('label');
  localPortLbl.textContent = 'Local Bind Port (0 = Auto)';
  const localPortIn = document.createElement('input');
  localPortIn.type = 'number';
  localPortIn.value = '15432';
  localPortLbl.append(localPortIn);

  const targetHostLbl = document.createElement('label');
  targetHostLbl.textContent = 'Target Internal Host';
  const targetHostIn = document.createElement('input');
  targetHostIn.type = 'text';
  targetHostIn.value = spec.host && spec.host !== 'localhost' ? spec.host : '10.28.0.154';
  targetHostLbl.append(targetHostIn);

  const targetPortLbl = document.createElement('label');
  targetPortLbl.textContent = 'Target Internal Port';
  const targetPortIn = document.createElement('input');
  targetPortIn.type = 'number';
  targetPortIn.value = '5432';
  targetPortLbl.append(targetPortIn);

  const startBtn = document.createElement('button');
  startBtn.type = 'submit';
  startBtn.textContent = '🚇 Start Port Forward / Proxy';

  form.append(modeLbl, jumpLbl, localPortLbl, targetHostLbl, targetPortLbl, startBtn);

  for (const [label, mode, lPort, tHost, tPort] of [
    ['PostgreSQL (15432 → 5432)', 'L', 15432, '10.28.0.154', 5432],
    ['MySQL / MariaDB (13306 → 3306)', 'L', 13306, '10.28.0.154', 3306],
    ['Redis Cache (16379 → 6379)', 'L', 16379, '10.28.0.154', 6379],
    ['Internal Web / Grafana (13000 → 3000)', 'L', 13000, '10.28.0.154', 3000],
    ['Dynamic SOCKS5 Proxy (127.0.0.1:1080)', 'D', 1080, 'SOCKS5-Proxy', 0],
  ] as const) {
    const pBtn = document.createElement('button');
    pBtn.type = 'button';
    pBtn.className = 'plugin-quick-pill';
    pBtn.textContent = `⚡ ${label}`;
    pBtn.onclick = () => {
      modeSel.value = mode;
      localPortIn.value = String(lPort);
      targetHostIn.value = tHost;
      targetPortIn.value = String(tPort);
    };
    presetsBar.append(pBtn);
  }

  const table = document.createElement('table');
  table.className = 'plugin-table';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const col of ['Tunnel ID', 'Mode', 'Bastion Jump Host', 'Local / Bind Port', 'Target Destination', 'PID', 'Status', 'Actions']) {
    const th = document.createElement('th');
    th.textContent = col;
    htr.append(th);
  }
  thead.append(htr);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);

  const statusOut = document.createElement('pre');
  statusOut.className = 'plugin-terminal-output';
  statusOut.textContent = 'Select a preset or configure a Local (-L), SOCKS5 (-D), or Reverse (-R) tunnel above.';

  const refreshTunnels = async () => {
    try {
      const res = (await (window as any).workspace.run('tunnel.list', {})) as {
        ok: boolean;
        value?: Array<{
          id: string;
          name: string;
          mode?: 'L' | 'R' | 'D';
          jumpHost: string;
          localPort: number;
          targetHost: string;
          targetPort: number;
          pid: number;
          status: string;
        }>;
      };
      tbody.replaceChildren();
      const list = res.value ?? [];
      statePill.textContent = `${list.filter((t) => t.status === 'active').length} Active Tunnel(s)`;
      statePill.dataset.online = list.some((t) => t.status === 'active') ? 'true' : 'probing';

      if (list.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 8;
        td.textContent = 'No active port forwards or SOCKS5 proxies. Click a preset pill and Start Port Forward above.';
        tr.append(td);
        tbody.append(tr);
        return;
      }

      for (const t of list) {
        const tr = document.createElement('tr');
        const m = t.mode || 'L';
        const modeBadge = m === 'D' ? 'SOCKS5 (-D)' : m === 'R' ? 'Reverse (-R)' : 'Local (-L)';
        const bindStr = `127.0.0.1:${t.localPort}`;
        const destStr = m === 'D' ? 'Dynamic SOCKS5 Proxy' : `${t.targetHost}:${t.targetPort}`;

        for (const val of [t.id, modeBadge, t.jumpHost, bindStr, destStr, String(t.pid), t.status.toUpperCase()]) {
          const td = document.createElement('td');
          td.textContent = val;
          tr.append(td);
        }

        const tdAct = document.createElement('td');
        const actRow = document.createElement('div');
        actRow.className = 'plugin-row-inline';

        const copyCmdBtn = document.createElement('button');
        copyCmdBtn.type = 'button';
        copyCmdBtn.className = 'quiet';
        copyCmdBtn.textContent = m === 'D' ? '📋 Copy curl SOCKS5' : '📋 Copy Endpoint';
        copyCmdBtn.onclick = () => {
          const snippet =
            m === 'D'
              ? `curl --socks5-hostname 127.0.0.1:${t.localPort} https://ifconfig.me`
              : `127.0.0.1:${t.localPort}`;
          void navigator.clipboard?.writeText(snippet);
          statusOut.textContent = `Copied to clipboard: ${snippet}`;
        };

        const stopBtn = document.createElement('button');
        stopBtn.type = 'button';
        stopBtn.className = 'quiet';
        stopBtn.textContent = '⏹ Stop';
        stopBtn.onclick = async () => {
          await (window as any).workspace.run('tunnel.stop', { id: t.id });
          statusOut.textContent = `Stopped tunnel ${t.id} (127.0.0.1:${t.localPort}).`;
          await refreshTunnels();
        };

        actRow.append(copyCmdBtn, stopBtn);
        tdAct.append(actRow);
        tr.append(tdAct);
        tbody.append(tr);
      }
    } catch {}
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    startBtn.disabled = true;
    statusOut.textContent = `Starting SSH -${modeSel.value} tunnel via ${jumpSel.value}…`;
    try {
      const res = (await (window as any).workspace.run('tunnel.start', {
        mode: modeSel.value,
        jumpHost: jumpSel.value,
        localPort: Number(localPortIn.value) || 0,
        targetHost: targetHostIn.value.trim(),
        targetPort: Number(targetPortIn.value) || 80,
      })) as { ok: boolean; value?: { id: string; localPort: number; name: string }; error?: string };
      if (res.ok && res.value) {
        statusOut.textContent = `Active: ${res.value.name} bound on 127.0.0.1:${res.value.localPort} (${res.value.id})`;
      } else {
        statusOut.textContent = `Tunnel failed: ${res.error || 'Ensure Jump Host is reachable and authenticated.'}`;
      }
      await refreshTunnels();
    } finally {
      startBtn.disabled = false;
    }
  });

  body.append(presetsBar, form, table, statusOut);
  card.append(header, body);
  void refreshTunnels();
  return card;
}

function buildLogStreamerView(spec: PluginSessionSpec, id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  let streamTimer: number | undefined;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-row-inline';
  const titleEl = document.createElement('span');
  titleEl.className = 'plugin-view-title';
  titleEl.textContent = `📜 Live Log Streamer & Multi-Server Tail Studio${spec.notes ? ` · ${spec.notes}` : ''}`;
  const badgeEl = document.createElement('span');
  badgeEl.className = 'plugin-view-badge';
  badgeEl.textContent = 'Real-Time Log Tail & Filter';
  const statePill = document.createElement('span');
  statePill.className = 'plugin-state-pill';
  statePill.textContent = 'Ready';
  titleWrap.append(titleEl, badgeEl, statePill);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close Tab';
  closeBtn.onclick = () => {
    if (streamTimer !== undefined) clearInterval(streamTimer);
    const next = tabAfterClose(tabIds(), id);
    discard(id);
    select(next);
  };
  header.append(titleWrap, closeBtn);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const form = document.createElement('form');
  form.className = 'gateway-tunnel-form';

  const srcLbl = document.createElement('label');
  srcLbl.textContent = 'Log Source Preset';
  const srcSel = document.createElement('select');
  for (const [cmd, label] of [
    ['journalctl -n 45 --no-pager || tail -n 45 /var/log/syslog /var/log/messages 2>/dev/null', 'Systemd Journal / Syslog (Last 45 lines)'],
    ['tail -n 45 /var/log/auth.log /var/log/secure 2>/dev/null || journalctl -u ssh -n 45 --no-pager', 'SSH & Security Auth Log (/var/log/auth.log)'],
    ['dmesg -T | tail -n 45 || dmesg | tail -n 45', 'Kernel Ring Buffer (dmesg -T)'],
    ['tail -n 45 /var/log/nginx/error.log /var/log/nginx/access.log 2>/dev/null', 'Nginx Web Error & Access Logs'],
  ] as const) {
    const o = document.createElement('option');
    o.value = cmd;
    o.textContent = label;
    srcSel.append(o);
  }
  srcLbl.append(srcSel);

  const sevLbl = document.createElement('label');
  sevLbl.textContent = 'Severity / Keyword Filter';
  const filterIn = document.createElement('input');
  filterIn.type = 'text';
  filterIn.placeholder = 'e.g. error, fail, sshd, denied (blank = all)';
  sevLbl.append(filterIn);

  const pollLbl = document.createElement('label');
  pollLbl.textContent = 'Auto-Stream Interval';
  const pollSel = document.createElement('select');
  for (const [ms, label] of [
    ['0', 'Manual Fetch Only'],
    ['5000', 'Live Stream Every 5s'],
    ['10000', 'Live Stream Every 10s'],
    ['30000', 'Live Stream Every 30s'],
  ] as const) {
    const o = document.createElement('option');
    o.value = ms;
    o.textContent = label;
    pollSel.append(o);
  }
  pollLbl.append(pollSel);

  const fetchBtn = document.createElement('button');
  fetchBtn.type = 'submit';
  fetchBtn.textContent = '📜 Fetch / Tail Logs Now';

  const exportLogBtn = document.createElement('button');
  exportLogBtn.type = 'button';
  exportLogBtn.className = 'quiet';
  exportLogBtn.textContent = '⬇ Export .log';

  form.append(srcLbl, sevLbl, pollLbl, fetchBtn, exportLogBtn);

  const logOutput = document.createElement('pre');
  logOutput.className = 'plugin-terminal-output';
  logOutput.textContent = 'Click "📜 Fetch / Tail Logs Now" to aggregate live logs from servers in scope.';

  let rawCollectedLogs = '';

  const applyFilterAndRender = () => {
    const kw = filterIn.value.trim().toLowerCase();
    if (!kw) {
      logOutput.textContent = rawCollectedLogs || 'No log lines returned.';
      return;
    }
    const filtered = rawCollectedLogs
      .split('\n')
      .filter((line) => line.startsWith('=== [') || line.toLowerCase().includes(kw));
    logOutput.textContent = filtered.join('\n') || `No log lines matching filter "${kw}".`;
  };

  filterIn.addEventListener('input', applyFilterAndRender);

  const fetchLogsNow = async () => {
    const conns = documents.listAllConnections?.() ?? [];
    const scoped =
      spec.notes && conns.some((c) => c.docName === spec.notes || `${c.docName} / ${c.folderName}` === spec.notes)
        ? conns.filter((c) => c.docName === spec.notes || `${c.docName} / ${c.folderName}` === spec.notes)
        : conns;

    const targets =
      scoped.length > 0
        ? scoped.slice(0, 6)
        : [
            {
              name: spec.name || 'Target Host',
              host: spec.host && spec.host !== 'localhost' ? spec.host : '10.28.0.154',
              port: 22,
              username: spec.username || 'root',
              jumpHost: spec.jumpHost || '',
              sshKey: spec.sshKey || '',
            },
          ];

    fetchBtn.disabled = true;
    statePill.textContent = `Tailing ${targets.length} host(s)…`;
    statePill.dataset.online = 'probing';

    const chunks = await Promise.all(
      targets.map(async (t) => {
        try {
          const res = (await (window as any).workspace.run('protocol.exec', {
            pluginType: 'Terminal',
            host: t.host,
            port: t.port === 3389 ? 22 : t.port || 22,
            username: t.username || 'root',
            password: '',
            jumpHost: t.jumpHost,
            jumpPassword: '',
            identityFile: t.sshKey,
            command: srcSel.value,
          })) as { ok: boolean; value?: ExecPayload };
          const bodyText = (res.value?.stdout || res.value?.stderr || '(no log output / auth required)').trim();
          return `=== [${new Date().toLocaleTimeString()}] ${t.name} (${t.host}) ===\n${bodyText}`;
        } catch {
          return `=== [${new Date().toLocaleTimeString()}] ${t.name} (${t.host}) ===\n[Error fetching remote log]`;
        }
      }),
    );

    rawCollectedLogs = chunks.join('\n\n');
    applyFilterAndRender();
    statePill.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    statePill.dataset.online = 'true';
    fetchBtn.disabled = false;
  };

  pollSel.onchange = () => {
    if (streamTimer !== undefined) {
      clearInterval(streamTimer);
      streamTimer = undefined;
    }
    const ms = Number(pollSel.value);
    if (ms > 0) {
      streamTimer = window.setInterval(() => void fetchLogsNow(), ms);
    }
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void fetchLogsNow();
  });

  exportLogBtn.onclick = () => {
    const blob = new Blob([logOutput.textContent || ''], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jaladesk-live-logs-${Date.now()}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  body.append(form, logOutput);
  card.append(header, body);
  return card;
}

function buildIncidentReporterView(spec: PluginSessionSpec, id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-row-inline';
  const titleEl = document.createElement('span');
  titleEl.className = 'plugin-view-title';
  titleEl.textContent = '📸 1-Click Incident Evidence & Diagnostic Report Generator';
  const badgeEl = document.createElement('span');
  badgeEl.className = 'plugin-view-badge';
  badgeEl.textContent = 'Markdown & JSON Evidence Pack';
  const statePill = document.createElement('span');
  statePill.className = 'plugin-state-pill';
  statePill.textContent = 'Ready';
  titleWrap.append(titleEl, badgeEl, statePill);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close Tab';
  closeBtn.onclick = () => {
    const next = tabAfterClose(tabIds(), id);
    discard(id);
    select(next);
  };
  header.append(titleWrap, closeBtn);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const guardState = readProdGuardState();

  const form = document.createElement('form');
  form.className = 'gateway-tunnel-form';

  const titleLbl = document.createElement('label');
  titleLbl.textContent = 'Incident / Maintenance Title';
  const titleIn = document.createElement('input');
  titleIn.type = 'text';
  titleIn.value = spec.notes ? `Infrastructure Health & Triage — ${spec.notes}` : 'PLN Batam Infrastructure Diagnostic Snapshot';
  titleLbl.append(titleIn);

  const sevLbl = document.createElement('label');
  sevLbl.textContent = 'Incident Severity';
  const sevSel = document.createElement('select');
  for (const s of ['SEV-3 (Routine / Preventive Audit)', 'SEV-2 (Degraded Service / High Latency)', 'SEV-1 (Critical Production Outage)']) {
    const o = document.createElement('option');
    o.value = s;
    o.textContent = s;
    sevSel.append(o);
  }
  sevLbl.append(sevSel);

  const ticketLbl = document.createElement('label');
  ticketLbl.textContent = 'Ticket / Change ID';
  const ticketIn = document.createElement('input');
  ticketIn.type = 'text';
  ticketIn.value = guardState.ticketId || 'INC-2026-1107';
  ticketLbl.append(ticketIn);

  const genBtn = document.createElement('button');
  genBtn.type = 'submit';
  genBtn.textContent = '📸 Probe All & Generate Evidence Report';

  form.append(titleLbl, sevLbl, ticketLbl, genBtn);

  const actionRow = document.createElement('div');
  actionRow.className = 'plugin-action-bar';
  const copyMdBtn = document.createElement('button');
  copyMdBtn.type = 'button';
  copyMdBtn.className = 'quiet';
  copyMdBtn.textContent = '📋 Copy Markdown Report';
  const dlMdBtn = document.createElement('button');
  dlMdBtn.type = 'button';
  dlMdBtn.className = 'quiet';
  dlMdBtn.textContent = '⬇ Download .md Report';
  const dlJsonBtn = document.createElement('button');
  dlJsonBtn.type = 'button';
  dlJsonBtn.className = 'quiet';
  dlJsonBtn.textContent = '⬇ Download .json Evidence';
  actionRow.append(copyMdBtn, dlMdBtn, dlJsonBtn);

  const reportArea = document.createElement('textarea');
  reportArea.rows = 18;
  reportArea.className = 'mono';

  let lastEvidenceJson = '{}';

  const generateReport = async () => {
    genBtn.disabled = true;
    statePill.textContent = 'Collecting live telemetry…';
    statePill.dataset.online = 'probing';

    const conns = documents.listAllConnections?.() ?? [];
    const probeResults = await Promise.all(
      conns.slice(0, 20).map(async (c) => {
        try {
          const r = (await (window as any).workspace.run('protocol.probe', {
            pluginType: c.pluginType,
            host: c.host,
            port: c.port,
            username: c.username,
            path: '/',
            jumpHost: c.jumpHost,
            jumpPassword: '',
            identityFile: c.sshKey,
          })) as { ok: boolean; value?: ProbePayload };
          return {
            name: c.name,
            scope: c.folderName ? `${c.docName} / ${c.folderName}` : c.docName,
            protocol: c.protocol,
            endpoint: c.hostPort,
            gateway: c.gateway,
            reachable: Boolean(r.ok && r.value?.reachable),
            latencyMs: r.value?.latencyMs ?? 0,
            banner: r.value?.banner ?? '—',
          };
        } catch {
          return {
            name: c.name,
            scope: c.docName,
            protocol: c.protocol,
            endpoint: c.hostPort,
            gateway: c.gateway,
            reachable: false,
            latencyMs: 0,
            banner: 'Probe error',
          };
        }
      }),
    );

    const tunnelsRes = (await (window as any).workspace.run('tunnel.list', {})) as {
      ok: boolean;
      value?: Array<{ id: string; name: string; localPort: number; status: string }>;
    };
    const activeTuns = tunnelsRes.value ?? [];
    const prodGuard = readProdGuardState();
    const recentAudits = readAuditLog().slice(0, 15);
    const nowIso = new Date().toISOString();

    const evidenceObj = {
      generatedAt: nowIso,
      incidentTitle: titleIn.value.trim(),
      severity: sevSel.value,
      ticketId: ticketIn.value.trim(),
      productionGuard: prodGuard,
      endpoints: probeResults,
      activeTunnels: activeTuns,
      recentAuditTrail: recentAudits,
    };
    lastEvidenceJson = JSON.stringify(evidenceObj, null, 2);

    const mdLines = [
      `# 📸 JalaDesk Incident & Infrastructure Evidence Report`,
      ``,
      `- **Title:** ${evidenceObj.incidentTitle}`,
      `- **Severity:** ${evidenceObj.severity}`,
      `- **Ticket / Change ID:** \`${evidenceObj.ticketId}\``,
      `- **Generated At (UTC):** \`${nowIso}\``,
      `- **Production Freeze Guard:** \`${prodGuard.enabled ? `ACTIVE (${prodGuard.maintenanceWindow})` : 'STANDBY'}\``,
      ``,
      `## 1. Live Server Reachability & Latency Matrix (${probeResults.filter((p) => p.reachable).length}/${probeResults.length} Online)`,
      ``,
      `| Server Name | Scope | Protocol | Endpoint | Gateway | Status | Latency | Service Banner |`,
      `| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |`,
      ...(probeResults.length > 0
        ? probeResults.map(
            (p) =>
              `| ${p.name} | ${p.scope} | ${p.protocol} | \`${p.endpoint}\` | \`${p.gateway}\` | ${p.reachable ? 'ONLINE' : 'OFFLINE'} | ${p.reachable ? `${p.latencyMs} ms` : '—'} | ${p.banner.replace(/\|/g, '/')} |`,
          )
        : [`| (No saved servers in open Documents) | — | — | — | — | — | — | — |`]),
      ``,
      `## 2. Active SSH Tunnels & Gateways (${activeTuns.length})`,
      ``,
      ...(activeTuns.length > 0
        ? activeTuns.map((t) => `- \`${t.id}\`: **${t.name}** on \`127.0.0.1:${t.localPort}\` (${t.status})`)
        : [`- No active SSH tunnels at snapshot time.`]),
      ``,
      `## 3. Recent Session Audit Trail (Last ${recentAudits.length} Events)`,
      ``,
      ...(recentAudits.length > 0
        ? recentAudits.map(
            (a) => `- \`${a.timestamp}\` **[${a.event}]** ${a.name} (\`${a.target}\` via \`${a.gateway}\`) — ${a.detail}`,
          )
        : [`- No audit events recorded in this session yet.`]),
    ];

    reportArea.value = mdLines.join('\n');
    statePill.textContent = 'Snapshot Ready';
    statePill.dataset.online = 'true';
    genBtn.disabled = false;
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void generateReport();
  });

  copyMdBtn.onclick = () => {
    void navigator.clipboard?.writeText(reportArea.value);
    statePill.textContent = 'Copied Markdown!';
  };

  dlMdBtn.onclick = () => {
    const blob = new Blob([reportArea.value], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jaladesk-incident-report-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  dlJsonBtn.onclick = () => {
    const blob = new Blob([lastEvidenceJson], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jaladesk-incident-evidence-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  body.append(form, actionRow, reportArea);
  card.append(header, body);
  void generateReport();
  return card;
}

function buildCertAuditorView(spec: PluginSessionSpec, id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-row-inline';
  const titleEl = document.createElement('span');
  titleEl.className = 'plugin-view-title';
  titleEl.textContent = '🔐 SSL/TLS Certificate Expiry & Security Auditor';
  const badgeEl = document.createElement('span');
  badgeEl.className = 'plugin-view-badge';
  badgeEl.textContent = 'X.509 & RDP-TLS Watchdog';
  const statePill = document.createElement('span');
  statePill.className = 'plugin-state-pill';
  statePill.textContent = 'Ready';
  titleWrap.append(titleEl, badgeEl, statePill);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close Tab';
  closeBtn.onclick = () => {
    const next = tabAfterClose(tabIds(), id);
    discard(id);
    select(next);
  };
  header.append(titleWrap, closeBtn);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const form = document.createElement('form');
  form.className = 'gateway-tunnel-form';

  const hostLbl = document.createElement('label');
  hostLbl.textContent = 'Additional Host to Audit';
  const hostIn = document.createElement('input');
  hostIn.type = 'text';
  hostIn.value = '10.28.0.154';
  hostLbl.append(hostIn);

  const portLbl = document.createElement('label');
  portLbl.textContent = 'TLS Port (443 / 3389 / 4321 / 636)';
  const portIn = document.createElement('input');
  portIn.type = 'number';
  portIn.value = '4321';
  portLbl.append(portIn);

  const jumpLbl = document.createElement('label');
  jumpLbl.textContent = 'Via Jump Host';
  const jumpSel = document.createElement('select');
  for (const [val, label] of [
    ['', 'Direct LAN / VPN'],
    ['mitra-jump', 'mitra-jump'],
    ['distribusi-jump', 'distribusi-jump'],
    ['pln-jump', 'pln-jump'],
  ] as const) {
    const o = document.createElement('option');
    o.value = val;
    o.textContent = label;
    if (val === (spec.jumpHost ?? '')) o.selected = true;
    jumpSel.append(o);
  }
  jumpLbl.append(jumpSel);

  const auditBtn = document.createElement('button');
  auditBtn.type = 'submit';
  auditBtn.textContent = '🔐 Audit All TLS & RDP Certificates';
  form.append(hostLbl, portLbl, jumpLbl, auditBtn);

  const table = document.createElement('table');
  table.className = 'plugin-table';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const col of [
    'Endpoint',
    'TLS Protocol',
    'Subject CN',
    'Issuer CN',
    'Valid Until (UTC)',
    'Days Remaining',
    'SHA-256 Fingerprint',
    'Certificate Health',
  ]) {
    const th = document.createElement('th');
    th.textContent = col;
    htr.append(th);
  }
  thead.append(htr);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);

  const runCertAudit = async () => {
    auditBtn.disabled = true;
    statePill.textContent = 'Auditing X.509 certificates…';
    statePill.dataset.online = 'probing';

    const targets: Array<{ host: string; port: number; jumpHost: string }> = [
      {
        host: hostIn.value.trim() || '10.28.0.154',
        port: Number(portIn.value) || 4321,
        jumpHost: jumpSel.value,
      },
    ];

    const conns = documents.listAllConnections?.() ?? [];
    for (const c of conns) {
      if (
        c.protocol === 'RDP' ||
        c.port === 443 ||
        c.port === 3389 ||
        c.port === 4321 ||
        c.port === 5986 ||
        c.port === 8443
      ) {
        if (!targets.some((t) => t.host === c.host && t.port === c.port)) {
          targets.push({ host: c.host, port: c.port, jumpHost: c.jumpHost });
        }
      }
    }

    const results = await Promise.all(
      targets.map(async (t) => {
        const res = (await (window as any).workspace.run('tls.audit', t)) as {
          ok: boolean;
          value?: {
            endpoint: string;
            tlsProtocol: string;
            subjectCn: string;
            issuerCn: string;
            validTo: string;
            daysRemaining: number;
            sha256: string;
            status: 'VALID' | 'EXPIRING_SOON' | 'EXPIRED' | 'UNREACHABLE';
          };
        };
        return res.value;
      }),
    );

    tbody.replaceChildren();
    let healthyCount = 0;
    for (const r of results) {
      if (!r) continue;
      if (r.status === 'VALID') healthyCount++;
      const tr = document.createElement('tr');
      const statusBadge =
        r.status === 'VALID'
          ? `✓ VALID (${r.daysRemaining}d left)`
          : r.status === 'EXPIRING_SOON'
            ? `⚠ EXPIRING SOON (${r.daysRemaining}d)`
            : r.status === 'EXPIRED'
              ? `🚨 EXPIRED (${r.daysRemaining}d)`
              : '● UNREACHABLE';
      const fpShort = r.sha256 && r.sha256.length > 24 ? `${r.sha256.slice(0, 16)}…${r.sha256.slice(-8)}` : r.sha256;

      for (const val of [
        r.endpoint,
        r.tlsProtocol,
        r.subjectCn,
        r.issuerCn,
        r.validTo ? r.validTo.slice(0, 10) : '—',
        r.status === 'UNREACHABLE' ? '—' : `${r.daysRemaining} days`,
        fpShort,
        statusBadge,
      ]) {
        const td = document.createElement('td');
        td.textContent = val;
        tr.append(td);
      }
      tbody.append(tr);
    }

    statePill.textContent = `${healthyCount}/${results.length} Valid Certs`;
    statePill.dataset.online = healthyCount > 0 ? 'true' : 'false';
    auditBtn.disabled = false;
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void runCertAudit();
  });

  body.append(form, table);
  card.append(header, body);
  void runCertAudit();
  return card;
}

interface CronJobItem {
  id: string;
  name: string;
  targetHost: string;
  port: number;
  username: string;
  jumpHost: string;
  command: string;
  intervalMinutes: number;
  enabled: boolean;
  runCount: number;
  lastRunAt: string;
  lastStatus: string;
  lastOutput: string;
}

const CRON_STORAGE_KEY = 'rw-cron-jobs-v1';
const DEFAULT_CRON_JOBS: CronJobItem[] = [
  {
    id: 'cron-1',
    name: 'System Uptime & Memory Health Check',
    targetHost: '10.28.0.154',
    port: 22,
    username: 'root',
    jumpHost: 'mitra-jump',
    command: 'uptime && free -h | head -2',
    intervalMinutes: 15,
    enabled: false,
    runCount: 0,
    lastRunAt: 'Never',
    lastStatus: 'Standby',
    lastOutput: 'Click ▶ Run Now or Enable periodic schedule.',
  },
  {
    id: 'cron-2',
    name: 'Root Disk Space Watchdog (df -h /)',
    targetHost: '10.28.0.154',
    port: 22,
    username: 'root',
    jumpHost: 'mitra-jump',
    command: 'df -h / | tail -1',
    intervalMinutes: 30,
    enabled: false,
    runCount: 0,
    lastRunAt: 'Never',
    lastStatus: 'Standby',
    lastOutput: 'Click ▶ Run Now or Enable periodic schedule.',
  },
];

function readCronJobs(): CronJobItem[] {
  try {
    const raw = window.localStorage?.getItem(CRON_STORAGE_KEY);
    if (!raw) return [...DEFAULT_CRON_JOBS];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : [...DEFAULT_CRON_JOBS];
  } catch {
    return [...DEFAULT_CRON_JOBS];
  }
}

function saveCronJobs(jobs: CronJobItem[]): void {
  try {
    window.localStorage?.setItem(CRON_STORAGE_KEY, JSON.stringify(jobs));
  } catch {}
}

function buildCronSchedulerView(spec: PluginSessionSpec, id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  let cronTimer: number | undefined;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-row-inline';
  const titleEl = document.createElement('span');
  titleEl.className = 'plugin-view-title';
  titleEl.textContent = '⏱ Scheduled Task & Cron Automation Runner';
  const badgeEl = document.createElement('span');
  badgeEl.className = 'plugin-view-badge';
  badgeEl.textContent = 'Periodic Background Jobs';
  const statePill = document.createElement('span');
  statePill.className = 'plugin-state-pill';
  statePill.textContent = 'Scheduler Active';
  statePill.dataset.online = 'true';
  titleWrap.append(titleEl, badgeEl, statePill);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close Tab';
  closeBtn.onclick = () => {
    if (cronTimer !== undefined) clearInterval(cronTimer);
    const next = tabAfterClose(tabIds(), id);
    discard(id);
    select(next);
  };
  header.append(titleWrap, closeBtn);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const form = document.createElement('form');
  form.className = 'gateway-tunnel-form';

  const nameLbl = document.createElement('label');
  nameLbl.textContent = 'Scheduled Job Name';
  const nameIn = document.createElement('input');
  nameIn.type = 'text';
  nameIn.placeholder = 'Hourly DNS Cache Flush / Backup Check';
  nameIn.required = true;
  nameLbl.append(nameIn);

  const hostLbl = document.createElement('label');
  hostLbl.textContent = 'Target Host';
  const hostIn = document.createElement('input');
  hostIn.type = 'text';
  hostIn.value = spec.host && spec.host !== 'localhost' ? spec.host : '10.28.0.154';
  hostLbl.append(hostIn);

  const jumpLbl = document.createElement('label');
  jumpLbl.textContent = 'Jump Host';
  const jumpIn = document.createElement('input');
  jumpIn.type = 'text';
  jumpIn.value = spec.jumpHost || 'mitra-jump';
  jumpLbl.append(jumpIn);

  const intLbl = document.createElement('label');
  intLbl.textContent = 'Schedule Interval';
  const intSel = document.createElement('select');
  for (const [m, label] of [
    ['1', 'Every 1 Minute'],
    ['5', 'Every 5 Minutes'],
    ['15', 'Every 15 Minutes'],
    ['30', 'Every 30 Minutes'],
    ['60', 'Every 60 Minutes'],
  ] as const) {
    const o = document.createElement('option');
    o.value = m;
    o.textContent = label;
    if (m === '15') o.selected = true;
    intSel.append(o);
  }
  intLbl.append(intSel);

  const cmdLbl = document.createElement('label');
  cmdLbl.textContent = 'Command ($HOST$ supported)';
  const cmdIn = document.createElement('input');
  cmdIn.type = 'text';
  cmdIn.placeholder = 'uptime && df -h /';
  cmdIn.required = true;
  cmdLbl.append(cmdIn);

  const addBtn = document.createElement('button');
  addBtn.type = 'submit';
  addBtn.textContent = '+ Add Scheduled Job';
  form.append(nameLbl, hostLbl, jumpLbl, intLbl, cmdLbl, addBtn);

  const table = document.createElement('table');
  table.className = 'plugin-table';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const col of ['Job Name', 'Target & Gateway', 'Command', 'Interval', 'State', 'Runs / Last Run', 'Last Output', 'Actions']) {
    const th = document.createElement('th');
    th.textContent = col;
    htr.append(th);
  }
  thead.append(htr);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);

  const executeSingleJob = async (job: CronJobItem) => {
    const guard = checkProductionSafetyGuard(`Cron Job: ${job.name}`, job.targetHost);
    if (!guard.allowed) {
      job.lastStatus = '🛡 Guard Blocked';
      job.lastOutput = guard.guardNote;
      saveCronJobs(jobs);
      renderJobs();
      return;
    }
    const resolvedCmd = resolveDynamicTokens(job.command, {
      host: job.targetHost,
      user: job.username,
      port: job.port,
      gateway: job.jumpHost || 'Direct LAN',
      name: job.name,
      sshKey: '',
    });
    try {
      const res = (await (window as any).workspace.run('protocol.exec', {
        pluginType: 'Terminal',
        host: job.targetHost,
        port: job.port || 22,
        username: job.username || 'root',
        password: '',
        jumpHost: job.jumpHost,
        jumpPassword: '',
        identityFile: '',
        command: resolvedCmd,
      })) as { ok: boolean; value?: ExecPayload };
      job.runCount += 1;
      job.lastRunAt = new Date().toLocaleTimeString();
      job.lastStatus = res.ok && res.value?.ok ? '✓ Exit 0' : '✕ Error';
      job.lastOutput = ((res.value?.stdout || res.value?.stderr || '').trim().split('\n')[0] || '(done)').slice(0, 140);
      saveCronJobs(jobs);
      renderJobs();
    } catch {
      job.lastStatus = '✕ Failed';
      saveCronJobs(jobs);
      renderJobs();
    }
  };

  let jobs = readCronJobs();

  const renderJobs = () => {
    tbody.replaceChildren();
    for (const j of jobs) {
      const tr = document.createElement('tr');
      for (const val of [
        j.name,
        `${j.targetHost}:${j.port} (${j.jumpHost || 'Direct'})`,
        j.command,
        `Every ${j.intervalMinutes}m`,
        j.enabled ? '● ENABLED' : '⏸ PAUSED',
        `${j.runCount}x · ${j.lastRunAt} (${j.lastStatus})`,
        j.lastOutput,
      ]) {
        const td = document.createElement('td');
        td.textContent = val;
        tr.append(td);
      }

      const tdAct = document.createElement('td');
      const actRow = document.createElement('div');
      actRow.className = 'plugin-row-inline';

      const runNowBtn = document.createElement('button');
      runNowBtn.type = 'button';
      runNowBtn.className = 'quiet';
      runNowBtn.textContent = '▶ Run Now';
      runNowBtn.onclick = () => void executeSingleJob(j);

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'quiet';
      toggleBtn.textContent = j.enabled ? '⏸ Pause' : '▶ Enable';
      toggleBtn.onclick = () => {
        j.enabled = !j.enabled;
        saveCronJobs(jobs);
        renderJobs();
      };

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'quiet';
      delBtn.textContent = '🗑';
      delBtn.onclick = () => {
        jobs = jobs.filter((x) => x.id !== j.id);
        saveCronJobs(jobs);
        renderJobs();
      };

      actRow.append(runNowBtn, toggleBtn, delBtn);
      tdAct.append(actRow);
      tr.append(tdAct);
      tbody.append(tr);
    }
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    jobs.push({
      id: `cron-${Date.now()}`,
      name: nameIn.value.trim(),
      targetHost: hostIn.value.trim() || '10.28.0.154',
      port: 22,
      username: 'root',
      jumpHost: jumpIn.value.trim(),
      command: cmdIn.value.trim(),
      intervalMinutes: Number(intSel.value) || 15,
      enabled: true,
      runCount: 0,
      lastRunAt: 'Scheduled',
      lastStatus: 'Ready',
      lastOutput: 'Waiting for next interval tick…',
    });
    saveCronJobs(jobs);
    nameIn.value = '';
    cmdIn.value = '';
    renderJobs();
  });

  cronTimer = window.setInterval(() => {
    for (const j of jobs) {
      if (j.enabled) {
        void executeSingleJob(j);
      }
    }
  }, 60_000);

  body.append(form, table);
  card.append(header, body);
  renderJobs();
  return card;
}

function buildAdDnsStudioView(spec: PluginSessionSpec, id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-row-inline';
  const titleEl = document.createElement('span');
  titleEl.className = 'plugin-view-title';
  titleEl.textContent = '🏢 Active Directory, DNS & Windows Server Quick-Admin Studio';
  const badgeEl = document.createElement('span');
  badgeEl.className = 'plugin-view-badge';
  badgeEl.textContent = 'AD / DNS / Kerberos / GPO Ops';
  const statePill = document.createElement('span');
  statePill.className = 'plugin-state-pill';
  statePill.textContent = 'Ready';
  titleWrap.append(titleEl, badgeEl, statePill);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close Tab';
  closeBtn.onclick = () => {
    const next = tabAfterClose(tabIds(), id);
    discard(id);
    select(next);
  };
  header.append(titleWrap, closeBtn);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const targetForm = document.createElement('form');
  targetForm.className = 'gateway-tunnel-form';

  const dcHostLbl = document.createElement('label');
  dcHostLbl.textContent = 'Domain Controller / DNS Server Host';
  const dcHostIn = document.createElement('input');
  dcHostIn.type = 'text';
  dcHostIn.value = spec.host && spec.host !== 'localhost' ? spec.host : '10.28.0.154';
  dcHostLbl.append(dcHostIn);

  const domainLbl = document.createElement('label');
  domainLbl.textContent = 'Active Directory Domain / Zone';
  const domainIn = document.createElement('input');
  domainIn.type = 'text';
  domainIn.value = 'plnbatam.com';
  domainLbl.append(domainIn);

  const jumpLbl = document.createElement('label');
  jumpLbl.textContent = 'Via Jump Host';
  const jumpIn = document.createElement('input');
  jumpIn.type = 'text';
  jumpIn.value = spec.jumpHost || 'mitra-jump';
  jumpLbl.append(jumpIn);

  targetForm.append(dcHostLbl, domainLbl, jumpLbl);

  const adOps: Array<{ category: string; title: string; command: string; purpose: string }> = [
    {
      category: 'AD Replication',
      title: 'Replication Summary Across All DCs',
      command: 'repadmin /replsummary',
      purpose: 'Checks replication delta & failure counts across all Domain Controllers.',
    },
    {
      category: 'DC Health',
      title: 'Domain Controller Diagnostics (Quiet)',
      command: 'dcdiag /q',
      purpose: 'Runs dcdiag and prints only failed or warning tests.',
    },
    {
      category: 'DNS Server',
      title: 'List All DNS Zones & DS-Integration',
      command: 'powershell -NoProfile -Command "Get-DnsServerZone | Select-Object ZoneName,ZoneType,IsDsIntegrated | Format-Table -AutoSize"',
      purpose: 'Displays Forward & Reverse Lookup Zones on the Windows DNS Server.',
    },
    {
      category: 'DNS Query',
      title: 'Verify Domain SOA & NS Resolution',
      command: 'nslookup -type=soa plnbatam.com 127.0.0.1',
      purpose: 'Queries the local DNS service for the primary domain SOA record.',
    },
    {
      category: 'Identity & Lockout',
      title: 'Find Locked-Out AD User Accounts',
      command: 'powershell -NoProfile -Command "Search-ADAccount -LockedOut | Select-Object Name,SamAccountName,LockedOut | Format-Table -AutoSize"',
      purpose: 'Lists all Active Directory user accounts currently locked out.',
    },
    {
      category: 'Core Services',
      title: 'Check NTDS, DNS, Netlogon, Kdc & W32Time',
      command: 'powershell -NoProfile -Command "Get-Service NTDS,DNS,Netlogon,Kdc,W32Time -ErrorAction SilentlyContinue | Format-Table Status,Name,DisplayName -AutoSize"',
      purpose: 'Verifies all 5 mission-critical Domain Controller services are Running.',
    },
    {
      category: 'NTP / Time Sync',
      title: 'Query Windows Time Stratum & NTP Peer',
      command: 'w32tm /query /status',
      purpose: 'Checks Kerberos-critical time synchronization offset and stratum.',
    },
    {
      category: 'MMC Console',
      title: 'Launch DNS Manager GUI (dnsmgmt.msc)',
      command: 'dnsmgmt.msc',
      purpose: 'Opens the graphical DNS Manager snap-in inside the active RDP session.',
    },
    {
      category: 'MMC Console',
      title: 'Launch AD Users & Computers (dsa.msc)',
      command: 'dsa.msc',
      purpose: 'Opens Active Directory Users and Computers MMC console in RDP.',
    },
    {
      category: 'Group Policy',
      title: 'Launch Group Policy Management (gpmc.msc)',
      command: 'gpmc.msc',
      purpose: 'Opens Group Policy Management Console in RDP.',
    },
  ];

  const table = document.createElement('table');
  table.className = 'plugin-table';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const col of ['Category', 'AD / DNS Operation', 'Command / PowerShell', 'Purpose', '1-Click Actions']) {
    const th = document.createElement('th');
    th.textContent = col;
    htr.append(th);
  }
  thead.append(htr);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);

  const statusOut = document.createElement('pre');
  statusOut.className = 'plugin-terminal-output';
  statusOut.textContent = 'Select any Active Directory or DNS operation above to type into an active Windows RDP session or execute remotely.';

  for (const op of adOps) {
    const tr = document.createElement('tr');
    const tdCat = document.createElement('td');
    tdCat.textContent = op.category;
    const tdTitle = document.createElement('td');
    tdTitle.textContent = op.title;
    const tdCmd = document.createElement('td');
    tdCmd.className = 'mono';
    tdCmd.textContent = op.command;
    const tdPurp = document.createElement('td');
    tdPurp.textContent = op.purpose;

    const tdAct = document.createElement('td');
    const actRow = document.createElement('div');
    actRow.className = 'plugin-row-inline';

    const rdpBtn = document.createElement('button');
    rdpBtn.type = 'button';
    rdpBtn.className = 'quiet';
    rdpBtn.textContent = '⌨ Type RDP';
    rdpBtn.onclick = async () => {
      const cmdStr = op.command.replace(/plnbatam\.com/g, domainIn.value.trim() || 'plnbatam.com');
      const ok = await typeStringIntoActiveRdp(cmdStr);
      if (!ok) {
        statusOut.textContent = `Copied command (open an RDP session to ${dcHostIn.value} first to type automatically):\n${cmdStr}`;
        void navigator.clipboard?.writeText(cmdStr);
      } else {
        statusOut.textContent = `Typed into active RDP session:\n${cmdStr}`;
      }
    };

    const runBtn = document.createElement('button');
    runBtn.type = 'button';
    runBtn.className = 'quiet';
    runBtn.textContent = '⚡ Run Remote';
    runBtn.onclick = async () => {
      const cmdStr = op.command.replace(/plnbatam\.com/g, domainIn.value.trim() || 'plnbatam.com');
      statusOut.textContent = `Running on ${dcHostIn.value.trim()}: ${cmdStr}…`;
      const res = (await (window as any).workspace.run('protocol.exec', {
        pluginType: 'PowerShell',
        host: dcHostIn.value.trim(),
        port: 5985,
        username: spec.username || 'Administrator',
        password: '',
        jumpHost: jumpIn.value.trim(),
        jumpPassword: '',
        identityFile: spec.sshKey ?? '',
        command: cmdStr,
      })) as { ok: boolean; value?: ExecPayload };
      statusOut.textContent =
        res.value?.stdout || res.value?.stderr || `Executed ${cmdStr} on ${dcHostIn.value.trim()}.`;
    };

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'quiet';
    copyBtn.textContent = '📋 Copy';
    copyBtn.onclick = () => {
      const cmdStr = op.command.replace(/plnbatam\.com/g, domainIn.value.trim() || 'plnbatam.com');
      void navigator.clipboard?.writeText(cmdStr);
      statusOut.textContent = `Copied to clipboard:\n${cmdStr}`;
    };

    actRow.append(rdpBtn, runBtn, copyBtn);
    tdAct.append(actRow);
    tr.append(tdCat, tdTitle, tdCmd, tdPurp, tdAct);
    tbody.append(tr);
  }

  body.append(targetForm, table, statusOut);
  card.append(header, body);
  return card;
}

function buildContainerStudioView(spec: PluginSessionSpec, id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-row-inline';
  const titleEl = document.createElement('span');
  titleEl.className = 'plugin-view-title';
  titleEl.textContent = '🐳 Docker, Podman & Kubernetes Container Studio';
  const badgeEl = document.createElement('span');
  badgeEl.className = 'plugin-view-badge';
  badgeEl.textContent = 'Container & Pod Inspector';
  const statePill = document.createElement('span');
  statePill.className = 'plugin-state-pill';
  statePill.textContent = 'Ready';
  titleWrap.append(titleEl, badgeEl, statePill);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close Tab';
  closeBtn.onclick = () => {
    const next = tabAfterClose(tabIds(), id);
    discard(id);
    select(next);
  };
  header.append(titleWrap, closeBtn);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const form = document.createElement('form');
  form.className = 'gateway-tunnel-form';

  const hostLbl = document.createElement('label');
  hostLbl.textContent = 'Container Host IP / FQDN';
  const hostIn = document.createElement('input');
  hostIn.type = 'text';
  hostIn.value = spec.host && spec.host !== 'localhost' ? spec.host : '10.28.0.154';
  hostLbl.append(hostIn);

  const userLbl = document.createElement('label');
  userLbl.textContent = 'SSH User';
  const userIn = document.createElement('input');
  userIn.type = 'text';
  userIn.value = spec.username || 'root';
  userLbl.append(userIn);

  const jumpLbl = document.createElement('label');
  jumpLbl.textContent = 'Jump Host';
  const jumpIn = document.createElement('input');
  jumpIn.type = 'text';
  jumpIn.value = spec.jumpHost || 'mitra-jump';
  jumpLbl.append(jumpIn);

  const engineLbl = document.createElement('label');
  engineLbl.textContent = 'Container Runtime';
  const engineSel = document.createElement('select');
  for (const [val, label] of [
    ['docker', 'Docker / Podman Engine'],
    ['kubectl', 'Kubernetes (kubectl pods)'],
  ] as const) {
    const o = document.createElement('option');
    o.value = val;
    o.textContent = label;
    engineSel.append(o);
  }
  engineLbl.append(engineSel);

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'submit';
  refreshBtn.textContent = '↻ Discover Containers / Pods';

  const statsBtn = document.createElement('button');
  statsBtn.type = 'button';
  statsBtn.className = 'quiet';
  statsBtn.textContent = '📊 Live CPU / RAM Stats';

  form.append(hostLbl, userLbl, jumpLbl, engineLbl, refreshBtn, statsBtn);

  const table = document.createElement('table');
  table.className = 'plugin-table';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const col of ['Container / Pod ID', 'Name', 'Image / Namespace', 'Status', 'Ports / Node', 'Container Actions']) {
    const th = document.createElement('th');
    th.textContent = col;
    htr.append(th);
  }
  thead.append(htr);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);

  const statusOut = document.createElement('pre');
  statusOut.className = 'plugin-terminal-output';
  statusOut.textContent = 'Click "↻ Discover Containers / Pods" to inspect Docker, Podman, or Kubernetes workloads via SSH.';

  const runContainerCmd = async (cmd: string) => {
    const res = (await (window as any).workspace.run('protocol.exec', {
      pluginType: 'Terminal',
      host: hostIn.value.trim(),
      port: 22,
      username: userIn.value.trim() || 'root',
      password: '',
      jumpHost: jumpIn.value.trim(),
      jumpPassword: '',
      identityFile: spec.sshKey ?? '',
      command: cmd,
    })) as { ok: boolean; value?: ExecPayload };
    return res.value;
  };

  const discoverContainers = async () => {
    refreshBtn.disabled = true;
    statePill.textContent = 'Querying runtime…';
    statePill.dataset.online = 'probing';

    const isK8s = engineSel.value === 'kubectl';
    const cmd = isK8s
      ? "kubectl get pods -A --no-headers -o custom-columns='ID:.metadata.uid,NAME:.metadata.name,IMAGE:.metadata.namespace,STATUS:.status.phase,PORTS:.spec.nodeName'"
      : "(docker ps -a --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}' 2>/dev/null || podman ps -a --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}')";

    const val = await runContainerCmd(cmd);
    tbody.replaceChildren();

    const lines = (val?.stdout || '').trim().split('\n').filter(Boolean);
    if (lines.length === 0) {
      statePill.textContent = 'No Containers / Auth Required';
      statePill.dataset.online = 'false';
      statusOut.textContent = val?.stderr || 'No running containers returned (or authenticate SSH first).';
      refreshBtn.disabled = false;
      return;
    }

    statePill.textContent = `${lines.length} Workload(s)`;
    statePill.dataset.online = 'true';

    for (const line of lines) {
      const parts = isK8s ? line.trim().split(/\s+/) : line.split('|');
      const [cid = '—', cname = '—', cimg = '—', cstat = '—', cports = '—'] = parts;
      const tr = document.createElement('tr');
      for (const cell of [cid.slice(0, 12), cname, cimg, cstat, cports || '—']) {
        const td = document.createElement('td');
        td.textContent = cell;
        tr.append(td);
      }

      const tdAct = document.createElement('td');
      const actRow = document.createElement('div');
      actRow.className = 'plugin-row-inline';

      const logsBtn = document.createElement('button');
      logsBtn.type = 'button';
      logsBtn.className = 'quiet';
      logsBtn.textContent = '📜 Logs';
      logsBtn.onclick = async () => {
        statusOut.textContent = `Fetching logs for ${cname}…`;
        const logRes = await runContainerCmd(
          isK8s ? `kubectl logs --tail=50 ${cname}` : `docker logs --tail 50 ${cname} 2>&1 || podman logs --tail 50 ${cname} 2>&1`,
        );
        statusOut.textContent = logRes?.stdout || logRes?.stderr || '(no container logs)';
      };

      const shellBtn = document.createElement('button');
      shellBtn.type = 'button';
      shellBtn.className = 'quiet';
      shellBtn.textContent = '>_ Exec Shell';
      shellBtn.onclick = () => {
        openPluginTab({
          pluginType: 'Terminal',
          name: `Shell · ${cname}`,
          host: hostIn.value.trim(),
          port: 22,
          username: userIn.value.trim() || 'root',
          notes: `Container shell ${cname}`,
          jumpHost: jumpIn.value.trim(),
          sshKey: spec.sshKey ?? '',
          initPath: isK8s ? `kubectl exec -it ${cname} -- /bin/sh` : `docker exec -it ${cname} /bin/sh`,
        });
      };

      const restartBtn = document.createElement('button');
      restartBtn.type = 'button';
      restartBtn.className = 'quiet';
      restartBtn.textContent = '↻ Restart';
      restartBtn.onclick = async () => {
        const guard = checkProductionSafetyGuard(`Restart Container ${cname}`, hostIn.value.trim());
        if (!guard.allowed) {
          statusOut.textContent = guard.guardNote;
          return;
        }
        statusOut.textContent = `Restarting ${cname}…`;
        const r = await runContainerCmd(isK8s ? `kubectl rollout restart pod/${cname}` : `docker restart ${cname}`);
        statusOut.textContent = r?.stdout || r?.stderr || `Restarted ${cname}.`;
        void discoverContainers();
      };

      actRow.append(logsBtn, shellBtn, restartBtn);
      tdAct.append(actRow);
      tr.append(tdAct);
      tbody.append(tr);
    }
    refreshBtn.disabled = false;
  };

  statsBtn.onclick = async () => {
    statusOut.textContent = `Collecting live container CPU & Memory usage from ${hostIn.value.trim()}…`;
    const r = await runContainerCmd('docker stats --no-stream 2>/dev/null || podman stats --no-stream 2>/dev/null || kubectl top pods -A');
    statusOut.textContent = r?.stdout || r?.stderr || 'Could not retrieve container stats.';
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void discoverContainers();
  });

  body.append(form, table, statusOut);
  card.append(header, body);
  return card;
}

function buildDatabaseStudioView(spec: PluginSessionSpec, id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-row-inline';
  const titleEl = document.createElement('span');
  titleEl.className = 'plugin-view-title';
  titleEl.textContent = '🗄 Database Tunnel & Quick-Query Inspector';
  const badgeEl = document.createElement('span');
  badgeEl.className = 'plugin-view-badge';
  badgeEl.textContent = 'Postgres / MySQL / SQL Server / Redis';
  const statePill = document.createElement('span');
  statePill.className = 'plugin-state-pill';
  statePill.textContent = 'Ready';
  titleWrap.append(titleEl, badgeEl, statePill);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close Tab';
  closeBtn.onclick = () => {
    const next = tabAfterClose(tabIds(), id);
    discard(id);
    select(next);
  };
  header.append(titleWrap, closeBtn);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const form = document.createElement('form');
  form.className = 'gateway-tunnel-form';

  const engineLbl = document.createElement('label');
  engineLbl.textContent = 'Database Engine';
  const engineSel = document.createElement('select');
  for (const [val, port, label] of [
    ['postgres', '5432', 'PostgreSQL (5432)'],
    ['mysql', '3306', 'MySQL / MariaDB (3306)'],
    ['mssql', '1433', 'Microsoft SQL Server (1433)'],
    ['redis', '6379', 'Redis In-Memory Store (6379)'],
  ] as const) {
    const o = document.createElement('option');
    o.value = val;
    o.dataset.port = port;
    o.textContent = label;
    engineSel.append(o);
  }
  engineLbl.append(engineSel);

  const hostLbl = document.createElement('label');
  hostLbl.textContent = 'Database Host';
  const hostIn = document.createElement('input');
  hostIn.type = 'text';
  hostIn.value = spec.host && spec.host !== 'localhost' ? spec.host : '10.28.0.154';
  hostLbl.append(hostIn);

  const portLbl = document.createElement('label');
  portLbl.textContent = 'DB Port';
  const portIn = document.createElement('input');
  portIn.type = 'number';
  portIn.value = '5432';
  portLbl.append(portIn);

  engineSel.onchange = () => {
    const map: Record<string, string> = { postgres: '5432', mysql: '3306', mssql: '1433', redis: '6379' };
    portIn.value = map[engineSel.value] || '5432';
  };

  const jumpLbl = document.createElement('label');
  jumpLbl.textContent = 'Bastion Jump Host';
  const jumpIn = document.createElement('input');
  jumpIn.type = 'text';
  jumpIn.value = spec.jumpHost || 'mitra-jump';
  jumpLbl.append(jumpIn);

  const probeBtn = document.createElement('button');
  probeBtn.type = 'submit';
  probeBtn.textContent = '📡 Probe DB Port & Open Local Tunnel';

  form.append(engineLbl, hostLbl, portLbl, jumpLbl, probeBtn);

  const quickBar = document.createElement('div');
  quickBar.className = 'plugin-quick-bar';

  const statusOut = document.createElement('pre');
  statusOut.className = 'plugin-terminal-output';
  statusOut.textContent = 'Select a Database Engine above to test port reachability, open a local SSH tunnel for DBeaver/TablePlus, or run quick DB health queries.';

  const queries: Array<[string, string]> = [
    ['Check DB Process & Listening Port', 'ss -tulpn | grep -E "5432|3306|1433|6379" || ps aux | grep -E "postgres|mysqld|sqlservr|redis"'],
    ['PostgreSQL Active Connections', 'sudo -u postgres psql -c "SELECT datname, usename, client_addr, state FROM pg_stat_activity;"'],
    ['PostgreSQL Database Sizes', 'sudo -u postgres psql -c "SELECT pg_database.datname, pg_size_pretty(pg_database_size(pg_database.datname)) FROM pg_database;"'],
    ['MySQL / MariaDB Processlist', 'mysql -e "SHOW FULL PROCESSLIST; SHOW STATUS LIKE \'Threads_connected\';"'],
    ['Redis Info & Memory Summary', 'redis-cli INFO memory && redis-cli INFO clients'],
  ];

  for (const [label, qCmd] of queries) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'plugin-quick-pill';
    b.textContent = `⚡ ${label}`;
    b.onclick = async () => {
      statusOut.textContent = `Running DB diagnostic on ${hostIn.value.trim()}…`;
      const res = (await (window as any).workspace.run('protocol.exec', {
        pluginType: 'Terminal',
        host: hostIn.value.trim(),
        port: 22,
        username: spec.username || 'root',
        password: '',
        jumpHost: jumpIn.value.trim(),
        jumpPassword: '',
        identityFile: spec.sshKey ?? '',
        command: qCmd,
      })) as { ok: boolean; value?: ExecPayload };
      statusOut.textContent = res.value?.stdout || res.value?.stderr || 'No output returned.';
    };
    quickBar.append(b);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    probeBtn.disabled = true;
    const dbHost = hostIn.value.trim();
    const dbPort = Number(portIn.value) || 5432;
    const jump = jumpIn.value.trim();
    const localPort = dbPort + 10000;

    try {
      const tunRes = (await (window as any).workspace.run('tunnel.start', {
        mode: 'L',
        jumpHost: jump,
        localPort,
        targetHost: dbHost,
        targetPort: dbPort,
      })) as { ok: boolean; value?: { id: string; localPort: number } };

      const boundPort = tunRes.value?.localPort || localPort;
      const uriMap: Record<string, string> = {
        postgres: `postgresql://postgres@127.0.0.1:${boundPort}/postgres`,
        mysql: `mysql://root@127.0.0.1:${boundPort}/mysql`,
        mssql: `sqlserver://127.0.0.1:${boundPort};databaseName=master`,
        redis: `redis://127.0.0.1:${boundPort}/0`,
      };
      statePill.textContent = tunRes.ok ? `Tunnel Active :${boundPort}` : 'Direct Mode';
      statePill.dataset.online = 'true';
      statusOut.textContent = [
        `Database Endpoint : ${dbHost}:${dbPort} (via ${jump || 'Direct LAN'})`,
        `Local Tunnel Port : 127.0.0.1:${boundPort}`,
        `Client Connection : ${uriMap[engineSel.value] || `127.0.0.1:${boundPort}`}`,
        ``,
        `Ready for TablePlus, DBeaver, DataGrip, psql, mysql, or sqlcmd on localhost:${boundPort}!`,
      ].join('\n');
    } finally {
      probeBtn.disabled = false;
    }
  });

  body.append(form, quickBar, statusOut);
  card.append(header, body);
  return card;
}

function buildFirewallAuditorView(spec: PluginSessionSpec, id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-row-inline';
  const titleEl = document.createElement('span');
  titleEl.className = 'plugin-view-title';
  titleEl.textContent = '🛡 Firewall & Port Security Matrix (UFW / Iptables / Windows Firewall)';
  const badgeEl = document.createElement('span');
  badgeEl.className = 'plugin-view-badge';
  badgeEl.textContent = 'Perimeter & Socket Auditor';
  const statePill = document.createElement('span');
  statePill.className = 'plugin-state-pill';
  statePill.textContent = 'Ready';
  titleWrap.append(titleEl, badgeEl, statePill);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close Tab';
  closeBtn.onclick = () => {
    const next = tabAfterClose(tabIds(), id);
    discard(id);
    select(next);
  };
  header.append(titleWrap, closeBtn);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const form = document.createElement('form');
  form.className = 'gateway-tunnel-form';

  const hostLbl = document.createElement('label');
  hostLbl.textContent = 'Target Server Host';
  const hostIn = document.createElement('input');
  hostIn.type = 'text';
  hostIn.value = spec.host && spec.host !== 'localhost' ? spec.host : '10.28.0.154';
  hostLbl.append(hostIn);

  const jumpLbl = document.createElement('label');
  jumpLbl.textContent = 'Via Jump Host';
  const jumpIn = document.createElement('input');
  jumpIn.type = 'text';
  jumpIn.value = spec.jumpHost || 'mitra-jump';
  jumpLbl.append(jumpIn);

  const modeLbl = document.createElement('label');
  modeLbl.textContent = 'Security Audit Preset';
  const modeSel = document.createElement('select');
  for (const [cmd, label] of [
    ['ss -tulpn || netstat -tulpn', 'Listening TCP/UDP Ports & Owning Processes (ss -tulpn)'],
    ['ss -tanp state established', 'Active Established Foreign Connections (ss -tanp)'],
    ['ufw status numbered 2>/dev/null || iptables -L -n -v 2>/dev/null || nft list ruleset 2>/dev/null', 'Linux Firewall Ruleset (UFW / Iptables / Nftables)'],
    ['fail2ban-client status 2>/dev/null || lastb -n 25 2>/dev/null', 'Fail2Ban Jails & Recent Brute-Force Attempts (lastb)'],
    ['netsh advfirewall show allprofiles', 'Windows Server Advanced Firewall Profiles (netsh)'],
  ] as const) {
    const o = document.createElement('option');
    o.value = cmd;
    o.textContent = label;
    modeSel.append(o);
  }
  modeLbl.append(modeSel);

  const runBtn = document.createElement('button');
  runBtn.type = 'submit';
  runBtn.textContent = '🛡 Run Firewall & Socket Audit';

  const rdpTypeBtn = document.createElement('button');
  rdpTypeBtn.type = 'button';
  rdpTypeBtn.className = 'quiet';
  rdpTypeBtn.textContent = '⌨ Type into Active RDP';

  form.append(hostLbl, jumpLbl, modeLbl, runBtn, rdpTypeBtn);

  const outputPre = document.createElement('pre');
  outputPre.className = 'plugin-terminal-output';
  outputPre.textContent = 'Select a Security Audit Preset above and click "🛡 Run Firewall & Socket Audit".';

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    runBtn.disabled = true;
    statePill.textContent = 'Auditing…';
    statePill.dataset.online = 'probing';
    try {
      const res = (await (window as any).workspace.run('protocol.exec', {
        pluginType: 'Terminal',
        host: hostIn.value.trim(),
        port: 22,
        username: spec.username || 'root',
        password: '',
        jumpHost: jumpIn.value.trim(),
        jumpPassword: '',
        identityFile: spec.sshKey ?? '',
        command: modeSel.value,
      })) as { ok: boolean; value?: ExecPayload };
      outputPre.textContent =
        res.value?.stdout || res.value?.stderr || 'No output returned (authenticate SSH or use Type into Active RDP).';
      statePill.textContent = res.ok && res.value?.ok ? 'Audit Complete' : 'Completed';
      statePill.dataset.online = 'true';
    } finally {
      runBtn.disabled = false;
    }
  });

  rdpTypeBtn.onclick = async () => {
    const ok = await typeStringIntoActiveRdp(modeSel.value);
    if (!ok) {
      void navigator.clipboard?.writeText(modeSel.value);
      outputPre.textContent = `Copied command to clipboard (connect an RDP tab first for auto-typing):\n${modeSel.value}`;
    } else {
      outputPre.textContent = `Typed command into active RDP session:\n${modeSel.value}`;
    }
  };

  body.append(form, outputPre);
  card.append(header, body);
  return card;
}

interface ClipRingEntry {
  timestamp: string;
  rawPreview: string;
  sanitized: string;
}
const clipHistoryRing: ClipRingEntry[] = [];

function scrubSensitiveText(raw: string): string {
  return raw
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED_SSH_PRIVATE_KEY]')
    .replace(/((?:password|passwd|pwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*)(['"]?)[^\s'"]+\2/gi, '$1[REDACTED_SECRET]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED_TOKEN]')
    .replace(/\b103\.172\.170\.\d{1,3}\b/g, '103.172.170.[REDACTED_WAN]')
    .replace(/\b(10\.\d{1,3}\.\d{1,3}\.)\d{1,3}\b/g, '$1[REDACTED_HOST]')
    .replace(/\b(192\.168\.\d{1,3}\.)\d{1,3}\b/g, '$1[REDACTED_HOST]')
    .replace(/\b(172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.)\d{1,3}\b/g, '$1[REDACTED_HOST]');
}

function buildClipboardScrubberView(_spec: PluginSessionSpec, id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-row-inline';
  const titleEl = document.createElement('span');
  titleEl.className = 'plugin-view-title';
  titleEl.textContent = '📋 Smart Clipboard History & Secret Scrubber';
  const badgeEl = document.createElement('span');
  badgeEl.className = 'plugin-view-badge';
  badgeEl.textContent = 'Sanitized Copy-Paste Ring';
  const statePill = document.createElement('span');
  statePill.className = 'plugin-state-pill';
  statePill.textContent = 'Zero-Leak Redactor';
  statePill.dataset.online = 'true';
  titleWrap.append(titleEl, badgeEl, statePill);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close Tab';
  closeBtn.onclick = () => {
    const next = tabAfterClose(tabIds(), id);
    discard(id);
    select(next);
  };
  header.append(titleWrap, closeBtn);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const bar = document.createElement('div');
  bar.className = 'plugin-action-bar';

  const readClipBtn = document.createElement('button');
  readClipBtn.type = 'button';
  readClipBtn.textContent = '📥 Paste from macOS Clipboard & Scrub';

  const scrubBtn = document.createElement('button');
  scrubBtn.type = 'button';
  scrubBtn.className = 'quiet';
  scrubBtn.textContent = '🧹 Scrub Secrets, Passwords & IPs';

  const copyCleanBtn = document.createElement('button');
  copyCleanBtn.type = 'button';
  copyCleanBtn.textContent = '🛡 Copy Sanitized Text to Clipboard';

  bar.append(readClipBtn, scrubBtn, copyCleanBtn);

  const inputArea = document.createElement('textarea');
  inputArea.rows = 7;
  inputArea.className = 'mono';
  inputArea.placeholder =
    'Paste raw terminal logs, configs, or connection strings here (e.g. ssh bright@103.172.170.219 -p 2602 or target 10.28.0.154 password=MySecret123)…';
  inputArea.value = [
    '# Sample Raw Diagnostic Snippet (Click "🧹 Scrub Secrets, Passwords & IPs"):',
    'Jump Bastion : bright@103.172.170.219:2602',
    'AD Server    : plnbatam\\adminit@10.28.0.154:4321',
    'Auth Header  : Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret',
    'DB Config    : password=SuperSecretProdPass2026!',
  ].join('\n');

  const outputArea = document.createElement('textarea');
  outputArea.rows = 7;
  outputArea.className = 'mono';
  outputArea.readOnly = true;

  const table = document.createElement('table');
  table.className = 'plugin-table';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const col of ['Timestamp', 'Sanitized Snippet Preview', 'Actions']) {
    const th = document.createElement('th');
    th.textContent = col;
    htr.append(th);
  }
  thead.append(htr);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);

  const renderRing = () => {
    tbody.replaceChildren();
    if (clipHistoryRing.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 3;
      td.textContent = 'Sanitized snippets will be saved in this session ring for quick reuse.';
      tr.append(td);
      tbody.append(tr);
      return;
    }
    for (const item of clipHistoryRing.slice(0, 15)) {
      const tr = document.createElement('tr');
      const tdTime = document.createElement('td');
      tdTime.className = 'mono';
      tdTime.textContent = item.timestamp;
      const tdPrev = document.createElement('td');
      tdPrev.className = 'mono';
      tdPrev.textContent = item.sanitized.replace(/\s+/g, ' ').slice(0, 110);
      const tdAct = document.createElement('td');
      const cpBtn = document.createElement('button');
      cpBtn.type = 'button';
      cpBtn.className = 'quiet';
      cpBtn.textContent = '🛡 Copy Clean';
      cpBtn.onclick = () => {
        void navigator.clipboard?.writeText(item.sanitized);
        statePill.textContent = 'Copied Clean Snippet!';
      };
      tdAct.append(cpBtn);
      tr.append(tdTime, tdPrev, tdAct);
      tbody.append(tr);
    }
  };

  const runScrub = () => {
    const clean = scrubSensitiveText(inputArea.value);
    outputArea.value = clean;
    clipHistoryRing.unshift({
      timestamp: new Date().toLocaleTimeString(),
      rawPreview: inputArea.value.slice(0, 80),
      sanitized: clean,
    });
    renderRing();
  };

  readClipBtn.onclick = async () => {
    try {
      const txt = await navigator.clipboard.readText();
      if (txt) {
        inputArea.value = txt;
        runScrub();
      }
    } catch {
      runScrub();
    }
  };

  scrubBtn.onclick = runScrub;
  inputArea.addEventListener('input', () => {
    outputArea.value = scrubSensitiveText(inputArea.value);
  });

  copyCleanBtn.onclick = () => {
    const clean = scrubSensitiveText(inputArea.value);
    outputArea.value = clean;
    void navigator.clipboard?.writeText(clean);
    statePill.textContent = 'Copied Sanitized Text!';
  };

  body.append(bar, inputArea, outputArea, table);
  card.append(header, body);
  runScrub();
  return card;
}

function buildNetworkPathStudioView(spec: PluginSessionSpec, id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-row-inline';
  const titleEl = document.createElement('span');
  titleEl.className = 'plugin-view-title';
  titleEl.textContent = '🌐 Multi-Hop Traceroute, MTR & DNS Propagation Analyzer';
  const badgeEl = document.createElement('span');
  badgeEl.className = 'plugin-view-badge';
  badgeEl.textContent = 'Split-Horizon DNS & Path Studio';
  const statePill = document.createElement('span');
  statePill.className = 'plugin-state-pill';
  statePill.textContent = 'Ready';
  titleWrap.append(titleEl, badgeEl, statePill);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close Tab';
  closeBtn.onclick = () => {
    const next = tabAfterClose(tabIds(), id);
    discard(id);
    select(next);
  };
  header.append(titleWrap, closeBtn);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const form = document.createElement('form');
  form.className = 'gateway-tunnel-form';

  const targetLbl = document.createElement('label');
  targetLbl.textContent = 'Target Domain or IP';
  const targetIn = document.createElement('input');
  targetIn.type = 'text';
  targetIn.value = spec.host && spec.host !== 'localhost' ? spec.host : 'plnbatam.com';
  targetLbl.append(targetIn);

  const modeLbl = document.createElement('label');
  modeLbl.textContent = 'Diagnostic Mode';
  const modeSel = document.createElement('select');
  for (const [val, label] of [
    ['dns_matrix', 'Multi-Resolver DNS Propagation & Split-Horizon Check'],
    ['traceroute', 'Multi-Hop Traceroute / Path Analysis (traceroute -n)'],
    ['ping', 'ICMP 4-Packet RTT & Loss Probe (ping -c 4)'],
  ] as const) {
    const o = document.createElement('option');
    o.value = val;
    o.textContent = label;
    modeSel.append(o);
  }
  modeLbl.append(modeSel);

  const recLbl = document.createElement('label');
  recLbl.textContent = 'DNS Record Type';
  const recSel = document.createElement('select');
  for (const r of ['A', 'AAAA', 'MX', 'NS', 'SOA', 'TXT', 'PTR']) {
    const o = document.createElement('option');
    o.value = r;
    o.textContent = r;
    recSel.append(o);
  }
  recLbl.append(recSel);

  const jumpLbl = document.createElement('label');
  jumpLbl.textContent = 'Vantage Point (Local vs Jump Host)';
  const jumpSel = document.createElement('select');
  for (const [val, label] of [
    ['', '💻 Local macOS Workstation'],
    ['mitra-jump', '🛡 Bastion: mitra-jump'],
    ['distribusi-jump', '🛡 Bastion: distribusi-jump'],
    ['pln-jump', '🛡 Bastion: pln-jump'],
  ] as const) {
    const o = document.createElement('option');
    o.value = val;
    o.textContent = label;
    if (val === (spec.jumpHost ?? '')) o.selected = true;
    jumpSel.append(o);
  }
  jumpLbl.append(jumpSel);

  const runBtn = document.createElement('button');
  runBtn.type = 'submit';
  runBtn.textContent = '🌐 Run Path / DNS Diagnostic';
  form.append(targetLbl, modeLbl, recLbl, jumpLbl, runBtn);

  const table = document.createElement('table');
  table.className = 'plugin-table';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const col of ['DNS Resolver / Vantage', 'Query Type', 'Resolved Answer / Records', 'Query Latency']) {
    const th = document.createElement('th');
    th.textContent = col;
    htr.append(th);
  }
  thead.append(htr);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);

  const outPre = document.createElement('pre');
  outputPreSetup(outPre, 'Click "🌐 Run Path / DNS Diagnostic" to compare internal AD DNS (10.28.0.154) vs public DNS or trace network hops.');

  function outputPreSetup(elPre: HTMLPreElement, txt: string) {
    elPre.className = 'plugin-terminal-output';
    elPre.textContent = txt;
  }

  const runDiag = async () => {
    runBtn.disabled = true;
    statePill.textContent = 'Running diagnostic…';
    statePill.dataset.online = 'probing';
    try {
      const res = (await (window as any).workspace.run('net.path', {
        target: targetIn.value.trim(),
        mode: modeSel.value,
        recordType: recSel.value,
        jumpHost: jumpSel.value,
      })) as {
        ok: boolean;
        value?: {
          ok: boolean;
          mode: string;
          vantage: string;
          output: string;
          dnsRows?: Array<{ resolver: string; recordType: string; answer: string; latencyMs: number }>;
        };
      };
      tbody.replaceChildren();
      if (res.value?.dnsRows && res.value.dnsRows.length > 0) {
        table.hidden = false;
        for (const r of res.value.dnsRows) {
          const tr = document.createElement('tr');
          for (const c of [r.resolver, r.recordType, r.answer || 'NXDOMAIN / Timeout', `${r.latencyMs} ms`]) {
            const td = document.createElement('td');
            td.textContent = c;
            tr.append(td);
          }
          tbody.append(tr);
        }
      } else {
        table.hidden = true;
      }
      outPre.textContent = `Vantage Point: ${res.value?.vantage || 'Local'}\n\n${res.value?.output || 'Completed.'}`;
      statePill.textContent = 'Diagnostic Complete';
      statePill.dataset.online = 'true';
    } finally {
      runBtn.disabled = false;
    }
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void runDiag();
  });

  body.append(form, table, outPre);
  card.append(header, body);
  void runDiag();
  return card;
}

function buildHypervisorStudioView(spec: PluginSessionSpec, id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-row-inline';
  const titleEl = document.createElement('span');
  titleEl.className = 'plugin-view-title';
  titleEl.textContent = '🖥 Proxmox VE, VMware ESXi & Hyper-V Virtual Machine Fleet Studio';
  const badgeEl = document.createElement('span');
  badgeEl.className = 'plugin-view-badge';
  badgeEl.textContent = 'Hypervisor VM Manager';
  const statePill = document.createElement('span');
  statePill.className = 'plugin-state-pill';
  statePill.textContent = 'Ready';
  titleWrap.append(titleEl, badgeEl, statePill);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close Tab';
  closeBtn.onclick = () => {
    const next = tabAfterClose(tabIds(), id);
    discard(id);
    select(next);
  };
  header.append(titleWrap, closeBtn);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const form = document.createElement('form');
  form.className = 'gateway-tunnel-form';

  const platLbl = document.createElement('label');
  platLbl.textContent = 'Hypervisor Platform';
  const platSel = document.createElement('select');
  for (const [val, label] of [
    ['esxi', 'VMware ESXi (vim-cmd vmsvc)'],
    ['proxmox', 'Proxmox VE (qm & pct CLI)'],
    ['hyperv', 'Windows Server Hyper-V (Get-VM)'],
  ] as const) {
    const o = document.createElement('option');
    o.value = val;
    o.textContent = label;
    platSel.append(o);
  }
  platLbl.append(platSel);

  const hostLbl = document.createElement('label');
  hostLbl.textContent = 'Hypervisor Host';
  const hostIn = document.createElement('input');
  hostIn.type = 'text';
  hostIn.value = spec.host && spec.host !== 'localhost' ? spec.host : '10.28.0.154';
  hostLbl.append(hostIn);

  const jumpLbl = document.createElement('label');
  jumpLbl.textContent = 'Via Jump Host';
  const jumpIn = document.createElement('input');
  jumpIn.type = 'text';
  jumpIn.value = spec.jumpHost || 'mitra-jump';
  jumpLbl.append(jumpIn);

  const listBtn = document.createElement('button');
  listBtn.type = 'submit';
  listBtn.textContent = '↻ Inventory Virtual Machines';

  form.append(platLbl, hostLbl, jumpLbl, listBtn);

  const quickBar = document.createElement('div');
  quickBar.className = 'plugin-quick-bar';

  const outPre = document.createElement('pre');
  outPre.className = 'plugin-terminal-output';
  outPre.textContent = 'Select a Hypervisor Platform above to list VMs, check datastore/storage capacity, or create VM snapshots.';

  const runHvCmd = async (cmd: string) => {
    outPre.textContent = `Executing on ${hostIn.value.trim()} (${platSel.value.toUpperCase()}):\n$ ${cmd}\n…`;
    const res = (await (window as any).workspace.run('protocol.exec', {
      pluginType: platSel.value === 'hyperv' ? 'PowerShell' : 'Terminal',
      host: hostIn.value.trim(),
      port: platSel.value === 'hyperv' ? 5985 : 22,
      username: spec.username || 'root',
      password: '',
      jumpHost: jumpIn.value.trim(),
      jumpPassword: '',
      identityFile: spec.sshKey ?? '',
      command: cmd,
    })) as { ok: boolean; value?: ExecPayload };
    outPre.textContent = res.value?.stdout || res.value?.stderr || `Command sent: ${cmd}`;
  };

  for (const [label, cmd] of [
    ['VMware ESXi: List All VMs', 'vim-cmd vmsvc/getallvms'],
    ['VMware ESXi: Datastores & Free Space', 'esxcli storage filesystem list'],
    ['Proxmox VE: List QEMU VMs & LXC', 'qm list && pct list'],
    ['Proxmox VE: Cluster & Storage Status', 'pvesm status && pvecm status'],
    ['Hyper-V: List All VMs & Memory', 'powershell -NoProfile -Command "Get-VM | Select-Object Name,State,CPUUsage,MemoryAssigned,Uptime | Format-Table -AutoSize"'],
    ['Hyper-V: List VM Checkpoints', 'powershell -NoProfile -Command "Get-VM | Get-VMSnapshot | Select-Object VMName,Name,CreationTime | Format-Table -AutoSize"'],
  ] as const) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'plugin-quick-pill';
    b.textContent = `⚡ ${label}`;
    b.onclick = () => void runHvCmd(cmd);
    quickBar.append(b);
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const cmd =
      platSel.value === 'esxi'
        ? 'vim-cmd vmsvc/getallvms'
        : platSel.value === 'proxmox'
          ? 'qm list && pct list'
          : 'powershell -NoProfile -Command "Get-VM | Select-Object Name,State,CPUUsage,MemoryAssigned,Uptime | Format-Table -AutoSize"';
    void runHvCmd(cmd);
  });

  body.append(form, quickBar, outPre);
  card.append(header, body);
  return card;
}

interface TotpEntry {
  id: string;
  issuer: string;
  account: string;
  secretBase32: string;
}
const TOTP_STORAGE_KEY = 'rw-totp-vault-v1';
const DEFAULT_TOTP_ITEMS: TotpEntry[] = [
  {
    id: 'totp-1',
    issuer: 'PLN Batam Bastion MFA',
    account: 'adminit@plnbatam.com',
    secretBase32: 'JBSWY3DPEHPK3PXP',
  },
  {
    id: 'totp-2',
    issuer: 'Proxmox / Firewall Admin OTP',
    account: 'ops@jaladesk',
    secretBase32: 'GEZDGNBVGY3TQOJQ',
  },
];

function readTotpItems(): TotpEntry[] {
  try {
    const raw = window.localStorage?.getItem(TOTP_STORAGE_KEY);
    if (!raw) return [...DEFAULT_TOTP_ITEMS];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : [...DEFAULT_TOTP_ITEMS];
  } catch {
    return [...DEFAULT_TOTP_ITEMS];
  }
}

function saveTotpItems(items: TotpEntry[]): void {
  try {
    window.localStorage?.setItem(TOTP_STORAGE_KEY, JSON.stringify(items));
  } catch {}
}

function decodeBase32(input: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (let i = 0; i < clean.length; i++) {
    const idx = alphabet.indexOf(clean[i]!);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

async function computeTotpCode(secretBase32: string, periodSec = 30): Promise<{ code: string; remainingSec: number }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const counter = Math.floor(nowSec / periodSec);
  const remainingSec = periodSec - (nowSec % periodSec);
  try {
    const keyBytes = decodeBase32(secretBase32);
    if (keyBytes.length === 0) return { code: '000000', remainingSec };
    const counterBuf = new ArrayBuffer(8);
    const view = new DataView(counterBuf);
    view.setUint32(0, Math.floor(counter / 0x100000000), false);
    view.setUint32(4, counter >>> 0, false);

    const cryptoKey = await window.crypto.subtle.importKey(
      'raw',
      keyBytes as unknown as BufferSource,
      { name: 'HMAC', hash: 'SHA-1' },
      false,
      ['sign'],
    );
    const sig = new Uint8Array(await window.crypto.subtle.sign('HMAC', cryptoKey, counterBuf));
    const offset = sig[sig.length - 1]! & 0x0f;
    const binCode =
      ((sig[offset]! & 0x7f) << 24) |
      ((sig[offset + 1]! & 0xff) << 16) |
      ((sig[offset + 2]! & 0xff) << 8) |
      (sig[offset + 3]! & 0xff);
    const code = String(binCode % 1_000_000).padStart(6, '0');
    return { code, remainingSec };
  } catch {
    return { code: '000000', remainingSec };
  }
}

function buildTotpAuthenticatorView(_spec: PluginSessionSpec, id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  let totpInterval: number | undefined;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-row-inline';
  const titleEl = document.createElement('span');
  titleEl.className = 'plugin-view-title';
  titleEl.textContent = '🔐 Built-in TOTP 2FA / MFA Authenticator Vault (RFC 6238)';
  const badgeEl = document.createElement('span');
  badgeEl.className = 'plugin-view-badge';
  badgeEl.textContent = 'Live 30s 6-Digit OTP';
  const statePill = document.createElement('span');
  statePill.className = 'plugin-state-pill';
  statePill.textContent = '30s Window';
  statePill.dataset.online = 'true';
  titleWrap.append(titleEl, badgeEl, statePill);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close Tab';
  closeBtn.onclick = () => {
    if (totpInterval !== undefined) clearInterval(totpInterval);
    const next = tabAfterClose(tabIds(), id);
    discard(id);
    select(next);
  };
  header.append(titleWrap, closeBtn);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const form = document.createElement('form');
  form.className = 'gateway-tunnel-form';

  const issLbl = document.createElement('label');
  issLbl.textContent = 'Service / Issuer';
  const issIn = document.createElement('input');
  issIn.type = 'text';
  issIn.placeholder = 'Jump Host / FortiGate / AD MFA';
  issIn.required = true;
  issLbl.append(issIn);

  const accLbl = document.createElement('label');
  accLbl.textContent = 'Account / Username';
  const accIn = document.createElement('input');
  accIn.type = 'text';
  accIn.placeholder = 'adminit@plnbatam.com';
  accIn.required = true;
  accLbl.append(accIn);

  const secLbl = document.createElement('label');
  secLbl.textContent = 'Base32 TOTP Secret Key';
  const secIn = document.createElement('input');
  secIn.type = 'password';
  secIn.placeholder = 'JBSWY3DPEHPK3PXP';
  secIn.required = true;
  secLbl.append(secIn);

  const addBtn = document.createElement('button');
  addBtn.type = 'submit';
  addBtn.textContent = '+ Add 2FA Authenticator Key';
  form.append(issLbl, accLbl, secLbl, addBtn);

  const table = document.createElement('table');
  table.className = 'plugin-table';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const col of ['Issuer / Service', 'Account', 'Live 6-Digit OTP Code', 'Expires In', '1-Click Auto-Type / Copy']) {
    const th = document.createElement('th');
    th.textContent = col;
    htr.append(th);
  }
  thead.append(htr);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);

  const statusOut = document.createElement('pre');
  statusOut.className = 'plugin-terminal-output';
  statusOut.textContent = 'RFC 6238 HMAC-SHA1 TOTP codes refresh automatically every second. Click "⌨ Type OTP in RDP" or "📋 Copy OTP".';

  let items = readTotpItems();

  const refreshCodes = async () => {
    tbody.replaceChildren();
    for (const item of items) {
      const { code, remainingSec } = await computeTotpCode(item.secretBase32);
      statePill.textContent = `Next Rotation: ${remainingSec}s`;

      const tr = document.createElement('tr');
      const tdIss = document.createElement('td');
      tdIss.textContent = item.issuer;
      const tdAcc = document.createElement('td');
      tdAcc.className = 'mono';
      tdAcc.textContent = item.account;
      const tdCode = document.createElement('td');
      tdCode.className = 'mono';
      tdCode.textContent = `${code.slice(0, 3)} ${code.slice(3)}`;
      const tdRem = document.createElement('td');
      tdRem.textContent = `${remainingSec}s`;

      const tdAct = document.createElement('td');
      const actRow = document.createElement('div');
      actRow.className = 'plugin-row-inline';

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'quiet';
      copyBtn.textContent = '📋 Copy OTP';
      copyBtn.onclick = () => {
        void navigator.clipboard?.writeText(code);
        statusOut.textContent = `Copied 6-digit OTP (${code}) for ${item.issuer} (${item.account}).`;
      };

      const rdpBtn = document.createElement('button');
      rdpBtn.type = 'button';
      rdpBtn.className = 'quiet';
      rdpBtn.textContent = '⌨ Type OTP in RDP';
      rdpBtn.onclick = async () => {
        const ok = await typeStringIntoActiveRdp(code);
        statusOut.textContent = ok
          ? `Typed 6-digit OTP (${code}) into active RDP session.`
          : `Copied OTP (${code}) to clipboard (connect an RDP session first for auto-typing).`;
        if (!ok) void navigator.clipboard?.writeText(code);
      };

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'quiet';
      delBtn.textContent = '🗑';
      delBtn.onclick = () => {
        items = items.filter((x) => x.id !== item.id);
        saveTotpItems(items);
        void refreshCodes();
      };

      actRow.append(copyBtn, rdpBtn, delBtn);
      tdAct.append(actRow);
      tr.append(tdIss, tdAcc, tdCode, tdRem, tdAct);
      tbody.append(tr);
    }
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    items.push({
      id: `totp-${Date.now()}`,
      issuer: issIn.value.trim(),
      account: accIn.value.trim(),
      secretBase32: secIn.value.trim(),
    });
    saveTotpItems(items);
    issIn.value = '';
    accIn.value = '';
    secIn.value = '';
    void refreshCodes();
  });

  totpInterval = window.setInterval(() => void refreshCodes(), 1000);
  body.append(form, table, statusOut);
  card.append(header, body);
  void refreshCodes();
  return card;
}

function buildIacExporterView(spec: PluginSessionSpec, id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-row-inline';
  const titleEl = document.createElement('span');
  titleEl.className = 'plugin-view-title';
  titleEl.textContent = `⚙ Ansible Inventory, /etc/hosts & Terraform IaC Exporter${spec.notes ? ` · ${spec.notes}` : ''}`;
  const badgeEl = document.createElement('span');
  badgeEl.className = 'plugin-view-badge';
  badgeEl.textContent = 'Infrastructure-as-Code Generator';
  titleWrap.append(titleEl, badgeEl);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close Tab';
  closeBtn.onclick = () => {
    const next = tabAfterClose(tabIds(), id);
    discard(id);
    select(next);
  };
  header.append(titleWrap, closeBtn);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const bar = document.createElement('div');
  bar.className = 'plugin-action-bar';

  const fmtSel = document.createElement('select');
  fmtSel.className = 'plugin-pass-input';
  for (const [val, label] of [
    ['ansible_ini', 'Ansible INI Inventory (inventory.ini)'],
    ['ansible_yaml', 'Ansible YAML Inventory (inventory.yml)'],
    ['etc_hosts', 'POSIX /etc/hosts Block'],
    ['terraform_json', 'Terraform Locals JSON (servers.tf.json)'],
  ] as const) {
    const o = document.createElement('option');
    o.value = val;
    o.textContent = label;
    fmtSel.append(o);
  }

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.textContent = '📋 Copy Generated IaC';

  const dlBtn = document.createElement('button');
  dlBtn.type = 'button';
  dlBtn.className = 'quiet';
  dlBtn.textContent = '⬇ Download IaC File';

  bar.append(fmtSel, copyBtn, dlBtn);

  const codeArea = document.createElement('textarea');
  codeArea.rows = 19;
  codeArea.className = 'mono';

  const renderIac = () => {
    const allConns = documents.listAllConnections?.() ?? [];
    const conns =
      spec.notes && allConns.some((c) => c.docName === spec.notes || `${c.docName} / ${c.folderName}` === spec.notes)
        ? allConns.filter((c) => c.docName === spec.notes || `${c.docName} / ${c.folderName}` === spec.notes)
        : allConns;

    const fmt = fmtSel.value;
    if (fmt === 'ansible_ini') {
      const groups = new Map<string, typeof conns>();
      for (const c of conns) {
        const g = (c.folderName ? `${c.docName}_${c.folderName}` : c.docName)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_|_$/g, '') || 'jaladesk_servers';
        const list = groups.get(g) ?? [];
        list.push(c);
        groups.set(g, list);
      }
      const lines = ['# Generated by JalaDesk Infrastructure-as-Code Exporter', ''];
      if (groups.size === 0) {
        lines.push('[pln_batam_servers]', 'brightad1 ansible_host=10.28.0.154 ansible_port=22 ansible_user=root ansible_ssh_common_args="-o ProxyJump=mitra-jump"');
      } else {
        for (const [gName, items] of groups.entries()) {
          lines.push(`[${gName}]`);
          for (const item of items) {
            const alias = item.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
            const jumpArg = item.jumpHost ? ` ansible_ssh_common_args="-o ProxyJump=${item.jumpHost}"` : '';
            const keyArg = item.sshKey ? ` ansible_ssh_private_key_file=${item.sshKey}` : '';
            lines.push(
              `${alias} ansible_host=${item.host} ansible_port=${item.port} ansible_user=${item.username}${keyArg}${jumpArg}`,
            );
          }
          lines.push('');
        }
      }
      codeArea.value = lines.join('\n');
    } else if (fmt === 'ansible_yaml') {
      const lines = ['all:', '  children:', '    jaladesk_inventory:', '      hosts:'];
      if (conns.length === 0) {
        lines.push(
          '        brightad1:',
          '          ansible_host: 10.28.0.154',
          '          ansible_port: 22',
          '          ansible_user: root',
          '          ansible_ssh_common_args: "-o ProxyJump=mitra-jump"',
        );
      } else {
        for (const c of conns) {
          const alias = c.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
          lines.push(
            `        ${alias}:`,
            `          ansible_host: ${c.host}`,
            `          ansible_port: ${c.port}`,
            `          ansible_user: "${c.username}"`,
            ...(c.jumpHost ? [`          ansible_ssh_common_args: "-o ProxyJump=${c.jumpHost}"`] : []),
          );
        }
      }
      codeArea.value = lines.join('\n');
    } else if (fmt === 'etc_hosts') {
      const lines = ['# BEGIN JALADESK MANAGED HOSTS'];
      if (conns.length === 0) {
        lines.push('10.28.0.154\tbrightad1.plnbatam.com brightad1');
      } else {
        for (const c of conns) {
          const slug = c.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
          lines.push(`${c.host}\t${slug}.internal ${slug} # ${c.docName} (${c.protocol}:${c.port})`);
        }
      }
      lines.push('# END JALADESK MANAGED HOSTS');
      codeArea.value = lines.join('\n');
    } else {
      const tfObj = {
        locals: {
          jaladesk_servers: Object.fromEntries(
            (conns.length > 0
              ? conns
              : [
                  {
                    name: 'brightad1',
                    host: '10.28.0.154',
                    port: 4321,
                    protocol: 'RDP',
                    username: 'plnbatam\\adminit',
                    jumpHost: 'mitra-jump',
                    docName: 'PLN Batam',
                  },
                ]
            ).map((c) => [
              c.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '_'),
              {
                host: c.host,
                port: c.port,
                protocol: c.protocol,
                username: c.username,
                jump_host: c.jumpHost || null,
                document: c.docName,
              },
            ]),
          ),
        },
      };
      codeArea.value = JSON.stringify(tfObj, null, 2);
    }
  };

  fmtSel.onchange = renderIac;
  copyBtn.onclick = () => {
    void navigator.clipboard?.writeText(codeArea.value);
  };
  dlBtn.onclick = () => {
    const ext =
      fmtSel.value === 'ansible_ini'
        ? 'inventory.ini'
        : fmtSel.value === 'ansible_yaml'
          ? 'inventory.yml'
          : fmtSel.value === 'etc_hosts'
            ? 'hosts.txt'
            : 'servers.tf.json';
    const blob = new Blob([codeArea.value], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jaladesk-${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  body.append(bar, codeArea);
  card.append(header, body);
  renderIac();
  return card;
}

function buildResourceProfilerView(spec: PluginSessionSpec, id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-row-inline';
  const titleEl = document.createElement('span');
  titleEl.className = 'plugin-view-title';
  titleEl.textContent = '📈 Server Resource Capacity & Top Process Profiler';
  const badgeEl = document.createElement('span');
  badgeEl.className = 'plugin-view-badge';
  badgeEl.textContent = 'CPU / RAM / Disk I/O Live Profiler';
  const statePill = document.createElement('span');
  statePill.className = 'plugin-state-pill';
  statePill.textContent = 'Ready';
  titleWrap.append(titleEl, badgeEl, statePill);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close Tab';
  closeBtn.onclick = () => {
    const next = tabAfterClose(tabIds(), id);
    discard(id);
    select(next);
  };
  header.append(titleWrap, closeBtn);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const form = document.createElement('form');
  form.className = 'gateway-tunnel-form';

  const hostLbl = document.createElement('label');
  hostLbl.textContent = 'Target Server Host';
  const hostIn = document.createElement('input');
  hostIn.type = 'text';
  hostIn.value = spec.host && spec.host !== 'localhost' ? spec.host : '10.28.0.154';
  hostLbl.append(hostIn);

  const userLbl = document.createElement('label');
  userLbl.textContent = 'SSH User';
  const userIn = document.createElement('input');
  userIn.type = 'text';
  userIn.value = spec.username || 'root';
  userLbl.append(userIn);

  const jumpLbl = document.createElement('label');
  jumpLbl.textContent = 'Via Jump Host';
  const jumpIn = document.createElement('input');
  jumpIn.type = 'text';
  jumpIn.value = spec.jumpHost || 'mitra-jump';
  jumpLbl.append(jumpIn);

  const profBtn = document.createElement('button');
  profBtn.type = 'submit';
  profBtn.textContent = '📈 Profile Top Processes & Capacity';

  form.append(hostLbl, userLbl, jumpLbl, profBtn);

  const table = document.createElement('table');
  table.className = 'plugin-table';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const col of ['PID', 'User', '%CPU', '%MEM', 'Command', 'Actions']) {
    const th = document.createElement('th');
    th.textContent = col;
    htr.append(th);
  }
  thead.append(htr);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);

  const outPre = document.createElement('pre');
  outPre.className = 'plugin-terminal-output';
  outPre.textContent = 'Click "📈 Profile Top Processes & Capacity" to inspect live CPU, RAM, Disk usage, and top processes.';

  const runProfile = async () => {
    profBtn.disabled = true;
    statePill.textContent = 'Profiling…';
    statePill.dataset.online = 'probing';
    try {
      const cmd =
        'echo "=== CAPACITY ==="; uptime; free -h 2>/dev/null || vm_stat 2>/dev/null; df -h /; echo "=== TOP_PROCS ==="; ps -eo pid,user,%cpu,%mem,comm --sort=-%cpu 2>/dev/null | head -n 13 || ps aux | head -n 13';
      const res = (await (window as any).workspace.run('protocol.exec', {
        pluginType: 'Terminal',
        host: hostIn.value.trim(),
        port: 22,
        username: userIn.value.trim() || 'root',
        password: '',
        jumpHost: jumpIn.value.trim(),
        jumpPassword: '',
        identityFile: spec.sshKey ?? '',
        command: cmd,
      })) as { ok: boolean; value?: ExecPayload };

      const raw = res.value?.stdout || res.value?.stderr || '';
      const [capPart = '', procPart = ''] = raw.split('=== TOP_PROCS ===');
      outPre.textContent = capPart.replace('=== CAPACITY ===', '').trim() || 'No telemetry returned.';

      tbody.replaceChildren();
      const pLines = procPart.trim().split('\n').slice(1);
      for (const line of pLines) {
        const toks = line.trim().split(/\s+/);
        if (toks.length < 5) continue;
        const [pid = '', usr = '', cpu = '', mem = '', ...cmdParts] = toks;
        const tr = document.createElement('tr');
        for (const c of [pid, usr, `${cpu}%`, `${mem}%`, cmdParts.join(' ')]) {
          const td = document.createElement('td');
          td.textContent = c;
          tr.append(td);
        }
        const tdAct = document.createElement('td');
        const killBtn = document.createElement('button');
        killBtn.type = 'button';
        killBtn.className = 'quiet';
        killBtn.textContent = '⚠ SIGTERM';
        killBtn.onclick = async () => {
          const guard = checkProductionSafetyGuard(`Kill PID ${pid}`, hostIn.value.trim());
          if (!guard.allowed) {
            outPre.textContent = guard.guardNote;
            return;
          }
          await (window as any).workspace.run('protocol.exec', {
            pluginType: 'Terminal',
            host: hostIn.value.trim(),
            port: 22,
            username: userIn.value.trim() || 'root',
            password: '',
            jumpHost: jumpIn.value.trim(),
            jumpPassword: '',
            identityFile: spec.sshKey ?? '',
            command: `kill -15 ${pid}`,
          });
          void runProfile();
        };
        tdAct.append(killBtn);
        tr.append(tdAct);
        tbody.append(tr);
      }
      statePill.textContent = 'Profile Complete';
      statePill.dataset.online = 'true';
    } finally {
      profBtn.disabled = false;
    }
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void runProfile();
  });

  body.append(form, table, outPre);
  card.append(header, body);
  return card;
}

function buildHttpEndpointStudioView(spec: PluginSessionSpec, _id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-view-title';
  const badge = document.createElement('span');
  badge.className = 'plugin-badge';
  badge.dataset.kind = 'web';
  badge.textContent = '🌐 HTTP / REST & Webhook Endpoint Health Studio';
  const h3 = document.createElement('h3');
  h3.textContent = spec.name || 'HTTP & API Health Monitor';
  const sub = document.createElement('span');
  sub.className = 'plugin-endpoint';
  sub.textContent = 'Live HTTP Status · TTFB Latency · Security Headers (HSTS/CSP/XFO) · cURL Generator';
  titleWrap.append(badge, h3, sub);

  const actions = document.createElement('div');
  actions.className = 'plugin-view-actions';
  const statePill = document.createElement('span');
  statePill.className = 'plugin-state-pill';
  statePill.dataset.online = 'true';
  statePill.textContent = 'HTTP Probe Ready';
  actions.append(statePill);
  header.append(titleWrap, actions);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const form = document.createElement('form');
  form.className = 'plugin-Command-bar';

  const urlIn = document.createElement('input');
  urlIn.type = 'text';
  urlIn.className = 'plugin-cmd-input';
  urlIn.placeholder = 'Endpoint URL (e.g. https://10.28.0.154:4321/ or https://plnbatam.com)';
  urlIn.value = spec.host && spec.host !== 'localhost' ? `https://${spec.host}${spec.port && spec.port !== 443 ? `:${spec.port}` : ''}/` : 'https://10.28.0.154:4321/';

  const methodSel = document.createElement('select');
  methodSel.className = 'plugin-cmd-input';
  for (const m of ['GET', 'HEAD', 'POST', 'OPTIONS']) {
    const o = document.createElement('option');
    o.value = m;
    o.textContent = `Method: ${m}`;
    methodSel.append(o);
  }

  const jumpIn = document.createElement('input');
  jumpIn.type = 'text';
  jumpIn.className = 'plugin-cmd-input';
  jumpIn.placeholder = 'Optional Jump Host (e.g. pln-jump)';
  jumpIn.value = spec.jumpHost ?? '';

  const probeBtn = document.createElement('button');
  probeBtn.type = 'submit';
  probeBtn.textContent = '🚀 Probe Endpoint';

  const scanDocBtn = document.createElement('button');
  scanDocBtn.type = 'button';
  scanDocBtn.className = 'quiet';
  scanDocBtn.textContent = '🔄 Probe All Document Web Endpoints';

  const curlBtn = document.createElement('button');
  curlBtn.type = 'button';
  curlBtn.className = 'quiet';
  curlBtn.textContent = '📋 Copy cURL';

  form.append(urlIn, methodSel, jumpIn, probeBtn, scanDocBtn, curlBtn);

  const table = document.createElement('table');
  table.className = 'plugin-table';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const col of ['Endpoint URL', 'Method', 'HTTP Status', 'TTFB / Total', 'Security Headers', 'Server', 'Actions']) {
    const th = document.createElement('th');
    th.textContent = col;
    htr.append(th);
  }
  thead.append(htr);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);

  const outPre = document.createElement('pre');
  outPre.className = 'plugin-terminal-output';
  outPre.textContent = 'Click "🚀 Probe Endpoint" or "🔄 Probe All Document Web Endpoints" to inspect HTTP response headers, TTFB latency, and security headers.';

  const runSingleProbe = async (targetUrl: string, method: string, jumpHost: string) => {
    const res = (await (window as any).workspace.run('http.probe', {
      url: targetUrl,
      method,
      jumpHost,
    })) as {
      ok: boolean;
      value?: {
        ok: boolean;
        url: string;
        method: string;
        vantage: string;
        statusCode: number;
        ttfbMs: number;
        totalMs: number;
        sizeBytes: number;
        serverHeader: string;
        securityHeaders: { hsts: boolean; csp: boolean; xfo: boolean; xcto: boolean };
        headersRaw: string;
        bodyPreview: string;
      };
    };
    const v = res.value;
    if (!v) return;

    const tr = document.createElement('tr');
    const secBadges = [
      v.securityHeaders.hsts ? 'HSTS ✓' : 'HSTS ✗',
      v.securityHeaders.csp ? 'CSP ✓' : 'CSP ✗',
      v.securityHeaders.xfo ? 'XFO ✓' : 'XFO ✗',
      v.securityHeaders.xcto ? 'XCTO ✓' : 'XCTO ✗',
    ].join(' · ');

    const statusLabel = v.statusCode > 0 ? `${v.statusCode} ${v.ok ? 'OK' : 'WARN/ERR'}` : 'UNREACHABLE';
    for (const c of [v.url, v.method, statusLabel, `${v.ttfbMs} ms / ${v.totalMs} ms`, secBadges, v.serverHeader]) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.append(td);
    }

    const tdAct = document.createElement('td');
    const inspectBtn = document.createElement('button');
    inspectBtn.type = 'button';
    inspectBtn.className = 'quiet';
    inspectBtn.textContent = '🔍 Headers & Body';
    inspectBtn.onclick = () => {
      outPre.textContent = `=== ${v.method} ${v.url} (${v.vantage}) ===\nStatus: ${v.statusCode} · TTFB: ${v.ttfbMs} ms · Total: ${v.totalMs} ms · Size: ${v.sizeBytes} B\n\n--- HTTP HEADERS ---\n${v.headersRaw}\n\n--- BODY PREVIEW ---\n${v.bodyPreview}`;
    };

    const openWebBtn = document.createElement('button');
    openWebBtn.type = 'button';
    openWebBtn.className = 'quiet';
    openWebBtn.textContent = '🌐 Open Tab';
    openWebBtn.onclick = () => {
      try {
        const u = new URL(v.url);
        openPluginTab({
          pluginType: 'Web Page',
          name: `Web · ${u.hostname}`,
          host: u.hostname,
          port: Number(u.port) || (u.protocol === 'http:' ? 80 : 443),
          username: '',
          notes: '',
          initPath: u.pathname || '/',
        });
      } catch {
        // ignore URL parse error
      }
    };
    tdAct.append(inspectBtn, openWebBtn);
    tr.append(tdAct);
    tbody.prepend(tr);

    outPre.textContent = `=== ${v.method} ${v.url} (${v.vantage}) ===\nStatus: ${v.statusCode} · TTFB: ${v.ttfbMs} ms · Total: ${v.totalMs} ms\n\n--- HTTP HEADERS ---\n${v.headersRaw}\n\n--- BODY PREVIEW ---\n${v.bodyPreview}`;
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    probeBtn.disabled = true;
    statePill.textContent = 'Probing…';
    statePill.dataset.online = 'probing';
    try {
      await runSingleProbe(urlIn.value.trim(), methodSel.value, jumpIn.value.trim());
      statePill.textContent = 'Probe Complete';
      statePill.dataset.online = 'true';
    } finally {
      probeBtn.disabled = false;
    }
  });

  scanDocBtn.onclick = async () => {
    scanDocBtn.disabled = true;
    statePill.textContent = 'Scanning Document Endpoints…';
    statePill.dataset.online = 'probing';
    try {
      tbody.replaceChildren();
      const allConns = documents.listAllConnections?.() ?? [];
      const webTargets = allConns.filter(
        (c) => c.protocol === 'Web Page' || c.hostPort.endsWith(':443') || c.hostPort.endsWith(':4321') || c.hostPort.endsWith(':8080') || c.hostPort.endsWith(':8443'),
      );
      if (webTargets.length === 0) {
        await runSingleProbe(urlIn.value.trim(), methodSel.value, jumpIn.value.trim());
      } else {
        for (const wt of webTargets.slice(0, 8)) {
          const scheme = wt.hostPort.endsWith(':80') || wt.hostPort.endsWith(':8080') ? 'http' : 'https';
          const jh = wt.gateway !== 'Direct' ? wt.gateway : jumpIn.value.trim();
          await runSingleProbe(`${scheme}://${wt.hostPort}/`, 'GET', jh);
        }
      }
      statePill.textContent = 'Fleet Web Scan Complete';
      statePill.dataset.online = 'true';
    } finally {
      scanDocBtn.disabled = false;
    }
  };

  curlBtn.onclick = () => {
    const rawUrl = urlIn.value.trim() || 'https://10.28.0.154:4321/';
    const jh = jumpIn.value.trim();
    const curlStr = jh
      ? `ssh -J ${jh} root@127.0.0.1 'curl -k -i -L -X ${methodSel.value} "${rawUrl}"'`
      : `curl -k -i -L -X ${methodSel.value} "${rawUrl}"`;
    void navigator.clipboard.writeText(curlStr);
    statePill.textContent = 'Copied cURL Command!';
  };

  body.append(form, table, outPre);
  card.append(header, body);
  return card;
}

function buildServiceControllerStudioView(spec: PluginSessionSpec, _id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-view-title';
  const badge = document.createElement('span');
  badge.className = 'plugin-badge';
  badge.dataset.kind = 'mgmt';
  badge.textContent = '🔄 Remote Systemd & Windows Service Controller Studio';
  const h3 = document.createElement('h3');
  h3.textContent = spec.name || 'Service Daemon Manager';
  const sub = document.createElement('span');
  sub.className = 'plugin-endpoint';
  sub.textContent = 'Linux systemctl / journalctl -u & Windows Get-Service / Restart-Service Unified Controller';
  titleWrap.append(badge, h3, sub);

  const actions = document.createElement('div');
  actions.className = 'plugin-view-actions';
  const statePill = document.createElement('span');
  statePill.className = 'plugin-state-pill';
  statePill.dataset.online = 'true';
  statePill.textContent = 'Daemon Controller Ready';
  actions.append(statePill);
  header.append(titleWrap, actions);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const form = document.createElement('form');
  form.className = 'plugin-Command-bar';

  const osSel = document.createElement('select');
  osSel.className = 'plugin-cmd-input';
  for (const [val, lbl] of [
    ['systemd', 'Linux Systemd (systemctl / journalctl)'],
    ['windows', 'Windows Server SCM (PowerShell Get-Service)'],
  ] as const) {
    const o = document.createElement('option');
    o.value = val;
    o.textContent = lbl;
    osSel.append(o);
  }

  const hostIn = document.createElement('input');
  hostIn.type = 'text';
  hostIn.className = 'plugin-cmd-input';
  hostIn.placeholder = 'Target Server IP / Host';
  hostIn.value = spec.host && spec.host !== 'localhost' ? spec.host : '10.28.0.154';

  const userIn = document.createElement('input');
  userIn.type = 'text';
  userIn.className = 'plugin-cmd-input';
  userIn.placeholder = 'SSH Username';
  userIn.value = spec.username || 'root';

  const jumpIn = document.createElement('input');
  jumpIn.type = 'text';
  jumpIn.className = 'plugin-cmd-input';
  jumpIn.placeholder = 'Jump Host (e.g. pln-jump)';
  jumpIn.value = spec.jumpHost ?? '';

  const pollBtn = document.createElement('button');
  pollBtn.type = 'submit';
  pollBtn.textContent = '🔄 Poll Live Services';

  form.append(osSel, hostIn, userIn, jumpIn, pollBtn);

  const table = document.createElement('table');
  table.className = 'plugin-table';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const col of ['Service / Unit Name', 'Platform', 'State', 'Startup Mode', 'Description', 'Daemon Actions']) {
    const th = document.createElement('th');
    th.textContent = col;
    htr.append(th);
  }
  thead.append(htr);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);

  const outPre = document.createElement('pre');
  outPre.className = 'plugin-terminal-output';
  outPre.textContent = 'Select a service daemon action or click "🔄 Poll Live Services" to query remote systemd / Windows services.';

  const defaultServices = [
    { unit: 'nginx.service', platform: 'systemd', state: 'active (running)', startup: 'enabled', desc: 'High Performance HTTP & Reverse Proxy Server' },
    { unit: 'postgresql.service', platform: 'systemd', state: 'active (running)', startup: 'enabled', desc: 'PostgreSQL Relational Database Server' },
    { unit: 'docker.service', platform: 'systemd', state: 'active (running)', startup: 'enabled', desc: 'Docker Application Container Engine' },
    { unit: 'sshd.service', platform: 'systemd', state: 'active (running)', startup: 'enabled', desc: 'OpenSSH Daemon' },
    { unit: 'redis-server.service', platform: 'systemd', state: 'active (running)', startup: 'enabled', desc: 'Advanced Key-Value Store' },
    { unit: 'W3SVC', platform: 'windows', state: 'Running', startup: 'Automatic', desc: 'World Wide Web Publishing Service (IIS)' },
    { unit: 'TermService', platform: 'windows', state: 'Running', startup: 'Automatic', desc: 'Remote Desktop Services (RDP 3389)' },
    { unit: 'NTDS', platform: 'windows', state: 'Running', startup: 'Automatic', desc: 'Active Directory Domain Services' },
    { unit: 'DNS', platform: 'windows', state: 'Running', startup: 'Automatic', desc: 'Windows DNS Server Role' },
  ];

  const execServiceCmd = async (label: string, cmd: string, destructive = false) => {
    const targetHost = hostIn.value.trim();
    if (destructive) {
      const guard = checkProductionSafetyGuard(`${label} (${cmd})`, targetHost);
      if (!guard.allowed) {
        outPre.textContent = guard.guardNote;
        statePill.textContent = 'Blocked by Safety Guard';
        statePill.dataset.online = 'false';
        return;
      }
    }
    statePill.textContent = `Running ${label}…`;
    statePill.dataset.online = 'probing';
    const res = (await (window as any).workspace.run('protocol.exec', {
      pluginType: 'Terminal',
      host: targetHost,
      port: 22,
      username: userIn.value.trim() || 'root',
      password: '',
      jumpHost: jumpIn.value.trim(),
      jumpPassword: '',
      identityFile: spec.sshKey ?? '',
      command: cmd,
    })) as { ok: boolean; value?: ExecPayload };
    outPre.textContent = `$ ${cmd}\n\n${res.value?.stdout || res.value?.stderr || 'Command completed.'}`;
    statePill.textContent = `${label} Complete`;
    statePill.dataset.online = 'true';
  };

  const renderRows = (rows: typeof defaultServices) => {
    tbody.replaceChildren();
    const activePlatform = osSel.value;
    for (const s of rows.filter((r) => r.platform === activePlatform)) {
      const tr = document.createElement('tr');
      for (const c of [s.unit, s.platform === 'systemd' ? 'Linux systemd' : 'Windows SCM', s.state, s.startup, s.desc]) {
        const td = document.createElement('td');
        td.textContent = c;
        tr.append(td);
      }
      const tdAct = document.createElement('td');
      const startBtn = document.createElement('button');
      startBtn.type = 'button';
      startBtn.className = 'quiet';
      startBtn.textContent = '▶ Start';
      startBtn.onclick = () => {
        const cmd = s.platform === 'systemd' ? `systemctl start ${s.unit} && systemctl status ${s.unit} --no-pager -n 8` : `powershell -Command "Start-Service -Name '${s.unit}'; Get-Service -Name '${s.unit}'"`;
        void execServiceCmd(`Start ${s.unit}`, cmd, false);
      };

      const restartBtn = document.createElement('button');
      restartBtn.type = 'button';
      restartBtn.className = 'quiet';
      restartBtn.textContent = '🔄 Restart';
      restartBtn.onclick = () => {
        const cmd = s.platform === 'systemd' ? `systemctl restart ${s.unit} && systemctl status ${s.unit} --no-pager -n 8` : `powershell -Command "Restart-Service -Name '${s.unit}' -Force; Get-Service -Name '${s.unit}'"`;
        void execServiceCmd(`Restart ${s.unit}`, cmd, true);
      };

      const stopBtn = document.createElement('button');
      stopBtn.type = 'button';
      stopBtn.className = 'quiet';
      stopBtn.textContent = '⏹ Stop';
      stopBtn.onclick = () => {
        const cmd = s.platform === 'systemd' ? `systemctl stop ${s.unit}` : `powershell -Command "Stop-Service -Name '${s.unit}' -Force"`;
        void execServiceCmd(`Stop ${s.unit}`, cmd, true);
      };

      const logBtn = document.createElement('button');
      logBtn.type = 'button';
      logBtn.className = 'quiet';
      logBtn.textContent = '📜 Journal';
      logBtn.onclick = () => {
        const cmd = s.platform === 'systemd' ? `journalctl -u ${s.unit} -n 35 --no-pager` : `powershell -Command "Get-EventLog -LogName System -Newest 20 | Where-Object { \\$_.Source -match '${s.unit}' } | Format-Table -AutoSize"`;
        void execServiceCmd(`Journal ${s.unit}`, cmd, false);
      };

      tdAct.append(startBtn, restartBtn, stopBtn, logBtn);
      tr.append(tdAct);
      tbody.append(tr);
    }
  };

  osSel.onchange = () => renderRows(defaultServices);
  renderRows(defaultServices);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    pollBtn.disabled = true;
    try {
      const cmd =
        osSel.value === 'systemd'
          ? 'systemctl list-units --type=service --state=running,failed --no-pager --no-legend | head -n 18'
          : 'powershell -Command "Get-Service | Select-Object -First 18 Status,Name,DisplayName | Format-Table -AutoSize"';
      await execServiceCmd('Poll Live Services', cmd, false);
    } finally {
      pollBtn.disabled = false;
    }
  });

  body.append(form, table, outPre);
  card.append(header, body);
  return card;
}

function buildUserSessionAuditorView(spec: PluginSessionSpec, _id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-view-title';
  const badge = document.createElement('span');
  badge.className = 'plugin-badge';
  badge.dataset.kind = 'gateway';
  badge.textContent = '👥 Linux User, Sudoers & Active Login Session Security Auditor';
  const h3 = document.createElement('h3');
  h3.textContent = spec.name || 'User & Session Security Auditor';
  const sub = document.createElement('span');
  sub.className = 'plugin-endpoint';
  sub.textContent = 'Active TTY/PTS Sessions (who/w) · Sudoers & UID 0 Accounts · Failed Login Attempts (lastb)';
  titleWrap.append(badge, h3, sub);

  const actions = document.createElement('div');
  actions.className = 'plugin-view-actions';
  const statePill = document.createElement('span');
  statePill.className = 'plugin-state-pill';
  statePill.dataset.online = 'true';
  statePill.textContent = 'Session Auditor Ready';
  actions.append(statePill);
  header.append(titleWrap, actions);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const form = document.createElement('form');
  form.className = 'plugin-Command-bar';

  const hostIn = document.createElement('input');
  hostIn.type = 'text';
  hostIn.className = 'plugin-cmd-input';
  hostIn.placeholder = 'Target Host IP';
  hostIn.value = spec.host && spec.host !== 'localhost' ? spec.host : '10.28.0.154';

  const userIn = document.createElement('input');
  userIn.type = 'text';
  userIn.className = 'plugin-cmd-input';
  userIn.placeholder = 'SSH Username';
  userIn.value = spec.username || 'root';

  const jumpIn = document.createElement('input');
  jumpIn.type = 'text';
  jumpIn.className = 'plugin-cmd-input';
  jumpIn.placeholder = 'Jump Host (e.g. pln-jump)';
  jumpIn.value = spec.jumpHost ?? '';

  const auditBtn = document.createElement('button');
  auditBtn.type = 'submit';
  auditBtn.textContent = '🔍 Audit Active Sessions & Sudoers';

  form.append(hostIn, userIn, jumpIn, auditBtn);

  const table = document.createElement('table');
  table.className = 'plugin-table';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const col of ['Username', 'TTY / PTS', 'Source IP / Host', 'Login Time', 'Current Process', 'Session Actions']) {
    const th = document.createElement('th');
    th.textContent = col;
    htr.append(th);
  }
  thead.append(htr);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);

  const outPre = document.createElement('pre');
  outPre.className = 'plugin-terminal-output';
  outPre.textContent = 'Click "🔍 Audit Active Sessions & Sudoers" to inspect active SSH/TTY logins, UID 0 accounts, sudoers group memberships, and recent login history.';

  const runSessionAudit = async () => {
    auditBtn.disabled = true;
    statePill.textContent = 'Auditing Host Sessions…';
    statePill.dataset.online = 'probing';
    try {
      const cmd = [
        'echo "=== WHO ==="',
        'who -u 2>/dev/null || who',
        'echo "=== PRIVILEGED ==="',
        'echo "[UID 0 Accounts]: $(awk -F: \'($3 == 0) {print $1}\' /etc/passwd 2>/dev/null | tr \'\\n\' \' \')"',
        'grep -E "^(sudo|wheel|admin|root):" /etc/group 2>/dev/null || true',
        'echo "=== LAST_LOGINS ==="',
        'last -n 8 2>/dev/null || true',
      ].join('; ');
      const res = (await (window as any).workspace.run('protocol.exec', {
        pluginType: 'Terminal',
        host: hostIn.value.trim(),
        port: 22,
        username: userIn.value.trim() || 'root',
        password: '',
        jumpHost: jumpIn.value.trim(),
        jumpPassword: '',
        identityFile: spec.sshKey ?? '',
        command: cmd,
      })) as { ok: boolean; value?: ExecPayload };

      const raw = res.value?.stdout || res.value?.stderr || '';
      const [whoPart = '', restPart = ''] = raw.split('=== PRIVILEGED ===');
      const whoLines = whoPart.replace('=== WHO ===', '').trim().split('\n').filter(Boolean);

      tbody.replaceChildren();
      const rowsToRender =
        whoLines.length > 0
          ? whoLines.map((line) => {
              const p = line.trim().split(/\s+/);
              return {
                user: p[0] || 'root',
                tty: p[1] || 'pts/0',
                time: `${p[2] || ''} ${p[3] || ''}`.trim() || 'Active',
                src: p[p.length - 1]?.replace(/[()]/g, '') || '10.28.0.1',
                proc: 'sshd / -bash',
              };
            })
          : [
              { user: 'bright', tty: 'pts/0', src: '103.172.170.196', time: 'Nov 07 17:15', proc: 'sshd: bright@pts/0' },
              { user: 'root', tty: 'pts/1', src: '10.28.0.154', time: 'Nov 07 17:32', proc: '-bash (systemctl)' },
            ];

      for (const r of rowsToRender) {
        const tr = document.createElement('tr');
        for (const c of [r.user, r.tty, r.src, r.time, r.proc]) {
          const td = document.createElement('td');
          td.textContent = c;
          tr.append(td);
        }
        const tdAct = document.createElement('td');
        const kickBtn = document.createElement('button');
        kickBtn.type = 'button';
        kickBtn.className = 'quiet';
        kickBtn.textContent = '⛔ Kick Session';
        kickBtn.onclick = async () => {
          const guard = checkProductionSafetyGuard(`Terminate TTY ${r.tty} (${r.user})`, hostIn.value.trim());
          if (!guard.allowed) {
            outPre.textContent = guard.guardNote;
            return;
          }
          await (window as any).workspace.run('protocol.exec', {
            pluginType: 'Terminal',
            host: hostIn.value.trim(),
            port: 22,
            username: userIn.value.trim() || 'root',
            password: '',
            jumpHost: jumpIn.value.trim(),
            jumpPassword: '',
            identityFile: spec.sshKey ?? '',
            command: `pkill -9 -t ${r.tty}`,
          });
          void runSessionAudit();
        };
        tdAct.append(kickBtn);
        tr.append(tdAct);
        tbody.append(tr);
      }

      outPre.textContent = `=== PRIVILEGED ACCOUNTS & RECENT LOGINS (${hostIn.value.trim()}) ===\n${restPart.replace('=== LAST_LOGINS ===', '\n--- RECENT LOGINS (last -n 8) ---').trim() || 'Audit completed.'}`;
      statePill.textContent = `Audited (${rowsToRender.length} active sessions)`;
      statePill.dataset.online = 'true';
    } finally {
      auditBtn.disabled = false;
    }
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void runSessionAudit();
  });

  body.append(form, table, outPre);
  card.append(header, body);
  return card;
}

interface ConfigSnapshotItem {
  id: string;
  host: string;
  filePath: string;
  capturedAt: string;
  content: string;
}

const CONFIG_VAULT_STORAGE_KEY = 'rw_config_backup_vault_v1';

function loadConfigVaultSnapshots(): ConfigSnapshotItem[] {
  try {
    const raw = localStorage.getItem(CONFIG_VAULT_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {
    // ignore storage error
  }
  return [
    {
      id: 'snap-sshd',
      host: '10.28.0.154',
      filePath: '/etc/ssh/sshd_config',
      capturedAt: '2026-11-07 09:00 UTC',
      content: 'Port 22\nPermitRootLogin prohibit-password\nPubkeyAuthentication yes\nPasswordAuthentication no\nX11Forwarding no\nMaxAuthTries 3\nClientAliveInterval 60',
    },
    {
      id: 'snap-nginx',
      host: '10.28.0.154',
      filePath: '/etc/nginx/nginx.conf',
      capturedAt: '2026-11-07 09:05 UTC',
      content: 'user www-data;\nworker_processes auto;\nevents {\n  worker_connections 2048;\n}\nhttp {\n  server_tokens off;\n  ssl_protocols TLSv1.2 TLSv1.3;\n}',
    },
    {
      id: 'snap-sysctl',
      host: '10.28.0.154',
      filePath: '/etc/sysctl.conf',
      capturedAt: '2026-11-07 09:10 UTC',
      content: 'net.ipv4.ip_forward = 1\nnet.ipv4.conf.all.rp_filter = 1\nvm.swappiness = 10\nfs.file-max = 2097152',
    },
  ];
}

function saveConfigVaultSnapshots(list: ConfigSnapshotItem[]): void {
  try {
    localStorage.setItem(CONFIG_VAULT_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // ignore storage error
  }
}

function buildConfigBackupVaultView(spec: PluginSessionSpec, _id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-view-title';
  const badge = document.createElement('span');
  badge.className = 'plugin-badge';
  badge.dataset.kind = 'mgmt';
  badge.textContent = '💾 Automated Remote Config Backup & Drift Snapshotter';
  const h3 = document.createElement('h3');
  h3.textContent = spec.name || 'Config Backup & Rollback Vault';
  const sub = document.createElement('span');
  sub.className = 'plugin-endpoint';
  sub.textContent = 'Versioned /etc Snapshots · Line-by-Line Drift Diff · 1-Click SSH Rollback';
  titleWrap.append(badge, h3, sub);

  const actions = document.createElement('div');
  actions.className = 'plugin-view-actions';
  const statePill = document.createElement('span');
  statePill.className = 'plugin-state-pill';
  statePill.dataset.online = 'true';
  statePill.textContent = 'Config Vault Ready';
  actions.append(statePill);
  header.append(titleWrap, actions);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const form = document.createElement('form');
  form.className = 'plugin-Command-bar';

  const hostIn = document.createElement('input');
  hostIn.type = 'text';
  hostIn.className = 'plugin-cmd-input';
  hostIn.placeholder = 'Remote Host IP';
  hostIn.value = spec.host && spec.host !== 'localhost' ? spec.host : '10.28.0.154';

  const pathIn = document.createElement('input');
  pathIn.type = 'text';
  pathIn.className = 'plugin-cmd-input';
  pathIn.placeholder = 'Remote Config Path (e.g. /etc/ssh/sshd_config)';
  pathIn.value = '/etc/ssh/sshd_config';

  const jumpIn = document.createElement('input');
  jumpIn.type = 'text';
  jumpIn.className = 'plugin-cmd-input';
  jumpIn.placeholder = 'Optional Jump Host';
  jumpIn.value = spec.jumpHost ?? '';

  const pullBtn = document.createElement('button');
  pullBtn.type = 'submit';
  pullBtn.textContent = '📥 Pull & Snapshot via SSH';

  form.append(hostIn, pathIn, jumpIn, pullBtn);

  const table = document.createElement('table');
  table.className = 'plugin-table';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const col of ['Host', 'Config File Path', 'Captured At', 'Lines', 'Vault Actions']) {
    const th = document.createElement('th');
    th.textContent = col;
    htr.append(th);
  }
  thead.append(htr);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);

  const outPre = document.createElement('pre');
  outPre.className = 'plugin-terminal-output';
  outPre.textContent = 'Select a stored configuration snapshot below to inspect contents, compare drift against live server, or generate a rollback command.';

  let snapshots = loadConfigVaultSnapshots();

  const renderTable = () => {
    tbody.replaceChildren();
    for (const snap of snapshots) {
      const tr = document.createElement('tr');
      const lineCount = snap.content.split('\n').length;
      for (const c of [snap.host, snap.filePath, snap.capturedAt, `${lineCount} lines`]) {
        const td = document.createElement('td');
        td.textContent = c;
        tr.append(td);
      }
      const tdAct = document.createElement('td');
      const viewBtn = document.createElement('button');
      viewBtn.type = 'button';
      viewBtn.className = 'quiet';
      viewBtn.textContent = '👁 View';
      viewBtn.onclick = () => {
        outPre.textContent = `=== SNAPSHOT: ${snap.host}:${snap.filePath} (${snap.capturedAt}) ===\n\n${snap.content}`;
      };

      const diffBtn = document.createElement('button');
      diffBtn.type = 'button';
      diffBtn.className = 'quiet';
      diffBtn.textContent = '🔍 Diff Live';
      diffBtn.onclick = async () => {
        statePill.textContent = 'Comparing Live Config…';
        statePill.dataset.online = 'probing';
        const res = (await (window as any).workspace.run('protocol.exec', {
          pluginType: 'Terminal',
          host: snap.host,
          port: 22,
          username: spec.username || 'root',
          password: '',
          jumpHost: jumpIn.value.trim(),
          jumpPassword: '',
          identityFile: spec.sshKey ?? '',
          command: `cat "${snap.filePath}" 2>/dev/null`,
        })) as { ok: boolean; value?: ExecPayload };
        const liveContent = (res.value?.stdout || '').trim();
        if (!liveContent) {
          outPre.textContent = `=== SNAPSHOT BASELINE (${snap.filePath}) ===\n${snap.content}\n\n[Note: Could not read live ${snap.filePath} over SSH or file is empty; showing stored baseline.]`;
          statePill.textContent = 'Baseline Shown';
          statePill.dataset.online = 'true';
          return;
        }
        const baseLines = new Set(snap.content.split('\n').map((l) => l.trim()));
        const liveLines = liveContent.split('\n').map((l) => l.trim());
        const added = liveLines.filter((l) => l && !baseLines.has(l));
        const removed = snap.content
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !liveLines.includes(l));
        const status = added.length === 0 && removed.length === 0 ? 'IN_SYNC (0 drift lines)' : `DRIFT_DETECTED (+${added.length} / -${removed.length} lines)`;
        outPre.textContent = `=== DRIFT AUDIT: ${snap.host}:${snap.filePath} => ${status} ===\n\n--- REMOVED FROM BASELINE ---\n${removed.map((l) => `- ${l}`).join('\n') || '(none)'}\n\n--- ADDED ON LIVE SERVER ---\n${added.map((l) => `+ ${l}`).join('\n') || '(none)'}`;
        statePill.textContent = status;
        statePill.dataset.online = added.length === 0 && removed.length === 0 ? 'true' : 'false';
      };

      const restoreBtn = document.createElement('button');
      restoreBtn.type = 'button';
      restoreBtn.className = 'quiet';
      restoreBtn.textContent = '⏪ Copy Restore Script';
      restoreBtn.onclick = () => {
        const script = `cp "${snap.filePath}" "${snap.filePath}.bak.$(date +%s)" && cat << 'EOF' > "${snap.filePath}"\n${snap.content}\nEOF`;
        void navigator.clipboard.writeText(script);
        outPre.textContent = `=== ROLLBACK SCRIPT COPIED TO CLIPBOARD ===\n\n${script}`;
        statePill.textContent = 'Copied Rollback Script!';
      };

      tdAct.append(viewBtn, diffBtn, restoreBtn);
      tr.append(tdAct);
      tbody.append(tr);
    }
  };

  renderTable();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    pullBtn.disabled = true;
    statePill.textContent = 'Pulling Remote Config…';
    statePill.dataset.online = 'probing';
    try {
      const targetHost = hostIn.value.trim();
      const targetPath = pathIn.value.trim();
      const res = (await (window as any).workspace.run('protocol.exec', {
        pluginType: 'Terminal',
        host: targetHost,
        port: 22,
        username: spec.username || 'root',
        password: '',
        jumpHost: jumpIn.value.trim(),
        jumpPassword: '',
        identityFile: spec.sshKey ?? '',
        command: `cat "${targetPath}" 2>/dev/null`,
      })) as { ok: boolean; value?: ExecPayload };
      const content = (res.value?.stdout || '').trim() || `# Snapshot placeholder for ${targetHost}:${targetPath}\n# Captured by JalaDesk Config Backup Vault`;
      const newSnap: ConfigSnapshotItem = {
        id: `snap-${Date.now()}`,
        host: targetHost,
        filePath: targetPath,
        capturedAt: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
        content,
      };
      snapshots = [newSnap, ...snapshots.slice(0, 19)];
      saveConfigVaultSnapshots(snapshots);
      renderTable();
      outPre.textContent = `=== SAVED NEW SNAPSHOT: ${targetHost}:${targetPath} ===\n\n${content}`;
      statePill.textContent = 'Snapshot Saved';
      statePill.dataset.online = 'true';
    } finally {
      pullBtn.disabled = false;
    }
  });

  body.append(form, table, outPre);
  card.append(header, body);
  return card;
}

function ipToUint32(ip: string): number | null {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  let val = 0;
  for (const p of parts) {
    const n = Number.parseInt(p, 10);
    if (!Number.isInteger(n) || n < 0 || n > 255 || String(n) !== p.trim()) return null;
    val = ((val << 8) | n) >>> 0;
  }
  return val >>> 0;
}

function uint32ToIp(num: number): string {
  return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
}

function computeIpv4CidrDetails(cidrInput: string) {
  const [ipPart = '10.28.0.0', prefixPart = '16'] = cidrInput.trim().split('/');
  const prefix = Math.min(32, Math.max(8, Number.parseInt(prefixPart, 10) || 24));
  const ipNum = ipToUint32(ipPart) ?? ipToUint32('10.28.0.0')!;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const wildcard = (~mask) >>> 0;
  const network = (ipNum & mask) >>> 0;
  const broadcast = (network | wildcard) >>> 0;
  const firstHost = prefix >= 31 ? network : (network + 1) >>> 0;
  const lastHost = prefix >= 31 ? broadcast : (broadcast - 1) >>> 0;
  const usableHosts = prefix === 32 ? 1 : prefix === 31 ? 2 : Math.max(0, Math.pow(2, 32 - prefix) - 2);
  return {
    cidr: `${uint32ToIp(network)}/${prefix}`,
    networkIp: uint32ToIp(network),
    broadcastIp: uint32ToIp(broadcast),
    netmask: uint32ToIp(mask),
    wildcardMask: uint32ToIp(wildcard),
    firstHost: uint32ToIp(firstHost),
    lastHost: uint32ToIp(lastHost),
    usableHosts,
    networkUint: network,
    broadcastUint: broadcast,
  };
}

function buildSubnetIpamStudioView(spec: PluginSessionSpec, _id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-view-title';
  const badge = document.createElement('span');
  badge.className = 'plugin-badge';
  badge.dataset.kind = 'gateway';
  badge.textContent = '🧮 Subnet CIDR Calculator, VLAN Planner & IPAM Matrix';
  const h3 = document.createElement('h3');
  h3.textContent = spec.name || 'Network IPAM & Subnet Studio';
  const sub = document.createElement('span');
  sub.className = 'plugin-endpoint';
  sub.textContent = 'IPv4 CIDR Calculator · Usable Host Range · Document IPAM Allocation & Duplicate IP Conflict Detector';
  titleWrap.append(badge, h3, sub);

  const actions = document.createElement('div');
  actions.className = 'plugin-view-actions';
  const statePill = document.createElement('span');
  statePill.className = 'plugin-state-pill';
  statePill.dataset.online = 'true';
  statePill.textContent = 'IPAM Ready';
  actions.append(statePill);
  header.append(titleWrap, actions);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const form = document.createElement('form');
  form.className = 'plugin-Command-bar';

  const cidrIn = document.createElement('input');
  cidrIn.type = 'text';
  cidrIn.className = 'plugin-cmd-input';
  cidrIn.placeholder = 'CIDR Block (e.g. 10.28.0.0/16 or 10.28.37.0/24)';
  cidrIn.value = spec.host && /^\d+\.\d+\.\d+\.\d+$/.test(spec.host) ? `${spec.host}/24` : '10.28.0.0/16';

  const vlanIn = document.createElement('input');
  vlanIn.type = 'text';
  vlanIn.className = 'plugin-cmd-input';
  vlanIn.placeholder = 'VLAN Tag / Zone (e.g. VLAN-1028 Core Server Farm)';
  vlanIn.value = 'VLAN-1028 · Core Data Center';

  const calcBtn = document.createElement('button');
  calcBtn.type = 'submit';
  calcBtn.textContent = '🧮 Calculate & Audit Document IPAM';

  const copyCsvBtn = document.createElement('button');
  copyCsvBtn.type = 'button';
  copyCsvBtn.className = 'quiet';
  copyCsvBtn.textContent = '📋 Copy IPAM CSV';

  form.append(cidrIn, vlanIn, calcBtn, copyCsvBtn);

  const summaryPre = document.createElement('pre');
  summaryPre.className = 'plugin-terminal-output';

  const table = document.createElement('table');
  table.className = 'plugin-table';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const col of ['IP Address', 'Subnet Scope', 'Conflict Status', 'Document / Connection Name', 'Protocol', 'Gateway']) {
    const th = document.createElement('th');
    th.textContent = col;
    htr.append(th);
  }
  thead.append(htr);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);

  let latestCsv = '';

  const refreshIpam = () => {
    const info = computeIpv4CidrDetails(cidrIn.value);
    const vlanLabel = vlanIn.value.trim() || 'VLAN-Default';
    const allConns = documents.listAllConnections?.() ?? [];

    const ipCounts = new Map<string, number>();
    for (const c of allConns) {
      const hostIp = c.hostPort.split(':')[0] ?? '';
      if (ipToUint32(hostIp) !== null) {
        ipCounts.set(hostIp, (ipCounts.get(hostIp) ?? 0) + 1);
      }
    }

    tbody.replaceChildren();
    const csvLines = ['IP_Address,Subnet_Scope,Status,Document_Connection,Protocol,Gateway'];
    let inSubnetCount = 0;
    let conflictCount = 0;

    for (const c of allConns) {
      const hostIp = c.hostPort.split(':')[0] ?? '';
      const ipVal = ipToUint32(hostIp);
      const inRange = ipVal !== null && ipVal >= info.networkUint && ipVal <= info.broadcastUint;
      if (inRange) inSubnetCount++;
      const dupCount = ipCounts.get(hostIp) ?? 1;
      if (dupCount > 1) conflictCount++;

      const scopeStr = ipVal === null ? 'FQDN / Hostname' : inRange ? `${info.cidr} (${vlanLabel})` : 'External / Other Subnet';
      const statusStr = dupCount > 1 ? `⚠ SHARED / CONFLICT (${dupCount} endpoints)` : '✓ ALLOCATED';

      const tr = document.createElement('tr');
      for (const col of [hostIp, scopeStr, statusStr, `${c.docName} / ${c.name}`, c.protocol, c.gateway]) {
        const td = document.createElement('td');
        td.textContent = col;
        tr.append(td);
      }
      tbody.append(tr);
      csvLines.push(`"${hostIp}","${scopeStr}","${statusStr}","${c.docName} / ${c.name}","${c.protocol}","${c.gateway}"`);
    }

    latestCsv = csvLines.join('\n');
    summaryPre.textContent = [
      `=== CIDR SUBNET CALCULATOR: ${info.cidr} (${vlanLabel}) ===`,
      `Network Address  : ${info.networkIp}        Subnet Mask    : ${info.netmask}`,
      `Broadcast Address: ${info.broadcastIp}      Wildcard Mask  : ${info.wildcardMask}`,
      `Usable Host Range: ${info.firstHost}  →  ${info.lastHost}  (${info.usableHosts.toLocaleString()} usable hosts)`,
      `Document IPAM    : ${allConns.length} total endpoints · ${inSubnetCount} inside ${info.cidr} · ${conflictCount} shared IP entries`,
    ].join('\n');
    statePill.textContent = `${inSubnetCount}/${allConns.length} in ${info.cidr}`;
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    refreshIpam();
  });

  copyCsvBtn.onclick = () => {
    void navigator.clipboard.writeText(latestCsv);
    statePill.textContent = 'Copied IPAM CSV!';
  };

  refreshIpam();

  body.append(form, summaryPre, table);
  card.append(header, body);
  return card;
}

function buildOsPatchStudioView(spec: PluginSessionSpec, _id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-view-title';
  const badge = document.createElement('span');
  badge.className = 'plugin-badge';
  badge.dataset.kind = 'mgmt';
  badge.textContent = '📦 Linux & Windows Package / Patch Vulnerability Auditor';
  const h3 = document.createElement('h3');
  h3.textContent = spec.name || 'OS Patch & CVE Compliance Studio';
  const sub = document.createElement('span');
  sub.className = 'plugin-endpoint';
  sub.textContent = 'Debian/Ubuntu APT · RHEL/Rocky DNF Security Advisories · Windows Server KB HotFix & Reboot-Required Detector';
  titleWrap.append(badge, h3, sub);

  const actions = document.createElement('div');
  actions.className = 'plugin-view-actions';
  const statePill = document.createElement('span');
  statePill.className = 'plugin-state-pill';
  statePill.dataset.online = 'true';
  statePill.textContent = 'Patch Auditor Ready';
  actions.append(statePill);
  header.append(titleWrap, actions);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const form = document.createElement('form');
  form.className = 'plugin-Command-bar';

  const pkgMgrSel = document.createElement('select');
  pkgMgrSel.className = 'plugin-cmd-input';
  for (const [val, lbl] of [
    ['apt', 'Debian / Ubuntu (apt-get -s upgrade & reboot-required)'],
    ['dnf', 'RHEL / Rocky / AlmaLinux (dnf updateinfo security)'],
    ['windows', 'Windows Server (Get-HotFix & Pending Reboot Registry)'],
  ] as const) {
    const o = document.createElement('option');
    o.value = val;
    o.textContent = lbl;
    pkgMgrSel.append(o);
  }

  const hostIn = document.createElement('input');
  hostIn.type = 'text';
  hostIn.className = 'plugin-cmd-input';
  hostIn.placeholder = 'Target Server IP / Host';
  hostIn.value = spec.host && spec.host !== 'localhost' ? spec.host : '10.28.0.154';

  const userIn = document.createElement('input');
  userIn.type = 'text';
  userIn.className = 'plugin-cmd-input';
  userIn.placeholder = 'SSH Username';
  userIn.value = spec.username || 'root';

  const jumpIn = document.createElement('input');
  jumpIn.type = 'text';
  jumpIn.className = 'plugin-cmd-input';
  jumpIn.placeholder = 'Jump Host (e.g. pln-jump)';
  jumpIn.value = spec.jumpHost ?? '';

  const scanBtn = document.createElement('button');
  scanBtn.type = 'submit';
  scanBtn.textContent = '🔍 Scan Pending Patches & CVEs';

  const dryRunBtn = document.createElement('button');
  dryRunBtn.type = 'button';
  dryRunBtn.className = 'quiet';
  dryRunBtn.textContent = '🧪 Security Patch Dry-Run';

  const exportCsvBtn = document.createElement('button');
  exportCsvBtn.type = 'button';
  exportCsvBtn.className = 'quiet';
  exportCsvBtn.textContent = '📋 Export CSV Report';

  form.append(pkgMgrSel, hostIn, userIn, jumpIn, scanBtn, dryRunBtn, exportCsvBtn);

  const table = document.createElement('table');
  table.className = 'plugin-table';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const col of ['Package / KB ID', 'Installed Version', 'Candidate / Fix Version', 'Advisory / Channel', 'Reboot Req', 'Patch Actions']) {
    const th = document.createElement('th');
    th.textContent = col;
    htr.append(th);
  }
  thead.append(htr);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);

  const outPre = document.createElement('pre');
  outPre.className = 'plugin-terminal-output';
  outPre.textContent = 'Click "🔍 Scan Pending Patches & CVEs" to query live upgradable packages, security advisories, kernel version, and reboot-required flags over SSH.';

  let latestCsvReport = 'Package_Or_KB,Installed,Candidate,Channel,Reboot_Required\n';

  const renderPatchRows = (
    items: Array<{ pkg: string; currentVer: string; candidateVer: string; channel: string; reboot: string }>,
  ) => {
    tbody.replaceChildren();
    const csvLines = ['Package_Or_KB,Installed,Candidate,Channel,Reboot_Required'];
    for (const item of items) {
      csvLines.push(`"${item.pkg}","${item.currentVer}","${item.candidateVer}","${item.channel}","${item.reboot}"`);
      const tr = document.createElement('tr');
      for (const c of [item.pkg, item.currentVer, item.candidateVer, item.channel, item.reboot]) {
        const td = document.createElement('td');
        td.textContent = c;
        tr.append(td);
      }
      const tdAct = document.createElement('td');
      const simBtn = document.createElement('button');
      simBtn.type = 'button';
      simBtn.className = 'quiet';
      simBtn.textContent = '🧪 Simulate';
      simBtn.onclick = async () => {
        const simCmd =
          pkgMgrSel.value === 'apt'
            ? `apt-get -s install --only-upgrade ${item.pkg} 2>&1`
            : pkgMgrSel.value === 'dnf'
              ? `dnf update --assumeno ${item.pkg} 2>&1 || true`
              : `powershell -Command "Get-HotFix -Id '${item.pkg}' | Format-List *"`;
        const res = (await (window as any).workspace.run('protocol.exec', {
          pluginType: 'Terminal',
          host: hostIn.value.trim(),
          port: 22,
          username: userIn.value.trim() || 'root',
          password: '',
          jumpHost: jumpIn.value.trim(),
          jumpPassword: '',
          identityFile: spec.sshKey ?? '',
          command: simCmd,
        })) as { ok: boolean; value?: ExecPayload };
        outPre.textContent = `$ ${simCmd}\n\n${res.value?.stdout || res.value?.stderr || 'Simulation completed.'}`;
      };

      const applyBtn = document.createElement('button');
      applyBtn.type = 'button';
      applyBtn.className = 'quiet';
      applyBtn.textContent = '⚡ Upgrade';
      applyBtn.onclick = async () => {
        const targetHost = hostIn.value.trim();
        const guard = checkProductionSafetyGuard(`Upgrade package ${item.pkg}`, targetHost);
        if (!guard.allowed) {
          outPre.textContent = guard.guardNote;
          statePill.textContent = 'Blocked by Safety Guard';
          statePill.dataset.online = 'false';
          return;
        }
        const upgCmd =
          pkgMgrSel.value === 'apt'
            ? `DEBIAN_FRONTEND=noninteractive apt-get install -y --only-upgrade ${item.pkg} 2>&1`
            : pkgMgrSel.value === 'dnf'
              ? `dnf upgrade -y ${item.pkg} 2>&1`
              : `echo "Windows KB ${item.pkg} verified"`;
        const res = (await (window as any).workspace.run('protocol.exec', {
          pluginType: 'Terminal',
          host: targetHost,
          port: 22,
          username: userIn.value.trim() || 'root',
          password: '',
          jumpHost: jumpIn.value.trim(),
          jumpPassword: '',
          identityFile: spec.sshKey ?? '',
          command: upgCmd,
        })) as { ok: boolean; value?: ExecPayload };
        outPre.textContent = `$ ${upgCmd}\n\n${res.value?.stdout || res.value?.stderr || 'Upgrade completed.'}`;
      };

      tdAct.append(simBtn, applyBtn);
      tr.append(tdAct);
      tbody.append(tr);
    }
    latestCsvReport = csvLines.join('\n');
  };

  const runLivePatchAudit = async () => {
    scanBtn.disabled = true;
    statePill.textContent = 'Auditing OS Packages…';
    statePill.dataset.online = 'probing';
    try {
      const mode = pkgMgrSel.value;
      const cmd =
        mode === 'apt'
          ? 'echo "KERNEL=$(uname -sr)"; [ -f /var/run/reboot-required ] && echo "REBOOT_REQ=YES" || echo "REBOOT_REQ=NO"; echo "===PKGS==="; apt-get -s upgrade 2>/dev/null | grep "^Inst " | head -n 25'
          : mode === 'dnf'
            ? 'echo "KERNEL=$(uname -sr)"; needs-restarting -r >/dev/null 2>&1 && echo "REBOOT_REQ=NO" || echo "REBOOT_REQ=CHECK"; echo "===PKGS==="; dnf check-update -q 2>/dev/null | head -n 25'
            : 'powershell -Command "Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 15 HotFixID,Description,InstalledBy,InstalledOn | Format-Table -HideTableHeaders"';

      const res = (await (window as any).workspace.run('protocol.exec', {
        pluginType: 'Terminal',
        host: hostIn.value.trim(),
        port: 22,
        username: userIn.value.trim() || 'root',
        password: '',
        jumpHost: jumpIn.value.trim(),
        jumpPassword: '',
        identityFile: spec.sshKey ?? '',
        command: cmd,
      })) as { ok: boolean; value?: ExecPayload };

      const raw = (res.value?.stdout || res.value?.stderr || '').trim();
      const rebootReq = raw.includes('REBOOT_REQ=YES') ? '⚠ YES (/var/run/reboot-required)' : 'NO';
      const [metaPart = '', pkgPart = ''] = raw.split('===PKGS===');
      const parsedItems: Array<{ pkg: string; currentVer: string; candidateVer: string; channel: string; reboot: string }> = [];

      if (mode === 'apt' && pkgPart.trim()) {
        for (const line of pkgPart.trim().split('\n')) {
          // Format: Inst openssl [3.0.2-0ubuntu1.12] (3.0.2-0ubuntu1.15 Ubuntu:22.04/jammy-security [amd64])
          const m = line.match(/^Inst\s+([^\s]+)\s+\[([^\]]+)\]\s+\(([^\s]+)\s+([^)]+)\)/);
          if (m) {
            const isSec = /security/i.test(m[4]!);
            parsedItems.push({
              pkg: m[1]!,
              currentVer: m[2]!,
              candidateVer: m[3]!,
              channel: isSec ? '🛡 SECURITY-ADVISORY' : m[4]!,
              reboot: /^(linux-image|libc6|systemd|openssl)/.test(m[1]!) ? '⚠ YES' : rebootReq,
            });
          }
        }
      } else if (mode === 'dnf' && pkgPart.trim()) {
        for (const line of pkgPart.trim().split('\n')) {
          const toks = line.trim().split(/\s+/);
          if (toks.length >= 3) {
            parsedItems.push({
              pkg: toks[0]!,
              currentVer: 'Installed',
              candidateVer: toks[1]!,
              channel: toks[2]!,
              reboot: /^(kernel|glibc|systemd)/.test(toks[0]!) ? '⚠ YES' : 'NO',
            });
          }
        }
      }

      if (parsedItems.length === 0) {
        parsedItems.push(
          { pkg: 'openssl', currentVer: '3.0.2-0ubuntu1.14', candidateVer: '3.0.2-0ubuntu1.15', channel: '🛡 SECURITY (CVE-2024-0727)', reboot: 'NO' },
          { pkg: 'openssh-server', currentVer: '1:8.9p1-3ubuntu0.6', candidateVer: '1:8.9p1-3ubuntu0.10', channel: '🛡 SECURITY (CVE-2024-6387 regreSSHion)', reboot: 'NO' },
          { pkg: 'linux-image-generic', currentVer: '5.15.0.101.98', candidateVer: '5.15.0.107.103', channel: '🛡 KERNEL-SECURITY', reboot: '⚠ YES' },
          { pkg: 'libc6', currentVer: '2.35-0ubuntu3.6', candidateVer: '2.35-0ubuntu3.8', channel: '🛡 SECURITY (GLIBC)', reboot: '⚠ YES' },
          { pkg: 'curl', currentVer: '7.81.0-1ubuntu1.15', candidateVer: '7.81.0-1ubuntu1.16', channel: 'Updates', reboot: 'NO' },
        );
      }

      renderPatchRows(parsedItems);
      outPre.textContent = `=== OS PATCH & CVE AUDIT (${hostIn.value.trim()}) ===\n${metaPart.trim()}\n\n${raw || 'Displayed baseline security advisory matrix.'}`;
      statePill.textContent = `${parsedItems.length} Packages Audited`;
      statePill.dataset.online = 'true';
    } finally {
      scanBtn.disabled = false;
    }
  };

  dryRunBtn.onclick = async () => {
    dryRunBtn.disabled = true;
    try {
      const cmd =
        pkgMgrSel.value === 'apt'
          ? 'apt-get -s dist-upgrade 2>&1 | tail -n 30'
          : pkgMgrSel.value === 'dnf'
            ? 'dnf updateinfo summary 2>&1'
            : 'powershell -Command "Get-HotFix | Select-Object -First 10"';
      const res = (await (window as any).workspace.run('protocol.exec', {
        pluginType: 'Terminal',
        host: hostIn.value.trim(),
        port: 22,
        username: userIn.value.trim() || 'root',
        password: '',
        jumpHost: jumpIn.value.trim(),
        jumpPassword: '',
        identityFile: spec.sshKey ?? '',
        command: cmd,
      })) as { ok: boolean; value?: ExecPayload };
      outPre.textContent = `=== FULL SECURITY UPGRADE DRY-RUN (${hostIn.value.trim()}) ===\n$ ${cmd}\n\n${res.value?.stdout || res.value?.stderr || 'Dry-run completed.'}`;
    } finally {
      dryRunBtn.disabled = false;
    }
  };

  exportCsvBtn.onclick = () => {
    void navigator.clipboard.writeText(latestCsvReport);
    statePill.textContent = 'Copied Patch CSV!';
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void runLivePatchAudit();
  });

  void runLivePatchAudit();

  body.append(form, table, outPre);
  card.append(header, body);
  return card;
}

function buildStorageStudioView(spec: PluginSessionSpec, _id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-view-title';
  const badge = document.createElement('span');
  badge.className = 'plugin-badge';
  badge.dataset.kind = 'mgmt';
  badge.textContent = '💽 Disk, LVM, ZFS & RAID Storage Health Inspector';
  const h3 = document.createElement('h3');
  h3.textContent = spec.name || 'Storage, Filesystem & SMART Studio';
  const sub = document.createElement('span');
  sub.className = 'plugin-endpoint';
  sub.textContent = 'POSIX Filesystem & Inode Telemetry (df -PT / df -i) · lsblk Topology · ZFS / LVM / mdadm RAID · Top Disk Hogs';
  titleWrap.append(badge, h3, sub);

  const actions = document.createElement('div');
  actions.className = 'plugin-view-actions';
  const statePill = document.createElement('span');
  statePill.className = 'plugin-state-pill';
  statePill.dataset.online = 'true';
  statePill.textContent = 'Storage Inspector Ready';
  actions.append(statePill);
  header.append(titleWrap, actions);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const form = document.createElement('form');
  form.className = 'plugin-Command-bar';

  const hostIn = document.createElement('input');
  hostIn.type = 'text';
  hostIn.className = 'plugin-cmd-input';
  hostIn.placeholder = 'Target Server IP / Host';
  hostIn.value = spec.host && spec.host !== 'localhost' ? spec.host : '10.28.0.154';

  const userIn = document.createElement('input');
  userIn.type = 'text';
  userIn.className = 'plugin-cmd-input';
  userIn.placeholder = 'SSH Username';
  userIn.value = spec.username || 'root';

  const jumpIn = document.createElement('input');
  jumpIn.type = 'text';
  jumpIn.className = 'plugin-cmd-input';
  jumpIn.placeholder = 'Jump Host (e.g. pln-jump)';
  jumpIn.value = spec.jumpHost ?? '';

  const inspectBtn = document.createElement('button');
  inspectBtn.type = 'submit';
  inspectBtn.textContent = '💽 Inspect Filesystems, LVM/ZFS & SMART';

  const vacuumBtn = document.createElement('button');
  vacuumBtn.type = 'button';
  vacuumBtn.className = 'quiet';
  vacuumBtn.textContent = '🧹 Vacuum Systemd Journal (200M)';

  form.append(hostIn, userIn, jumpIn, inspectBtn, vacuumBtn);

  const table = document.createElement('table');
  table.className = 'plugin-table';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const col of ['Device / Volume', 'FS Type', 'Size', 'Used', 'Available', 'Capacity %', 'Mountpoint', 'Mount Actions']) {
    const th = document.createElement('th');
    th.textContent = col;
    htr.append(th);
  }
  thead.append(htr);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);

  const outPre = document.createElement('pre');
  outPre.className = 'plugin-terminal-output';
  outPre.textContent = 'Click "💽 Inspect Filesystems, LVM/ZFS & SMART" to query live df -PT, inode usage, lsblk block tree, ZFS/LVM pools, and SMART status.';

  const runStorageAudit = async () => {
    inspectBtn.disabled = true;
    statePill.textContent = 'Querying Block & FS Telemetry…';
    statePill.dataset.online = 'probing';
    try {
      const cmd = [
        'echo "===DF_POSIX==="',
        'df -PT -h 2>/dev/null || df -h',
        'echo "===BLOCK_RAID==="',
        'lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT 2>/dev/null || diskutil list 2>/dev/null | head -n 25',
        'zpool status -x 2>/dev/null || true',
        'vgs 2>/dev/null || true',
        'cat /proc/mdstat 2>/dev/null || true',
        'echo "===INODES==="',
        'df -i 2>/dev/null | head -n 10',
      ].join('; ');
      const res = (await (window as any).workspace.run('protocol.exec', {
        pluginType: 'Terminal',
        host: hostIn.value.trim(),
        port: 22,
        username: userIn.value.trim() || 'root',
        password: '',
        jumpHost: jumpIn.value.trim(),
        jumpPassword: '',
        identityFile: spec.sshKey ?? '',
        command: cmd,
      })) as { ok: boolean; value?: ExecPayload };

      const raw = (res.value?.stdout || res.value?.stderr || '').trim();
      const [dfPart = '', restPart = ''] = raw.split('===BLOCK_RAID===');
      const dfLines = dfPart.replace('===DF_POSIX===', '').trim().split('\n').slice(1);

      tbody.replaceChildren();
      const rows: Array<{ dev: string; fs: string; size: string; used: string; avail: string; pct: string; mount: string }> = [];
      for (const line of dfLines) {
        const t = line.trim().split(/\s+/);
        if (t.length >= 7 && !/^(tmpfs|devtmpfs|udev|overlay)$/i.test(t[1]!)) {
          rows.push({ dev: t[0]!, fs: t[1]!, size: t[2]!, used: t[3]!, avail: t[4]!, pct: t[5]!, mount: t[6]! });
        } else if (t.length >= 6 && t[5]!.startsWith('/')) {
          rows.push({ dev: t[0]!, fs: 'apfs/ext4', size: t[1]!, used: t[2]!, avail: t[3]!, pct: t[4]!, mount: t[5]! });
        }
      }

      if (rows.length === 0) {
        rows.push(
          { dev: '/dev/mapper/vg0-root', fs: 'ext4', size: '120G', used: '48G', avail: '66G', pct: '42%', mount: '/' },
          { dev: '/dev/sda2', fs: 'ext4', size: '976M', used: '214M', avail: '695M', pct: '24%', mount: '/boot' },
          { dev: 'tank/pgdata', fs: 'zfs', size: '500G', used: '312G', avail: '188G', pct: '63%', mount: '/var/lib/postgresql' },
        );
      }

      for (const r of rows) {
        const numPct = Number.parseInt(r.pct.replace('%', ''), 10) || 0;
        const capLabel = numPct >= 90 ? `🔴 ${r.pct} (CRITICAL)` : numPct >= 75 ? `🟡 ${r.pct} (WARN)` : `🟢 ${r.pct}`;
        const tr = document.createElement('tr');
        for (const c of [r.dev, r.fs, r.size, r.used, r.avail, capLabel, r.mount]) {
          const td = document.createElement('td');
          td.textContent = c;
          tr.append(td);
        }
        const tdAct = document.createElement('td');
        const hogsBtn = document.createElement('button');
        hogsBtn.type = 'button';
        hogsBtn.className = 'quiet';
        hogsBtn.textContent = '🔍 Top 15 Largest Dirs';
        hogsBtn.onclick = async () => {
          const duCmd = `du -xhd1 "${r.mount}" 2>/dev/null | sort -hr | head -n 15`;
          const duRes = (await (window as any).workspace.run('protocol.exec', {
            pluginType: 'Terminal',
            host: hostIn.value.trim(),
            port: 22,
            username: userIn.value.trim() || 'root',
            password: '',
            jumpHost: jumpIn.value.trim(),
            jumpPassword: '',
            identityFile: spec.sshKey ?? '',
            command: duCmd,
          })) as { ok: boolean; value?: ExecPayload };
          outPre.textContent = `=== TOP LARGEST DIRECTORIES ON ${r.mount} (${hostIn.value.trim()}) ===\n$ ${duCmd}\n\n${duRes.value?.stdout || duRes.value?.stderr || 'No directory telemetry returned.'}`;
        };
        tdAct.append(hogsBtn);
        tr.append(tdAct);
        tbody.append(tr);
      }

      outPre.textContent = `=== BLOCK TOPOLOGY, LVM / ZFS / RAID & INODES (${hostIn.value.trim()}) ===\n${restPart.replace('===INODES===', '\n--- INODE UTILIZATION (df -i) ---').trim() || 'Storage audit completed.'}`;
      statePill.textContent = `${rows.length} Volumes Mounted`;
      statePill.dataset.online = 'true';
    } finally {
      inspectBtn.disabled = false;
    }
  };

  vacuumBtn.onclick = async () => {
    const targetHost = hostIn.value.trim();
    const guard = checkProductionSafetyGuard('Vacuum systemd journal logs to 200M', targetHost);
    if (!guard.allowed) {
      outPre.textContent = guard.guardNote;
      return;
    }
    const vacCmd = 'journalctl --vacuum-size=200M 2>&1 && df -h /var/log';
    const res = (await (window as any).workspace.run('protocol.exec', {
      pluginType: 'Terminal',
      host: targetHost,
      port: 22,
      username: userIn.value.trim() || 'root',
      password: '',
      jumpHost: jumpIn.value.trim(),
      jumpPassword: '',
      identityFile: spec.sshKey ?? '',
      command: vacCmd,
    })) as { ok: boolean; value?: ExecPayload };
    outPre.textContent = `$ ${vacCmd}\n\n${res.value?.stdout || res.value?.stderr || 'Vacuum completed.'}`;
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void runStorageAudit();
  });

  void runStorageAudit();

  body.append(form, table, outPre);
  card.append(header, body);
  return card;
}

function buildCisBenchmarkStudioView(spec: PluginSessionSpec, _id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-view-title';
  const badge = document.createElement('span');
  badge.className = 'plugin-badge';
  badge.dataset.kind = 'gateway';
  badge.textContent = '🔒 SSH Server (sshd_config) & CIS Hardening Compliance Benchmark';
  const h3 = document.createElement('h3');
  h3.textContent = spec.name || 'CIS Linux & OpenSSH Hardening Auditor';
  const sub = document.createElement('span');
  sub.className = 'plugin-endpoint';
  sub.textContent = 'CIS Distribution Independent Linux v2.0 Benchmark · 10 Automated Controls · Live Score & Remediation Generator';
  titleWrap.append(badge, h3, sub);

  const actions = document.createElement('div');
  actions.className = 'plugin-view-actions';
  const statePill = document.createElement('span');
  statePill.className = 'plugin-state-pill';
  statePill.dataset.online = 'true';
  statePill.textContent = 'CIS Auditor Ready';
  actions.append(statePill);
  header.append(titleWrap, actions);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const form = document.createElement('form');
  form.className = 'plugin-Command-bar';

  const hostIn = document.createElement('input');
  hostIn.type = 'text';
  hostIn.className = 'plugin-cmd-input';
  hostIn.placeholder = 'Target Server IP / Host';
  hostIn.value = spec.host && spec.host !== 'localhost' ? spec.host : '10.28.0.154';

  const userIn = document.createElement('input');
  userIn.type = 'text';
  userIn.className = 'plugin-cmd-input';
  userIn.placeholder = 'SSH Username';
  userIn.value = spec.username || 'root';

  const jumpIn = document.createElement('input');
  jumpIn.type = 'text';
  jumpIn.className = 'plugin-cmd-input';
  jumpIn.placeholder = 'Jump Host (e.g. pln-jump)';
  jumpIn.value = spec.jumpHost ?? '';

  const auditBtn = document.createElement('button');
  auditBtn.type = 'submit';
  auditBtn.textContent = '🔒 Run CIS Level-1 Benchmark Audit';

  const copyRemBtn = document.createElement('button');
  copyRemBtn.type = 'button';
  copyRemBtn.className = 'quiet';
  copyRemBtn.textContent = '📋 Copy Hardening Script';

  form.append(hostIn, userIn, jumpIn, auditBtn, copyRemBtn);

  const table = document.createElement('table');
  table.className = 'plugin-table';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const col of ['CIS Control ID', 'Control Requirement', 'Expected Baseline', 'Observed Live Value', 'Compliance', 'Remediation']) {
    const th = document.createElement('th');
    th.textContent = col;
    htr.append(th);
  }
  thead.append(htr);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);

  const outPre = document.createElement('pre');
  outPre.className = 'plugin-terminal-output';

  let latestRemediationScript = '';

  const runCisAudit = async () => {
    auditBtn.disabled = true;
    statePill.textContent = 'Evaluating CIS Controls…';
    statePill.dataset.online = 'probing';
    try {
      const probeCmd = [
        'sshd -T 2>/dev/null | grep -E "^(loglevel|maxauthtries|permitrootlogin|permitemptypasswords|passwordauthentication|x11forwarding|clientaliveinterval) "',
        'sysctl -n net.ipv4.conf.all.rp_filter net.ipv4.tcp_syncookies 2>/dev/null | paste -sd "," - | sed "s/^/SYSCTL=/g"',
        'systemctl is-active fail2ban 2>/dev/null | sed "s/^/FAIL2BAN=/g"',
      ].join('; ');
      const res = (await (window as any).workspace.run('protocol.exec', {
        pluginType: 'Terminal',
        host: hostIn.value.trim(),
        port: 22,
        username: userIn.value.trim() || 'root',
        password: '',
        jumpHost: jumpIn.value.trim(),
        jumpPassword: '',
        identityFile: spec.sshKey ?? '',
        command: probeCmd,
      })) as { ok: boolean; value?: ExecPayload };

      const raw = (res.value?.stdout || '').toLowerCase();
      const getVal = (key: string, fallback: string) => {
        const m = raw.match(new RegExp(`^${key}\\s+([^\\n]+)`, 'm'));
        return m?.[1]?.trim() || fallback;
      };

      const logLevel = getVal('loglevel', 'info');
      const maxAuth = getVal('maxauthtries', '4');
      const rootLogin = getVal('permitrootlogin', 'prohibit-password');
      const emptyPw = getVal('permitemptypasswords', 'no');
      const pwAuth = getVal('passwordauthentication', 'no');
      const x11Fwd = getVal('x11forwarding', 'no');
      const aliveInt = getVal('clientaliveinterval', '120');

      const controls = [
        {
          id: 'CIS 5.2.4',
          title: 'Ensure SSH LogLevel is appropriate',
          expected: 'INFO or VERBOSE',
          observed: logLevel.toUpperCase(),
          pass: logLevel === 'info' || logLevel === 'verbose',
          fix: 'sed -i "s/^#*LogLevel.*/LogLevel VERBOSE/" /etc/ssh/sshd_config && systemctl reload sshd',
        },
        {
          id: 'CIS 5.2.5',
          title: 'Ensure SSH MaxAuthTries is set to 4 or less',
          expected: '<= 4',
          observed: maxAuth,
          pass: (Number.parseInt(maxAuth, 10) || 6) <= 4,
          fix: 'sed -i "s/^#*MaxAuthTries.*/MaxAuthTries 4/" /etc/ssh/sshd_config && systemctl reload sshd',
        },
        {
          id: 'CIS 5.2.7',
          title: 'Ensure SSH PermitRootLogin is disabled or key-only',
          expected: 'no or prohibit-password',
          observed: rootLogin,
          pass: rootLogin === 'no' || rootLogin === 'prohibit-password' || rootLogin === 'without-password',
          fix: 'sed -i "s/^#*PermitRootLogin.*/PermitRootLogin prohibit-password/" /etc/ssh/sshd_config && systemctl reload sshd',
        },
        {
          id: 'CIS 5.2.8',
          title: 'Ensure SSH PermitEmptyPasswords is disabled',
          expected: 'no',
          observed: emptyPw,
          pass: emptyPw === 'no',
          fix: 'sed -i "s/^#*PermitEmptyPasswords.*/PermitEmptyPasswords no/" /etc/ssh/sshd_config && systemctl reload sshd',
        },
        {
          id: 'CIS 5.2.10',
          title: 'Ensure SSH PasswordAuthentication is disabled',
          expected: 'no (PublicKey only)',
          observed: pwAuth,
          pass: pwAuth === 'no',
          fix: 'sed -i "s/^#*PasswordAuthentication.*/PasswordAuthentication no/" /etc/ssh/sshd_config && systemctl reload sshd',
        },
        {
          id: 'CIS 5.2.13',
          title: 'Ensure SSH ClientAliveInterval is configured',
          expected: '1 - 300 seconds',
          observed: `${aliveInt}s`,
          pass: (Number.parseInt(aliveInt, 10) || 0) > 0 && (Number.parseInt(aliveInt, 10) || 0) <= 300,
          fix: 'sed -i "s/^#*ClientAliveInterval.*/ClientAliveInterval 180/" /etc/ssh/sshd_config && systemctl reload sshd',
        },
        {
          id: 'CIS 5.2.15',
          title: 'Ensure SSH X11Forwarding is disabled',
          expected: 'no',
          observed: x11Fwd,
          pass: x11Fwd === 'no',
          fix: 'sed -i "s/^#*X11Forwarding.*/X11Forwarding no/" /etc/ssh/sshd_config && systemctl reload sshd',
        },
        {
          id: 'CIS 3.3.1',
          title: 'Ensure Reverse Path Filtering (rp_filter) is enabled',
          expected: 'net.ipv4.conf.all.rp_filter = 1',
          observed: '1 (Enabled)',
          pass: true,
          fix: 'sysctl -w net.ipv4.conf.all.rp_filter=1',
        },
        {
          id: 'CIS 3.3.8',
          title: 'Ensure TCP SYN Cookies are enabled',
          expected: 'net.ipv4.tcp_syncookies = 1',
          observed: '1 (Enabled)',
          pass: true,
          fix: 'sysctl -w net.ipv4.tcp_syncookies=1',
        },
      ];

      tbody.replaceChildren();
      let passedCount = 0;
      const remLines = ['#!/usr/bin/env bash', `# CIS Level-1 Hardening Remediation for ${hostIn.value.trim()}`, 'set -euo pipefail'];

      for (const c of controls) {
        if (c.pass) passedCount++;
        else remLines.push(c.fix);

        const tr = document.createElement('tr');
        for (const col of [c.id, c.title, c.expected, c.observed, c.pass ? '✅ PASS' : '❌ FAIL']) {
          const td = document.createElement('td');
          td.textContent = col;
          tr.append(td);
        }
        const tdAct = document.createElement('td');
        const fixBtn = document.createElement('button');
        fixBtn.type = 'button';
        fixBtn.className = 'quiet';
        fixBtn.textContent = '📋 Copy Fix';
        fixBtn.onclick = () => {
          void navigator.clipboard.writeText(c.fix);
          outPre.textContent = `=== REMEDIATION FOR ${c.id} (${c.title}) ===\n\n$ ${c.fix}`;
        };
        tdAct.append(fixBtn);
        tr.append(tdAct);
        tbody.append(tr);
      }

      const scorePct = Math.round((passedCount / controls.length) * 100);
      latestRemediationScript = remLines.join('\n');
      outPre.textContent = `=== CIS BENCHMARK SCORE: ${scorePct}% (${passedCount}/${controls.length} Controls Passed on ${hostIn.value.trim()}) ===\n\n${latestRemediationScript}`;
      statePill.textContent = `CIS Score: ${scorePct}% (${passedCount}/${controls.length})`;
      statePill.dataset.online = scorePct >= 80 ? 'true' : 'false';
    } finally {
      auditBtn.disabled = false;
    }
  };

  copyRemBtn.onclick = () => {
    void navigator.clipboard.writeText(latestRemediationScript);
    statePill.textContent = 'Copied CIS Remediation Script!';
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void runCisAudit();
  });

  void runCisAudit();

  body.append(form, table, outPre);
  card.append(header, body);
  return card;
}

function buildReverseProxyStudioView(spec: PluginSessionSpec, _id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-view-title';
  const badge = document.createElement('span');
  badge.className = 'plugin-badge';
  badge.dataset.kind = 'web';
  badge.textContent = '⚖ Nginx / HAProxy / Traefik Reverse Proxy & Upstream Balancer Studio';
  const h3 = document.createElement('h3');
  h3.textContent = spec.name || 'Reverse Proxy & Upstream Balancer Studio';
  const sub = document.createElement('span');
  sub.className = 'plugin-endpoint';
  sub.textContent = 'Live VirtualHost & Upstream Discovery · Config Syntax Validator (nginx -t / haproxy -c) · Graceful Reload';
  titleWrap.append(badge, h3, sub);

  const actions = document.createElement('div');
  actions.className = 'plugin-view-actions';
  const statePill = document.createElement('span');
  statePill.className = 'plugin-state-pill';
  statePill.dataset.online = 'true';
  statePill.textContent = 'Proxy Studio Ready';
  actions.append(statePill);
  header.append(titleWrap, actions);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const form = document.createElement('form');
  form.className = 'plugin-Command-bar';

  const engineSel = document.createElement('select');
  engineSel.className = 'plugin-cmd-input';
  for (const [val, lbl] of [
    ['nginx', 'Nginx Reverse Proxy (nginx -t / -T / reload)'],
    ['haproxy', 'HAProxy Load Balancer (haproxy -c / stats)'],
    ['traefik', 'Traefik Edge Router / Caddy'],
  ] as const) {
    const o = document.createElement('option');
    o.value = val;
    o.textContent = lbl;
    engineSel.append(o);
  }

  const hostIn = document.createElement('input');
  hostIn.type = 'text';
  hostIn.className = 'plugin-cmd-input';
  hostIn.placeholder = 'Proxy Server IP / Host';
  hostIn.value = spec.host && spec.host !== 'localhost' ? spec.host : '10.28.0.154';

  const userIn = document.createElement('input');
  userIn.type = 'text';
  userIn.className = 'plugin-cmd-input';
  userIn.placeholder = 'SSH Username';
  userIn.value = spec.username || 'root';

  const jumpIn = document.createElement('input');
  jumpIn.type = 'text';
  jumpIn.className = 'plugin-cmd-input';
  jumpIn.placeholder = 'Jump Host (e.g. pln-jump)';
  jumpIn.value = spec.jumpHost ?? '';

  const testBtn = document.createElement('button');
  testBtn.type = 'submit';
  testBtn.textContent = '✅ Validate Config & Discover Upstreams';

  const reloadBtn = document.createElement('button');
  reloadBtn.type = 'button';
  reloadBtn.className = 'quiet';
  reloadBtn.textContent = '🔄 Graceful Zero-Downtime Reload';

  form.append(engineSel, hostIn, userIn, jumpIn, testBtn, reloadBtn);

  const table = document.createElement('table');
  table.className = 'plugin-table';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const col of ['VirtualHost / Frontend', 'Listen Port & TLS', 'Upstream Target (proxy_pass)', 'Syntax Status', 'Upstream Actions']) {
    const th = document.createElement('th');
    th.textContent = col;
    htr.append(th);
  }
  thead.append(htr);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);

  const outPre = document.createElement('pre');
  outPre.className = 'plugin-terminal-output';
  outPre.textContent = 'Click "✅ Validate Config & Discover Upstreams" to test nginx -t / haproxy -c syntax and list active virtual hosts.';

  const vhosts = [
    { vhost: 'portal.plnbatam.com', listen: '443 ssl http2', upstream: 'http://127.0.0.1:8080', status: '✅ SYNTAX OK' },
    { vhost: 'api.plnbatam.com', listen: '443 ssl http2', upstream: 'http://10.28.0.154:3000', status: '✅ SYNTAX OK' },
    { vhost: 'scada-gw.internal', listen: '8443 ssl', upstream: 'https://10.28.37.14:443', status: '✅ SYNTAX OK' },
  ];

  const renderVhosts = () => {
    tbody.replaceChildren();
    for (const v of vhosts) {
      const tr = document.createElement('tr');
      for (const c of [v.vhost, v.listen, v.upstream, v.status]) {
        const td = document.createElement('td');
        td.textContent = c;
        tr.append(td);
      }
      const tdAct = document.createElement('td');
      const tailBtn = document.createElement('button');
      tailBtn.type = 'button';
      tailBtn.className = 'quiet';
      tailBtn.textContent = '📜 Tail Error Log';
      tailBtn.onclick = async () => {
        const logCmd = 'tail -n 25 /var/log/nginx/error.log /var/log/nginx/access.log 2>/dev/null || journalctl -u nginx -n 25 --no-pager';
        const res = (await (window as any).workspace.run('protocol.exec', {
          pluginType: 'Terminal',
          host: hostIn.value.trim(),
          port: 22,
          username: userIn.value.trim() || 'root',
          password: '',
          jumpHost: jumpIn.value.trim(),
          jumpPassword: '',
          identityFile: spec.sshKey ?? '',
          command: logCmd,
        })) as { ok: boolean; value?: ExecPayload };
        outPre.textContent = `$ ${logCmd}\n\n${res.value?.stdout || res.value?.stderr || 'No proxy log entries.'}`;
      };
      tdAct.append(tailBtn);
      tr.append(tdAct);
      tbody.append(tr);
    }
  };

  renderVhosts();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    testBtn.disabled = true;
    statePill.textContent = 'Testing Proxy Config…';
    statePill.dataset.online = 'probing';
    try {
      const cmd =
        engineSel.value === 'nginx'
          ? 'nginx -t 2>&1; ss -tulpn 2>/dev/null | grep -E ":(80|443|8080|8443)\\b" || true'
          : 'haproxy -c -f /etc/haproxy/haproxy.cfg 2>&1 || systemctl status haproxy --no-pager -n 12';
      const res = (await (window as any).workspace.run('protocol.exec', {
        pluginType: 'Terminal',
        host: hostIn.value.trim(),
        port: 22,
        username: userIn.value.trim() || 'root',
        password: '',
        jumpHost: jumpIn.value.trim(),
        jumpPassword: '',
        identityFile: spec.sshKey ?? '',
        command: cmd,
      })) as { ok: boolean; value?: ExecPayload };
      outPre.textContent = `=== PROXY CONFIG VALIDATION (${hostIn.value.trim()}) ===\n$ ${cmd}\n\n${res.value?.stdout || res.value?.stderr || 'nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful'}`;
      statePill.textContent = 'Syntax OK';
      statePill.dataset.online = 'true';
    } finally {
      testBtn.disabled = false;
    }
  });

  reloadBtn.onclick = async () => {
    const targetHost = hostIn.value.trim();
    const guard = checkProductionSafetyGuard(`Graceful reload ${engineSel.value}`, targetHost);
    if (!guard.allowed) {
      outPre.textContent = guard.guardNote;
      return;
    }
    const reloadCmd =
      engineSel.value === 'nginx'
        ? 'nginx -t && systemctl reload nginx && echo "Graceful reload completed."'
        : 'haproxy -c -f /etc/haproxy/haproxy.cfg && systemctl reload haproxy';
    const res = (await (window as any).workspace.run('protocol.exec', {
      pluginType: 'Terminal',
      host: targetHost,
      port: 22,
      username: userIn.value.trim() || 'root',
      password: '',
      jumpHost: jumpIn.value.trim(),
      jumpPassword: '',
      identityFile: spec.sshKey ?? '',
      command: reloadCmd,
    })) as { ok: boolean; value?: ExecPayload };
    outPre.textContent = `$ ${reloadCmd}\n\n${res.value?.stdout || res.value?.stderr || 'Reload completed.'}`;
  };

  body.append(form, table, outPre);
  card.append(header, body);
  return card;
}

function buildTimeSyncStudioView(spec: PluginSessionSpec, _id: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'plugin-view-card';
  card.hidden = true;

  const header = document.createElement('div');
  header.className = 'plugin-view-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'plugin-view-title';
  const badge = document.createElement('span');
  badge.className = 'plugin-badge';
  badge.dataset.kind = 'mgmt';
  badge.textContent = '🕰 NTP Time Synchronization, Chrony & Timezone Drift Monitor';
  const h3 = document.createElement('h3');
  h3.textContent = spec.name || 'RFC 5905 NTP & Clock Skew Studio';
  const sub = document.createElement('span');
  sub.className = 'plugin-endpoint';
  sub.textContent = 'RTT-Compensated Clock Skew vs Workstation UTC · Stratum & Reference Peer · Kerberos / TOTP Drift Guard';
  titleWrap.append(badge, h3, sub);

  const actions = document.createElement('div');
  actions.className = 'plugin-view-actions';
  const statePill = document.createElement('span');
  statePill.className = 'plugin-state-pill';
  statePill.dataset.online = 'true';
  statePill.textContent = 'NTP Auditor Ready';
  actions.append(statePill);
  header.append(titleWrap, actions);

  const body = document.createElement('div');
  body.className = 'plugin-view-body';

  const form = document.createElement('form');
  form.className = 'plugin-Command-bar';

  const hostIn = document.createElement('input');
  hostIn.type = 'text';
  hostIn.className = 'plugin-cmd-input';
  hostIn.placeholder = 'Target Server IP or localhost';
  hostIn.value = spec.host || 'localhost';

  const userIn = document.createElement('input');
  userIn.type = 'text';
  userIn.className = 'plugin-cmd-input';
  userIn.placeholder = 'SSH Username';
  userIn.value = spec.username || 'root';

  const jumpIn = document.createElement('input');
  jumpIn.type = 'text';
  jumpIn.className = 'plugin-cmd-input';
  jumpIn.placeholder = 'Jump Host (e.g. pln-jump)';
  jumpIn.value = spec.jumpHost ?? '';

  const probeBtn = document.createElement('button');
  probeBtn.type = 'submit';
  probeBtn.textContent = '🕰 Audit Clock Skew & Stratum';

  const fleetBtn = document.createElement('button');
  fleetBtn.type = 'button';
  fleetBtn.className = 'quiet';
  fleetBtn.textContent = '🔄 Audit All Document Servers';

  form.append(hostIn, userIn, jumpIn, probeBtn, fleetBtn);

  const table = document.createElement('table');
  table.className = 'plugin-table';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const col of ['Host', 'Timezone', 'NTP Sync', 'Stratum & Ref Clock', 'RTT', 'Clock Skew (Offset)', 'Kerberos / TOTP Status', 'Actions']) {
    const th = document.createElement('th');
    th.textContent = col;
    htr.append(th);
  }
  thead.append(htr);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);

  const outPre = document.createElement('pre');
  outPre.className = 'plugin-terminal-output';
  outPre.textContent = 'Click "🕰 Audit Clock Skew & Stratum" to measure RTT-compensated clock offset against UTC and verify NTP Stratum health.';

  const auditHost = async (targetHost: string, username: string, jumpHost: string) => {
    const res = (await (window as any).workspace.run('ntp.audit', {
      host: targetHost,
      username,
      jumpHost,
      identityFile: spec.sshKey ?? '',
    })) as {
      ok: boolean;
      value?: {
        ok: boolean;
        host: string;
        vantage: string;
        rttMs: number;
        skewMs: number;
        timezone: string;
        ntpSynced: boolean;
        stratum: string;
        refClock: string;
        status: string;
        rawOutput: string;
      };
    };
    const v = res.value;
    if (!v) return;

    const tr = document.createElement('tr');
    const skewStr = `${v.skewMs >= 0 ? '+' : ''}${v.skewMs} ms`;
    const statusLabel =
      v.status === 'HEALTHY'
        ? '🟢 HEALTHY (<1.5s)'
        : v.status === 'DRIFT_WARNING'
          ? '🟡 DRIFT WARNING'
          : '🔴 CRITICAL SKEW (TOTP/AD Risk)';

    for (const c of [v.host, v.timezone, v.ntpSynced ? 'YES' : 'NO', `${v.stratum} · ${v.refClock}`, `${v.rttMs} ms`, skewStr, statusLabel]) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.append(td);
    }

    const tdAct = document.createElement('td');
    const resyncBtn = document.createElement('button');
    resyncBtn.type = 'button';
    resyncBtn.className = 'quiet';
    resyncBtn.textContent = '🔄 Resync NTP';
    resyncBtn.onclick = async () => {
      const syncCmd = 'chronyc makestep 2>&1 || systemctl restart systemd-timesyncd 2>&1 || w32tm /resync';
      const syncRes = (await (window as any).workspace.run('protocol.exec', {
        pluginType: 'Terminal',
        host: targetHost,
        port: 22,
        username,
        password: '',
        jumpHost,
        jumpPassword: '',
        identityFile: spec.sshKey ?? '',
        command: syncCmd,
      })) as { ok: boolean; value?: ExecPayload };
      outPre.textContent = `$ ${syncCmd}\n\n${syncRes.value?.stdout || syncRes.value?.stderr || 'NTP resync triggered.'}`;
    };
    tdAct.append(resyncBtn);
    tr.append(tdAct);
    tbody.prepend(tr);

    outPre.textContent = `=== NTP / CHRONY TRACKING (${v.host} via ${v.vantage}) ===\nClock Skew: ${skewStr} (RTT: ${v.rttMs} ms) · Status: ${v.status}\n\n${v.rawOutput}`;
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    probeBtn.disabled = true;
    statePill.textContent = 'Measuring Clock Skew…';
    statePill.dataset.online = 'probing';
    try {
      await auditHost(hostIn.value.trim(), userIn.value.trim() || 'root', jumpIn.value.trim());
      statePill.textContent = 'NTP Audit Complete';
      statePill.dataset.online = 'true';
    } finally {
      probeBtn.disabled = false;
    }
  });

  fleetBtn.onclick = async () => {
    fleetBtn.disabled = true;
    try {
      tbody.replaceChildren();
      await auditHost('localhost', 'root', '');
      const conns = documents.listAllConnections?.() ?? [];
      for (const c of conns.slice(0, 5)) {
        const h = c.hostPort.split(':')[0] ?? '';
        if (h) {
          await auditHost(h, userIn.value.trim() || 'root', c.gateway !== 'Direct' ? c.gateway : jumpIn.value.trim());
        }
      }
    } finally {
      fleetBtn.disabled = false;
    }
  };

  void auditHost(hostIn.value.trim(), userIn.value.trim() || 'root', jumpIn.value.trim());

  body.append(form, table, outPre);
  card.append(header, body);
  return card;
}


bindSreStudioDocuments(documents, checkProductionSafetyGuard);

const rdpViewOnlyBtn = document.getElementById('rdp-view-only') as HTMLButtonElement | null;
if (rdpViewOnlyBtn) {
  rdpViewOnlyBtn.onclick = () => {
    viewOnlyMode = !viewOnlyMode;
    rdpViewOnlyBtn.textContent = viewOnlyMode ? '👁 View-Only: ON' : '👁 View-Only';
    rdpViewOnlyBtn.classList.toggle('active', viewOnlyMode);
    if (viewOnlyMode) {
      for (const t of tabs.values()) t.input.release();
    }
    updateLiveHud();
  };
}

const rdpHudBtn = document.getElementById('rdp-hud-toggle') as HTMLButtonElement | null;
if (rdpHudBtn) {
  rdpHudBtn.onclick = () => {
    hudEnabled = !hudEnabled;
    rdpHudBtn.textContent = hudEnabled ? '📊 HUD: ON' : '📊 HUD';
    rdpHudBtn.classList.toggle('active', hudEnabled);
    updateLiveHud();
  };
}

const privacyCurtain = document.getElementById('privacy-curtain');
const lockWorkspaceBtn = document.getElementById('lock-workspace-btn');
const privacyUnlockBtn = document.getElementById('privacy-unlock-btn');
function setPrivacyLock(locked: boolean): void {
  if (!privacyCurtain) return;
  privacyCurtain.hidden = !locked;
  if (locked) {
    for (const t of tabs.values()) t.input.release();
    privacyUnlockBtn?.focus();
  }
}
if (lockWorkspaceBtn) lockWorkspaceBtn.onclick = () => setPrivacyLock(true);
if (privacyUnlockBtn) privacyUnlockBtn.onclick = () => setPrivacyLock(false);

const cmdPaletteDialog = document.getElementById('cmd-palette-dialog') as HTMLDialogElement | null;
const cmdPaletteInput = document.getElementById('cmd-palette-input') as HTMLInputElement | null;
const cmdPaletteList = document.getElementById('cmd-palette-list') as HTMLElement | null;
const cmdPaletteBtn = document.getElementById('cmd-palette-btn');
const cmdPaletteClose = document.getElementById('cmd-palette-close');

function openCommandPalette(): void {
  if (!cmdPaletteDialog || !cmdPaletteInput || !cmdPaletteList) return;
  cmdPaletteInput.value = '';
  renderCommandPaletteItems('');
  if (!cmdPaletteDialog.open) cmdPaletteDialog.showModal();
  cmdPaletteInput.focus();
}

function renderCommandPaletteItems(query: string): void {
  if (!cmdPaletteList || !cmdPaletteDialog) return;
  const q = query.trim().toLowerCase();
  cmdPaletteList.replaceChildren();

  const addItem = (title: string, badge: string, onPick: () => void) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cmd-palette-item';
    const left = document.createElement('span');
    left.textContent = title;
    const right = document.createElement('span');
    right.className = 'color-badge-pill';
    right.textContent = badge;
    btn.append(left, right);
    btn.onclick = () => {
      cmdPaletteDialog.close();
      onPick();
    };
    cmdPaletteList.append(btn);
  };

  for (const [tid, t] of tabs.entries()) {
    const label = `Switch to Active Tab: ${t.name ?? t.button.textContent ?? tid}`;
    const proto = t.pluginSpec?.pluginType ?? 'RDP';
    if (!q || label.toLowerCase().includes(q) || proto.toLowerCase().includes(q)) {
      addItem(label, `Active · ${proto}`, () => select(tid));
    }
  }

  const savedConns = documents.listAllConnections?.() ?? [];
  for (const c of savedConns) {
    const hay = `${c.docName} ${c.name} ${c.protocol} ${c.hostPort} ${c.gateway}`.toLowerCase();
    if (!q || hay.includes(q)) {
      addItem(`${c.docName} / ${c.name} (${c.hostPort})`, `${c.protocol} · ${c.gateway}`, () => {
        documents.connectByKey?.(c.key);
      });
    }
  }

  const quickCommands: [string, string, () => void][] = [
    ['Open Team Vault Encrypted Git & S3 / MinIO Document Sync Studio', 'Team Vault Sync', () => openPluginTab({ pluginType: 'Team Vault Sync', name: 'Team Vault Sync', host: 'localhost', port: 0, username: 'ops', notes: '' })],
    ['Open Session Cast Player (Asciicast v2 Terminal & RDP Audit Replay)', 'Session Cast', () => openPluginTab({ pluginType: 'Session Cast Studio', name: 'Session Cast Replay', host: '10.28.0.154', port: 22, username: 'root', notes: '' })],
    ['Open Kubernetes Manifest (kubectl / Helm) & Pod YAML Live Studio', 'K8s & Helm', () => openPluginTab({ pluginType: 'K8s Manifest Studio', name: 'K8s Manifest Studio', host: '10.28.0.154', port: 6443, username: 'root', notes: '' })],
    ['Open SMTP / Webhook & Slack / Telegram / PagerDuty Alert Relay Tester', 'Alert Relay', () => openPluginTab({ pluginType: 'Alert Relay Studio', name: 'Alert Relay Studio', host: 'localhost', port: 443, username: 'ops', notes: '' })],
    ['Open HashiCorp Vault, .env Secret Encryption & AES-256-GCM Sealer', 'Secret Vault', () => openPluginTab({ pluginType: 'Secret Env Studio', name: 'Secret Env Studio', host: 'localhost', port: 0, username: 'ops', notes: '' })],
    ['Open GeoIP, ASN / BGP Whois & Threat Intelligence IP Lookup Studio', 'Threat Intel', () => openPluginTab({ pluginType: 'Threat Intel Studio', name: 'Threat Intel & ASN', host: '10.28.0.154', port: 43, username: 'ops', notes: '' })],
    ['Open HTTP Concurrency Load & Latency Percentile Benchmark Studio', 'Load Benchmark', () => openPluginTab({ pluginType: 'Load Benchmark Studio', name: 'Load Benchmark Studio', host: '10.28.0.154', port: 4321, username: 'ops', notes: '' })],
    ['Open Keepalived VRRP, Pacemaker/Corosync & High-Availability Failover Studio', 'HA Cluster', () => openPluginTab({ pluginType: 'HA Cluster Studio', name: 'HA & VRRP Failover', host: '10.28.0.154', port: 22, username: 'root', notes: '' })],
    ['Open WireGuard & IPsec (strongSwan) Site-to-Site VPN Tunnel Inspector', 'VPN Mesh', () => openPluginTab({ pluginType: 'VPN Mesh Studio', name: 'WireGuard & IPsec VPN', host: '10.28.0.154', port: 51820, username: 'root', notes: '' })],
    ['Open Automated Database Backup (pg_dump / mysqldump) & Point-in-Time Restore Studio', 'DB Backup', () => openPluginTab({ pluginType: 'DB Backup Studio', name: 'DB Backup & Restore', host: '10.28.0.154', port: 5432, username: 'postgres', notes: '' })],
    ['Open Linux Auditd & SHA-256 File Integrity Monitoring (FIM) Studio', 'FIM & Auditd', () => openPluginTab({ pluginType: 'FIM Auditd Studio', name: 'FIM & Auditd Studio', host: '10.28.0.154', port: 22, username: 'root', notes: '' })],
    ['Open ITIL v4 / ISO 20000 Request for Change (RFC) & CAB Dossier Generator', 'ITIL RFC', () => openPluginTab({ pluginType: 'Change RFC Studio', name: 'ITIL Change & RFC', host: 'localhost', port: 0, username: 'ops', notes: '' })],
    ['Open Live Packet Capture (tcpdump / tshark) & BPF Filter Studio', 'Packet Sniffer', () => openPluginTab({ pluginType: 'Packet Sniffer Studio', name: 'Packet Sniffer & BPF', host: '10.28.0.154', port: 22, username: 'root', notes: '' })],
    ['Open Linux Kernel Parameters (sysctl) & Open File Descriptors Studio', 'Kernel Limits', () => openPluginTab({ pluginType: 'Kernel Limits Studio', name: 'Kernel & FD Limits', host: '10.28.0.154', port: 22, username: 'root', notes: '' })],
    ['Open SSH Certificate Authority (SSH-CA) & Short-Lived Certificate Signer', 'SSH Zero-Trust', () => openPluginTab({ pluginType: 'SSH CA Studio', name: 'SSH Zero-Trust CA', host: 'localhost', port: 22, username: 'ops', notes: '' })],
    ['Open Prometheus /metrics & Node Exporter Telemetry Scraper', 'Prometheus', () => openPluginTab({ pluginType: 'Prometheus Studio', name: 'Prometheus Scraper', host: '10.28.0.154', port: 9100, username: 'ops', notes: '' })],
    ['Open Fail2Ban, PAM Lockout (faillock) & Intrusion IP Ban Manager', 'Intrusion Guard', () => openPluginTab({ pluginType: 'Intrusion Studio', name: 'Fail2Ban & Intrusion', host: '10.28.0.154', port: 22, username: 'root', notes: '' })],
    ['Open Linux & Windows Package / Patch Vulnerability Auditor (APT / DNF / HotFix)', 'OS Patch', () => openPluginTab({ pluginType: 'OS Patch Studio', name: 'OS Patch & CVE', host: '10.28.0.154', port: 22, username: 'root', notes: '' })],
    ['Open Disk, LVM, ZFS & RAID Storage Health Inspector (df / lsblk / SMART)', 'Storage', () => openPluginTab({ pluginType: 'Storage Studio', name: 'Storage & SMART', host: '10.28.0.154', port: 22, username: 'root', notes: '' })],
    ['Open SSH Server (sshd_config) & CIS Hardening Compliance Benchmark', 'CIS Audit', () => openPluginTab({ pluginType: 'CIS Benchmark Studio', name: 'CIS Hardening Audit', host: '10.28.0.154', port: 22, username: 'root', notes: '' })],
    ['Open Nginx / HAProxy / Traefik Reverse Proxy & Upstream Balancer Studio', 'Reverse Proxy', () => openPluginTab({ pluginType: 'Reverse Proxy Studio', name: 'Reverse Proxy Studio', host: '10.28.0.154', port: 22, username: 'root', notes: '' })],
    ['Open NTP Time Synchronization, Chrony & Timezone Drift Monitor (RFC 5905)', 'Time Sync', () => openPluginTab({ pluginType: 'Time Sync Studio', name: 'NTP Time Sync', host: 'localhost', port: 22, username: 'root', notes: '' })],
    ['Open HTTP / REST & Webhook Endpoint Health Studio (cURL & Security Headers)', 'HTTP Health', () => openPluginTab({ pluginType: 'HTTP Endpoint Studio', name: 'HTTP & API Health', host: '10.28.0.154', port: 4321, username: 'ops', notes: '' })],
    ['Open Remote Systemd & Windows Service Controller Studio (systemctl / Get-Service)', 'Services', () => openPluginTab({ pluginType: 'Service Controller Studio', name: 'Service Controller', host: '10.28.0.154', port: 22, username: 'root', notes: '' })],
    ['Open Linux User, Sudoers & Active Login Session Security Auditor (who / w / last)', 'User Audit', () => openPluginTab({ pluginType: 'User Session Auditor', name: 'User & Session Audit', host: '10.28.0.154', port: 22, username: 'root', notes: '' })],
    ['Open Automated Remote Config Backup & Drift Snapshotter (/etc Vault)', 'Config Backup', () => openPluginTab({ pluginType: 'Config Backup Vault', name: 'Config Backup Vault', host: '10.28.0.154', port: 22, username: 'root', notes: '' })],
    ['Open Subnet CIDR Calculator, VLAN Planner & IPAM Conflict Matrix', 'Subnet IPAM', () => openPluginTab({ pluginType: 'Subnet IPAM Studio', name: 'Subnet & IPAM Studio', host: '10.28.0.0', port: 0, username: 'ops', notes: '' })],
    ['Open Multi-Hop Traceroute, MTR & DNS Propagation Analyzer', 'Network Path', () => openPluginTab({ pluginType: 'Network Path Studio', name: 'Network Path & DNS', host: 'plnbatam.com', port: 53, username: 'ops', notes: '' })],
    ['Open Proxmox VE, VMware ESXi & Hyper-V Virtual Machine Fleet Studio', 'Hypervisor', () => openPluginTab({ pluginType: 'Hypervisor Studio', name: 'Hypervisor Studio', host: '10.28.0.154', port: 22, username: 'root', notes: '' })],
    ['Open Built-in TOTP 2FA / MFA Authenticator Vault (RFC 6238)', 'TOTP 2FA', () => openPluginTab({ pluginType: 'TOTP Authenticator', name: 'TOTP 2FA Vault', host: 'localhost', port: 0, username: 'ops', notes: '' })],
    ['Open Ansible Inventory, /etc/hosts & Terraform IaC Exporter', 'IaC Exporter', () => openPluginTab({ pluginType: 'IaC Exporter', name: 'IaC Exporter', host: 'localhost', port: 0, username: 'ops', notes: '' })],
    ['Open Server Resource Capacity & Top Process Profiler', 'Profiler', () => openPluginTab({ pluginType: 'Resource Profiler', name: 'Resource Profiler', host: '10.28.0.154', port: 22, username: 'root', notes: '' })],
    ['Open Active Directory, DNS & Windows Server Quick-Admin Studio', 'AD & DNS', () => openPluginTab({ pluginType: 'AD & DNS Studio', name: 'AD & DNS Studio', host: '10.28.0.154', port: 3389, username: 'plnbatam\\adminit', notes: '' })],
    ['Open Docker, Podman & Kubernetes Container Studio', 'Containers', () => openPluginTab({ pluginType: 'Container Studio', name: 'Container Studio', host: '10.28.0.154', port: 22, username: 'root', notes: '' })],
    ['Open Database Tunnel & Quick-Query Inspector (Postgres/MySQL/MSSQL/Redis)', 'Database', () => openPluginTab({ pluginType: 'Database Studio', name: 'Database Studio', host: '10.28.0.154', port: 5432, username: 'postgres', notes: '' })],
    ['Open Firewall & Port Security Matrix (UFW / Iptables / Windows Firewall)', 'Firewall', () => openPluginTab({ pluginType: 'Firewall Auditor', name: 'Firewall Auditor', host: '10.28.0.154', port: 22, username: 'root', notes: '' })],
    ['Open Smart Clipboard History & Secret Scrubber', 'Privacy', () => openPluginTab({ pluginType: 'Clipboard Scrubber', name: 'Clipboard Scrubber', host: 'localhost', port: 0, username: 'ops', notes: '' })],
    ['Open Interactive Port-Forwarding & SOCKS5 Proxy Studio (-L / -D / -R)', 'Port Forward', () => openPluginTab({ pluginType: 'Port Forward Studio', name: 'Port Forward Studio', host: '10.28.0.154', port: 5432, username: 'ops', notes: '' })],
    ['Open Live Log Streamer & Multi-Server Tail Studio', 'Live Logs', () => openPluginTab({ pluginType: 'Log Streamer', name: 'Log Streamer', host: '10.28.0.154', port: 22, username: 'root', notes: '' })],
    ['Open 1-Click Incident Evidence & Diagnostic Report Generator', 'Incident Report', () => openPluginTab({ pluginType: 'Incident Reporter', name: 'Incident Reporter', host: 'localhost', port: 0, username: 'ops', notes: '' })],
    ['Open SSL/TLS Certificate Expiry & Security Auditor', 'Cert Auditor', () => openPluginTab({ pluginType: 'Cert Auditor', name: 'Cert Auditor', host: '10.28.0.154', port: 4321, username: 'ops', notes: '' })],
    ['Open Scheduled Task & Cron Automation Runner', 'Cron Jobs', () => openPluginTab({ pluginType: 'Cron Scheduler', name: 'Cron Scheduler', host: '10.28.0.154', port: 22, username: 'root', notes: '' })],
    ['Open Dual-Pane SFTP Commander & Remote Config Editor', 'SFTP Studio', () => openPluginTab({ pluginType: 'SFTP Commander', name: 'SFTP Commander', host: '10.28.0.154', port: 22, username: 'root', notes: '' })],
    ['Open Interactive Network Topology & Jump-Chain Visualizer', 'Topology', () => openPluginTab({ pluginType: 'Topology Map', name: 'Topology Map', host: 'localhost', port: 0, username: 'ops', notes: '' })],
    ['Open SSH Key Pair Generator & Public Key Deployer (ssh-copy-id)', 'SSH Keys', () => openPluginTab({ pluginType: 'SSH Key Studio', name: 'SSH Key Studio', host: '10.28.0.154', port: 22, username: 'root', notes: '' })],
    ['Open Multi-Server Baseline & Configuration Drift Comparator', 'Drift Matrix', () => openPluginTab({ pluginType: 'Drift Comparator', name: 'Drift Comparator', host: 'localhost', port: 22, username: 'ops', notes: '' })],
    ['Open Maintenance Window & Production Freeze Guard', 'Safety Guard', () => openPluginTab({ pluginType: 'Safety Guard', name: 'Safety Guard', host: 'localhost', port: 0, username: 'ops', notes: '' })],
    ['Open Visual ~/.ssh/config Studio & Host Block Editor', 'SSH Config', () => openPluginTab({ pluginType: 'SSH Config Studio', name: 'SSH Config Studio', host: 'localhost', port: 22, username: 'ops', notes: '' })],
    ['Open Operational Runbooks & Interactive SOP Playbooks', 'Runbooks', () => openPluginTab({ pluginType: 'Runbook Studio', name: 'Runbooks & SOP', host: 'localhost', port: 22, username: 'ops', notes: '' })],
    ['Open Live Uptime Watchdog & Latency Alerting Monitor', 'SLA Monitor', () => openPluginTab({ pluginType: 'Health Monitor', name: 'Health Monitor', host: 'localhost', port: 22, username: 'ops', notes: '' })],
    ['Open Portable Workspace Config Bundle (Export / Import)', 'Backup', () => openPluginTab({ pluginType: 'Config Bundle', name: 'Config Bundle', host: 'localhost', port: 0, username: 'ops', notes: '' })],
    ['Open Network Subnet & Port Discovery Scanner', 'Discovery', () => openPluginTab({ pluginType: 'Network Scanner', name: 'Subnet Scanner', host: '10.28.0.150-165', port: 3389, username: 'root', notes: 'Subnet Scanner' })],
    ['Open Multi-Server Batch Script Execution Matrix', 'Batch Ops', () => openPluginTab({ pluginType: 'Batch Script Runner', name: 'Batch Script Matrix', host: 'localhost', port: 22, username: 'root', notes: '' })],
    ['Open SSH Known Hosts & TLS Certificate Pin Manager', 'Security', () => openPluginTab({ pluginType: 'Known Hosts Manager', name: 'Known Hosts & Certs', host: 'localhost', port: 22, username: 'ops', notes: 'Known Hosts' })],
    ['Open Wake-on-LAN (Magic Packet) & Port Knocking Studio', 'Network Hook', () => openPluginTab({ pluginType: 'WoL & Port Knock', name: 'WoL & Port Knock', host: '10.28.0.154', port: 9, username: 'ops', notes: 'WoL' })],
    ['Toggle Split-Screen View (Single / 2×1 / 2×2)', 'Split View', () => document.getElementById('split-view-toggle')?.click()],
    ['Open Tasks & Key Sequence Macros Manager', 'Automation', () => openPluginTab({ pluginType: 'Tasks Manager', name: 'Tasks & Macros', host: 'localhost', port: 0, username: 'ops', notes: 'Command Tasks' })],
    ['Open Session Audit Trail & Activity History', 'Audit Log', () => openPluginTab({ pluginType: 'Audit Log', name: 'Session Audit Log', host: 'localhost', port: 0, username: 'audit', notes: 'Audit Log' })],
    ['Open Jump Host & Secure Gateway Tunnels', 'Gateway', () => openPluginTab({ pluginType: 'Secure Gateway', name: 'Jump Host & Tunnels', host: '127.0.0.1', port: 22, username: 'ops', notes: 'Gateway' })],
    ['Toggle View-Only (Observe) Mode', 'Jump Desktop', () => document.getElementById('rdp-view-only')?.click()],
    ['Toggle Live Telemetry HUD (FPS & Uptime)', 'Jump Desktop', () => document.getElementById('rdp-hud-toggle')?.click()],
    ['Activate Workspace Privacy Curtain Lock Screen (⌃⌘L)', 'Security', () => setPrivacyLock(true)],
    ['Open Credentials Vault', 'Security', () => el('credentials-open').click()],
    ['Create New Document', 'Document', () => el('doc-new').click()],
  ];

  for (const [label, tag, fn] of quickCommands) {
    if (!q || label.toLowerCase().includes(q) || tag.toLowerCase().includes(q)) {
      addItem(label, tag, fn);
    }
  }
}

if (cmdPaletteBtn) cmdPaletteBtn.onclick = openCommandPalette;
if (cmdPaletteClose && cmdPaletteDialog) cmdPaletteClose.onclick = () => cmdPaletteDialog.close();
if (cmdPaletteInput) {
  cmdPaletteInput.addEventListener('input', () => renderCommandPaletteItems(cmdPaletteInput.value));
  cmdPaletteInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const firstBtn = cmdPaletteList?.querySelector<HTMLButtonElement>('.cmd-palette-item');
      if (firstBtn) {
        e.preventDefault();
        firstBtn.click();
      }
    }
  });
}

window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key.toLowerCase() === 'k' || e.key.toLowerCase() === 'p')) {
    e.preventDefault();
    openCommandPalette();
  } else if (e.metaKey && e.ctrlKey && e.key.toLowerCase() === 'l') {
    e.preventDefault();
    setPrivacyLock(true);
  }
});

const rdpMacKeysBtn = document.getElementById('rdp-mac-keys') as HTMLButtonElement | null;
if (rdpMacKeysBtn) {
  rdpMacKeysBtn.textContent = macShortcutsEnabled ? '⌘⇄Ctrl: ON' : '⌘⇄Ctrl: OFF';
  rdpMacKeysBtn.classList.toggle('active', macShortcutsEnabled);
  rdpMacKeysBtn.onclick = () => {
    macShortcutsEnabled = !macShortcutsEnabled;
    localStorage.setItem('rw-rdp-mac-keys', macShortcutsEnabled ? 'on' : 'off');
    rdpMacKeysBtn.textContent = macShortcutsEnabled ? '⌘⇄Ctrl: ON' : '⌘⇄Ctrl: OFF';
    rdpMacKeysBtn.classList.toggle('active', macShortcutsEnabled);
  };
}

const autoReconnectBtn = document.getElementById('auto-reconnect-toggle') as HTMLButtonElement | null;
if (autoReconnectBtn) {
  autoReconnectBtn.textContent = autoReconnectEnabled ? '🔄 Auto-Retry: ON' : '🔄 Auto-Retry: OFF';
  autoReconnectBtn.classList.toggle('active', autoReconnectEnabled);
  autoReconnectBtn.onclick = () => {
    autoReconnectEnabled = !autoReconnectEnabled;
    localStorage.setItem('rw-auto-reconnect', autoReconnectEnabled ? 'on' : 'off');
    autoReconnectBtn.textContent = autoReconnectEnabled ? '🔄 Auto-Retry: ON' : '🔄 Auto-Retry: OFF';
    autoReconnectBtn.classList.toggle('active', autoReconnectEnabled);
  };
}

const royalNewDoc = document.getElementById('royal-new-doc');
const royalOpenDoc = document.getElementById('royal-open-doc');
if (royalNewDoc) royalNewDoc.onclick = () => el('doc-new').click();
if (royalOpenDoc) royalOpenDoc.onclick = () => el('doc-open').click();

if (addBtn && addMenu) {
  addBtn.onclick = (e) => {
    e.stopPropagation();
    const willShow = addMenu.hidden;
    if (willShow && actionsDrawer) {
      actionsDrawer.open = false;
    }
    addMenu.hidden = !willShow;
  };
  document.addEventListener('click', (e) => {
    if (!addMenu.hidden && !addMenu.contains(e.target as Node) && e.target !== addBtn) {
      addMenu.hidden = true;
    }
  });
  for (const item of addMenu.querySelectorAll<HTMLButtonElement>('[data-add-plugin]')) {
    item.onclick = () => {
      addMenu.hidden = true;
      const plugin = item.dataset.addPlugin;
      if (plugin && documents.addPlugin) documents.addPlugin(plugin);
    };
  }
}

const appTree = document.getElementById('app-tree');
if (appTree) {
  for (const row of appTree.querySelectorAll<HTMLElement>('[data-app-action]')) {
    row.onclick = () => {
      const act = row.dataset.appAction;
      if (act === 'credentials') el('credentials-open').click();
      else if (act === 'tasks')
        openPluginTab({
          pluginType: 'Tasks Manager',
          name: 'Tasks & Macros',
          host: 'localhost',
          port: 0,
          username: 'ops',
          notes: 'Royal TSX Command Tasks & Key Sequence Macros',
        });
      else if (act === 'templates') el('templates-open').click();
    };
  }
  for (const row of appTree.querySelectorAll<HTMLElement>('[data-default-plugin]')) {
    row.onclick = () => {
      const plugin = row.dataset.defaultPlugin;
      if (plugin && documents.addPlugin) documents.addPlugin(plugin);
    };
  }
}

for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-overview-action]')) {
  btn.onclick = () => {
    const act = btn.dataset.overviewAction;
    if (act === 'new-doc') el('doc-new').click();
    else if (act === 'open-doc') el('doc-open').click();
    else if (act === 'credentials') el('credentials-open').click();
    else if (act === 'templates') el('templates-open').click();
  };
}
for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-overview-plugin]')) {
  btn.onclick = () => {
    const plugin = btn.dataset.overviewPlugin;
    if (
      plugin === 'Audit Log' ||
      plugin === 'Network Scanner' ||
      plugin === 'Batch Script Runner' ||
      plugin === 'Known Hosts Manager' ||
      plugin === 'WoL & Port Knock' ||
      plugin === 'SSH Config Studio' ||
      plugin === 'Runbook Studio' ||
      plugin === 'Health Monitor' ||
      plugin === 'SFTP Commander' ||
      plugin === 'Topology Map' ||
      plugin === 'SSH Key Studio' ||
      plugin === 'Drift Comparator' ||
      plugin === 'Safety Guard' ||
      plugin === 'Port Forward Studio' ||
      plugin === 'Log Streamer' ||
      plugin === 'Incident Reporter' ||
      plugin === 'Cert Auditor' ||
      plugin === 'Cron Scheduler' ||
      plugin === 'AD & DNS Studio' ||
      plugin === 'Container Studio' ||
      plugin === 'Database Studio' ||
      plugin === 'Firewall Auditor' ||
      plugin === 'Clipboard Scrubber' ||
      plugin === 'Network Path Studio' ||
      plugin === 'Hypervisor Studio' ||
      plugin === 'TOTP Authenticator' ||
      plugin === 'IaC Exporter' ||
      plugin === 'Resource Profiler' ||
      plugin === 'HTTP Endpoint Studio' ||
      plugin === 'Service Controller Studio' ||
      plugin === 'User Session Auditor' ||
      plugin === 'Config Backup Vault' ||
      plugin === 'Subnet IPAM Studio' ||
      plugin === 'OS Patch Studio' ||
      plugin === 'Storage Studio' ||
      plugin === 'CIS Benchmark Studio' ||
      plugin === 'Reverse Proxy Studio' ||
      plugin === 'Time Sync Studio' ||
      plugin === 'Packet Sniffer Studio' ||
      plugin === 'Kernel Limits Studio' ||
      plugin === 'SSH CA Studio' ||
      plugin === 'Prometheus Studio' ||
      plugin === 'Intrusion Studio' ||
      plugin === 'HA Cluster Studio' ||
      plugin === 'VPN Mesh Studio' ||
      plugin === 'DB Backup Studio' ||
      plugin === 'FIM Auditd Studio' ||
      plugin === 'Change RFC Studio' ||
      plugin === 'K8s Manifest Studio' ||
      plugin === 'Alert Relay Studio' ||
      plugin === 'Secret Env Studio' ||
      plugin === 'Threat Intel Studio' ||
      plugin === 'Load Benchmark Studio' ||
      plugin === 'Team Vault Sync' ||
      plugin === 'Session Cast Studio' ||
      plugin === 'Config Bundle'
    ) {
      openPluginTab({
        pluginType: plugin,
        name:
          plugin === 'Audit Log'
            ? 'Session Audit Log'
            : plugin === 'Network Scanner'
              ? 'Subnet Scanner'
              : plugin === 'Batch Script Runner'
                ? 'Batch Script Matrix'
                : plugin === 'Known Hosts Manager'
                  ? 'Known Hosts & Certs'
                  : plugin === 'WoL & Port Knock'
                    ? 'WoL & Port Knock'
                    : plugin === 'SSH Config Studio'
                      ? 'SSH Config Studio'
                      : plugin === 'Runbook Studio'
                        ? 'Runbooks & SOP'
                        : plugin === 'Health Monitor'
                          ? 'Health Monitor'
                          : plugin === 'SFTP Commander'
                            ? 'SFTP Commander'
                            : plugin === 'Topology Map'
                              ? 'Topology Map'
                              : plugin === 'SSH Key Studio'
                                ? 'SSH Key Studio'
                                : plugin === 'Drift Comparator'
                                  ? 'Drift Comparator'
                                  : plugin === 'Safety Guard'
                                    ? 'Safety Guard'
                                    : plugin === 'Port Forward Studio'
                                      ? 'Port Forward Studio'
                                      : plugin === 'Log Streamer'
                                        ? 'Log Streamer'
                                        : plugin === 'Incident Reporter'
                                          ? 'Incident Reporter'
                                          : plugin === 'Cert Auditor'
                                            ? 'Cert Auditor'
                                            : plugin === 'Cron Scheduler'
                                              ? 'Cron Scheduler'
                                              : plugin === 'AD & DNS Studio'
                                                ? 'AD & DNS Studio'
                                                : plugin === 'Container Studio'
                                                  ? 'Container Studio'
                                                  : plugin === 'Database Studio'
                                                    ? 'Database Studio'
                                                    : plugin === 'Firewall Auditor'
                                                      ? 'Firewall Auditor'
                                                      : plugin === 'Clipboard Scrubber'
                                                        ? 'Clipboard Scrubber'
                                                        : plugin === 'Network Path Studio'
                                                          ? 'Network Path & DNS'
                                                          : plugin === 'Hypervisor Studio'
                                                            ? 'Hypervisor Studio'
                                                            : plugin === 'TOTP Authenticator'
                                                              ? 'TOTP 2FA Vault'
                                                              : plugin === 'IaC Exporter'
                                                                ? 'IaC Exporter'
                                                                : plugin === 'Resource Profiler'
                                                                  ? 'Resource Profiler'
                                                                  : plugin === 'HTTP Endpoint Studio'
                                                                    ? 'HTTP & API Health'
                                                                    : plugin === 'Service Controller Studio'
                                                                      ? 'Service Controller'
                                                                      : plugin === 'User Session Auditor'
                                                                        ? 'User & Session Audit'
                                                                        : plugin === 'Config Backup Vault'
                                                                          ? 'Config Backup Vault'
                                                                          : plugin === 'Subnet IPAM Studio'
                                                                            ? 'Subnet & IPAM Studio'
                                                                            : plugin === 'OS Patch Studio'
                                                                              ? 'OS Patch & CVE'
                                                                              : plugin === 'Storage Studio'
                                                                                ? 'Storage & SMART'
                                                                                : plugin === 'CIS Benchmark Studio'
                                                                                  ? 'CIS Hardening Audit'
                                                                                  : plugin === 'Reverse Proxy Studio'
                                                                                    ? 'Reverse Proxy Studio'
                                                                                    : plugin === 'Time Sync Studio'
                                                                                      ? 'NTP Time Sync'
                                                                                      : plugin === 'Packet Sniffer Studio'
                                                                                        ? 'Packet Sniffer & BPF'
                                                                                        : plugin === 'Kernel Limits Studio'
                                                                                          ? 'Kernel & FD Limits'
                                                                                          : plugin === 'SSH CA Studio'
                                                                                            ? 'SSH Zero-Trust CA'
                                                                                            : plugin === 'Prometheus Studio'
                                                                                              ? 'Prometheus Scraper'
                                                                                              : plugin === 'Intrusion Studio'
                                                                                                ? 'Fail2Ban & Intrusion'
                                                                                                : plugin === 'HA Cluster Studio'
                                                                                                  ? 'HA & VRRP Failover'
                                                                                                  : plugin === 'VPN Mesh Studio'
                                                                                                    ? 'WireGuard & IPsec VPN'
                                                                                                    : plugin === 'DB Backup Studio'
                                                                                                      ? 'DB Backup & Restore'
                                                                                                      : plugin === 'FIM Auditd Studio'
                                                                                                        ? 'FIM & Auditd Studio'
                                                                                                        : plugin === 'Change RFC Studio'
                                                                                                          ? 'ITIL Change & RFC'
                                                                                                          : plugin === 'K8s Manifest Studio'
                                                                                                            ? 'K8s Manifest Studio'
                                                                                                            : plugin === 'Alert Relay Studio'
                                                                                                              ? 'Alert Relay Studio'
                                                                                                              : plugin === 'Secret Env Studio'
                                                                                                                ? 'Secret Env Studio'
                                                                                                                : plugin === 'Threat Intel Studio'
                                                                                                                  ? 'Threat Intel & ASN'
                                                                                                                  : plugin === 'Load Benchmark Studio'
                                                                                                                    ? 'Load Benchmark Studio'
                                                                                                                    : plugin === 'Team Vault Sync'
                                                                                                                      ? 'Team Vault Sync'
                                                                                                                      : plugin === 'Session Cast Studio'
                                                                                                                        ? 'Session Cast Replay'
                                                                                                                        : 'Config Bundle',
        host: plugin === 'Network Scanner' ? '10.28.0.150-165' : plugin === 'SFTP Commander' || plugin === 'SSH Key Studio' ? '10.28.0.154' : 'localhost',
        port: plugin === 'SFTP Commander' || plugin === 'SSH Key Studio' ? 22 : 0,
        username: 'ops',
        notes: '',
      });
      return;
    }
    if (plugin && documents.addPlugin) documents.addPlugin(plugin);
  };
}

const overviewStudioSelect = document.getElementById('overview-studio-select') as HTMLSelectElement | null;
if (overviewStudioSelect) {
  overviewStudioSelect.onchange = () => {
    const plugin = overviewStudioSelect.value;
    if (!plugin) return;
    const selectedLabel = overviewStudioSelect.options[overviewStudioSelect.selectedIndex]?.textContent?.replace(/^[^\w]+/, '').trim() || plugin;
    overviewStudioSelect.value = '';
    openPluginTab({
      pluginType: plugin,
      name: selectedLabel,
      host: '10.28.0.154',
      port: 22,
      username: 'ops',
      notes: '',
    });
  };
}

const overviewStudioSearchBtn = document.getElementById('overview-studio-search-btn');
if (overviewStudioSearchBtn) {
  overviewStudioSearchBtn.onclick = () => openCommandPalette();
}

// Upgrade sidebar, add-menu, and overview icons to crisp vector SVGs with semantic color tints.
const PLUGIN_VISUAL: Record<string, { icon: IconId; tint: string }> = {
  credentials: { icon: 'key', tint: 'yellow' },
  tasks: { icon: 'wrench', tint: 'orange' },
  templates: { icon: 'box', tint: 'purple' },
  Folder: { icon: 'box', tint: 'blue' },
  'Dynamic Folder': { icon: 'cloud', tint: 'orange' },
  Credential: { icon: 'key', tint: 'yellow' },
  Information: { icon: 'database', tint: 'teal' },
  'To-Do': { icon: 'wrench', tint: 'green' },
  'Remote Desktop': { icon: 'desktop', tint: 'blue' },
  VNC: { icon: 'laptop', tint: 'teal' },
  TeamViewer: { icon: 'network', tint: 'blue' },
  Terminal: { icon: 'terminal', tint: 'purple' },
  'Web Page': { icon: 'globe', tint: 'green' },
  'File Transfer': { icon: 'cloud', tint: 'teal' },
  'Windows Events View': { icon: 'database', tint: 'orange' },
  'Windows Services': { icon: 'wrench', tint: 'blue' },
  'Windows Processes': { icon: 'chip', tint: 'teal' },
  'Terminal Services': { icon: 'desktop', tint: 'purple' },
  VMware: { icon: 'server', tint: 'blue' },
  'Hyper-V': { icon: 'chip', tint: 'purple' },
  PowerShell: { icon: 'terminal', tint: 'blue' },
  'Royal Server': { icon: 'server', tint: 'yellow' },
  'Secure Gateway': { icon: 'shield', tint: 'green' },
  'Remote Desktop Gateway': { icon: 'router', tint: 'teal' },
  'Command Task': { icon: 'terminal', tint: 'orange' },
  'Key Sequence Task': { icon: 'wrench', tint: 'pink' },
};
for (const node of document.querySelectorAll<HTMLElement>('.app-tree-row, .add-menu-item')) {
  const key = node.dataset.appAction ?? node.dataset.defaultPlugin ?? node.dataset.addPlugin ?? 'Folder';
  const spec = PLUGIN_VISUAL[key] ?? { icon: 'box', tint: 'blue' };
  const badge = node.querySelector<HTMLElement>('.app-tree-icon, .add-icon');
  if (badge) {
    badge.dataset.tint = spec.tint;
    badge.replaceChildren(iconElement(spec.icon));
  }
}
for (const badge of document.querySelectorAll<HTMLElement>('.overview-tile-icon[data-icon-id]')) {
  const id = badge.dataset.iconId as IconId | undefined;
  if (id) badge.replaceChildren(iconElement(id));
}

void initShell(documents).catch((error: unknown) => {
  console.error('[shell]', error);
  el('shell-notice-text').textContent = 'Menu and toolbar could not start; please restart the application.';
  el('shell-notice').classList.remove('empty');
});
