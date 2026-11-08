// IPC for documents. The renderer asks for things ("open a document", "add a folder here"); the main process shows the dialogs, asks for the
// password and does the work, and answers with plain data. The renderer never names a path and never sees a password, a key or a session.
// Every handler checks its sender first (the same check the RDP channels use) and then answers { ok: true, ... } or { ok: false, code, message };
// the only thing that ever rejects is a sender that is not the app window. What a change leaves behind is told as a `delta` (see library.ts): the objects
// that are new or different and the ids that are gone, with the document's `seq`, so a reply is as big as the edit and not as big as the document.
import { basename } from 'node:path';
import { DocumentLibrary, DuplicateDocumentError, LibraryError, checkName, type DocSummary, type Snapshot } from '../documents/library.js';
import type { KeyCache } from '../documents/keywrap.js';
import { checkMeta } from '../documents/meta.js';
import { writablePublicProperty } from '../documents/projection.js';
import { redactCredentialError } from '../credentials/model.js';
import type { Json, ObjectNode } from '../documents/model.js';
import { applyPatch, type Patch } from '../documents/ops.js';
import { MAX_RECENT } from './commands.js';
import { checkStored, managed } from './connection-settings.js';
import { PreferencesError, type AutosaveMode } from './preferences.js';
import type { RecentItem } from './recent.js';

/** `rememberable`: the prompt offers to keep the key of the document in the keystore of the system (only when keys are used at all). `remember`: the box was ticked in the answer that was wrong, and is ticked again on the prompt that follows it. */
export type PasswordRequest = { purpose: 'open' | 'create'; name: string; error?: string; rememberable?: true; remember?: true };
/** What a prompt for a password answers: the password, or the password together with the choice to remember the key (a prompt that does not offer the choice answers a string); nothing when it was cancelled. */
export type PasswordAnswer = string | { password: string; remember: boolean };
export type Dialogs = {
  chooseOpenPath(): Promise<string | undefined>;
  chooseSavePath(suggestedName: string): Promise<string | undefined>;
  askPassword(request: PasswordRequest): Promise<PasswordAnswer | undefined>;
  /** `why`: when the document is asked about because it could not be saved by itself, the fixed text of the reason. */
  confirmClose(name: string, why?: string): Promise<'save' | 'discard' | 'cancel'>;
  confirmRemove(name: string, count: number): Promise<boolean>;
  /** A native confirmation: only an explicit Save may upgrade a legacy document. */
  confirmUpgrade?(name: string): Promise<boolean>;
  /** A different file has the identity of an open document. Only an explicit copy creates another identity. */
  confirmDuplicate?(name: string): Promise<'skip' | 'cancel' | 'copy'>;
};
/**
 * A question that the main process shows in a dialog, as plain data (so that what it says, and what a key chooses, can be tested without a window): `defaultId` is the button that
 * Enter chooses and `cancelId` the one that Escape chooses. A question that throws work away has the answer that throws nothing away for both.
 */
export type Question = { type: 'question' | 'warning'; message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number };
/** A notice: a dialog with nothing to choose. */
export type Notice = { type: 'error'; message: string; detail: string };
export const upgradeQuestion = (name: string): Question => ({
  type: 'warning', message: `Simpan “${name}” sebagai format 2?`,
  detail: 'Versi lama aplikasi tidak dapat membuka format 2. Revisi lama tetap dipertahankan. Pilih Batal untuk mempertahankan berkas yang ada.',
  buttons: ['Batal', 'Simpan sebagai format 2'], defaultId: 0, cancelId: 0,
});
export const duplicateQuestion = (name: string): Question => ({
  type: 'question', message: `ID dokumen “${name}” sudah terbuka dari berkas lain.`,
  detail: 'Lewati untuk mempertahankan dokumen terbuka. Buka sebagai salinan membuat berkas terpisah dengan ID baru dan password baru; sumber tidak diubah.',
  buttons: ['Lewati', 'Batal', 'Buka sebagai salinan'], defaultId: 0, cancelId: 1,
});
/** What the favourites need of the preferences (Preferences satisfies it): the favourites of a document by its id, and a choice. */
export type FavoritesStore = {
  favoritesOf(docId: string): string[];
  setFavorite(docId: string, objectId: string, on: boolean): Promise<string[]>;
};
/** Why the favourites are not what the person left: the file that could not be understood was set aside (`reset`), or could not be opened at all (`unavailable`, `too-new`). Told once, with the list of open documents. */
export type PreferencesNotice = 'reset' | 'unavailable' | 'too-new';
/** What the documents need of the keys that the system remembers (Keystore satisfies it): whether they are used now, the cache, and forgetting the key of a file (it says whether there was one). */
export type KeysLike = { usable(): boolean; readonly cache: KeyCache; forget(path: string): Promise<boolean> };
/** What the documents need of the list of recent documents (Recent satisfies it): the list, putting a document on it and taking it off, and whether the person chose this document in the menu just now (the window opens a recent document only after a click of the person). */
export type RecentLike = { list(): RecentItem[]; add(path: string): Promise<boolean>; remove(path: string): Promise<boolean>; chosen(path: string): boolean };
export type IpcLike = { handle(channel: string, listener: (event: any, payload?: unknown) => unknown): void };
export type Reply = Record<string, unknown>;

const messages: Record<string, string> = {
  'wrong-password': 'Password salah, atau berkas telah diubah.',
  unreadable: 'Berkas ini bukan dokumen yang dapat dibaca.',
  'too-new': 'Berkas dibuat oleh versi aplikasi yang lebih baru.',
  'upgrade-required': 'Simpan secara manual untuk menyetujui format 2; berkas lama belum diubah.',
  'not-found': 'Berkas tidak ditemukan.',
  exists: 'Berkas sudah ada; dokumen baru tidak menimpa berkas yang ada.',
  busy: 'Berkas sedang dipakai atau terus berubah. Coba lagi.',
  rekeyed: 'Password dokumen diubah oleh penulis lain. Tutup dan buka ulang dokumen.',
  'reopen-required':'Status penulisan tidak pasti. Tutup dan buka ulang dokumen sebelum mengedit lagi.',
  'already-open': 'Dokumen ini sudah terbuka.',
  'duplicate-document': 'ID dokumen ini sudah terbuka dari berkas lain.',
  'unknown-document': 'Dokumen itu tidak terbuka.',
  'unknown-object': 'Objek itu tidak ada lagi.',
  unsaved: 'Dokumen memiliki perubahan yang belum tersimpan.',
  conflict: 'Berkas diubah di tempat lain dan ada konflik; tidak ada yang ditulis. Pilih Konflik… untuk menyelesaikannya.',
  'unknown-conflict': 'Konflik itu sudah tidak ada; daftar dimuat ulang.',
  'revision-key': 'Revisi ini disegel dengan kunci lain (password dokumen pernah diubah) dan tidak dapat dibuka dari sini.',
  'autosave-failed': 'Simpan otomatis gagal; perubahan belum tersimpan. Simpan secara manual.',
  'autosave-held': 'Simpan otomatis tertahan: berkas diubah di tempat lain. Pilih Konflik… untuk menyelesaikannya.',
  'too-many-autosave': 'Terlalu banyak dokumen yang menyimpan sendiri di komputer ini.',
  'autosave-unavailable': 'Simpan otomatis tidak tersedia: berkas preferensi di komputer ini tidak dapat dibuka.',
  cycle: 'Folder tidak dapat dipindahkan ke dalam dirinya sendiri.',
  'too-deep': 'Folder bersarang terlalu dalam.',
  'too-many': 'Dokumen sudah mencapai jumlah objek maksimum.',
  invalid: 'Data tidak valid.',
  'too-large': 'Dokumen terlalu besar untuk disimpan.',
  io: 'Berkas tidak dapat dibaca atau ditulis.',
  cancelled: 'Dibatalkan.',
  'too-many-favorites': 'Terlalu banyak favorit di dokumen ini.',
  preferences: 'Preferensi tidak dapat disimpan.',
  'unknown-recent': 'Dokumen itu sudah tidak ada di daftar terbaru.',
  'key-not-kept': 'Dokumen terbuka, tetapi kuncinya tidak dapat diingat di komputer ini.',
  'key-not-forgotten': 'Kunci yang diingat tidak dapat dilupakan; kunci itu masih ada di komputer ini.',
  'preferences-reset': 'Berkas favorit tidak dapat dipahami dan disimpan di sampingnya dengan akhiran .bad-; favorit dimulai dari kosong, dan pilihan simpan otomatis ikut hilang.',
  'preferences-unavailable': 'Favorit tidak tersedia: berkas preferensi di komputer ini tidak dapat dibuka. Pilihan simpan otomatis juga tidak berlaku: dokumen tidak menyimpan sendiri.',
  'preferences-too-new': 'Favorit tidak tersedia: berkas preferensi dibuat oleh versi aplikasi yang lebih baru dan dibiarkan apa adanya. Pilihan simpan otomatis juga tidak berlaku.',
};
/** The fixed text for a failure code (an unknown one is said as an I/O failure). Also used by the dialogs the main process shows itself. */
export const messageFor = (code: string): string => messages[code] ?? messages.io;
export const cancelled = (): Reply => ({ ok: false, code: 'cancelled', message: messages.cancelled });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function bad(message: string): never { throw new LibraryError('invalid', message); }
export const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : bad('The request is not an object'));
export const idOf = (value: unknown): string => (typeof value === 'string' && UUID.test(value) ? value : bad('Not an id'));
export const textOf = (value: unknown): string => (typeof value === 'string' ? value : bad('Not text'));
const positionOf = (value: unknown): number => (Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000 ? (value as number) : bad('Not a position'));
const propsOf = (value: unknown): Record<string, Json> => {
  const props = record(value);
  if (Object.keys(props).some((key) => !writablePublicProperty(key))) bad('That property is private or unsupported');
  return props as Record<string, Json>; // values, depth and size are checked by the document model
};
const reportFailure = (report: ((error: unknown) => void) | undefined, error: unknown): void => { try { report?.(redactCredentialError(error)); } catch { /* A logger cannot break the safety reply. */ } };
const PROP_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/; // the property names the document model allows
const MAX_UNSET = 64;
/** A patch: what to set (properties) and what to remove (names), nothing else, and no name in both. */
function patchOf(value: unknown): Patch {
  const p = record(value);
  if (Object.keys(p).some((key) => key !== 'set' && key !== 'unset')) bad('Not a patch');
  const set = p.set === undefined ? undefined : propsOf(p.set);
  if (set && Object.keys(set).some((key) => !PROP_KEY.test(key))) bad('Not a property name');
  if (p.unset !== undefined && (!Array.isArray(p.unset) || p.unset.length > MAX_UNSET || p.unset.some((key) => typeof key !== 'string' || !PROP_KEY.test(key) || !writablePublicProperty(key)))) bad('Not a list of property names');
  const unset = p.unset as string[] | undefined;
  if (set && unset?.some((key) => Object.hasOwn(set, key))) bad('A property cannot be set and removed at once');
  return { ...(set ? { set } : {}), ...(unset ? { unset } : {}) };
}
const touchesSettings = (patch: Patch): boolean => [...Object.keys(patch.set ?? {}), ...(patch.unset ?? [])].some((key) => managed.includes(key));
/** What is written must be valid: the notes, colour, icon and sort among the properties written, and the settings of a connection when they are touched. */
function checkWritten(node: ObjectNode, next: Record<string, Json>, written: Record<string, Json>, settings: boolean): void {
  if (checkMeta(node.type, written).length > 0) bad('The notes, colour, icon or sort are not valid');
  if (settings && node.type === 'connection' && checkStored(next).length > 0) bad('The connection settings are not valid');
}
const withExtension = (path: string): string => (/\.rwdoc$/i.test(path) ? path : `${path}.rwdoc`);

/** The file name offered in the save dialog: what the renderer typed as a name, without separators or characters a file system refuses, without leading dots, bounded. */
export function suggestedFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim().slice(0, 100).trim();
  return `${cleaned || 'Dokumen'}.rwdoc`;
}

/**
 * A channel the way every channel of the documents is made: the sender is checked first, and the answer is { ok: true, ... } or { ok: false, code, message } with the fixed text of the code;
 * a failure that is not the person's (an I/O failure, a bug) is reported to the main process and not told in detail. A failure says which change the document is at (`seq`), so a window that
 * is behind (a merge changed the document before the failure) asks for it again instead of working from a stale picture. `tooMany` is the code for a preference that has no room.
 */
export function handlerFor(deps: { ipc: IpcLike; check: (event: any) => void; library: DocumentLibrary; report?: (error: unknown) => void }) {
  const { ipc, check, library, report } = deps;
  const current = (payload: unknown): { seq?: number } => {
    const id = typeof payload === 'object' && payload !== null ? (payload as { id?: unknown }).id : undefined;
    if (typeof id !== 'string' || !UUID.test(id)) return {};
    try { return { seq: library.view(id).seq }; } catch { return {}; } // not an open document: nothing to tell
  };
  return (channel: string, run: (payload: unknown) => Promise<Reply>, tooMany = 'too-many-favorites'): void => {
    ipc.handle(channel, async (event, payload) => {
      check(event);
      try {
        return await run(payload);
      } catch (error) {
        const incident = error instanceof PreferencesError ? error.code === 'io' : !(error instanceof LibraryError) || error.code === 'io';
        if (incident) reportFailure(report, error); // what went wrong stays in the main process
        const code = error instanceof LibraryError ? error.code : error instanceof PreferencesError ? ({ invalid: 'invalid', 'too-many': tooMany, 'too-new': 'preferences-too-new', io: 'preferences' } as const)[error.code] : 'io';
        return { ok: false, code, message: messageFor(code), ...current(payload) };
      }
    });
  };
}

export function registerDocumentIpc(deps: { ipc: IpcLike; check: (event: any) => void; library: DocumentLibrary; dialogs: Dialogs; report?: (error: unknown) => void; preferences?: FavoritesStore; notice?: PreferencesNotice; autosaveOf?: (docId: string) => AutosaveMode | undefined; keys?: KeysLike; recent?: RecentLike }): void {
  const { ipc, check, library, dialogs, report, preferences, notice, autosaveOf, keys, recent } = deps;
  const on = handlerFor({ ipc, check, library, ...(report ? { report } : {}) });
  // The window works on folders and connections only: an id of another kind is, for it, an object that does not exist.
  const shownNode = (id: string, objectId: string) => {
    const node = library.node(id, objectId);
    if (!node || (node.type !== 'folder' && node.type !== 'connection')) throw new LibraryError('unknown-object', 'That object does not exist');
    return node;
  };
  // The favourites the window is told of are those of the document that still exist as something it shows; without preferences it is told nothing of favourites at all.
  const present = (id: string, docId: string): string[] => (preferences ? preferences.favoritesOf(docId).filter((x) => { const n = library.node(id, x); return n !== undefined && (n.type === 'folder' || n.type === 'connection'); }) : []);
  const told = (snapshot: Snapshot): Snapshot | (Snapshot & { favorites: string[] }) => (preferences ? { ...snapshot, favorites: present(snapshot.id, snapshot.docId) } : snapshot);

  on('documents:views', async () => ({ ok: true, snapshots: library.snapshots().map(told), ...(notice ? { notice: messages[`preferences-${notice}`] } : {}) }));

  on('documents:snapshot', async (payload) => ({ ok: true, snapshot: told(library.snapshot(idOf(record(payload).id))) }));

  // The key of a document that the person asked to be remembered is given to the keystore after the document is open; a keystore that will not take it is no reason for the document not to be open, so the person is told in a note.
  // Whether keys are used is asked at the moment the key is kept, not when the prompt was shown: the person may have turned them off in the settings while the password was being typed.
  const keepKey = async (id: string): Promise<string | undefined> => {
    try { if (keys!.usable() && await library.rememberKey(id, keys!.cache)) return undefined; } catch (error) { reportFailure(report, error); }
    return messages['key-not-kept'];
  };
  const answered = (answer: PasswordAnswer | undefined): { password: string; remember: boolean } | undefined => (answer === undefined ? undefined : typeof answer === 'string' ? { password: answer, remember: false } : answer);
  const commitNote=(warnings:readonly string[]|undefined)=>warnings?.length?'Penulisan telah berhasil. Ada peringatan lock atau konfirmasi commit; pastikan semua penulis ditutup sebelum pemulihan lock offline.':undefined;
  const finished = async (opened: DocSummary, note: string | undefined): Promise<Reply> => {
    await recent?.add(opened.path);      // a list that cannot be kept is no reason for a document not to be open
    return { ok: true, snapshot: told(library.snapshot(opened.id)), ...((note||commitNote(opened.warnings))?{note:[note,commitNote(opened.warnings)].filter(Boolean).join(' ')}:{}) };
  };

  on('documents:create', async (payload) => {
    const name = checkName(textOf(record(payload).name)); // before any dialog: a request that cannot work shows nothing
    const chosen = await dialogs.chooseSavePath(suggestedFileName(name));
    if (!chosen) return cancelled();
    await library.assertNew(withExtension(chosen)); // a taken name is refused before a password is asked for
    const usable = keys?.usable() ?? false;
    const answer = answered(await dialogs.askPassword({ purpose: 'create', name, ...(usable ? { rememberable: true as const } : {}) }));
    if (answer === undefined) return cancelled();
    const created = await library.create(withExtension(chosen), name, answer.password);
    return finished(created, answer.remember && usable ? await keepKey(created.id) : undefined);
  });

  /** Opens a file that is chosen (by the dialog, or from the list of recent documents): with the key the system remembers if it has one that works, else with the password that is asked for until it is right. */
  async function openFile(chosen: string): Promise<Reply> {
    if (library.isOpen(chosen)) throw new LibraryError('already-open', 'That file is already open');
    const usable = keys?.usable() ?? false;
    if (usable) {
      try {
        const quick = await library.openRemembered(chosen, keys!.cache);
        if (quick) return finished(quick, undefined);
      } catch (failure) {
        if (failure instanceof DuplicateDocumentError) return duplicateFile(chosen, failure);
        throw failure;
      }
    }
    let error: string | undefined;
    let ticked = false;      // the box in the answer that was wrong: the person should not have to tick it again
    for (;;) {
      const answer = answered(await dialogs.askPassword({ purpose: 'open', name: basename(chosen), ...(usable ? { rememberable: true as const } : {}), ...(usable && ticked ? { remember: true as const } : {}), ...(error ? { error } : {}) }));
      if (answer === undefined) return cancelled();
      ticked = answer.remember;
      try {
        const opened = await library.open(chosen, answer.password);
        return await finished(opened, answer.remember && usable ? await keepKey(opened.id) : undefined);
      } catch (failure) {
        if (failure instanceof DuplicateDocumentError) return duplicateFile(chosen, failure, answer.password);
        if (!(failure instanceof LibraryError) || failure.code !== 'wrong-password') throw failure;
        error = messages['wrong-password']; // ask again, saying so
      }
    }
  }

  async function duplicateFile(chosen: string, failure: DuplicateDocumentError, oldPassword?: string): Promise<Reply> {
    const choice = await dialogs.confirmDuplicate?.(basename(chosen)) ?? 'skip';
    if (choice === 'skip') return { ok: true, skipped: true, note: 'Dokumen dengan ID sama dilewati.' };
    if (choice === 'cancel') return cancelled();
    const destination = await dialogs.chooseSavePath(suggestedFileName(`${basename(chosen).replace(/\.rwdoc$/i, '')} salinan`));
    if (!destination) return cancelled();
    const path = withExtension(destination);
    await library.assertNew(path);
    if (oldPassword === undefined) {
      const old = answered(await dialogs.askPassword({ purpose: 'open', name: basename(chosen) }));
      if (old === undefined) return cancelled();
      oldPassword = old.password;
    }
    const fresh = answered(await dialogs.askPassword({ purpose: 'create', name: basename(path) }));
    if (fresh === undefined) return cancelled();
    for (;;) {
      try {
        return await finished(await library.openAsCopy(chosen, oldPassword, path, fresh.password, failure.duplicateStamp), undefined);
      } catch (error) {
        if (!(error instanceof LibraryError) || error.code !== 'wrong-password') throw error;
        const old = answered(await dialogs.askPassword({ purpose: 'open', name: basename(chosen), error: messages['wrong-password'] }));
        if (old === undefined) return cancelled();
        oldPassword = old.password;
      }
    }
  }

  on('documents:open', async () => {
    const chosen = await dialogs.chooseOpenPath();
    if (!chosen) return cancelled();
    return openFile(chosen);
  });

  if (recent) {
    // by its place in the list: the window never names a path, and the list is the main process's own. A document with a key that is remembered opens without a question, so this is done only for a place the
    // person chose in the menu just now (the main process saw the click): a window that asks for one nobody chose gets nothing, and neither does one that asks for another than the one that was chosen.
    on('documents:open-recent', async (payload) => {
      const index = record(payload).index;
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= MAX_RECENT) bad('Not a place in the list');
      const item = recent.list()[index as number];
      if (!item) return { ok: false, code: 'unknown-recent', message: messages['unknown-recent'] };
      if (!recent.chosen(item.path)) bad('That document was not chosen');
      try { await library.assertExists(item.path); return await openFile(item.path); } catch (failure) {
        if (failure instanceof LibraryError && failure.code === 'not-found') await recent.remove(item.path);      // the file is gone: it is no use in the list
        throw failure;
      }
    });
  }

  if (keys) {
    on('documents:forget-key', async (payload) => {
      const path = library.view(idOf(record(payload).id)).path;
      try { return { ok: true, forgot: await keys.forget(path) }; } catch (error) {
        reportFailure(report, error);      // what went wrong stays in the main process; the words are about the key, not about the file of the document
        return { ok: false, code: 'key-not-forgotten', message: messages['key-not-forgotten'] };
      }
    });
  }

  on('documents:add', async (payload) => {
    const p = record(payload);
    const id = idOf(p.id);
    const parentId = p.parentId === null ? null : idOf(p.parentId);
    const type = p.type;
    if (type !== 'folder' && type !== 'connection') return bad('Only folders and connections can be added here');
    if(type==='connection'&&library.privateDocument(id).doc.kind==='vault')return bad('A private vault accepts folders and credentials');
    const props = propsOf(p.props);
    if (checkMeta(type, props).length > 0) bad('The notes, colour, icon or sort are not valid');
    if (type === 'connection' && checkStored(props).length > 0) bad('The connection settings are not valid');
    const added = library.add(id, { parentId, type, name: textOf(p.name), props });
    return { ok: true, objectId: added.objectId, delta: added.delta };
  });

  on('documents:update', async (payload) => {
    const p = record(payload);
    const id = idOf(p.id);
    const objectId = idOf(p.objectId);
    const patch = p.patch === undefined ? undefined : patchOf(p.patch);
    if (p.props !== undefined && patch !== undefined) bad('Properties are either replaced or patched, not both');
    if (p.name === undefined && p.props === undefined && patch === undefined) bad('Nothing to change');
    if (p.spreadSort !== undefined && typeof p.spreadSort !== 'boolean') bad('spreadSort is true or false');
    const change: { name?: string; props?: Record<string, Json>; patch?: Patch; spreadSort?: boolean } = {};
    if (p.name !== undefined) change.name = textOf(p.name);
    const node = shownNode(id, objectId);
    if (p.props !== undefined) {
      const publicProps = propsOf(p.props);
      change.patch = { set: publicProps, unset: Object.keys(node.props).filter((key) => writablePublicProperty(key) && !Object.hasOwn(publicProps, key)) };
      checkWritten(node, applyPatch(node.props, change.patch), publicProps, true);
    }
    if (patch) {
      change.patch = patch;
      checkWritten(node, applyPatch(node.props, patch), patch.set ?? {}, touchesSettings(patch));
    }
    if (p.spreadSort === true) {
      if (node.type !== 'folder') bad('Only a folder has a sort setting to spread');
      const left = change.props ?? (change.patch ? applyPatch(node.props, change.patch) : node.props);   // what the folder is left with is what the folders below get: it must be a setting that may be written, or none
      if (Object.hasOwn(left, 'sort') && checkMeta('folder', { sort: left.sort as Json }).length > 0) bad('The sort setting to spread is not valid');
      change.spreadSort = true;
    }
    return { ok: true, delta: library.update(id, objectId, change) };
  });

  on('documents:remove', async (payload) => {
    const p = record(payload);
    const id = idOf(p.id);
    const objectId = idOf(p.objectId);
    const node = shownNode(id, objectId);
    if (!(await dialogs.confirmRemove(node.name, library.subtreeSize(id, objectId)))) return cancelled();
    return { ok: true, delta: library.remove(id, objectId) };
  });

  on('documents:move', async (payload) => {
    const p = record(payload);
    const id = idOf(p.id);
    const objectId = idOf(p.objectId);
    const parentId = p.parentId === null ? null : idOf(p.parentId);
    const index = p.index === undefined ? undefined : positionOf(p.index);
    shownNode(id, objectId);
    return { ok: true, delta: library.move(id, objectId, parentId, index) };
  });

  on('documents:duplicate', async (payload) => {
    const p = record(payload);
    const id = idOf(p.id);
    const objectId = idOf(p.objectId);
    shownNode(id, objectId);
    const copy = library.duplicate(id, objectId);
    return { ok: true, objectId: copy.objectId, delta: copy.delta };
  });

  if (preferences) {
    on('documents:favorite', async (payload) => {
      const p = record(payload);
      const id = idOf(p.id);
      const objectId = idOf(p.objectId);
      if (typeof p.on !== 'boolean') bad('on is true or false');
      shownNode(id, objectId);
      const docId = library.view(id).docId;
      await preferences.setFavorite(docId, objectId, p.on);
      return { ok: true, favorites: present(id, docId) };
    });
  }

  on('documents:save', async (payload) => {
    const id = idOf(record(payload).id);
    const request = library.upgradeRequest(id);
    if (request) {
      if (!(await dialogs.confirmUpgrade?.(library.view(id).name))) return cancelled();
      library.approveUpgrade(id, request); // rejects edits while the native confirmation was open
    }
    const outcome = await library.save(id);
    return { ok: true, saved: outcome.saved, conflicts: outcome.conflicts, delta: outcome.delta,...(commitNote(outcome.warnings)?{note:commitNote(outcome.warnings)}:{}) };
  });

  on('documents:close', async (payload) => {
    const id = idOf(record(payload).id);
    const view = library.view(id);
    if (!view.dirty) { library.close(id); return { ok: true }; }
    let decision: 'save' | 'discard' | 'cancel';
    if (autosaveOf?.(view.docId)) { // a document that saves by itself, when it is closed or on edit, is saved without a question
      try {
        const outcome = await library.save(id);
        if (!outcome.saved) return { ok: false, code: 'conflict', message: messages.conflict, conflicts: outcome.conflicts, delta: outcome.delta }; // held back: it stays open
        library.close(id);
        return { ok: true };
      } catch (error) {
        reportFailure(report, error);
        decision = await dialogs.confirmClose(view.name, messageFor(error instanceof LibraryError ? error.code : 'io')); // it could not be saved (or was edited again meanwhile): asked like any document, so that it can be thrown away, and told why
      }
    } else {
      decision = await dialogs.confirmClose(view.name);
    }
    if (decision === 'cancel') return cancelled();
    if (decision === 'save') {
      const outcome = await library.save(id);
      if (!outcome.saved) return { ok: false, code: 'conflict', message: messages.conflict, conflicts: outcome.conflicts, delta: outcome.delta }; // held back: it stays open
      library.close(id);
    } else {
      library.close(id, { discard: true });
    }
    return { ok: true };
  });
}
