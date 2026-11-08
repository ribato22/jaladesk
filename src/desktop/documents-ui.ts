// The documents part of the window: the open documents as one tree, the buttons and keys that act on the selected row, the search that narrows the tree, and the properties dialog.
// The window keeps one model per open document (docmodel.ts) and takes in what the main process sends (a Snapshot, then a Delta per change); what a
// row looks like and where a drop lands come from navigation.ts, how the rows are drawn from tree-view.ts. Every change to a document goes through
// window.documents, so this file holds no document logic and never sees a password, a key or a path. The favourites are not part of any document: the
// main process tells them with each snapshot and keeps them (preferences.ts) for the person who uses this computer.
import type { Choice, ConflictView } from '../documents/conflicts.js';
import type { Delta, RevisionInfo, RevisionView, Snapshot } from '../documents/library.js';
import { COLORS, ICONS, MAX_NOTES, checkMeta, colorOf, notesOf, type IconId, type SortBy, type SortCriterion, type SortDir } from '../documents/meta.js';
import { DEFAULT_RDP, checkSettings, toProps, type RdpRequest, type RdpSettings } from './connection-settings.js';
import type { OpenStored } from './connections.js';
import { applyDelta, modelOf, type DocModel } from './docmodel.js';
import { iconElement } from './icons.js';
import { allExpanded, buildRows, documentKey, isSorted, keepSelection, moveTarget, narrows, navigate, objectKey, onlyDocuments, parseKey, resolveDrop, type Direction, type DropZone, type NavKey, type Row, type RowFilter } from './navigation.js';
import { changedMetaProps, metaOf, metaProps, patchFor, rdpOf, subfolderCount, type Meta, type PropertyPatch } from './properties.js';
import { initSafety } from './safety-ui.js';
import { createTreeView } from './tree-view.js';

export type Failure = { ok: false; code: string; message: string; seq?: number; delta?: Delta };
type Result<T = object> = ({ ok: true } & T) | Failure;
type Opened = {snapshot:Shown;note?:string;skipped?:never}|{skipped:true;note:string};
type Shown = Snapshot & { favorites?: string[] }; // a snapshot, with the favourites of its document when the main process keeps any
declare global {
  interface Window {
    documents: {
      views(): Promise<Result<{ snapshots: Shown[]; notice?: string }>>;
      snapshot(id: string): Promise<Result<{ snapshot: Shown }>>;
      create(name: string): Promise<Result<{ snapshot: Shown; note?: string }>>;
      open(): Promise<Result<Opened>>;
      /** One of the recent documents, by its place in the list (the main process keeps the list and the paths). */
      openRecent(index: number): Promise<Result<Opened>>;
      /** Forgets the key that the system remembers for an open document; says whether there was one. */
      forgetKey(id: string): Promise<Result<{ forgot: boolean }>>;
      add(input: { id: string; parentId: string | null; type: 'folder' | 'connection'; name: string; props: Record<string, unknown> }): Promise<Result<{ objectId: string; delta: Delta }>>;
      update(input: { id: string; objectId: string; name?: string; props?: Record<string, unknown>; patch?: PropertyPatch; spreadSort?: boolean }): Promise<Result<{ delta: Delta }>>;
      remove(input: { id: string; objectId: string }): Promise<Result<{ delta: Delta }>>;
      move(input: { id: string; objectId: string; parentId: string | null; index?: number }): Promise<Result<{ delta: Delta }>>;
      duplicate(input: { id: string; objectId: string }): Promise<Result<{ objectId: string; delta: Delta }>>;
      favorite(input: { id: string; objectId: string; on: boolean }): Promise<Result<{ favorites: string[] }>>;
      save(id: string): Promise<Result<{ saved: boolean; conflicts: number; delta: Delta;note?:string }>>;
      close(id: string): Promise<Result>;
      conflicts(id: string): Promise<Result<{ views: ConflictView[]; total: number }>>;
      resolve(input: { id: string; items: { key: string; choice: Choice }[] } | { id: string; all: 'mine' | 'theirs' }): Promise<Result<{ delta: Delta }>>;
      reload(id: string): Promise<Result<{ delta: Delta }>>;
      revisions(id: string): Promise<Result<{ revisions: RevisionInfo[] }>>;
      revision(input: { id: string; name: string }): Promise<Result<{ revision: RevisionView }>>;
      restore(input: { id: string; name: string; ids: string[]; folderName: string } | { id: string; name: string; all: true }): Promise<Result<{ delta: Delta; created?: string; changed?: boolean }>>;
      autosave(input: { id: string; mode?: 'off' | 'close' | 'edit' }): Promise<Result<{ mode: 'off' | 'close' | 'edit' }>>;
      /** The main process changed documents without being asked (a close that did not finish saved or merged some): they are to be taken again. */
      onRefresh(callback: () => void): () => void;
      /** The change that a save by itself left in a document, and what a save by itself could not do (it failed, or the file was changed elsewhere and the save was held back). */
      onDelta(callback: (delta: Delta) => void): () => void;
      onEvent(callback: (event: { id: string; code: string; message: string }) => void): () => void;
    };
  }
}

export type PluginSessionSpec = {
  pluginType: string;
  name: string;
  host: string;
  port: number;
  username: string;
  notes: string;
  color?: string;
  authMode?: string;
  sshKey?: string;
  jumpHost?: string;
  initPath?: string;
};

type ProtocolExtras = {
  authMode?: string;
  sshKey?: string;
  jumpHost?: string;
  initPath?: string;
  defaultUser?: string;
  customColor?: string;
  folderMode?: string;
  wolMac?: string;
  knockSeq?: string;
};

type SwatchDef = {
  id: string;
  label: string;
  base: (typeof COLORS)[number]['id'];
  hex: string;
};

const EXTENDED_COLORS: readonly SwatchDef[] = [
  { id: 'sapphire', label: 'Sapphire (Royal Blue)', base: 'blue', hex: '#285b7d' },
  { id: 'gold', label: 'Royal Gold', base: 'yellow', hex: '#d49b38' },
  { id: 'emerald', label: 'Emerald', base: 'green', hex: '#2e8b57' },
  { id: 'indigo', label: 'Indigo', base: 'purple', hex: '#5558b0' },
  { id: 'cyan', label: 'Cyan', base: 'teal', hex: '#1f8ea8' },
  { id: 'crimson', label: 'Crimson', base: 'red', hex: '#b32d2e' },
  { id: 'rose', label: 'Rose', base: 'pink', hex: '#c94676' },
  { id: 'amber', label: 'Amber', base: 'orange', hex: '#a97231' },
  { id: 'slate', label: 'Slate', base: 'gray', hex: '#4f6277' },
];

const CORE_SWATCH_HEX: Record<string, string> = {
  red: '#c0392b',
  orange: '#c16617',
  yellow: '#997a00',
  green: '#2e8b57',
  teal: '#178c8c',
  blue: '#2f6fb5',
  purple: '#7b4fb0',
  pink: '#d1498a',
  gray: '#6b7785',
};

const ALL_SWATCH_COLORS: readonly SwatchDef[] = [
  ...COLORS.map((c) => ({ id: c.id, label: c.label, base: c.id, hex: CORE_SWATCH_HEX[c.id] ?? '#2f6fb5' })),
  ...EXTENDED_COLORS,
];

function nearestSwatchForHex(hex: string): SwatchDef {
  const m = hex.trim().match(/^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
  if (!m) return ALL_SWATCH_COLORS.find((c) => c.id === 'sapphire') ?? ALL_SWATCH_COLORS[0]!;
  const r = parseInt(m[1]!, 16), g = parseInt(m[2]!, 16), b = parseInt(m[3]!, 16);
  let best = ALL_SWATCH_COLORS[0]!;
  let bestDist = Infinity;
  for (const s of ALL_SWATCH_COLORS) {
    const sm = s.hex.match(/^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
    if (!sm) continue;
    const dr = r - parseInt(sm[1]!, 16);
    const dg = g - parseInt(sm[2]!, 16);
    const db = b - parseInt(sm[3]!, 16);
    const dist = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
    if (dist < bestDist) {
      bestDist = dist;
      best = s;
    }
  }
  return best;
}

type DocPref = {
  color?: string;
  icon?: IconId;
  jumpHost?: string;
  sshKey?: string;
  defaultUser?: string;
};

const DOC_PREFS_STORAGE_KEY = 'jaladesk.docPrefs.v1';

function readAllDocPrefs(): Record<string, DocPref> {
  try {
    const raw = window.localStorage?.getItem(DOC_PREFS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, DocPref>) : {};
  } catch {
    return {};
  }
}

function getDocPref(sessionId: string, docName: string, docId?: string): DocPref {
  const all = readAllDocPrefs();
  const bySession = all[`id:${sessionId}`];
  const byDocId = docId ? all[`doc:${docId}`] : undefined;
  const byName = docName.trim() ? all[`name:${docName.trim().toLowerCase()}`] : undefined;
  return { ...(byName ?? {}), ...(byDocId ?? {}), ...(bySession ?? {}) };
}

function setDocPref(sessionId: string, docName: string, pref: DocPref, docId?: string): void {
  try {
    const all = readAllDocPrefs();
    const cleaned: DocPref = {};
    if (pref.color) cleaned.color = pref.color;
    if (pref.icon) cleaned.icon = pref.icon;
    if (pref.jumpHost) cleaned.jumpHost = pref.jumpHost;
    if (pref.sshKey) cleaned.sshKey = pref.sshKey;
    if (pref.defaultUser) cleaned.defaultUser = pref.defaultUser;
    all[`id:${sessionId}`] = cleaned;
    if (docId) all[`doc:${docId}`] = cleaned;
    if (docName.trim()) all[`name:${docName.trim().toLowerCase()}`] = cleaned;
    window.localStorage?.setItem(DOC_PREFS_STORAGE_KEY, JSON.stringify(all));
  } catch {}
}

/** What the rest of the window gives this part: a way to open a session, which answers with why none was opened (nothing when one was); the tab it makes shows the colour of the object, if the object has one. */
export type Host = {
  open(request: RdpRequest, name: string, color?: string): Promise<string | undefined>;
  openStored?(ref: OpenStored): Promise<string | undefined>;
  openPlugin?(spec: PluginSessionSpec): void;
};
/** What this part gives the rest of the window: the commands of the menu that are about the documents and have no button. */
export type ListedConnectionItem = {
  key: string;
  docName: string;
  folderName: string;
  name: string;
  protocol: string;
  pluginType: string;
  host: string;
  port: number;
  username: string;
  hostPort: string;
  gateway: string;
  jumpHost: string;
  sshKey: string;
};

export type Documents = {
  openRecent(index: number): Promise<void>;
  forgetKey(): Promise<void>;
  selected():{id:string;expectedSeq:number;objectId?:string;type?:string;parentId?:string|null}|undefined;
  refresh():Promise<void>;
  revealSource(source:{documentId?:string;objectId?:string}):void;
  addPlugin?(pluginType: string): void;
  listAllConnections?(): ListedConnectionItem[];
  connectByKey?(key: string): void;
  importDiscoveredHost?(spec: { name: string; host: string; port: number; pluginType: string; username?: string; jumpHost?: string }): Promise<boolean>;
  exportDocPrefs?(): Record<string, DocPref>;
  importDocPrefs?(prefs: Record<string, DocPref>): void;
};

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const navKeys: readonly string[] = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];
const altMoves: Record<string, Direction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'out', ArrowRight: 'in' };
const NO_META: Meta = { notes: '', sort: [] };
const NO_FAVORITES = 'Favorites unavailable: preferences could not be saved on this computer.';

const PLUGIN_DEFAULTS: Record<string, { port: number; icon: IconId; host: string; username: string }> = {
  'Remote Desktop': { port: 3389, icon: 'desktop', host: '10.28.37.14', username: 'bright' },
  'VNC': { port: 5900, icon: 'desktop', host: '10.28.37.14', username: 'admin' },
  'TeamViewer': { port: 5938, icon: 'laptop', host: '129044812', username: 'admin' },
  'Terminal': { port: 22, icon: 'terminal', host: '10.28.37.14', username: 'root' },
  'Web Page': { port: 443, icon: 'globe', host: '10.28.37.14', username: 'admin' },
  'File Transfer': { port: 22, icon: 'database', host: '10.28.37.14', username: 'root' },
  'Windows Events View': { port: 5985, icon: 'server', host: '10.28.37.14', username: 'bright' },
  'Windows Services': { port: 5985, icon: 'wrench', host: '10.28.37.14', username: 'bright' },
  'Windows Processes': { port: 5985, icon: 'chip', host: '10.28.37.14', username: 'bright' },
  'Terminal Services': { port: 3389, icon: 'server', host: '10.28.37.14', username: 'bright' },
  'VMware': { port: 443, icon: 'cloud', host: 'esx00.local', username: 'root' },
  'Hyper-V': { port: 5985, icon: 'box', host: 'hv01.local', username: 'Administrator' },
  'PowerShell': { port: 5985, icon: 'terminal', host: '10.28.37.14', username: 'bright' },
  'Royal Server': { port: 54899, icon: 'router', host: 'gw01.local', username: 'admin' },
  'Secure Gateway': { port: 22, icon: 'shield', host: 'bastion.local', username: 'ops' },
  'Remote Desktop Gateway': { port: 443, icon: 'shield', host: 'rdgw.local', username: 'bright' },
  'Command Task': { port: 22, icon: 'wrench', host: '127.0.0.1', username: 'operator' },
  'Key Sequence Task': { port: 3389, icon: 'key', host: '127.0.0.1', username: 'operator' },
  'Information': { port: 443, icon: 'database', host: 'docs.local', username: 'owner' },
  'To-Do': { port: 443, icon: 'wrench', host: 'tasks.local', username: 'owner' },
};

function parsePluginTag(notes: string): { pluginType: string; cleanNotes: string; extras: ProtocolExtras } {
  const m = notes.match(/^\[Plugin:\s*([^\]]+)\]\r?\n?/);
  if (!m) return { pluginType: 'Remote Desktop', cleanNotes: notes, extras: {} };
  const parts = m[1]!.split('|').map((s) => s.trim());
  const pluginType = parts[0] || 'Remote Desktop';
  const extras: ProtocolExtras = {};
  for (let i = 1; i < parts.length; i++) {
    const kv = parts[i]!;
    const eq = kv.indexOf('=');
    if (eq > 0) {
      const k = kv.slice(0, eq).trim();
      const v = kv.slice(eq + 1).trim();
      if (k === 'auth') extras.authMode = v;
      else if (k === 'key') extras.sshKey = v;
      else if (k === 'jump') extras.jumpHost = v;
      else if (k === 'path') extras.initPath = v;
      else if (k === 'user') extras.defaultUser = v;
      else if (k === 'ccolor') extras.customColor = v;
      else if (k === 'fmode') extras.folderMode = v;
      else if (k === 'wol') extras.wolMac = v;
      else if (k === 'knock') extras.knockSeq = v;
    }
  }
  return { pluginType, cleanNotes: notes.slice(m[0].length), extras };
}

function encodePluginNotes(pluginType: string, rawNotes: string, extras: ProtocolExtras = {}): string {
  const stripped = parsePluginTag(rawNotes).cleanNotes.trim();
  const kvParts: string[] = [];
  if (extras.authMode && extras.authMode !== 'auto') kvParts.push(`auth=${extras.authMode}`);
  if (extras.sshKey) kvParts.push(`key=${extras.sshKey}`);
  if (extras.jumpHost) kvParts.push(`jump=${extras.jumpHost}`);
  if (extras.initPath) kvParts.push(`path=${extras.initPath}`);
  if (extras.defaultUser) kvParts.push(`user=${extras.defaultUser}`);
  if (extras.customColor) kvParts.push(`ccolor=${extras.customColor}`);
  if (extras.folderMode && extras.folderMode !== 'standard') kvParts.push(`fmode=${extras.folderMode}`);
  if (extras.wolMac) kvParts.push(`wol=${extras.wolMac}`);
  if (extras.knockSeq) kvParts.push(`knock=${extras.knockSeq}`);

  if ((!pluginType || pluginType === 'Remote Desktop' || pluginType === 'Folder') && kvParts.length === 0) return stripped;
  const header = `[Plugin: ${[pluginType || 'Remote Desktop', ...kvParts].join(' | ')}]`;
  return stripped ? `${header}\n${stripped}`.slice(0, MAX_NOTES) : header;
}

type Initial = { name: string; rdp?: RdpSettings; meta?: Meta; folder?: boolean; isDocument?: boolean; subfolders?: number; pluginType?: string; extras?: ProtocolExtras };
/** What the dialog ended with. `renamed` says whether the name box was changed: a name that was not touched is not sent (it may have been changed meanwhile by somebody else). */
type Answer = { name: string; renamed: boolean; rdp?: RdpSettings; meta?: Meta; spread?: boolean; pluginType?: string; extras?: ProtocolExtras; rawColor?: string };
/** What is done with an answer while the dialog is still open: the reason why not (the dialog stays, with what was typed), or nothing when it was done. */
type Submit = (answer: Answer) => Promise<string | undefined>;

export function initDocuments(host: Host): Documents {
  const models = new Map<string, DocModel>();
  const favorites = new Map<string, Set<string>>();   // by session id; a document has an entry only when the main process keeps favourites for it
  const expanded = new Set<string>();
  let filter: RowFilter = { query: '', notes: false, onlyFavorites: false };
  let rows: Row[] = [];
  let selected: string | undefined;
  let messageTimer: number | undefined;

  const selection = (from: string | undefined) => {
    const key = parseKey(from ?? '');
    const model = key && models.get(key.sessionId);
    return model ? { model, node: key.objectId ? model.objects.get(key.objectId) : undefined } : undefined;
  };
  const current = () => selection(selected);
  // Two places in the documents section, both next to the buttons that were pressed: what went well (a few seconds) and what went wrong (until the next action).
  function say(text: string) { el('doc-message').textContent = text; clearTimeout(messageTimer); messageTimer = window.setTimeout(() => { el('doc-message').textContent = ''; }, 5000); }
  const showError = (text: string) => { el('doc-error').textContent = text; };
  const report = (error: unknown) => { console.warn('documents:', error); showError('An error occurred; please try again.'); };
  // Every button and key goes through here: the last error is cleared, and an answer that never comes (the main process could not reply) is said instead of vanishing.
  const act = (run: () => Promise<void>) => () => { showError(''); run().catch(report); };
  let queue: Promise<void> = Promise.resolve();
  const queued = (run: () => Promise<void>) => () => { showError(''); queue = queue.then(run).catch(report); };
  /** An action on the row that is selected when it is asked for: the row is remembered now, not looked up when its turn comes. */
  const forSelected = (run: (key: string | undefined) => Promise<void>) => () => { const key = selected; act(() => run(key))(); };
  const queuedForSelected = (run: (key: string | undefined) => Promise<void>) => () => { const key = selected; queued(() => run(key))(); };

  /** A picture of the document that is known to be old is never shown without a word. */
  const BEHIND = 'Document view is out of date; close and reopen the document.';
  const behind = () => showError(BEHIND);
  /** The model of a snapshot; its favourites are taken in as well (a snapshot that has none means the main process keeps none for the window). */
  function know(snapshot: Shown): DocModel {
    if (snapshot.favorites) favorites.set(snapshot.id, new Set(snapshot.favorites)); else favorites.delete(snapshot.id);
    return modelOf(snapshot);
  }
  /** Takes one change in. A change that does not follow the one the window is at means a change was missed: the document is asked for again, whole, before this returns. */
  async function take(delta: Delta): Promise<void> {
    const model = models.get(delta.id);
    if (model && applyDelta(model, delta) === 'gap') await resync(delta.id).catch(behind);
  }
  async function resync(id: string) {
    const reply = await window.documents.snapshot(id);
    if (!reply.ok) throw new Error(reply.code);
    const model = models.get(id);
    if (model && reply.snapshot.seq > model.seq) { models.set(id, know(reply.snapshot)); render(); } // never an older state than the window has
  }
  /** Takes in what a refusal tells: the change it left behind, and that the document is further on than this window knows. */
  function learn(reply: Failure, id?: string) {
    if (reply.delta) void take(reply.delta);
    const model = id ? models.get(id) : undefined;
    if (id && model && reply.seq !== undefined && reply.seq !== model.seq) void resync(id).catch(behind); // the document is further on than this window knows
  }
  function fail(reply: Failure, id?: string) {
    learn(reply, id);
    if (reply.code !== 'cancelled') showError(reply.message);
    render();
  }
  /** A refusal that happens while the properties dialog is open: the tree is brought up to date behind it, and the reason is for the dialog to say. */
  function refused(reply: Failure, id: string): string {
    learn(reply, id);
    render();
    return reply.message;
  }

  function updateButtons() {
    const s = current();
    const canConnectFolder = s?.node?.type === 'folder' && s.model.children.has(s.node.id);
    el<HTMLButtonElement>('doc-save').disabled = !s?.model.dirty;
    el<HTMLButtonElement>('doc-close').disabled = !s;
    el<HTMLButtonElement>('doc-properties-open').disabled = !s;
    el<HTMLButtonElement>('doc-password-open').disabled = !s;
    el<HTMLButtonElement>('obj-add-folder').disabled = !s;
    el<HTMLButtonElement>('obj-add-connection').disabled = !s || s.model.kind==='vault';
    el<HTMLButtonElement>('obj-connect').disabled = !(s?.node?.type === 'connection' || canConnectFolder);
    el<HTMLButtonElement>('obj-edit').disabled = !s;
    el<HTMLButtonElement>('obj-duplicate').disabled = !s?.node;
    el<HTMLButtonElement>('obj-transfer').disabled = !s;
    el<HTMLButtonElement>('obj-bulk').disabled = !s;
    el<HTMLButtonElement>('obj-remove').disabled = !s?.node;
    const star = el<HTMLButtonElement>('obj-favorite');
    const mine = s ? favorites.get(s.model.id) : undefined;
    star.disabled = !s?.node || !mine;
    star.setAttribute('aria-pressed', String(!!s?.node && mine?.has(s.node.id) === true));
    star.title = s?.node && !mine ? NO_FAVORITES : '';
    el<HTMLButtonElement>('tree-expand').disabled = models.size === 0 || narrows(filter);       // a search opens the folders it needs and no one can close them: nothing to open or close
    el<HTMLButtonElement>('tree-collapse').disabled = models.size === 0 || narrows(filter);
    input('tree-favorites').disabled = noFavourites();
    const rawNote = s?.node ? notesOf(s.node.props) : '';
    const parsedNote = parsePluginTag(rawNote).cleanNotes.trim();
    el('obj-notes').hidden = parsedNote === '';
    el('obj-notes-text').textContent = parsedNote;
    renderFolderDashboard(s);
    safety.update();
  }

  const pingStatusCache = new Map<string, { reachable: boolean; latencyMs: number; checkedAt: number }>();

  function getPingKey(model: DocModel, conn: NonNullable<ReturnType<typeof current>>['node']): string {
    if (!conn) return '';
    const hostStr = typeof conn.props.host === 'string' ? conn.props.host : '127.0.0.1';
    const portNum = typeof conn.props.port === 'number' ? conn.props.port : 3389;
    const eff = resolveEffectiveInheritance(model, conn);
    return `${hostStr}:${portNum}@${eff.jumpHost}`;
  }

  async function probeSingleNode(model: DocModel, conn: NonNullable<ReturnType<typeof current>>['node']): Promise<void> {
    if (!conn || conn.type !== 'connection') return;
    const parsed = parsePluginTag(notesOf(conn.props));
    const eff = resolveEffectiveInheritance(model, conn);
    const hostStr = typeof conn.props.host === 'string' ? conn.props.host : '127.0.0.1';
    const portNum = typeof conn.props.port === 'number' ? conn.props.port : 3389;
    const userStr = typeof conn.props.username === 'string' && conn.props.username ? conn.props.username : eff.defaultUser || 'root';
    const key = `${hostStr}:${portNum}@${eff.jumpHost}`;
    try {
      const res = (await (window as any).workspace?.run('protocol.probe', {
        pluginType: parsed.pluginType,
        host: hostStr,
        port: portNum,
        username: userStr,
        path: '/',
        jumpHost: eff.jumpHost,
        jumpPassword: '',
        identityFile: parsed.extras.sshKey || eff.sshKey || '',
      })) as { ok: boolean; value?: { reachable: boolean; latencyMs: number } } | undefined;
      if (res?.ok && res.value) {
        pingStatusCache.set(key, {
          reachable: res.value.reachable,
          latencyMs: res.value.latencyMs,
          checkedAt: Date.now(),
        });
      }
    } catch {}
  }

  function decorateTreeWithPingDots() {
    const treeEl = document.getElementById('tree');
    if (!treeEl) return;
    for (const rowEl of treeEl.querySelectorAll<HTMLElement>('[data-key]')) {
      const k = rowEl.dataset.key;
      if (!k) continue;
      rowEl.querySelector('.tree-ping-dot')?.remove();
      const parsedKey = parseKey(k);
      if (!parsedKey || !parsedKey.objectId) continue;
      const m = models.get(parsedKey.sessionId);
      const node = m?.objects.get(parsedKey.objectId);
      if (!m || !node || node.type !== 'connection') continue;
      const pk = getPingKey(m, node);
      const st = pingStatusCache.get(pk);
      if (!st) continue;
      const dot = document.createElement('span');
      dot.className = 'tree-ping-dot';
      dot.dataset.online = st.reachable ? 'true' : 'false';
      dot.title = st.reachable ? `Online (${st.latencyMs} ms)` : 'Offline / Unreachable';
      rowEl.append(dot);
    }
  }

  async function syncSshConfigIntoScope(model: DocModel, parentFolderId: string | null) {
    try {
      const res = (await (window as any).workspace?.run('ssh.env')) as
        | {
            ok: boolean;
            value?: {
              jumpHosts: { alias: string; hostName: string; port: number; user: string; identityFile?: string }[];
              allHosts: { alias: string; hostName: string; port: number; user: string; proxyJump?: string; identityFile?: string }[];
            };
          }
        | undefined;
      if (!res?.ok || !res.value) return;
      const existingNames = new Set<string>();
      for (const obj of model.objects.values()) {
        existingNames.add(obj.name.toLowerCase());
      }
      let addedCount = 0;
      for (const j of res.value.jumpHosts) {
        if (existingNames.has(j.alias.toLowerCase())) continue;
        const notes = encodePluginNotes('Secure Gateway', 'Auto-synced Jump Host from ~/.ssh/config', {
          sshKey: j.identityFile,
        });
        const r = await window.documents.add({
          id: model.id,
          parentId: parentFolderId,
          type: 'connection',
          name: j.alias,
          props: {
            host: j.hostName,
            port: j.port || 22,
            username: j.user || 'root',
            icon: 'shield',
            color: 'orange',
            notes,
          },
        });
        if (r.ok) {
          await take(r.delta);
          existingNames.add(j.alias.toLowerCase());
          addedCount++;
        }
      }
      for (const h of res.value.allHosts) {
        if (existingNames.has(h.alias.toLowerCase())) continue;
        const notes = encodePluginNotes('Terminal', 'Auto-synced SSH Host from ~/.ssh/config', {
          jumpHost: h.proxyJump,
          sshKey: h.identityFile,
        });
        const r = await window.documents.add({
          id: model.id,
          parentId: parentFolderId,
          type: 'connection',
          name: h.alias,
          props: {
            host: h.hostName,
            port: h.port || 22,
            username: h.user || 'root',
            icon: 'terminal',
            color: 'purple',
            notes,
          },
        });
        if (r.ok) {
          await take(r.delta);
          existingNames.add(h.alias.toLowerCase());
          addedCount++;
        }
      }
      render();
      say(addedCount > 0 ? `Synced ${addedCount} SSH host(s) from ~/.ssh/config into ${model.name}.` : 'All hosts from ~/.ssh/config are already in this document.');
    } catch {
      showError('Could not sync ~/.ssh/config hosts.');
    }
  }

  function renderFolderDashboard(s: ReturnType<typeof current>) {
    const dash = document.getElementById('folder-dashboard');
    if (!dash) return;
    if (!s) {
      dash.hidden = true;
      dash.replaceChildren();
      return;
    }
    const model = s.model;
    const focusFolderId = s.node ? (s.node.type === 'folder' ? s.node.id : s.node.parentId) : null;
    const focusFolder = focusFolderId ? model.objects.get(focusFolderId) : undefined;
    const scopeTitle = focusFolder ? `${model.name} / ${focusFolder.name}` : model.name;
    const docPref = getDocPref(model.id, model.name, model.docId);
    const folderJump = focusFolder ? resolveEffectiveInheritance(model, focusFolder).jumpHost : (docPref.jumpHost ?? '');

    const childConnections: NonNullable<typeof s.node>[] = [];
    const collect = (parentId: string | null) => {
      const ids = model.children.get(parentId);
      if (!ids) return;
      for (const cid of ids) {
        const obj = model.objects.get(cid);
        if (!obj) continue;
        if (obj.type === 'connection') childConnections.push(obj);
        else if (obj.type === 'folder') collect(obj.id);
      }
    };
    collect(focusFolderId);

    dash.hidden = false;
    dash.replaceChildren();

    const header = document.createElement('div');
    header.className = 'folder-dash-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'folder-dash-title';
    const titleSpan = document.createElement('span');
    titleSpan.textContent = `${scopeTitle} (${childConnections.length} server${childConnections.length === 1 ? '' : 's'})`;
    const gwBadge = document.createElement('span');
    gwBadge.className = 'color-badge-pill';
    gwBadge.textContent = folderJump ? `Gateway: ${folderJump}` : 'Gateway: Direct LAN';
    titleWrap.append(titleSpan, gwBadge);

    const actionsWrap = document.createElement('div');
    actionsWrap.className = 'plugin-row-inline';
    const addConnBtn = document.createElement('button');
    addConnBtn.type = 'button';
    addConnBtn.className = 'quiet';
    addConnBtn.textContent = '+ New Connection';
    addConnBtn.onclick = () => {
      const targetKey = focusFolder ? objectKey(model.id, focusFolder.id) : documentKey(model.id);
      queued(() => addObject('connection', targetKey))();
    };
    const syncSshBtn = document.createElement('button');
    syncSshBtn.type = 'button';
    syncSshBtn.className = 'quiet';
    syncSshBtn.textContent = '🔄 Sync SSH Config';
    syncSshBtn.title = 'Royal TSX Dynamic Folder: Import/Sync hosts & Jump Hosts from ~/.ssh/config into this scope';
    syncSshBtn.onclick = () => {
      void syncSshConfigIntoScope(model, focusFolderId);
    };
    const scanSubnetBtn = document.createElement('button');
    scanSubnetBtn.type = 'button';
    scanSubnetBtn.className = 'quiet';
    scanSubnetBtn.textContent = '🔍 Scan Subnet';
    scanSubnetBtn.title = 'Interactive Subnet & Port Discovery Wizard (scans LAN or via inherited Jump Host)';
    scanSubnetBtn.onclick = () => {
      const sampleHost =
        childConnections.length > 0 && typeof childConnections[0]!.props.host === 'string'
          ? childConnections[0]!.props.host
          : '10.28.0.154';
      const prefix = sampleHost.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/)?.[1] ?? '10.28.0';
      host.openPlugin?.({
        pluginType: 'Network Scanner',
        name: `Scanner · ${scopeTitle}`,
        host: `${prefix}.150-165`,
        port: 3389,
        username: docPref.defaultUser || 'root',
        notes: scopeTitle,
        jumpHost: folderJump,
        sshKey: docPref.sshKey ?? '',
      });
    };
    const propBtn = document.createElement('button');
    propBtn.type = 'button';
    propBtn.className = 'quiet';
    propBtn.textContent = focusFolder ? 'Folder Properties…' : 'Document Properties…';
    propBtn.onclick = () => {
      const targetKey = focusFolder ? objectKey(model.id, focusFolder.id) : documentKey(model.id);
      queued(() => editObject(targetKey))();
    };
    const runbookBtn = document.createElement('button');
    runbookBtn.type = 'button';
    runbookBtn.className = 'quiet';
    runbookBtn.textContent = '📖 Runbooks';
    runbookBtn.title = 'Open Operational SOP & Interactive Runbook Playbooks for this scope';
    runbookBtn.onclick = () => {
      host.openPlugin?.({
        pluginType: 'Runbook Studio',
        name: `Runbook · ${scopeTitle}`,
        host: scopeTitle,
        port: 22,
        username: docPref.defaultUser || 'root',
        notes: scopeTitle,
        jumpHost: folderJump,
        sshKey: docPref.sshKey ?? '',
      });
    };
    actionsWrap.append(addConnBtn, syncSshBtn, scanSubnetBtn, runbookBtn, propBtn);
    if (childConnections.length > 0) {
      const healthBtn = document.createElement('button');
      healthBtn.type = 'button';
      healthBtn.className = 'quiet';
      healthBtn.textContent = '🔔 Health Monitor';
      healthBtn.title = 'Live Uptime Watchdog & Latency Alerting across servers in this scope';
      healthBtn.onclick = () => {
        host.openPlugin?.({
          pluginType: 'Health Monitor',
          name: `Health · ${scopeTitle}`,
          host: scopeTitle,
          port: 22,
          username: docPref.defaultUser || 'root',
          notes: scopeTitle,
          jumpHost: folderJump,
          sshKey: docPref.sshKey ?? '',
        });
      };
      const batchScriptBtn = document.createElement('button');
      batchScriptBtn.type = 'button';
      batchScriptBtn.className = 'quiet';
      batchScriptBtn.textContent = '⚡ Batch Script';
      batchScriptBtn.title = 'Run a Bash or PowerShell command in parallel across all servers in this scope';
      batchScriptBtn.onclick = () => {
        host.openPlugin?.({
          pluginType: 'Batch Script Runner',
          name: `Batch · ${scopeTitle}`,
          host: scopeTitle,
          port: 22,
          username: docPref.defaultUser || 'root',
          notes: scopeTitle,
          jumpHost: folderJump,
          sshKey: docPref.sshKey ?? '',
        });
      };
      const pingAllBtn = document.createElement('button');
      pingAllBtn.type = 'button';
      pingAllBtn.className = 'quiet';
      pingAllBtn.textContent = '📡 Ping Status';
      pingAllBtn.title = 'Jump Desktop / Royal TSX: Live TCP reachability & latency check (via inherited Jump Host)';
      pingAllBtn.onclick = () => {
        pingAllBtn.disabled = true;
        pingAllBtn.textContent = '📡 Probing…';
        void (async () => {
          await Promise.all(childConnections.slice(0, 16).map((c) => probeSingleNode(model, c)));
          decorateTreeWithPingDots();
          renderFolderDashboard(current());
        })();
      };
      const connectAllBtn = document.createElement('button');
      connectAllBtn.type = 'button';
      connectAllBtn.textContent = `⚡ Connect All (${childConnections.length})`;
      connectAllBtn.onclick = () => {
        void (async () => {
          for (const conn of childConnections) {
            await connectSingleNode(model, conn);
          }
        })();
      };
      const topologyBtn = document.createElement('button');
      topologyBtn.type = 'button';
      topologyBtn.className = 'quiet';
      topologyBtn.textContent = '🕸 Topology';
      topologyBtn.title = 'Interactive Network Topology & Jump-Chain Visualizer';
      topologyBtn.onclick = () => {
        host.openPlugin?.({
          pluginType: 'Topology Map',
          name: `Topology · ${scopeTitle}`,
          host: scopeTitle,
          port: 22,
          username: docPref.defaultUser || 'root',
          notes: scopeTitle,
          jumpHost: folderJump,
          sshKey: docPref.sshKey ?? '',
        });
      };
      const driftBtn = document.createElement('button');
      driftBtn.type = 'button';
      driftBtn.className = 'quiet';
      driftBtn.textContent = '📊 Drift Matrix';
      driftBtn.title = 'Multi-Server Baseline & Configuration Drift Comparator';
      driftBtn.onclick = () => {
        host.openPlugin?.({
          pluginType: 'Drift Comparator',
          name: `Drift · ${scopeTitle}`,
          host: scopeTitle,
          port: 22,
          username: docPref.defaultUser || 'root',
          notes: scopeTitle,
          jumpHost: folderJump,
          sshKey: docPref.sshKey ?? '',
        });
      };
      const studioSelect = document.createElement('select');
      studioSelect.className = 'session-select';
      studioSelect.title = 'Open Folder / Document in Enterprise Studio (Progressive Disclosure)';
      const placeholderOpt = document.createElement('option');
      placeholderOpt.value = '';
      placeholderOpt.textContent = '🧰 Open Folder in Studio…';
      studioSelect.append(placeholderOpt);

      const studioItems: [string, string, number, boolean][] = [
        ['☁️ Team Vault Git & S3 Sync', 'Team Vault Sync', 0, false],
        ['🎬 Session Cast Replay (Asciicast v2)', 'Session Cast Studio', 22, true],
        ['☸ K8s Manifest & Helm Studio', 'K8s Manifest Studio', 6443, true],
        ['📨 Alert & Webhook Relay Tester', 'Alert Relay Studio', 443, false],
        ['🔐 Vault & .env Secret Sealer', 'Secret Env Studio', 0, false],
        ['🌍 GeoIP, ASN & Threat Intel', 'Threat Intel Studio', 43, true],
        ['⚡ HTTP Load & Stress Benchmark', 'Load Benchmark Studio', 4321, true],
        ['🏢 Active Directory & DNS Studio', 'AD & DNS Studio', 3389, true],
        ['🐳 Docker & Containers Studio', 'Container Studio', 22, true],
        ['🛡 Firewall & Port Security Matrix', 'Firewall Auditor', 22, true],
        ['⚙ IaC / Ansible Inventory Exporter', 'IaC Exporter', 22, false],
        ['📈 CPU / RAM / I/O Resource Profiler', 'Resource Profiler', 22, true],
        ['🔄 Systemd & Windows Service Controller', 'Service Controller Studio', 22, true],
        ['🧮 Subnet CIDR & IPAM Matrix', 'Subnet IPAM Studio', 0, true],
        ['🔒 CIS & SSH Hardening Benchmark', 'CIS Benchmark Studio', 22, true],
        ['🕰 NTP / Chrony Clock Skew Auditor', 'Time Sync Studio', 22, true],
        ['📡 Live Packet Capture (tcpdump / BPF)', 'Packet Sniffer Studio', 22, true],
        ['📊 Prometheus /metrics Scraper', 'Prometheus Studio', 9100, true],
        ['🛡 SHA-256 FIM & Linux Auditd', 'FIM Auditd Studio', 22, true],
        ['📋 ITIL v4 Change & RFC Generator', 'Change RFC Studio', 0, false],
        ['📜 Live Multi-Server Log Streamer', 'Log Streamer', 22, false],
        ['🔐 SSL/TLS Certificate Expiry Audit', 'Cert Auditor', 443, false],
        ['📸 1-Click Incident Dossier Report', 'Incident Reporter', 22, false],
      ];

      for (const [label, pluginType, defaultPort, useFirstHost] of studioItems) {
        const opt = document.createElement('option');
        opt.value = `${pluginType}|${defaultPort}|${useFirstHost ? '1' : '0'}`;
        opt.textContent = label;
        studioSelect.append(opt);
      }

      studioSelect.onchange = () => {
        if (!studioSelect.value) return;
        const [pluginType, portStr, useFirstFlag] = studioSelect.value.split('|');
        studioSelect.value = '';
        const firstConn = childConnections[0];
        const firstHost = typeof firstConn?.props.host === 'string' ? firstConn.props.host : '10.28.0.154';
        const targetHost = useFirstFlag === '1' ? firstHost : scopeTitle;
        host.openPlugin?.({
          pluginType,
          name: `${pluginType} · ${scopeTitle}`,
          host: targetHost,
          port: Number(portStr) || 22,
          username: docPref.defaultUser || 'root',
          notes: scopeTitle,
          jumpHost: folderJump,
          sshKey: docPref.sshKey ?? '',
        });
      };

      actionsWrap.append(studioSelect, topologyBtn, driftBtn, healthBtn, batchScriptBtn, pingAllBtn, connectAllBtn);
    }
    header.append(titleWrap, actionsWrap);
    dash.append(header);

    if (childConnections.length === 0) {
      const emptyHint = document.createElement('p');
      emptyHint.className = 'hint';
      emptyHint.textContent = 'No connections in this scope yet. Click "+ New Connection" or "🔄 Sync SSH Config" to populate servers that automatically inherit this Jump Host & credentials.';
      dash.append(emptyHint);
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'folder-dash-grid';
    for (const conn of childConnections.slice(0, 24)) {
      const parsed = parsePluginTag(notesOf(conn.props));
      const eff = resolveEffectiveInheritance(model, conn);
      const card = document.createElement('div');
      card.className = 'folder-dash-card';
      const col = parsed.extras.customColor || colorOf(conn.props);
      if (col) card.dataset.color = col;

      const top = document.createElement('div');
      top.className = 'folder-dash-card-top';
      const nameEl = document.createElement('span');
      nameEl.className = 'folder-dash-card-name';
      nameEl.textContent = conn.name;

      const badgeGroup = document.createElement('div');
      badgeGroup.className = 'plugin-row-inline';
      const pk = getPingKey(model, conn);
      const pingState = pingStatusCache.get(pk);
      const pingPill = document.createElement('span');
      pingPill.className = 'dash-ping-pill';
      if (pingState) {
        pingPill.dataset.online = pingState.reachable ? 'true' : 'false';
        pingPill.textContent = pingState.reachable ? `● ${pingState.latencyMs}ms` : '● Offline';
      } else {
        pingPill.textContent = '○ Ping';
      }
      pingPill.title = 'Click to probe live reachability';
      pingPill.onclick = () => {
        pingPill.textContent = '…';
        void probeSingleNode(model, conn).then(() => {
          decorateTreeWithPingDots();
          renderFolderDashboard(current());
        });
      };

      const protoBadge = document.createElement('span');
      protoBadge.className = 'color-badge-pill';
      protoBadge.textContent = parsed.pluginType === 'Remote Desktop' ? 'RDP' : parsed.pluginType;
      badgeGroup.append(pingPill, protoBadge);
      top.append(nameEl, badgeGroup);

      const hostStr = typeof conn.props.host === 'string' ? conn.props.host : '127.0.0.1';
      const portNum = typeof conn.props.port === 'number' ? conn.props.port : 3389;
      const metaEl = document.createElement('div');
      metaEl.className = 'folder-dash-card-meta';
      metaEl.textContent = `${hostStr}:${portNum}${eff.jumpHost ? ` · via ${eff.jumpHost}` : ''}`;

      const cardActs = document.createElement('div');
      cardActs.className = 'folder-dash-card-actions';
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'quiet';
      editBtn.textContent = 'Properties';
      editBtn.onclick = () => {
        const k = objectKey(model.id, conn.id);
        select(k);
        queued(() => editObject(k))();
      };
      const connBtn = document.createElement('button');
      connBtn.type = 'button';
      connBtn.textContent = 'Connect';
      connBtn.onclick = () => {
        const k = objectKey(model.id, conn.id);
        select(k);
        act(() => connect(k))();
      };
      cardActs.append(editBtn, connBtn);
      card.append(top, metaEl, cardActs);
      grid.append(card);
    }
    dash.append(grid);
  }

  function updateStatus() {
    let text = '';
    if (narrows(filter)) {
      const shown = rows.filter((r) => r.type !== 'document').length;
      let total = 0;
      for (const model of models.values()) total += model.objects.size;
      text = shown === 0 ? 'No matching objects.' : `${shown} of ${total} objects shown.`;
    }
    el('tree-search-status').textContent = text;
  }

  /** No open document has favourites kept (the preferences could not be opened): "only favourites" could only say that none match. */
  const noFavourites = () => models.size > 0 && ![...models.keys()].some((id) => favorites.has(id));
  function render() {
    if (filter.onlyFavorites && noFavourites()) { filter = { ...filter, onlyFavorites: false }; el<HTMLInputElement>('tree-favorites').checked = false; }   // the box went off (disabled) while it was ticked: it must not go on hiding everything
    const built = buildRows([...models.values()], expanded, { filter, favorites });
    rows = built.map((r): Row => {
      const m = models.get(r.sessionId);
      if (r.type === 'document') {
        const pref = getDocPref(r.sessionId, r.name, m?.docId);
        return {
          ...r,
          ...(pref.icon ? { icon: pref.icon } : {}),
          ...(pref.color ? { color: pref.color as any } : {}),
        };
      }
      if (m && r.objectId) {
        const node = m.objects.get(r.objectId);
        if (node) {
          const parsed = parsePluginTag(notesOf(node.props));
          const customCol = parsed.extras.customColor;
          const hasRealNote = parsed.cleanNotes.trim() !== '';
          return {
            ...r,
            ...(customCol ? { color: customCol as any } : {}),
            note: hasRealNote ? true : undefined,
          };
        }
      }
      return r;
    });
    selected = keepSelection(rows, selected);
    view.render(rows, selected);
    decorateTreeWithPingDots();
    el('tree-empty').hidden = models.size > 0;
    updateStatus();
    updateButtons();
  }
  // A click only moves the selection: the rows are not redrawn, so a double click lands on the row the first click hit.
  function select(key: string) {
    selected = key;
    view.setSelected(key);
    updateButtons();
  }
  function toggle(key: string, open: boolean) {
    if (narrows(filter)) { select(key); return; }   // the search has opened what it shows: what is open is kept untouched for when it ends
    if (open) expanded.add(key); else expanded.delete(key);
    selected = key;
    render();
  }
  function show(key: string | undefined) {
    selected = key;
    render();
    if (key) view.reveal(key);
    view.focus();
  }
  /** Ends the search, so that an object that was just made or copied is in the list. What the notes box says is a way of searching, not a search, and stays. */
  function clearFilter() {
    filter = { query: '', notes: filter.notes, onlyFavorites: false };
    el<HTMLInputElement>('tree-search').value = '';
    el<HTMLInputElement>('tree-favorites').checked = false;
  }
  /** Opens the document and every folder above an object, so that it is in the list when no search is open: a search shows the folders above a match open without opening them. */
  function reveal(sessionId: string, objectId: string) {
    const model = models.get(sessionId);
    expanded.add(documentKey(sessionId));
    for (let id = model?.objects.get(objectId)?.parentId, hops = 0; id && model && hops <= model.objects.size; id = model.objects.get(id)?.parentId, hops++) expanded.add(objectKey(sessionId, id));
  }

  // ---- the properties dialog ----
  const input = (id: string) => el<HTMLInputElement>(id);
  const tick = (group: string, value: string) => {
    const radio = document.querySelector<HTMLInputElement>(`input[name=${group}][value="${value}"]`);
    if (radio) radio.checked = true;
    const badgeId = group === 'doc-prop-color' ? 'doc-prop-color-badge' : group === 'p-color' ? 'p-color-badge' : '';
    const customId = group === 'doc-prop-color' ? 'doc-prop-custom-color' : group === 'p-color' ? 'p-custom-color' : '';
    if (badgeId) {
      const badge = document.getElementById(badgeId);
      const sw = ALL_SWATCH_COLORS.find((c) => c.id === value);
      if (badge) badge.textContent = sw ? sw.label : 'Default';
      const customIn = customId ? (document.getElementById(customId) as HTMLInputElement | null) : null;
      if (customIn && sw) customIn.value = sw.hex;
    }
  };
  const picked = (group: string) => document.querySelector<HTMLInputElement>(`input[name=${group}]:checked`)?.value ?? '';
  /** The colours and the icons the dialog offers, made from the lists the main process checks against (documents/meta.ts), plus Royal extended swatches. */
  function buildPicks() {
    const add = (where: HTMLElement, group: string, value: string, label: string, face: SVGElement | string): HTMLElement => {
      const item = document.createElement('label');
      item.className = 'pick';
      item.title = label;
      const radio = document.createElement('input');
      radio.type = 'radio'; radio.name = group; radio.value = value; radio.className = 'sr-only';
      radio.onchange = () => tick(group, value);
      const shape = document.createElement('span');
      shape.className = 'face';
      if (typeof face === 'string') shape.textContent = face; else shape.append(face);
      const words = document.createElement('span');
      words.className = 'sr-only';
      words.textContent = label;
      item.append(radio, shape, words);
      where.append(item);
      return shape;
    };
    const pColors = document.getElementById('p-colors');
    if (pColors) {
      pColors.replaceChildren();
      add(pColors, 'p-color', '', 'No color', '×');
      for (const color of ALL_SWATCH_COLORS) add(pColors, 'p-color', color.id, color.label, '').dataset.color = color.id;
    }
    const pIcons = document.getElementById('p-icons');
    if (pIcons) {
      pIcons.replaceChildren();
      add(pIcons, 'p-icon', '', 'Default icon', '–');
      for (const icon of ICONS) add(pIcons, 'p-icon', icon.id, icon.label, iconElement(icon.id));
    }
    const docColors = document.getElementById('doc-prop-colors');
    if (docColors) {
      docColors.replaceChildren();
      add(docColors, 'doc-prop-color', '', 'No color', '×');
      for (const color of ALL_SWATCH_COLORS) add(docColors, 'doc-prop-color', color.id, color.label, '').dataset.color = color.id;
    }
    const docIcons = document.getElementById('doc-prop-icons');
    if (docIcons) {
      docIcons.replaceChildren();
      add(docIcons, 'doc-prop-icon', '', 'Default document icon', '–');
      for (const icon of ICONS) add(docIcons, 'doc-prop-icon', icon.id, icon.label, iconElement(icon.id));
    }
    const pCustom = document.getElementById('p-custom-color') as HTMLInputElement | null;
    if (pCustom) {
      pCustom.oninput = () => {
        const nearest = nearestSwatchForHex(pCustom.value);
        tick('p-color', nearest.id);
        const badge = document.getElementById('p-color-badge');
        if (badge) badge.textContent = `${nearest.label} (${pCustom.value})`;
      };
    }
    const docCustom = document.getElementById('doc-prop-custom-color') as HTMLInputElement | null;
    if (docCustom) {
      docCustom.oninput = () => {
        const nearest = nearestSwatchForHex(docCustom.value);
        tick('doc-prop-color', nearest.id);
        const badge = document.getElementById('doc-prop-color-badge');
        if (badge) badge.textContent = `${nearest.label} (${docCustom.value})`;
      };
    }
  }
  /** The second criterion needs the first, and is another property than the first. */
  function syncSort() {
    const first = el<HTMLSelectElement>('p-sort-by-1'), second = el<HTMLSelectElement>('p-sort-by-2');
    el<HTMLSelectElement>('p-sort-dir-1').disabled = first.value === '';
    second.disabled = first.value === '';
    if (first.value === '' || second.value === first.value) second.value = '';
    for (const option of second.options) option.disabled = option.value !== '' && option.value === first.value;
    el<HTMLSelectElement>('p-sort-dir-2').disabled = second.value === '';
  }
  const countNotes = () => { el('p-notes-count').textContent = `${el<HTMLTextAreaElement>('p-notes').value.length} / ${MAX_NOTES}`; };
  function showMeta(meta: Meta, folder: boolean, subfolders: number, extras?: ProtocolExtras, isDocument = false) {
    el<HTMLTextAreaElement>('p-notes').value = meta.notes;
    countNotes();
    const activeColor = extras?.customColor || meta.color || '';
    tick('p-color', activeColor);
    tick('p-icon', meta.icon ?? '');
    el('p-sort').hidden = !folder || isDocument;
    const folderGw = document.getElementById('p-folder-gateway');
    if (folderGw) {
      folderGw.hidden = !folder;
      const legend = document.getElementById('p-folder-gateway-legend');
      if (legend) {
        legend.textContent = isDocument
          ? 'Document Jump Host & Default Credentials (Inherited by All Folders & Connections)'
          : 'Inherited Jump Host & Credentials (Applies to All Child Folders & Connections)';
      }
      const fJump = document.getElementById('p-folder-jump') as HTMLSelectElement | null;
      const fUser = document.getElementById('p-folder-user') as HTMLInputElement | null;
      const fKey = document.getElementById('p-folder-ssh-key') as HTMLSelectElement | null;
      const fMode = document.getElementById('p-folder-mode') as HTMLSelectElement | null;
      if (fJump) fJump.value = extras?.jumpHost ?? '';
      if (fUser) fUser.value = extras?.defaultUser ?? '';
      if (fKey) fKey.value = extras?.sshKey ?? '';
      if (fMode) fMode.value = extras?.folderMode ?? 'standard';
    }
    ['1', '2'].forEach((n, i) => {
      el<HTMLSelectElement>(`p-sort-by-${n}`).value = meta.sort[i]?.by ?? '';
      el<HTMLSelectElement>(`p-sort-dir-${n}`).value = meta.sort[i]?.dir ?? 'asc';
    });
    syncSort();
    input('p-sort-sub').checked = false;
    el('p-sort-sub-row').hidden = !(folder && !isDocument && subfolders > 0);
    el('p-sort-sub-count').textContent = String(subfolders);
  }
  function readMeta(folder: boolean): { meta: Meta; rawColor: string } {
    const rawColor = picked('p-color');
    const swatch = ALL_SWATCH_COLORS.find((c) => c.id === rawColor);
    const color = swatch?.base;
    const icon = ICONS.find((i) => i.id === picked('p-icon'))?.id;
    const sort: SortCriterion[] = [];
    if (folder) {
      for (const n of ['1', '2']) {
        const by = el<HTMLSelectElement>(`p-sort-by-${n}`).value, dir = el<HTMLSelectElement>(`p-sort-dir-${n}`).value;
        if (by === '') break;
        if ((by === 'name' || by === 'type') && (dir === 'asc' || dir === 'desc') && !sort.some((c) => c.by === by)) sort.push({ by: by as SortBy, dir: dir as SortDir });
      }
    }
    return {
      meta: { notes: el<HTMLTextAreaElement>('p-notes').value, ...(color ? { color } : {}), ...(icon ? { icon } : {}), sort },
      rawColor,
    };
  }

  function syncProtocolFormFields(pluginType: string, extras: ProtocolExtras = {}) {
    const secRdp = document.getElementById('p-section-rdp');
    const secSsh = document.getElementById('p-section-ssh');
    const secWeb = document.getElementById('p-section-web');
    const secVnc = document.getElementById('p-section-vnc');
    const secMgmt = document.getElementById('p-section-mgmt');
    const hostLbl = document.getElementById('p-host-label-text');
    const userLbl = document.getElementById('p-user-label-text');
    const sshPathLbl = document.getElementById('p-ssh-path-label');

    const isRdp = ['Remote Desktop', 'Terminal Services', 'Remote Desktop Gateway', 'Key Sequence Task'].includes(pluginType);
    const isSshOrSftp = ['Terminal', 'File Transfer', 'Secure Gateway', 'Royal Server', 'Command Task'].includes(pluginType);
    const isWeb = ['Web Page', 'Information', 'To-Do'].includes(pluginType);
    const isVnc = ['VNC', 'TeamViewer'].includes(pluginType);
    const isMgmt = !isRdp && !isSshOrSftp && !isWeb && !isVnc;

    if (secRdp) secRdp.hidden = !isRdp;
    if (secSsh) secSsh.hidden = !isSshOrSftp;
    if (secWeb) secWeb.hidden = !isWeb;
    if (secVnc) secVnc.hidden = !isVnc;
    if (secMgmt) secMgmt.hidden = !isMgmt;

    if (hostLbl && userLbl) {
      if (pluginType === 'File Transfer') {
        hostLbl.textContent = 'SFTP Server Host / IP';
        userLbl.textContent = 'SFTP Username';
      } else if (pluginType === 'Terminal' || pluginType === 'Command Task') {
        hostLbl.textContent = 'SSH Host / IP';
        userLbl.textContent = 'SSH Username';
      } else if (pluginType === 'Secure Gateway' || pluginType === 'Royal Server') {
        hostLbl.textContent = 'Bastion / Jump Host IP';
        userLbl.textContent = 'Bastion Username';
      } else if (isWeb) {
        hostLbl.textContent = 'Web Host / Domain';
        userLbl.textContent = 'Auth Username (Optional)';
      } else if (isVnc) {
        hostLbl.textContent = 'Remote Display Host / ID';
        userLbl.textContent = 'Session Username';
      } else if (isMgmt) {
        hostLbl.textContent = 'Managed Server / Hypervisor';
        userLbl.textContent = 'Administrator Username';
      } else {
        hostLbl.textContent = 'Computer Name / IP';
        userLbl.textContent = 'Domain \\ Username';
      }
    }

    if (sshPathLbl) {
      const sshPathIn = document.getElementById('p-ssh-path') as HTMLInputElement | null;
      if (pluginType === 'File Transfer') {
        sshPathLbl.textContent = 'Initial Remote Directory';
        if (sshPathIn) sshPathIn.placeholder = '/root or /var/www';
      } else if (pluginType === 'Command Task') {
        sshPathLbl.textContent = 'Task Command to Execute';
        if (sshPathIn) sshPathIn.placeholder = 'systemctl status nginx && df -h';
      } else if (pluginType === 'Secure Gateway' || pluginType === 'Royal Server' || pluginType === 'Remote Desktop Gateway') {
        sshPathLbl.textContent = 'Default Intranet Target (Optional)';
        if (sshPathIn) sshPathIn.placeholder = 'e.g. 10.28.37.14:3389';
      } else {
        sshPathLbl.textContent = 'Startup Shell Command (Optional)';
        if (sshPathIn) sshPathIn.placeholder = 'e.g. tmux attach || bash';
      }
    }

    const rdpJump = document.getElementById('p-rdp-jump') as HTMLSelectElement | null;
    const sshAuth = document.getElementById('p-ssh-auth') as HTMLSelectElement | null;
    const sshKey = document.getElementById('p-ssh-key') as HTMLSelectElement | null;
    const sshJump = document.getElementById('p-ssh-jump') as HTMLSelectElement | null;
    const sshPath = document.getElementById('p-ssh-path') as HTMLInputElement | null;
    const webPath = document.getElementById('p-web-path') as HTMLInputElement | null;
    const vncJump = document.getElementById('p-vnc-jump') as HTMLSelectElement | null;
    const mgmtJump = document.getElementById('p-mgmt-jump') as HTMLSelectElement | null;

    if (rdpJump) rdpJump.value = extras.jumpHost ?? '';
    if (sshAuth) sshAuth.value = extras.authMode ?? 'auto';
    if (sshKey) sshKey.value = extras.sshKey ?? '';
    if (sshJump) sshJump.value = extras.jumpHost ?? '';
    if (sshPath) sshPath.value = extras.initPath ?? '';
    if (webPath) webPath.value = extras.initPath ?? '/';
    if (vncJump) vncJump.value = extras.jumpHost ?? '';
    if (mgmtJump) mgmtJump.value = extras.jumpHost ?? '';
    const wolMacIn = document.getElementById('p-wol-mac') as HTMLInputElement | null;
    const knockSeqIn = document.getElementById('p-knock-seq') as HTMLInputElement | null;
    if (wolMacIn) wolMacIn.value = extras.wolMac ?? '';
    if (knockSeqIn) knockSeqIn.value = extras.knockSeq ?? '';
  }

  async function refreshDialogJumpHosts(desiredJump = '', desiredKey = ''): Promise<void> {
    try {
      const ws = (window as any).workspace;
      if (!ws || typeof ws.run !== 'function') return;

      // Also sync any Secure Gateway objects present in open Documents into the Jump Host registry
      for (const m of models.values()) {
        for (const node of m.objects.values()) {
          if (node.type === 'connection') {
            const parsed = parsePluginTag(notesOf(node.props));
            if (['Secure Gateway', 'Royal Server', 'Remote Desktop Gateway'].includes(parsed.pluginType)) {
              const h = typeof node.props.host === 'string' ? node.props.host.trim() : '';
              const p = typeof node.props.port === 'number' ? node.props.port : 22;
              const u = typeof node.props.username === 'string' ? node.props.username.trim() : 'root';
              if (node.name.trim() && h) {
                await ws.run('gateway.add', {
                  alias: node.name.trim(),
                  hostName: h,
                  port: p,
                  user: u || 'root',
                  identityFile: parsed.extras.sshKey ?? '',
                  proxyJump: parsed.extras.jumpHost ?? '',
                });
              }
            }
          }
        }
      }

      const res = (await ws.run('ssh.env', {})) as {
        ok: boolean;
        value?: {
          jumpHosts: { alias: string; hostName: string; port: number; user: string }[];
          keys: string[];
        };
      };
      if (!res.ok || !res.value) return;

      const jumps = res.value.jumpHosts ?? [];
      const keys = res.value.keys ?? [];

      const jumpSelects: { id: string; directLabel: string; includeUser: boolean; allowDirectOverride?: boolean }[] = [
        { id: 'p-rdp-jump', directLabel: 'Inherit from Folder / Document (or Direct)', includeUser: false, allowDirectOverride: true },
        { id: 'p-ssh-jump', directLabel: 'Inherit from Folder / Document (or Direct)', includeUser: true, allowDirectOverride: true },
        { id: 'p-vnc-jump', directLabel: 'Inherit from Folder / Document (or Direct)', includeUser: false, allowDirectOverride: true },
        { id: 'p-mgmt-jump', directLabel: 'Inherit from Folder / Document (or Direct)', includeUser: false, allowDirectOverride: true },
        { id: 'p-folder-jump', directLabel: 'Inherit from Parent / Document', includeUser: false, allowDirectOverride: true },
        { id: 'doc-prop-jump', directLabel: 'Direct Connection (No Document Jump Host)', includeUser: false, allowDirectOverride: false },
      ];

      for (const spec of jumpSelects) {
        const sel = document.getElementById(spec.id) as HTMLSelectElement | null;
        if (!sel) continue;
        const currentVal = desiredJump || sel.value;
        sel.replaceChildren();
        const directOpt = document.createElement('option');
        directOpt.value = '';
        directOpt.textContent = spec.directLabel;
        sel.append(directOpt);
        if (spec.allowDirectOverride) {
          const forceDirectOpt = document.createElement('option');
          forceDirectOpt.value = '__direct__';
          forceDirectOpt.textContent = 'Direct LAN / VPN (No Jump Host)';
          sel.append(forceDirectOpt);
        }
        for (const j of jumps) {
          const opt = document.createElement('option');
          opt.value = j.alias;
          opt.textContent = spec.includeUser
            ? `${j.alias} (${j.user}@${j.hostName}:${j.port})`
            : `${j.alias} (${j.hostName}:${j.port})`;
          sel.append(opt);
        }
        sel.value = currentVal;
      }

      const topJumpSel = document.getElementById('jump-host-select') as HTMLSelectElement | null;
      if (topJumpSel) {
        const curTop = topJumpSel.value;
        const existingVals = new Set(Array.from(topJumpSel.options).map((o) => o.value));
        const customOpt = Array.from(topJumpSel.options).find((o) => o.value === '__custom__');
        for (const j of jumps) {
          if (!existingVals.has(j.alias)) {
            const opt = document.createElement('option');
            opt.value = j.alias;
            opt.textContent = `Jump: ${j.alias} (${j.user}@${j.hostName}:${j.port})`;
            if (customOpt) topJumpSel.insertBefore(opt, customOpt);
            else topJumpSel.append(opt);
          }
        }
        topJumpSel.value = curTop;
      }

      for (const keySelId of ['p-ssh-key', 'p-folder-ssh-key', 'doc-prop-ssh-key']) {
        const keySel = document.getElementById(keySelId) as HTMLSelectElement | null;
        if (keySel && keys.length > 0) {
          const curKey = desiredKey || keySel.value;
          const existingKeys = new Set(Array.from(keySel.options).map((o) => o.value));
          for (const k of keys) {
            if (!existingKeys.has(k)) {
              const opt = document.createElement('option');
              opt.value = k;
              opt.textContent = k;
              keySel.append(opt);
            }
          }
          keySel.value = curKey;
        }
      }
    } catch {
      // Ignore in headless unit tests where window.workspace is not mounted
    }
  }

  function readProtocolFormFields(pluginType: string): ProtocolExtras {
    const isRdp = ['Remote Desktop', 'Terminal Services', 'Remote Desktop Gateway', 'Key Sequence Task'].includes(pluginType);
    const isSshOrSftp = ['Terminal', 'File Transfer', 'Secure Gateway', 'Royal Server', 'Command Task'].includes(pluginType);
    const isWeb = ['Web Page', 'Information', 'To-Do'].includes(pluginType);
    const isVnc = ['VNC', 'TeamViewer'].includes(pluginType);
    const wolMac = (document.getElementById('p-wol-mac') as HTMLInputElement | null)?.value.trim() ?? '';
    const knockSeq = (document.getElementById('p-knock-seq') as HTMLInputElement | null)?.value.trim() ?? '';
    const preConnect: ProtocolExtras = {
      ...(wolMac ? { wolMac } : {}),
      ...(knockSeq ? { knockSeq } : {}),
    };

    if (isSshOrSftp) {
      return {
        ...preConnect,
        authMode: (document.getElementById('p-ssh-auth') as HTMLSelectElement | null)?.value ?? 'auto',
        sshKey: (document.getElementById('p-ssh-key') as HTMLSelectElement | null)?.value ?? '',
        jumpHost: (document.getElementById('p-ssh-jump') as HTMLSelectElement | null)?.value ?? '',
        initPath: (document.getElementById('p-ssh-path') as HTMLInputElement | null)?.value.trim() ?? '',
      };
    }
    if (isRdp) {
      return {
        ...preConnect,
        jumpHost: (document.getElementById('p-rdp-jump') as HTMLSelectElement | null)?.value ?? '',
      };
    }
    if (isWeb) {
      return {
        ...preConnect,
        initPath: (document.getElementById('p-web-path') as HTMLInputElement | null)?.value.trim() ?? '/',
      };
    }
    if (isVnc) {
      return {
        ...preConnect,
        jumpHost: (document.getElementById('p-vnc-jump') as HTMLSelectElement | null)?.value ?? '',
      };
    }
    return {
      ...preConnect,
      jumpHost: (document.getElementById('p-mgmt-jump') as HTMLSelectElement | null)?.value ?? '',
    };
  }

  function readFolderFormFields(): ProtocolExtras {
    return {
      jumpHost: (document.getElementById('p-folder-jump') as HTMLSelectElement | null)?.value ?? '',
      defaultUser: (document.getElementById('p-folder-user') as HTMLInputElement | null)?.value.trim() ?? '',
      sshKey: (document.getElementById('p-folder-ssh-key') as HTMLSelectElement | null)?.value ?? '',
      folderMode: (document.getElementById('p-folder-mode') as HTMLSelectElement | null)?.value ?? 'standard',
    };
  }

  function ask(title: string, initial: Initial, submit?: Submit): Promise<Answer | undefined> {
    const dialog = el<HTMLDialogElement>('props');
    const form = el<HTMLFormElement>('props-form');
    const ok = el<HTMLButtonElement>('p-ok');
    const pluginSelect = document.getElementById('p-plugin-type') as HTMLSelectElement | null;
    el('props-title').textContent = title;
    el('props-error').textContent = '';
    input('p-name').value = initial.name;
    const shownName = input('p-name').value;
    el('p-rdp').hidden = !initial.rdp;
    const r = initial.rdp ?? DEFAULT_RDP;
    const activePlugin = initial.pluginType ?? 'Remote Desktop';
    syncProtocolFormFields(activePlugin, initial.extras);
    void refreshDialogJumpHosts(initial.extras?.jumpHost ?? '', initial.extras?.sshKey ?? '');
    if (pluginSelect) {
      pluginSelect.value = activePlugin;
      pluginSelect.onchange = () => {
        const def = PLUGIN_DEFAULTS[pluginSelect.value];
        if (def) {
          input('p-port').value = String(def.port);
          if (!input('p-host').value.trim()) input('p-host').value = def.host;
          if (!input('p-username').value.trim()) input('p-username').value = def.username;
          tick('p-icon', def.icon);
        }
        if (title.startsWith('New ')) {
          el('props-title').textContent = `New ${pluginSelect.value}`;
        }
        syncProtocolFormFields(pluginSelect.value, readProtocolFormFields(pluginSelect.value));
      };
    }
    input('p-host').value = r.host; input('p-port').value = String(r.port); input('p-username').value = r.username; input('p-pin').value = r.certificateSha256;
    input('p-clip-from').checked = r.clipboardFromRemote; input('p-clip-to').checked = r.clipboardToRemote;
    el('p-meta').hidden = !initial.meta;
    if (initial.meta) showMeta(initial.meta, initial.folder === true, initial.subfolders ?? 0, initial.extras, initial.isDocument === true);
    return new Promise((resolve) => {
      let busy = false;
      const finish = (value: Answer | undefined) => {
        form.onsubmit = null; dialog.oncancel = null; el('p-cancel').onclick = null;
        if (pluginSelect) pluginSelect.onchange = null;
        if (dialog.open) dialog.close();
        resolve(value);
      };
      const cancel = () => { if (!busy) finish(undefined); };
      form.onsubmit = async (event) => {
        event.preventDefault();
        if (busy) return;
        const name = input('p-name').value.trim();
        if (!name) { el('props-error').textContent = 'Name cannot be empty.'; return; }
        const chosenPlugin = pluginSelect && !el('p-rdp').hidden ? pluginSelect.value : initial.pluginType;
        const readRes = initial.meta ? readMeta(initial.folder === true) : undefined;
        let meta = readRes?.meta;
        const rawColor = readRes?.rawColor ?? '';
        const isExtendedColor = EXTENDED_COLORS.some((c) => c.id === rawColor);
        const extras: ProtocolExtras = initial.folder
          ? { ...readFolderFormFields(), ...(isExtendedColor ? { customColor: rawColor } : {}) }
          : chosenPlugin
            ? { ...readProtocolFormFields(chosenPlugin), ...(isExtendedColor ? { customColor: rawColor } : {}) }
            : isExtendedColor
              ? { customColor: rawColor }
              : {};
        if (meta && !initial.isDocument) {
          const tagType = initial.folder
            ? (initial.pluginType === 'Dynamic Folder' || extras.folderMode === 'dynamic' ? 'Dynamic Folder' : 'Folder')
            : (chosenPlugin || 'Remote Desktop');
          meta = { ...meta, notes: encodePluginNotes(tagType, meta.notes, extras) };
        }
        const problems = meta && initial.meta && !initial.isDocument ? checkMeta(initial.folder ? 'folder' : 'connection', changedMetaProps(initial.meta, meta)) : [];
        if (problems.length > 0) { el('props-error').textContent = problems.map((p) => p.message).join(' '); return; }
        const spread = !!meta && initial.folder === true && !initial.isDocument && !el('p-sort-sub-row').hidden && input('p-sort-sub').checked;
        let rdp: RdpSettings | undefined;
        if (initial.rdp) {
          rdp = { host: input('p-host').value.trim(), port: Number(input('p-port').value), username: input('p-username').value, certificateSha256: input('p-pin').value.trim(), clipboardFromRemote: input('p-clip-from').checked, clipboardToRemote: input('p-clip-to').checked };
          const settingProblems = checkSettings(rdp);
          if (settingProblems.length > 0) { el('props-error').textContent = settingProblems.map((p) => p.message).join(' '); return; }
        }
        if (rdp && chosenPlugin && ['Secure Gateway', 'Royal Server', 'Remote Desktop Gateway'].includes(chosenPlugin)) {
          try {
            const ws = (window as any).workspace;
            if (ws && typeof ws.run === 'function') {
              await ws.run('gateway.add', {
                alias: name,
                hostName: rdp.host,
                port: rdp.port,
                user: rdp.username,
                identityFile: extras.sshKey ?? '',
                proxyJump: extras.jumpHost ?? '',
              });
              await refreshDialogJumpHosts(extras.jumpHost ?? '', extras.sshKey ?? '');
            }
          } catch {}
        }
        const answer: Answer = { name, renamed: input('p-name').value !== shownName, ...(rdp ? { rdp } : {}), ...(meta ? { meta, spread } : {}), ...(chosenPlugin ? { pluginType: chosenPlugin } : {}), extras, rawColor };
        if (submit) {
          busy = true; ok.disabled = true;
          const why = await submit(answer).catch((error: unknown) => { console.warn('documents:', error); return 'An error occurred; please try again.'; });
          busy = false; ok.disabled = false;
          if (why !== undefined) {
            if (!dialog.open) { showError(why); finish(undefined); return; }
            el('props-error').textContent = why;
            return;
          }
        }
        finish(answer);
      };
      dialog.oncancel = (event) => { event.preventDefault(); cancel(); };
      el('p-cancel').onclick = cancel;
      dialog.showModal();
      input('p-name').select();
    });
  }

  function opened(snapshot: Shown, note?: string) {
    models.set(snapshot.id, know(snapshot));
    safety.known(snapshot.id);
    expanded.add(documentKey(snapshot.id));
    show(documentKey(snapshot.id));
    if (note) say(note);
  }
  async function createDocument() {
    const answer = await ask('New Document', { name: 'Connections', meta: NO_META, folder: true, isDocument: true });
    if (!answer) return;
    const reply = await window.documents.create(answer.name);
    if (!reply.ok) return fail(reply);
    const chosenColor = answer.rawColor || answer.meta?.color || '';
    const chosenIcon = answer.meta?.icon;
    const chosenJump = answer.extras?.jumpHost && answer.extras.jumpHost !== '__direct__' ? answer.extras.jumpHost : '';
    if (chosenColor || chosenIcon || chosenJump || answer.extras?.defaultUser || answer.extras?.sshKey) {
      setDocPref(
        reply.snapshot.id,
        reply.snapshot.name,
        {
          color: chosenColor || undefined,
          icon: chosenIcon,
          jumpHost: chosenJump || undefined,
          defaultUser: answer.extras?.defaultUser || undefined,
          sshKey: answer.extras?.sshKey || undefined,
        },
        (reply.snapshot as any).docId
      );
    }
    opened(reply.snapshot, reply.note);
  }
  async function openDocument() {
    const reply = await window.documents.open();
    if (!reply.ok) return fail(reply);
    if(reply.skipped){say(reply.note);return;}
    opened(reply.snapshot, reply.note);
  }
  async function saveDocument(key?: string) {
    const s = selection(key); if (!s) return;
    const reply = await window.documents.save(s.model.id);
    if (!reply.ok) return fail(reply, s.model.id);
    await take(reply.delta);
    if (!reply.saved) showError(`File changed elsewhere with ${reply.conflicts} conflicts; nothing written. Choose Conflicts… to resolve.`);
    else if(reply.note)say(reply.note);
    else say(`Saved${reply.delta.reset ? '; external changes merged' : ''}.${reply.delta.dirty ? ' Unsaved changes remain.' : ''}`);
    render();
  }
  async function closeDocument(key?: string) {
    const s = selection(key); if (!s) return;
    const reply = await window.documents.close(s.model.id);
    if (!reply.ok) return fail(reply, s.model.id);
    models.delete(s.model.id);
    favorites.delete(s.model.id);
    safety.forget(s.model.id);
    show(undefined);
  }
  async function addObject(type: 'folder' | 'connection', key?: string, pluginType = 'Remote Desktop') {
    let s = selection(key);
    if (!s && models.size > 0) {
      const firstId = models.keys().next().value!;
      s = selection(documentKey(firstId));
    }
    const def = PLUGIN_DEFAULTS[pluginType] ?? PLUGIN_DEFAULTS['Remote Desktop']!;
    const rdpInit: RdpSettings | undefined = type === 'connection'
      ? { ...DEFAULT_RDP, host: def.host, port: def.port, username: def.username }
      : undefined;
    const metaInit: Meta = type === 'connection'
      ? { notes: '', icon: def.icon, sort: [] }
      : pluginType === 'Dynamic Folder'
        ? { notes: 'script: ./discover-hosts.sh', icon: 'cloud', sort: [] }
        : NO_META;
    const title = type === 'folder' ? (pluginType === 'Dynamic Folder' ? 'New Dynamic Folder' : 'New Folder') : `New ${pluginType}`;
    const defaultName = type === 'folder' ? (pluginType === 'Dynamic Folder' ? 'Dynamic Folder' : 'New Folder') : pluginType;

    // If no document is open and the user creates a connection/task/gateway from the Royal TSX Add menu, open it directly as an interactive workspace tab!
    if (!s) {
      if (type === 'folder') {
        await createDocument();
        return;
      }
      const answer = await ask(title, { name: defaultName, rdp: rdpInit, meta: metaInit, folder: false, pluginType });
      if (!answer || !answer.rdp) return;
      const chosen = answer.pluginType ?? pluginType;
      const tabColor = answer.rawColor || answer.meta?.color;
      if (chosen === 'Remote Desktop') {
        const topJumpSel = document.getElementById('jump-host-select') as HTMLSelectElement | null;
        const jh = answer.extras?.jumpHost === '__direct__' ? '' : (answer.extras?.jumpHost ?? '');
        if (topJumpSel) topJumpSel.value = jh;
        try {
          await (window as any).workspace?.run('gateway.configure', { jumpHost: jh });
        } catch {}
        const why = await host.open(
          { host: answer.rdp.host, port: answer.rdp.port, username: answer.rdp.username, certificateSha256: answer.rdp.certificateSha256, clipboard: { toRemote: answer.rdp.clipboardToRemote, fromRemote: answer.rdp.clipboardFromRemote } },
          answer.name,
          tabColor
        );
        if (why) showError(why);
      } else if (host.openPlugin) {
        host.openPlugin({
          pluginType: chosen,
          name: answer.name,
          host: answer.rdp.host,
          port: answer.rdp.port,
          username: answer.rdp.username,
          notes: parsePluginTag(answer.meta?.notes ?? '').cleanNotes,
          color: tabColor,
          ...answer.extras,
          jumpHost: answer.extras?.jumpHost === '__direct__' ? '' : answer.extras?.jumpHost,
        });
      }
      return;
    }

    const activeSelection = s;
    const parentId = !activeSelection.node ? null : activeSelection.node.type === 'folder' ? activeSelection.node.id : activeSelection.node.parentId;
    let created: string | undefined;
    const answer = await ask(title, { name: defaultName, rdp: rdpInit, meta: metaInit, folder: type === 'folder', pluginType }, async (a) => {
      const reply = await window.documents.add({ id: activeSelection.model.id, parentId, type, name: a.name, props: { ...(a.rdp ? toProps(a.rdp) : {}), ...metaProps(a.meta ?? NO_META) } });
      if (!reply.ok) return refused(reply, activeSelection.model.id);
      await take(reply.delta);
      created = reply.objectId;
      return undefined;
    });
    if (!answer || created === undefined) return;
    clearFilter();
    reveal(activeSelection.model.id, created);
    show(objectKey(activeSelection.model.id, created));
  }
  async function editObject(key?: string) {
    const s = selection(key);
    if (!s) return;
    if (!s.node) {
      el<HTMLButtonElement>('doc-properties-open')?.click();
      return;
    }
    const node = s.node;
    const rdp = rdpOf(node);
    const before = { ...(rdp ? { rdp } : {}), meta: metaOf(node) };
    const parsed = parsePluginTag(before.meta.notes);
    const uiMeta: Meta = { ...before.meta, notes: parsed.cleanNotes };
    const answer = await ask('Properties', { name: node.name, rdp, meta: uiMeta, folder: node.type === 'folder', subfolders: node.type === 'folder' ? subfolderCount(s.model, node.id) : 0, pluginType: parsed.pluginType, extras: parsed.extras }, async (a) => {
      const patch = patchFor(node, before, { ...(a.rdp ? { rdp: a.rdp } : {}), meta: a.meta ?? before.meta }, { spread: a.spread === true });
      if (!a.renamed && !patch) return undefined;
      const reply = await window.documents.update({ id: s.model.id, objectId: node.id, ...(a.renamed ? { name: a.name } : {}), ...(patch ? { patch } : {}), ...(a.spread ? { spreadSort: true } : {}) });
      if (!reply.ok) return refused(reply, s.model.id);
      await take(reply.delta);
      return undefined;
    });
    if (answer) show(selected);
  }
  async function removeObject(key?: string) {
    const s = selection(key); if (!s?.node) return;
    const parent = s.node.parentId ? objectKey(s.model.id, s.node.parentId) : documentKey(s.model.id);
    const reply = await window.documents.remove({ id: s.model.id, objectId: s.node.id });
    if (!reply.ok) return fail(reply, s.model.id);
    await take(reply.delta);
    show(parent);
  }
  async function duplicateObject(key?: string) {
    const s = selection(key); if (!s?.node) return;
    const reply = await window.documents.duplicate({ id: s.model.id, objectId: s.node.id });
    if (!reply.ok) return fail(reply, s.model.id);
    await take(reply.delta);
    clearFilter();
    reveal(s.model.id, reply.objectId);
    show(objectKey(s.model.id, reply.objectId));
  }
  /** Makes the selected object a favourite of this computer, or not one any more. */
  async function toggleFavorite(key?: string) {
    const s = selection(key); if (!s?.node) return;
    const mine = favorites.get(s.model.id);
    if (!mine) { showError(NO_FAVORITES); return; }
    const reply = await window.documents.favorite({ id: s.model.id, objectId: s.node.id, on: !mine.has(s.node.id) });
    if (!reply.ok) return fail(reply, s.model.id);
    favorites.set(s.model.id, new Set(reply.favorites));
    render();
  }
  /** Moves an object into a folder (or the top level) at a position among that folder's children, counted without the object itself. */
  async function moveObject(sessionId: string, objectId: string, parentId: string | null, index: number) {
    const reply = await window.documents.move({ id: sessionId, objectId, parentId, index });
    if (!reply.ok) return fail(reply, sessionId);
    await take(reply.delta);
    if (parentId) expanded.add(objectKey(sessionId, parentId));
    show(objectKey(sessionId, objectId));
  }
  async function moveByKey(direction: Direction, key?: string) {
    const s = selection(key); if (!s?.node) return;
    if (narrows(filter)) { showError('Clear the search filter first to move objects.'); return; }
    if ((direction === 'up' || direction === 'down') && isSorted(s.model, s.node.parentId)) { showError('This folder is sorted automatically. Change or disable sorting in Folder Properties.'); return; }
    const to = moveTarget(s.model, s.node.id, direction);
    if (to) await moveObject(s.model.id, s.node.id, to.parentId, to.index);
  }

  function resolveEffectiveInheritance(model: DocModel, node: { id: string; parentId: string | null; props: Record<string, unknown> }): {
    jumpHost: string;
    sshKey: string;
    defaultUser: string;
  } {
    const ownParsed = parsePluginTag(notesOf(node.props as any));
    let jumpHost: string | undefined = ownParsed.extras.jumpHost || undefined;
    let sshKey: string | undefined = ownParsed.extras.sshKey || undefined;
    let defaultUser: string | undefined = ownParsed.extras.defaultUser || undefined;

    let curParentId = node.parentId;
    let hops = 0;
    while (curParentId && hops <= model.objects.size) {
      hops++;
      const parent = model.objects.get(curParentId);
      if (!parent) break;
      const pParsed = parsePluginTag(notesOf(parent.props));
      if (jumpHost === undefined && pParsed.extras.jumpHost) {
        jumpHost = pParsed.extras.jumpHost;
      }
      if (sshKey === undefined && pParsed.extras.sshKey) {
        sshKey = pParsed.extras.sshKey;
      }
      if (defaultUser === undefined && pParsed.extras.defaultUser) {
        defaultUser = pParsed.extras.defaultUser;
      }
      curParentId = parent.parentId;
    }

    const docPref = getDocPref(model.id, model.name, model.docId);
    if (jumpHost === undefined && docPref.jumpHost) {
      jumpHost = docPref.jumpHost;
    }
    if (sshKey === undefined && docPref.sshKey) {
      sshKey = docPref.sshKey;
    }
    if (defaultUser === undefined && docPref.defaultUser) {
      defaultUser = docPref.defaultUser;
    }

    return {
      jumpHost: jumpHost === '__direct__' ? '' : (jumpHost ?? ''),
      sshKey: sshKey ?? '',
      defaultUser: defaultUser ?? '',
    };
  }

  async function connectSingleNode(model: DocModel, node: { id: string; name: string; type: string; parentId: string | null; props: Record<string, any> }): Promise<void> {
    const parsed = parsePluginTag(notesOf(node.props));
    const eff = resolveEffectiveInheritance(model, node);
    const effectiveColor = parsed.extras.customColor || colorOf(node.props);
    const rawUser = typeof node.props.username === 'string' ? node.props.username.trim() : '';
    const effectiveUser = eff.defaultUser && (!rawUser || rawUser === 'bright' || rawUser === 'admin' || rawUser === 'root')
      ? eff.defaultUser
      : (rawUser || eff.defaultUser || 'admin');

    const topJumpSel = document.getElementById('jump-host-select') as HTMLSelectElement | null;
    if (topJumpSel) topJumpSel.value = eff.jumpHost;
    try {
      await (window as any).workspace?.run('gateway.configure', { jumpHost: eff.jumpHost });
      if (parsed.extras.wolMac) {
        say(`Sending Pre-Connect Wake-on-LAN Magic Packet (${parsed.extras.wolMac})…`);
        await (window as any).workspace?.run('net.wol', {
          mac: parsed.extras.wolMac,
          broadcastHost: '255.255.255.255',
          port: 9,
          jumpHost: eff.jumpHost,
          identityFile: eff.sshKey || parsed.extras.sshKey || '',
        });
      }
      if (parsed.extras.knockSeq) {
        const targetHost = typeof node.props.host === 'string' ? node.props.host : '127.0.0.1';
        say(`Executing Pre-Connect Port Knock (${parsed.extras.knockSeq}) on ${targetHost}…`);
        await (window as any).workspace?.run('net.knock', {
          host: targetHost,
          sequence: parsed.extras.knockSeq,
          delayMs: 100,
          jumpHost: eff.jumpHost,
        });
      }
    } catch {}

    if (parsed.pluginType !== 'Remote Desktop' && host.openPlugin) {
      host.openPlugin({
        pluginType: parsed.pluginType,
        name: node.name,
        host: typeof node.props.host === 'string' ? node.props.host : '127.0.0.1',
        port: typeof node.props.port === 'number' ? node.props.port : 22,
        username: effectiveUser,
        notes: parsed.cleanNotes,
        color: effectiveColor,
        ...parsed.extras,
        jumpHost: eff.jumpHost,
        sshKey: eff.sshKey || parsed.extras.sshKey,
      });
      return;
    }
    if (!host.openStored) { showError('Stored connections are unavailable.'); return; }
    const why = await host.openStored({ documentHandle: model.id, objectId: node.id, expectedSeq: model.seq });
    if (why) showError(why);
  }

  async function connect(key?: string) {
    const sel = selection(key), node = sel?.node;
    if (!sel || !node) return;
    if (node.type === 'folder') {
      const parsed = parsePluginTag(notesOf(node.props));
      if (parsed.pluginType === 'Dynamic Folder' && host.openPlugin) {
        const eff = resolveEffectiveInheritance(sel.model, node);
        host.openPlugin({
          pluginType: 'Dynamic Folder',
          name: node.name,
          host: '127.0.0.1',
          port: 22,
          username: eff.defaultUser || 'root',
          notes: parsed.cleanNotes,
          color: parsed.extras.customColor || colorOf(node.props),
          jumpHost: eff.jumpHost,
          sshKey: eff.sshKey,
        });
        return;
      }
      // Royal TSX "Connect All in Folder": collect all child connections in folder subtree
      const childConnections: typeof node[] = [];
      const collect = (folderId: string) => {
        const ids = sel.model.children.get(folderId);
        if (!ids) return;
        for (const cid of ids) {
          const child = sel.model.objects.get(cid);
          if (!child) continue;
          if (child.type === 'connection') childConnections.push(child);
          else if (child.type === 'folder') collect(child.id);
        }
      };
      collect(node.id);
      if (childConnections.length === 0) {
        say(`Folder “${node.name}” has no child connections yet.`);
        return;
      }
      say(`Connecting ${childConnections.length} session(s) in “${node.name}”…`);
      for (const conn of childConnections) {
        await connectSingleNode(sel.model, conn);
      }
      return;
    }
    // Delegate stored connection resolution to host.openStored / plugin launcher
    await connectSingleNode(sel.model, node);
  }
  function activate(key?: string) {
    if (key) select(key);
    const s = current(); if (!s) return;
    if (s.node?.type === 'connection') { forSelected(connect)(); return; }
    const at = selected!;
    toggle(at, !expanded.has(at));
    view.focus();
  }

  const box = input('tree-search');
  const searchBox = () => { box.focus(); box.select(); };
  /** From the search box to the tree: the first row below the document is selected when the selection is on a document row. */
  function toTree() {
    if (!parseKey(selected ?? '')?.objectId) {
      const first = rows.find((r) => r.type !== 'document');
      if (first) { select(first.key); view.reveal(first.key); }
    }
    view.focus();
  }
  const withCommand = (event: KeyboardEvent, letter: string) => (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === letter;

  function onKey(event: KeyboardEvent) {
    if (event.altKey && !event.ctrlKey && !event.metaKey && altMoves[event.key]) {
      event.preventDefault();
      if (!event.repeat) queuedForSelected((key) => moveByKey(altMoves[event.key]!, key))();
    } else if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      if (!event.repeat) queuedForSelected(duplicateObject)();
    } else if (withCommand(event, 'b')) {
      event.preventDefault();
      if (!event.repeat) queuedForSelected(toggleFavorite)();
    } else if (withCommand(event, 'f')) {
      event.preventDefault();
      searchBox();
    } else if (navKeys.includes(event.key)) {
      event.preventDefault();
      const move = navigate(rows, selected, event.key as NavKey);
      if (move.toggle && narrows(filter)) {
        const above = move.toggle.expanded ? undefined : rows.find((r) => r.key === move.toggle!.key)?.parentKey;
        if (above) { select(above); view.reveal(above); }
      } else if (move.toggle) toggle(move.toggle.key, move.toggle.expanded);
      else if (move.focus) { select(move.focus); view.reveal(move.focus); }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (!event.repeat) activate();
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      if (!event.repeat) queuedForSelected(removeObject)();
    }
  }

  const dropTo = (dragKey: string, targetKey: string, zone: DropZone) => resolveDrop(models, dragKey, targetKey, zone);
  const view = createTreeView(el('tree'), {
    select,
    toggle,
    activate,
    key: onKey,
    canDrop: (dragKey, targetKey, zone) => !narrows(filter) && !('refused' in dropTo(dragKey, targetKey, zone)),
    drop: (dragKey, targetKey, zone) => queued(async () => {
      const to = dropTo(dragKey, targetKey, zone);
      if (!('refused' in to)) await moveObject(to.sessionId, to.objectId, to.parentId, to.index);
    })(),
    openForDrop: (key) => { expanded.add(key); render(); },
  });
  const safety = initSafety({ selected: () => current()?.model, take, resync, render, reveal, show: (key) => show(key), clearFilter, stale: () => BEHIND, showError, say, fail, refused, report });
  el('doc-new').onclick = queued(createDocument);
  el('doc-open').onclick = act(openDocument);
  el('doc-save').onclick = forSelected(saveDocument);
  el('doc-close').onclick = queuedForSelected(closeDocument);
  el('obj-connect').onclick = forSelected(connect);
  el('obj-add-folder').onclick = queuedForSelected((key) => addObject('folder', key));
  el('obj-add-connection').onclick = queuedForSelected((key) => addObject('connection', key));
  el('obj-edit').onclick = queuedForSelected(editObject);
  el('obj-duplicate').onclick = queuedForSelected(duplicateObject);
  el('obj-favorite').onclick = queuedForSelected(toggleFavorite);
  el('obj-remove').onclick = queuedForSelected(removeObject);
  const reshown = () => { render(); if (selected) view.reveal(selected); view.focus(); };
  el('tree-expand').onclick = () => { for (const key of allExpanded([...models.values()])) expanded.add(key); reshown(); };
  el('tree-collapse').onclick = () => { expanded.clear(); for (const key of onlyDocuments([...models.values()])) expanded.add(key); reshown(); };

  box.oninput = () => { filter = { ...filter, query: box.value }; render(); };
  input('tree-search-notes').onchange = () => { filter = { ...filter, notes: input('tree-search-notes').checked }; render(); };
  input('tree-favorites').onchange = () => { filter = { ...filter, onlyFavorites: input('tree-favorites').checked }; render(); };
  box.onkeydown = (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (box.value !== '') { box.value = ''; filter = { ...filter, query: '' }; render(); } else view.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'Enter') {
      event.preventDefault();
      toTree();
    } else if (withCommand(event, 'f')) {
      event.preventDefault();
      box.select();
    }
  };
  buildPicks();
  el('p-notes').oninput = countNotes;
  el('p-sort-by-1').onchange = syncSort;
  el('p-sort-by-2').onchange = syncSort;

  const populateDocPropertiesDialog = async () => {
    const s = current();
    if (!s) return;
    const pref = getDocPref(s.model.id, s.model.name, s.model.docId);
    await refreshDialogJumpHosts(pref.jumpHost ?? '', pref.sshKey ?? '');
    tick('doc-prop-color', pref.color ?? '');
    tick('doc-prop-icon', pref.icon ?? '');
    const jumpSel = document.getElementById('doc-prop-jump') as HTMLSelectElement | null;
    const userIn = document.getElementById('doc-prop-default-user') as HTMLInputElement | null;
    const keySel = document.getElementById('doc-prop-ssh-key') as HTMLSelectElement | null;
    if (jumpSel) jumpSel.value = pref.jumpHost ?? '';
    if (userIn) userIn.value = pref.defaultUser ?? '';
    if (keySel) keySel.value = pref.sshKey ?? '';
  };

  const applyDocAppearanceFromDialog = () => {
    const s = current();
    if (!s) return;
    const chosenColor = picked('doc-prop-color');
    const chosenIcon = ICONS.find((i) => i.id === picked('doc-prop-icon'))?.id;
    const jumpSel = document.getElementById('doc-prop-jump') as HTMLSelectElement | null;
    const userIn = document.getElementById('doc-prop-default-user') as HTMLInputElement | null;
    const keySel = document.getElementById('doc-prop-ssh-key') as HTMLSelectElement | null;
    const newNameIn = document.getElementById('doc-properties-name') as HTMLInputElement | null;
    const effectiveDocName = newNameIn?.value.trim() || s.model.name;
    setDocPref(
      s.model.id,
      effectiveDocName,
      {
        color: chosenColor || undefined,
        icon: chosenIcon,
        jumpHost: jumpSel?.value || undefined,
        defaultUser: userIn?.value.trim() || undefined,
        sshKey: keySel?.value || undefined,
      },
      s.model.docId
    );
    render();
    const loadingEl = document.getElementById('doc-properties-loading');
    if (loadingEl) loadingEl.textContent = 'Document Icon, Color & Inherited Jump Host applied.';
    say(`Updated appearance & Jump Host inheritance for “${effectiveDocName}”.`);
  };

  document.getElementById('doc-properties-open')?.addEventListener('click', () => {
    void populateDocPropertiesDialog();
  });
  document.getElementById('doc-properties-reload')?.addEventListener('click', () => {
    void populateDocPropertiesDialog();
  });
  document.getElementById('doc-prop-apply-appearance')?.addEventListener('click', () => {
    applyDocAppearanceFromDialog();
  });
  document.getElementById('doc-properties-save')?.addEventListener('click', () => {
    applyDocAppearanceFromDialog();
  });

  window.documents.onRefresh(() => { for (const id of [...models.keys()]) void resync(id).catch(behind); });
  void window.documents.views().then((reply) => {
    if (!reply.ok) { showError(reply.message); return; }
    for (const snapshot of reply.snapshots) { models.set(snapshot.id, know(snapshot)); expanded.add(documentKey(snapshot.id)); safety.known(snapshot.id); }
    render();
    if (reply.notice) showError(reply.notice);
  }).catch(() => showError('Document list could not be loaded.'));
  render();
  return {
    selected:()=>{const s=current();return s?{id:s.model.id,expectedSeq:s.model.seq,...(s.node?{objectId:s.node.id,type:s.node.type,parentId:s.node.parentId}:{})}:undefined;},
    refresh:async()=>{const reply=await window.documents.views();if(!reply.ok)throw Error(reply.message);const ids=new Set(reply.snapshots.map(s=>s.id));for(const id of models.keys())if(!ids.has(id))models.delete(id);for(const snapshot of reply.snapshots){models.set(snapshot.id,know(snapshot));expanded.add(documentKey(snapshot.id));}render();},
    revealSource:source=>{const m=[...models.values()].find(m=>m.docId===source.documentId);if(m){if(source.objectId){reveal(m.id,source.objectId);show(objectKey(m.id,source.objectId));}else show(documentKey(m.id));}},
    addPlugin: (pluginType: string) => {
      if (pluginType === 'Credential') {
        el('credentials-open').click();
        return;
      }
      if (pluginType === 'Folder' || pluginType === 'Dynamic Folder') {
        queuedForSelected((key) => addObject('folder', key, pluginType))();
        return;
      }
      queuedForSelected((key) => addObject('connection', key, pluginType))();
    },
    listAllConnections: () => {
      const items: ListedConnectionItem[] = [];
      for (const m of models.values()) {
        for (const obj of m.objects.values()) {
          if (obj.type !== 'connection') continue;
          const parsed = parsePluginTag(notesOf(obj.props));
          const eff = resolveEffectiveInheritance(m, obj);
          const hostStr = typeof obj.props.host === 'string' ? obj.props.host : '127.0.0.1';
          const portNum = typeof obj.props.port === 'number' ? obj.props.port : 3389;
          const rawUser = typeof obj.props.username === 'string' ? obj.props.username.trim() : '';
          const effectiveUser =
            eff.defaultUser && (!rawUser || rawUser === 'bright' || rawUser === 'admin' || rawUser === 'root')
              ? eff.defaultUser
              : rawUser || eff.defaultUser || 'root';
          const parentFolder = obj.parentId ? m.objects.get(obj.parentId) : undefined;
          items.push({
            key: objectKey(m.id, obj.id),
            docName: m.name,
            folderName: parentFolder?.name ?? '',
            name: obj.name,
            protocol: parsed.pluginType === 'Remote Desktop' ? 'RDP' : parsed.pluginType,
            pluginType: parsed.pluginType,
            host: hostStr,
            port: portNum,
            username: effectiveUser,
            hostPort: `${hostStr}:${portNum}`,
            gateway: eff.jumpHost || 'Direct LAN',
            jumpHost: eff.jumpHost,
            sshKey: eff.sshKey || parsed.extras.sshKey || '',
          });
        }
      }
      return items;
    },
    connectByKey: (key: string) => {
      const p = parseKey(key);
      if (p?.objectId) reveal(p.sessionId, p.objectId);
      select(key);
      act(() => connect(key))();
    },
    importDiscoveredHost: async (spec) => {
      let targetModel: DocModel | undefined = current()?.model ?? [...models.values()][0];
      if (!targetModel) {
        const createdDoc = await window.documents.create('Discovered Infrastructure');
        if (!createdDoc.ok) return false;
        opened(createdDoc.snapshot);
        targetModel = models.get(createdDoc.snapshot.id);
      }
      if (!targetModel) return false;
      const curSel = current();
      const parentId =
        curSel && curSel.model.id === targetModel.id && curSel.node
          ? curSel.node.type === 'folder'
            ? curSel.node.id
            : curSel.node.parentId
          : null;
      const def = PLUGIN_DEFAULTS[spec.pluginType] ?? PLUGIN_DEFAULTS['Remote Desktop']!;
      const notes = encodePluginNotes(spec.pluginType, 'Imported via Subnet & Port Scanner', {
        ...(spec.jumpHost ? { jumpHost: spec.jumpHost } : {}),
      });
      const r = await window.documents.add({
        id: targetModel.id,
        parentId,
        type: 'connection',
        name: spec.name,
        props: {
          host: spec.host,
          port: spec.port || def.port,
          username: spec.username || def.username,
          icon: def.icon,
          color: spec.pluginType === 'Remote Desktop' ? 'blue' : spec.pluginType === 'Terminal' ? 'purple' : 'teal',
          notes,
        },
      });
      if (!r.ok) return false;
      await take(r.delta);
      render();
      say(`Imported “${spec.name}” (${spec.host}:${spec.port}) into ${targetModel.name}.`);
      return true;
    },
    exportDocPrefs: () => readAllDocPrefs(),
    importDocPrefs: (prefs) => {
      try {
        const merged = { ...readAllDocPrefs(), ...prefs };
        window.localStorage?.setItem(DOC_PREFS_STORAGE_KEY, JSON.stringify(merged));
        render();
      } catch {}
    },
    openRecent: async (index) => {
      showError('');
      try {
        const reply = await window.documents.openRecent(index);
        if (!reply.ok) return fail(reply);
        if(reply.skipped){say(reply.note);return;}
        opened(reply.snapshot, reply.note);
      } catch (error) { report(error); }
    },
    forgetKey: async () => {
      showError('');
      const s = current();
      if (!s) return;
      try {
        const reply = await window.documents.forgetKey(s.model.id);
        if (!reply.ok) return fail(reply, s.model.id);
        say(reply.forgot ? `Remembered key for “${s.model.name}” forgotten.` : `No remembered key for “${s.model.name}”.`);
      } catch (error) { report(error); }
    },
  };
}
