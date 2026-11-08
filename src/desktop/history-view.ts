// What the window says about an earlier version of a document: when it was taken, the name of the folder a restore makes, the tree of its objects (a model the tree view draws like
// any other, under a session of its own), and which of its objects the document does not have any more or has changed. Pure functions of what the main process told (RevisionView).
import type { RevisionView } from '../documents/library.js';
import { modelOf, type DocModel } from './docmodel.js';
import { objectKey } from './navigation.js';

/** The session of the tree of an earlier version: never the id of a document, and without a colon, which the keys of the rows are cut at. */
export const REVISION_SESSION = 'revision';

/** The time a revision was taken, for a person: the date and the time of day. */
export function timeLabel(at: number, timeZone?: string): string {
  if (!Number.isFinite(at)) return 'waktu tidak diketahui';
  return new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'medium', ...(timeZone ? { timeZone } : {}) }).format(at);
}

/** The name of the folder that a restore of objects puts them in. */
export const restoreFolderName = (at: number, timeZone?: string): string => `Dipulihkan ${timeLabel(at, timeZone)}`;

/** The earlier version as a model the tree can draw: only what the window sees of it. */
export function revisionModel(view: RevisionView): DocModel {
  return modelOf({ id: REVISION_SESSION, docId: '', name: view.docName, revision: 0, dirty: false, conflicts: 0, seq: 0, objects: view.objects });
}

/** The rows of the objects that the document does not have any more ('gone') or that are not the same ('changed'), by the key of the row. */
export function marksOf(view: RevisionView): Map<string, 'gone' | 'changed'> {
  const marks = new Map<string, 'gone' | 'changed'>();
  for (const id of view.gone) marks.set(objectKey(REVISION_SESSION, id), 'gone');
  for (const id of view.changed) marks.set(objectKey(REVISION_SESSION, id), 'changed');
  return marks;
}

export function summaryOf(view: RevisionView): string {
  const parts: string[] = [];
  if (view.gone.length > 0) parts.push(`${view.gone.length} objek tidak ada lagi`);
  if (view.changed.length > 0) parts.push(`${view.changed.length} berbeda`);
  if (view.added > 0) parts.push(`${view.added} objek baru sejak revisi ini`);
  return parts.length > 0 ? parts.join(' · ') : 'Sama dengan dokumen sekarang.';
}
