// What the window says about a conflict: a title that tells what it is about and what happened, the choices with words (and, for a field, what each side holds), and the count.
// Pure functions of what the main process told (documents/conflicts.ts: ConflictView); nothing here sees an id, a key of a hidden object or anything the window may not see,
// and the DOM code draws what these return.
import type { Choice, ConflictView, Value } from '../documents/conflicts.js';

export type Option = { choice: Choice; label: string; detail?: string };

const thing = { folder: 'Folder', connection: 'Koneksi', document: 'Dokumen' } as const;
const quoted = (name: string): string => `“${name}”`;

const kinds = { number: 'angka', boolean: 'benar/salah', null: 'tanpa nilai', array: 'daftar', object: 'objek' } as const;

/** A value as a person reads it: its text, or in words that there is none, that it is the top level, that the folder is not there, or that it is empty; a value that is not text says what it is. */
export function valueText(value: Value): string {
  if (value.none) return '(tidak ada)';
  if (value.top) return '(tingkat atas)';
  if (value.gone) return '(folder tidak ada)';
  if (value.text === '') return '(kosong)';
  const text = value.cut ? `${value.text}…` : value.text;
  return value.json === undefined ? text : `${text} (${kinds[value.json]})`;
}

export function titleOf(view: ConflictView): string {
  switch (view.kind) {
    case 'field': {
      if (view.what === 'document-name') return 'Nama dokumen';
      const what = view.what === 'name' ? 'nama' : view.what === 'parent' ? 'folder induk' : view.what === 'type' ? 'jenis' : `properti ${view.property ?? ''}`;
      return `${thing[view.objectType]} ${quoted(view.object)} — ${what}`;
    }
    case 'delete-edit': return `${thing[view.objectType]} ${quoted(view.object)} — ${view.deletedBy === 'mine' ? 'dihapus di sini, tetapi diubah di tempat lain' : 'dihapus di tempat lain, tetapi diubah di sini'}`;
    case 'orphan': return `${thing[view.objectType]} ${quoted(view.object)} — folder induknya sudah tidak ada`; // deleted here or there: the merge cannot tell which side the person did it on
    case 'cycle': return `Folder ${view.objects.map(quoted).join(', ')}${view.total > view.objects.length ? ` dan ${view.total - view.objects.length} lainnya` : ''} — saling memindahkan hingga membentuk lingkaran`;
    case 'hidden': return `Objek yang tidak ditampilkan — ${view.of === 'field' ? 'diubah di dua tempat' : view.of === 'delete-edit' ? 'dihapus di satu tempat, diubah di tempat lain' : 'folder induknya sudah tidak ada'}`;
  }
}

/** What can be chosen, in the order the main process gives; none is chosen beforehand. */
export function optionsOf(view: ConflictView): Option[] {
  const label = (choice: Choice): string => {
    switch (choice) {
      case 'mine': return 'Milik saya';
      case 'theirs': return 'Milik mereka';
      case 'accept': return 'Terima: folder kembali ke tempat semula';
      case 'keep': return view.kind === 'delete-edit' ? (view.deletedBy === 'mine' ? 'Pertahankan (ada perubahan di tempat lain)' : 'Pertahankan (perubahan saya)') : view.kind === 'orphan' ? 'Pertahankan di tingkat atas' : 'Pertahankan';
      case 'delete': return view.kind === 'delete-edit' ? (view.deletedBy === 'mine' ? 'Hapus (seperti di sini)' : 'Hapus (seperti di tempat lain)') : 'Hapus';
    }
  };
  return view.choices.map((choice) => {
    const inside = (view.kind === 'delete-edit' || view.kind === 'orphan') && choice === 'delete' && view.below > 0 ? `${view.below} objek di dalamnya ikut terhapus` : undefined;
    const detail = view.kind === 'field' && (choice === 'mine' || choice === 'theirs') ? valueText(view[choice]) : inside;
    return { choice, label: label(choice), ...(detail === undefined ? {} : { detail }) };
  });
}

/**
 * The question before "mine for everything" or "theirs for everything": how many conflicts it is for and what it does to each kind (the main process decides each as `sideItems` says: a field is that
 * side's, an object that one side deleted and the other edited is deleted when it is the side that deleted it and kept otherwise, and an object whose folder is gone stays at the top level).
 */
export function confirmText(side: 'mine' | 'theirs', total: number): string {
  const head = `Terapkan “${side === 'mine' ? 'Milik saya' : 'Milik mereka'}” untuk ${total} konflik?`;
  const rest = side === 'mine'
    ? 'Nilai milik saya dipakai di semua. Yang saya hapus di sini tetap terhapus (perubahan di tempat lain pada objek itu tidak dipakai), dan yang dihapus di tempat lain tetap ada dengan perubahan saya.'
    : 'Nilai milik mereka dipakai di semua. Yang dihapus di tempat lain ikut terhapus di sini (perubahan saya pada objek itu hilang), dan yang saya hapus di sini kembali dengan perubahan mereka.';
  return `${head} ${rest} Objek yang folder induknya sudah tidak ada dipertahankan di tingkat atas.`;
}

export function summary(total: number, shown: number): string {
  if (total === 0) return 'Tidak ada konflik.';
  if (shown < total) return `Menampilkan ${shown} dari ${total} konflik; “Semua milik saya” dan “Semua milik mereka” berlaku untuk seluruhnya.`;
  return `${total} konflik`;
}
