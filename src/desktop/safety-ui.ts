// The part of the window for the safety of the data: the conflicts that hold a save back (a dialog to decide them, which never opens by itself), reloading a document from its file,
// when a document saves by itself, and the earlier versions of a document (a dialog to look at them, to restore objects from and to put one back whole). Like the rest of the window
// it holds no document logic: it asks the main process (window.documents) and draws what it is told, with the text from conflicts-view.ts and history-view.ts. What the main process
// pushes without being asked (the change that a save by itself left, and that such a save failed or was held back) is taken in here too.
import type { Choice, ConflictView } from '../documents/conflicts.js';
import type { Delta } from '../documents/library.js';
import { confirmText, optionsOf, summary, titleOf, valueText } from './conflicts-view.js';
import type { DocModel } from './docmodel.js';
import type { Failure } from './documents-ui.js';
import { REVISION_SESSION, marksOf, restoreFolderName, revisionModel, summaryOf, timeLabel } from './history-view.js';
import { allExpanded, buildRows, documentKey, navigate, objectKey, parseKey, type NavKey, type Row } from './navigation.js';
import { createTreeView } from './tree-view.js';

/** What the rest of the documents part gives this one. */
export type SafetyHost = {
  /** The document that the selected row belongs to. */
  selected(): DocModel | undefined;
  take(delta: Delta): Promise<void>;
  resync(id: string): Promise<void>;
  render(): void;
  /** Opens the document and the folders above an object, so that it is in the list. */
  reveal(sessionId: string, objectId: string): void;
  /** Selects a row, brings it into view and gives the tree the focus. */
  show(key: string): void;
  /** Ends the search, so that an object that was just put back is in the list. */
  clearFilter(): void;
  /** What is said when the picture of a document is known to be old. */
  stale(): string;
  showError(text: string): void;
  say(text: string): void;
  fail(reply: Failure, id?: string): void;
  /** A refusal that happens inside a dialog: the tree is brought up to date behind it, and the reason is for the dialog to say. */
  refused(reply: Failure, id: string): string;
  report(error: unknown): void;
};
export type Safety = {
  /** Brings the buttons and the choice of saving by itself up to date with the selected document. */
  update(): void;
  /** A document is open: how it saves by itself is asked. */
  known(id: string): void;
  forget(id: string): void;
};
type Mode = 'off' | 'close' | 'edit';
const NAV_KEYS: readonly string[] = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function initSafety(host: SafetyHost): Safety {
  const modes = new Map<string, Mode | 'unknown'>();      // by session id; 'unknown': the main process could not say how the document saves, so nothing is shown that might be wrong
  let unavailable: string | undefined;          // why saving by itself cannot be chosen, when the preferences cannot be kept
  let reloading = false;                         // a reload is under way: a second press would ask the same question again
  const act = (run: () => Promise<void>) => () => { host.showError(''); run().catch(host.report); };

  // ---- saving by itself ----
  const select = el<HTMLSelectElement>('doc-autosave');
  function update(): void {
    const model = host.selected();
    el<HTMLButtonElement>('doc-conflicts').disabled = !model || model.conflicts === 0;
    el<HTMLButtonElement>('doc-history').disabled = !model;
    el<HTMLButtonElement>('doc-reload').disabled = !model || reloading;
    const mode = model && modes.get(model.id);
    select.disabled = !model || unavailable !== undefined || mode === 'unknown';
    const why = unavailable ?? (mode === 'unknown' ? 'Cara menyimpan otomatis tidak dapat dibaca; muat ulang jendela.' : '');
    select.title = why;
    el('doc-autosave-note').textContent = model ? why : ''; // a disabled choice cannot be focused and a title is not read: the reason is on the page
    if (mode === 'unknown') select.selectedIndex = -1; else select.value = mode ?? 'off';
  }
  select.onchange = act(async () => {
    const model = host.selected();
    if (!model) return;
    const reply = await window.documents.autosave({ id: model.id, mode: select.value as Mode });
    if (!reply.ok) { host.fail(reply, model.id); return; } // the choice goes back to what it was, as the window is drawn again
    modes.set(model.id, reply.mode);
    update();
  });
  function known(id: string): void {
    void window.documents.autosave({ id }).then((reply) => {
      if (reply.ok) modes.set(id, reply.mode);
      else if (reply.code === 'autosave-unavailable') unavailable = reply.message;
      else { modes.set(id, 'unknown'); host.showError(reply.message); }
      update();
    }).catch((error) => { modes.set(id, 'unknown'); host.report(error); update(); });
  }

  // ---- reloading ----
  el('doc-reload').onclick = act(async () => {
    const model = host.selected();
    if (!model || reloading) return;
    reloading = true;
    update();
    try {
      const reply = await window.documents.reload(model.id); // the main process asks first: this throws work away
      if (!reply.ok) { host.fail(reply, model.id); return; }
      await host.take(reply.delta);
      host.say('Dimuat ulang dari berkas; perubahan yang belum disimpan dan konflik dibuang.');
      host.render();
    } finally { reloading = false; update(); }
  });

  // ---- one request at a time in a dialog ----
  type Guard = { state: { busy: boolean }; run(work: () => Promise<void>): () => void };
  /**
   * The work of a dialog: one request at a time (the dialog stays open until the answer comes, and a second press would send the same request again: a part put back twice, a
   * choice decided twice), and what goes wrong is said in the dialog, because the line of the document is behind it, where it is not heard. `after` brings the buttons to what they should be.
   */
  function guarded(errorId: string, after: () => void): Guard {
    const state = { busy: false };
    return {
      state,
      run: (work) => () => {
        if (state.busy) return;
        state.busy = true;
        say(errorId, '');
        after();
        work().catch((error) => { console.warn('documents:', error); say(errorId, 'Terjadi kesalahan; coba lagi.'); }).finally(() => { state.busy = false; after(); });
      },
    };
  }
  const say = (id: string, text: string) => {
    el(id).textContent = text;
    if (text !== '' && id.endsWith('-error') && !(id === 'conflicts-error' ? dialog : history).open) host.showError(text); // the dialog was closed meanwhile: what happened is not left unsaid
  };

  // ---- the conflicts ----
  const dialog = el<HTMLDialogElement>('conflicts');
  const list = el('conflicts-list');
  let conflictsFor: string | undefined;
  let total = 0;
  let side: 'mine' | 'theirs' | undefined;
  const hideConfirm = () => { side = undefined; el('conflicts-confirm').hidden = true; };
  const reasonOf = (reply: Failure) => (reply.code === 'invalid' ? `${reply.message} Periksa pilihannya: objek tidak boleh berada di folder yang dihapus.` : reply.message);
  const deciding: Guard = guarded('conflicts-error', () => { for (const id of ['conflicts-apply', 'conflicts-all-mine', 'conflicts-all-theirs', 'conflicts-confirm-yes', 'conflicts-close']) el<HTMLButtonElement>(id).disabled = deciding.state.busy; });
  function item(view: ConflictView, index: number): HTMLElement {
    const li = document.createElement('li');
    const box = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = titleOf(view);
    box.append(legend);
    if (view.kind === 'field') {
      const was = document.createElement('p');
      was.className = 'was';
      was.textContent = `Semula: ${valueText(view.base)}`;
      box.append(was);
    }
    for (const option of optionsOf(view)) {
      const label = document.createElement('label');
      label.className = 'choice';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = `c${index}`;
      radio.value = option.choice;
      radio.dataset.key = view.key;
      const words = document.createElement('span');
      words.textContent = option.label;
      label.append(radio, words);
      if (option.detail !== undefined) {
        const detail = document.createElement('span');
        detail.className = 'detail';
        detail.textContent = option.detail;
        label.append(detail);
      }
      box.append(label);
    }
    li.append(box);
    return li;
  }
  /** Draws the list as the main process says it is now. A failure is said where the person is: in the dialog when it is open, on the line of the document when it is not (yet). */
  async function load(id: string, inDialog: boolean): Promise<'some' | 'none' | 'failed'> {
    hideConfirm();
    const reply = await window.documents.conflicts(id);
    if (!reply.ok) {
      if (inDialog) say('conflicts-error', host.refused(reply, id)); else host.fail(reply, id);
      return 'failed';
    }
    list.replaceChildren(...reply.views.map(item));
    total = reply.total;
    say('conflicts-summary', summary(reply.total, reply.views.length));
    return reply.total > 0 ? 'some' : 'none';
  }
  async function decide(id: string, how: { items: { key: string; choice: Choice }[] } | { all: 'mine' | 'theirs' }): Promise<void> {
    hideConfirm();
    const reply = await window.documents.resolve({ id, ...how });
    if (!reply.ok) {
      say('conflicts-error', reasonOf(reply));
      host.refused(reply, id);
      if (reply.code === 'unknown-conflict') await load(id, true); // the list is not what the document holds: it is drawn again
      return;
    }
    await host.take(reply.delta);
    host.render();
    if (reply.delta.conflicts === 0) { // nothing is left to decide: what the document says, not what a list that could not be drawn again says
      dialog.close();
      host.say('Semua konflik sudah diputuskan. Simpan untuk menulis hasilnya.');
      host.show(documentKey(id)); // the button that had the focus is not there to use any more: the tree has it
      return;
    }
    await load(id, true);
  }
  el('doc-conflicts').onclick = act(async () => {
    const model = host.selected();
    if (!model) return;
    say('conflicts-error', '');
    const state = await load(model.id, false);
    if (state === 'failed') return;
    if (state === 'none') { host.say('Tidak ada konflik.'); host.render(); return; }
    conflictsFor = model.id;
    dialog.showModal();
    list.querySelector<HTMLInputElement>('input')?.focus();
  });
  el('conflicts-apply').onclick = deciding.run(async () => {
    if (!conflictsFor) return;
    const items = [...list.querySelectorAll<HTMLInputElement>('input[type=radio]:checked')].map((radio) => ({ key: radio.dataset.key!, choice: radio.value as Choice }));
    if (items.length === 0) { say('conflicts-error', 'Pilih salah satu untuk tiap konflik yang ingin diputuskan.'); return; }
    await decide(conflictsFor, { items });
  });
  for (const which of ['mine', 'theirs'] as const) {
    el(`conflicts-all-${which}`).onclick = () => {
      side = which;
      say('conflicts-error', '');
      say('conflicts-confirm-text', confirmText(which, total));
      el('conflicts-confirm').hidden = false;
      el('conflicts-confirm-no').focus(); // the safe answer is the one that is at hand
    };
  }
  el('conflicts-confirm-no').onclick = () => {
    const opener = side;
    hideConfirm();
    if (opener) el(`conflicts-all-${opener}`).focus(); // the question is gone with the button that had the focus: it goes back to what asked it
  };
  el('conflicts-confirm-yes').onclick = deciding.run(async () => {
    const chosen = side;
    hideConfirm();
    try { if (conflictsFor && chosen) await decide(conflictsFor, { all: chosen }); }
    finally { if (dialog.open) list.querySelector<HTMLInputElement>('input')?.focus(); } // still open, also when it failed: the button that had the focus is gone
  });
  el('conflicts-close').onclick = () => { if (!deciding.state.busy) dialog.close(); };
  dialog.oncancel = (event) => { if (deciding.state.busy) event.preventDefault(); }; // Escape while a request is under way would say how it went in a dialog that is closed
  dialog.onclose = () => { conflictsFor = undefined; hideConfirm(); host.render(); };

  // ---- the earlier versions ----
  const history = el<HTMLDialogElement>('history');
  let historyFor: string | undefined;
  let chosen: { name: string; at: number } | undefined;
  let model: DocModel | undefined;
  let marks = new Map<string, 'gone' | 'changed'>();
  const open = new Set<string>();
  let rows: Row[] = [];
  let selected: string | undefined;
  let asked = 0; // the revision that was asked for last: an answer to an earlier question is old, and is not drawn
  const restorable = () => parseKey(selected ?? '')?.objectId !== undefined;
  const buttons = () => {
    el<HTMLButtonElement>('hist-restore').disabled = restoring.state.busy || !chosen || !restorable();
    el<HTMLButtonElement>('hist-restore-all').disabled = restoring.state.busy || !chosen;
    el<HTMLButtonElement>('hist-close').disabled = restoring.state.busy;
  };
  const restoring: Guard = guarded('hist-error', () => buttons());
  function draw(): void {
    rows = model ? buildRows([model], open, { compared: marks }) : [];
    tree.render(rows, selected);
    buttons();
  }
  function choose(key: string): void {
    selected = key;
    say('hist-error', ''); // what was said about the last object is not about this one
    tree.setSelected(key);
    buttons();
  }
  function toggle(key: string, wanted: boolean): void {
    if (wanted) open.add(key); else open.delete(key);
    selected = key;
    draw();
  }
  const tree = createTreeView(el('hist-tree'), {
    select: choose,
    toggle,
    activate: (key) => { const row = rows.find((r) => r.key === key); if (row?.hasChildren) toggle(key, !row.expanded); },
    key: (event) => {
      if (!NAV_KEYS.includes(event.key)) return;
      event.preventDefault();
      const move = navigate(rows, selected, event.key as NavKey);
      if (move.toggle) toggle(move.toggle.key, move.toggle.expanded);
      else if (move.focus) { choose(move.focus); tree.reveal(move.focus); }
    },
    canDrop: () => false,
    drop: () => undefined,
    openForDrop: () => undefined,
  }, { readOnly: true });

  async function pick(id: string, info: { name: string; at: number }): Promise<void> {
    const mine = ++asked;
    say('hist-error', '');
    const reply = await window.documents.revision({ id, name: info.name });
    if (mine !== asked || historyFor !== id) return; // another revision was asked for since, or the dialog was closed (or opened for another document): this answer is old
    if (!reply.ok) { say('hist-error', host.refused(reply, id)); return; }
    chosen = info;
    model = revisionModel(reply.revision);
    marks = marksOf(reply.revision);
    open.clear();
    for (const key of allExpanded([model])) open.add(key);
    selected = documentKey(REVISION_SESSION);
    say('hist-summary', `${timeLabel(info.at)}: ${summaryOf(reply.revision)}`); // which version the tree is of, in words: the mark on its button is for the eyes
    for (const button of el('hist-list').querySelectorAll('button')) {
      const current = button.dataset.name === info.name;
      button.classList.toggle('current', current);
      if (current) button.setAttribute('aria-current', 'true'); else button.removeAttribute('aria-current');
    }
    draw();
  }
  el('doc-history').onclick = act(async () => {
    const doc = host.selected();
    if (!doc) return;
    const reply = await window.documents.revisions(doc.id);
    if (!reply.ok) { host.fail(reply, doc.id); return; }
    historyFor = doc.id;
    asked++;
    chosen = undefined; model = undefined; selected = undefined; marks = new Map();
    say('hist-error', '');
    say('hist-summary', reply.revisions.length === 0 ? 'Belum ada revisi: satu dibuat tiap kali dokumen disimpan.' : 'Pilih revisi untuk melihat isinya.');
    el('hist-list').replaceChildren(...reply.revisions.map((info) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'quiet';
      button.dataset.name = info.name;
      button.textContent = timeLabel(info.at);
      button.onclick = () => {
        if (restoring.state.busy) return;
        pick(doc.id, info).catch((error) => { console.warn('documents:', error); say('hist-error', 'Terjadi kesalahan; coba lagi.'); });
      };
      return button;
    }));
    draw();
    history.showModal();
    el('hist-list').querySelector('button')?.focus();
  });
  el('hist-restore').onclick = restoring.run(async () => {
    const key = parseKey(selected ?? '');
    if (!historyFor || !chosen || !key?.objectId) return;
    const id = historyFor, name = restoreFolderName(chosen.at);
    const reply = await window.documents.restore({ id, name: chosen.name, ids: [key.objectId], folderName: name });
    if (!reply.ok) { say('hist-error', host.refused(reply, id)); return; }
    await host.take(reply.delta);
    history.close();
    host.clearFilter(); // a search that does not match the new folder would leave it out of the list
    if (reply.created) { host.reveal(id, reply.created); host.show(objectKey(id, reply.created)); } else host.render();
    host.say(`Objek dipulihkan ke folder “${name}”; simpan untuk menuliskannya.`);
  });
  el('hist-restore-all').onclick = restoring.run(async () => {
    if (!historyFor || !chosen) return;
    const id = historyFor, at = chosen.at;
    const reply = await window.documents.restore({ id, name: chosen.name, all: true }); // the main process asks first: this puts the document back as it was
    if (!reply.ok) { if (reply.code !== 'cancelled') say('hist-error', host.refused(reply, id)); return; }
    await host.take(reply.delta);
    history.close();
    host.say(reply.changed === false ? 'Dokumen sudah sama dengan revisi ini; tidak ada yang berubah.' : `Dokumen diganti dengan revisi ${timeLabel(at)}; belum disimpan.`);
    host.render();
  });
  el('hist-close').onclick = () => { if (!restoring.state.busy) history.close(); };
  history.oncancel = (event) => { if (restoring.state.busy) event.preventDefault(); };
  history.onclose = () => { historyFor = undefined; asked++; chosen = undefined; model = undefined; marks = new Map(); selected = undefined; draw(); }; // what the tree held of the version is let go

  // ---- what the main process says without being asked ----
  window.documents.onDelta((delta) => { void host.take(delta).then(() => host.render()).catch(host.report); });
  window.documents.onEvent((event) => {
    host.showError(event.message);
    void host.resync(event.id).catch(() => host.showError(`${event.message} ${host.stale()}`)); // the save that failed may have taken another program's changes in: the document is asked for again, and a picture that cannot be had is said to be old
  });

  return { update, known, forget: (id) => { modes.delete(id); } };
}
