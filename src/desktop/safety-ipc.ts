// IPC for the safety of the data: the conflicts that hold a save back and how they are decided, reloading a document from its file, the earlier versions that are kept (to look at, and to
// restore from), and when a document saves by itself. Made like the channels of the documents (handlerFor in documents-ipc.ts): the sender is checked, a request that is not
// exactly what it should be is refused before anything is done, and the answer is { ok: true, ... } or { ok: false, code, message }. What throws away work (a reload, putting a whole earlier
// version in) is asked in a dialog of the main process first; nothing here shows the window an id of an object it does not see, a name or a value that it may not, or a path.
import { LibraryError, MAX_CONFLICT_VIEWS, type DocumentLibrary } from '../documents/library.js';
import type { Choice } from '../documents/conflicts.js';
import { revisionTime } from '../documents/store.js';
import { bad, cancelled, handlerFor, idOf, messageFor, record, textOf, type IpcLike, type Question } from './documents-ipc.js';
import type { AutosaveMode } from './preferences.js';

/** What the main process asks the person before it throws work away. */
export type SafetyDialogs = {
  confirmReload(name: string): Promise<boolean>;
  /** `at`: when the earlier version was taken (milliseconds since 1970); `unsaved`: the document has changes that are not saved (or a save held back by a conflict), which are thrown away too. */
  confirmRestoreAll(name: string, at: number, unsaved: boolean): Promise<boolean>;
};

/** Reloading a document from its file throws away what was changed here and what was held back; Enter and Escape answer "Batal". */
export const reloadQuestion = (name: string): Question => ({
  type: 'warning', buttons: ['Muat ulang', 'Batal'], defaultId: 1, cancelId: 1,
  message: `Muat ulang “${name}” dari berkas?`,
  detail: 'Perubahan yang belum disimpan dan konflik yang tertahan akan dibuang.',
});
/**
 * Putting a whole earlier version in makes it the working copy. What is saved in the file stays in the revision that the next save keeps; what is not saved (changes, a conflict that holds
 * the save back) is in no revision, and it is said so when there is some. `when`: the time of the earlier version, written for a person (history-view.ts `timeLabel`).
 */
export const restoreAllQuestion = (name: string, when: string, unsaved: boolean): Question => ({
  type: 'warning', buttons: ['Ganti isi dokumen', 'Batal'], defaultId: 1, cancelId: 1,
  message: `Ganti seluruh isi “${name}” dengan revisi ${when}?`,
  detail: unsaved
    ? 'Perubahan yang belum disimpan dan konflik yang tertahan akan dibuang, dan tidak tersimpan di revisi mana pun. Isi revisi ini menjadi perubahan yang belum disimpan; isi berkas yang sekarang tetap ada di revisi saat dokumen disimpan.'
    : 'Ini menjadi perubahan yang belum disimpan; isi yang sekarang tetap ada di revisi saat dokumen disimpan.',
});
/** What choosing how a document saves needs of the preferences (Preferences satisfies it). */
export type AutosaveStore = {
  autosaveOf(docId: string): AutosaveMode | undefined;
  setAutosave(docId: string, mode: AutosaveMode | 'off'): Promise<AutosaveMode | undefined>;
};

const KEY = /^c-[0-9a-f]{16}$/;
const CHOICES: readonly string[] = ['mine', 'theirs', 'keep', 'delete', 'accept'];
const REVISION = /^\d{8}T\d{9}Z-[0-9a-f]{12}\.rwdoc$/;
export const MAX_RESTORE = 50; // objects named in one restore
const revisionName = (value: unknown): string => (typeof value === 'string' && REVISION.test(value) ? value : bad('Not the name of a revision'));

export function registerSafetyIpc(deps: { ipc: IpcLike; check: (event: any) => void; library: DocumentLibrary; dialogs: SafetyDialogs; report?: (error: unknown) => void; preferences?: AutosaveStore; autosaver?: { chose(id: string): void } }): void {
  const { ipc, check, library, dialogs, report, preferences, autosaver } = deps;
  const on = handlerFor({ ipc, check, library, ...(report ? { report } : {}) });

  on('documents:conflicts', async (payload) => ({ ok: true, ...library.conflicts(idOf(record(payload).id)) }));

  on('documents:resolve', async (payload) => {
    const p = record(payload);
    const id = idOf(p.id);
    if ((p.items === undefined) === (p.all === undefined)) bad('Either the choices or one side for everything');
    if (p.all !== undefined) {
      if (p.all !== 'mine' && p.all !== 'theirs') bad('Not a side');
      return { ok: true, delta: library.resolve(id, { all: p.all }) };
    }
    if (!Array.isArray(p.items) || p.items.length === 0 || p.items.length > MAX_CONFLICT_VIEWS) bad('Not a list of choices');
    const items = p.items.map((item: unknown) => {
      const one = record(item);
      if (typeof one.key !== 'string' || !KEY.test(one.key) || typeof one.choice !== 'string' || !CHOICES.includes(one.choice)) bad('Not a choice');
      return { key: one.key as string, choice: one.choice as Choice };
    });
    return { ok: true, delta: library.resolve(id, { items }) };
  });

  on('documents:reload', async (payload) => {
    const id = idOf(record(payload).id);
    if (!(await dialogs.confirmReload(library.view(id).name))) return cancelled();
    return { ok: true, delta: await library.reload(id) };
  });

  on('documents:revisions', async (payload) => ({ ok: true, revisions: await library.revisions(idOf(record(payload).id)) }));

  on('documents:revision', async (payload) => {
    const p = record(payload);
    return { ok: true, revision: await library.revision(idOf(p.id), revisionName(p.name)) };
  });

  on('documents:restore', async (payload) => {
    const p = record(payload);
    const id = idOf(p.id);
    const name = revisionName(p.name);
    if (p.all !== undefined) {
      if (p.all !== true || p.ids !== undefined || p.folderName !== undefined) bad('Either the whole document or some objects');
      if (!(await library.revisions(id)).some((revision) => revision.name === name)) throw new LibraryError('not-found', 'That earlier version is not there'); // a question about what is not there is not asked
      const view = library.view(id);
      if (!(await dialogs.confirmRestoreAll(view.name, revisionTime(name), view.dirty))) return cancelled();
      return { ok: true, ...(await library.restore(id, name, { all: true })) };
    }
    if (!Array.isArray(p.ids) || p.ids.length === 0 || p.ids.length > MAX_RESTORE) bad('Not a list of objects');
    return { ok: true, ...(await library.restore(id, name, { ids: p.ids.map(idOf), folderName: textOf(p.folderName) })) };
  });

  on('documents:autosave', async (payload) => {
    const p = record(payload);
    const id = idOf(p.id);
    if (!preferences) return { ok: false, code: 'autosave-unavailable', message: messageFor('autosave-unavailable') };
    const docId = library.view(id).docId;
    if (p.mode === undefined) return { ok: true, mode: preferences.autosaveOf(docId) ?? 'off' };
    if (p.mode !== 'off' && p.mode !== 'close' && p.mode !== 'edit') bad('Not a mode of saving');
    const mode = (await preferences.setAutosave(docId, p.mode)) ?? 'off';
    autosaver?.chose(id);
    return { ok: true, mode };
  }, 'too-many-autosave');
}
