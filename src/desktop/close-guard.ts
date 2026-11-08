// What closing the window does with documents that have unsaved changes. The window asks once for all of them; a close that loses an edit
// is the worst thing this app can do, so the decision is a function of the library and two questions, and is tested without a window.
import { messageFor, type Notice, type Question } from './documents-ipc.js';

/** The part of DocumentLibrary this needs (DocumentLibrary satisfies it). */
export type Closable = {
  views(): { id: string; name: string; dirty: boolean }[];
  dirtyIds(): string[];
  save(id: string): Promise<{ saved: boolean }>;
};
/** A document that was not saved, and why: 'conflict' (another writer's changes could not be merged), 'changed' (edited again while it was being saved), or the library's error code ('io' when a failure has none). */
export type NotSaved = { name: string; code: string };
export type CloseDialogs = {
  askSaveAll(names: string[]): Promise<'save' | 'discard' | 'cancel'>;
  /**
   * 'automatic': these documents save by themselves and could not (the person is asked about them next, and the window may close); 'failed': these were not saved after the person said to save,
   * so the window stays; 'changed': an edit arrived while the documents were being saved, so they are unsaved again and the window stays.
   */
  tellNotSaved(reason: 'automatic' | 'failed' | 'changed', documents: NotSaved[]): Promise<void>;
};

/** The question for the documents that have unsaved changes: Enter saves them all and Escape cancels the close (nothing is thrown away by a key). */
export const saveAllQuestion = (names: string[]): Question => ({
  type: 'question', buttons: ['Simpan semua', 'Jangan simpan', 'Batal'], defaultId: 0, cancelId: 2,
  message: names.length === 1 ? `Simpan perubahan pada “${names[0]}”?` : `Simpan perubahan pada ${names.length} dokumen?`,
  detail: 'Perubahan yang tidak disimpan akan hilang.',
});
/** What is said when documents were not saved: which ones and why, and what happens next (the window stays, or the person is asked). */
export function notSavedNotice(reason: 'automatic' | 'failed' | 'changed', documents: NotSaved[]): Notice {
  const list = documents.map((d) => (d.code === 'changed' ? `“${d.name}”` : `“${d.name}”: ${messageFor(d.code)}`)).join('\n');
  const [message, advice] = reason === 'automatic' ? ['Tidak semua dokumen dapat disimpan sendiri.', 'Setelah ini Anda ditanya apakah perubahannya disimpan atau dibuang.']
    : reason === 'failed' ? ['Tidak semua dokumen dapat disimpan, jadi jendela tidak ditutup.', 'Simpan atau buang perubahannya dari jendela dokumen.']
    : ['Dokumen berubah lagi saat disimpan, jadi jendela tidak ditutup.', 'Tutup lagi untuk menyimpan perubahan terakhir.'];
  return { type: 'error', message, detail: `${list}\n\n${advice}` };
}

const unsaved = (library: Closable) => library.views().filter((v) => v.dirty);
const codeOf = (error: unknown): string => (typeof (error as { code?: unknown } | null)?.code === 'string' ? (error as { code: string }).code : 'io');

/** Saves one document; what it was not saved for, if it was not. */
async function saveOne(library: Closable, id: string): Promise<NotSaved | undefined> {
  let code = 'conflict'; // a save that neither wrote nor failed was held back by a conflict
  const outcome = await library.save(id).catch((error: unknown) => { code = codeOf(error); return undefined; });
  // A document that is no longer unsaved needs nothing (it was saved, or closed meanwhile); one that still is, and was not saved, keeps the window.
  return !outcome?.saved && library.dirtyIds().includes(id) ? { name: library.views().find((v) => v.id === id)?.name ?? '', code } : undefined;
}

/**
 * 'close' only when nothing unsaved is left, or the user said to throw it away. The documents that save by themselves (`savesItself`: when they are closed, or on edit) are saved first and
 * are not asked about; if one of them cannot be saved the person is told why and is then asked, like for any document with unsaved changes (so that it can be thrown away: a file that is
 * gone would otherwise keep the window for good). Every unsaved document is tried, so one that cannot be saved does not keep the others from it; the window then stays and says which
 * ones failed and why.
 */
export async function decideClose(library: Closable, dialogs: CloseDialogs, savesItself: (id: string) => boolean = () => false): Promise<'close' | 'stay'> {
  const automatic: NotSaved[] = [];
  for (const id of library.dirtyIds().filter(savesItself)) { const failure = await saveOne(library, id); if (failure) automatic.push(failure); }
  if (automatic.length > 0) await dialogs.tellNotSaved('automatic', automatic);
  const names = unsaved(library).map((v) => v.name);
  if (names.length === 0) return 'close';
  const answer = await dialogs.askSaveAll(names);
  if (answer === 'cancel') return 'stay';
  if (answer === 'discard') return 'close';
  const failed: NotSaved[] = [];
  for (const id of library.dirtyIds()) { const failure = await saveOne(library, id); if (failure) failed.push(failure); }
  if (failed.length > 0) { await dialogs.tellNotSaved('failed', failed); return 'stay'; }
  const changed = unsaved(library);
  if (changed.length > 0) { await dialogs.tellNotSaved('changed', changed.map((v) => ({ name: v.name, code: 'changed' }))); return 'stay'; }
  return 'close';
}
