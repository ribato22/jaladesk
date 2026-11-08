// Saves the documents that were chosen to save on edit, by themselves: a few seconds after the last edit, and no later than a minute after the first edit that
// was not saved. It is told of every change of a document (the library's onChange) and asks the host to save, one document at a time. It stops while a conflict
// is held back (the person decides it), says once that a save failed or was held back, and never lets what the host does fail the timers. The clock is given, so
// that what waits and for how long can be tested without waiting. What fails is also reported (`report`), every time: the window is told once, a log is told always.
import type { ChangeEvent, DocumentLibrary } from '../documents/library.js';
import { messageFor } from './documents-ipc.js';
import type { AutosaveMode } from './preferences.js';

export const QUIET_MS = 5_000;     // after the last edit
export const LONGEST_MS = 60_000;  // after the first edit that was not saved

export type Timers = { now(): number; set(run: () => void, ms: number): unknown; clear(handle: unknown): void };
export const realTimers: Timers = { now: () => Date.now(), set: (run, ms) => setTimeout(run, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

export type AutosaveHost = {
  /** How the person chose that the document saves; nothing when it does not. */
  mode(id: string): AutosaveMode | undefined;
  /** Whether the document has unsaved changes, and conflicts that are held back; nothing when it is not open. */
  state(id: string): { dirty: boolean; conflicts: number } | undefined;
  /** A save that a timer asks for (and not a person): the file it replaces is kept as a revision only when the newest revision is old enough. */
  save(id: string): Promise<{ saved: boolean; conflicts: number }>;
  /** Tells the person that a save by itself failed (`code`: why, as the library says it), or was held back because the file was changed elsewhere. */
  say(id: string, what: 'failed' | 'held', code?: string): void;
};

type Watch = { quiet?: unknown; longest?: unknown; since?: number; saving: boolean; again: boolean; told: boolean }; // since: when the first edit that is not saved was made

export class Autosaver {
  readonly #watch = new Map<string, Watch>();
  readonly #running = new Set<Promise<void>>();
  #disposed = false;
  constructor(private readonly host: AutosaveHost, private readonly timers: Timers = realTimers, private readonly quietMs = QUIET_MS, private readonly longestMs = LONGEST_MS, private readonly report?: (error: unknown) => void) {}

  /** A document changed, was saved, had its conflicts decided, or was closed. */
  changed(event: ChangeEvent): void {
    if (event.closed) this.#forget(event.id); else this.#follow(event.id, event.dirty, event.conflicts);
  }

  /** The person chose another way of saving for a document: it takes effect at once. */
  chose(id: string): void {
    if (this.#disposed) return;
    const state = this.host.state(id);
    if (state) { this.#of(id).told = false; this.#follow(id, state.dirty, state.conflicts); } else this.#forget(id);
  }

  /** Stops everything for good: what is waiting is forgotten, and a save that is under way leaves nothing behind when it ends. */
  dispose(): void {
    this.#disposed = true;
    for (const id of [...this.#watch.keys()]) this.#forget(id);
  }

  /** Resolves when no save that a timer asked for is under way (one that is waiting for its time is not). */
  async idle(): Promise<void> { while (this.#running.size > 0) await Promise.allSettled([...this.#running]); }

  #of(id: string): Watch {
    let watch = this.#watch.get(id);
    if (!watch) { watch = { saving: false, again: false, told: false }; this.#watch.set(id, watch); }
    return watch;
  }
  #disarm(watch: Watch): void {
    if (watch.quiet !== undefined) this.timers.clear(watch.quiet);
    if (watch.longest !== undefined) this.timers.clear(watch.longest);
    watch.quiet = watch.longest = undefined;
  }
  #forget(id: string): void {
    const watch = this.#watch.get(id);
    if (watch) this.#disarm(watch);
    this.#watch.delete(id);
  }

  #follow(id: string, dirty: boolean, conflicts: number): void {
    if (this.#disposed) return;
    const watch = this.#of(id);
    if (!dirty) watch.told = false; // saved, by anybody: a failure after this one is news again
    if (this.host.mode(id) !== 'edit' || !dirty || conflicts > 0) { this.#disarm(watch); watch.since = undefined; return; }
    const now = this.timers.now();
    watch.since ??= now;
    if (watch.saving) { watch.again = true; return; } // after the save that is under way, which counts the minute from this edit, not from its own end
    if (watch.quiet !== undefined) this.timers.clear(watch.quiet);
    watch.quiet = this.timers.set(() => this.#due(id), this.quietMs);
    watch.longest ??= this.timers.set(() => this.#due(id), Math.max(0, this.longestMs - (now - watch.since!)));
  }

  #due(id: string): void {
    const watch = this.#watch.get(id);
    if (!watch || this.#disposed) return;
    this.#disarm(watch);
    const state = this.host.state(id);
    if (!state || !state.dirty || state.conflicts > 0 || this.host.mode(id) !== 'edit') return;
    watch.since = undefined; // the save takes what there is; an edit made while it runs is the first of the next
    const running = this.#save(id, watch);
    this.#running.add(running);
    void running.finally(() => this.#running.delete(running));
  }

  async #save(id: string, watch: Watch): Promise<void> {
    watch.saving = true;
    watch.again = false;
    try {
      const outcome = await this.host.save(id);
      if (outcome.saved) watch.told = false;
      else if (outcome.conflicts > 0) this.#say(id, 'held');
    } catch (error) {
      this.#reported(error);
      const code = (error as { code?: unknown } | null)?.code;
      if (!watch.told) { watch.told = true; this.#say(id, 'failed', typeof code === 'string' ? code : undefined); } // said once for a run of failures; the next edit tries again
    } finally {
      watch.saving = false;
    }
    if (watch.again && !this.#disposed) { const state = this.host.state(id); if (state) this.#follow(id, state.dirty, state.conflicts); }
  }

  #say(id: string, what: 'failed' | 'held', code?: string): void {
    try { this.host.say(id, what, code); } catch (error) { this.#reported(error); /* nobody to tell: the window is gone */ }
  }

  #reported(error: unknown): void {
    try { this.report?.(error); } catch { /* a log that fails is not a reason to stop saving */ }
  }
}

/** What the windows are sent that they did not ask for: the change that a save by a timer left (a Delta), or that such a save failed or was held back (an event with its fixed text). */
export type Push = (channel: 'documents:delta' | 'documents:event', payload: unknown) => void;

/**
 * An autosaver for the application: it follows every document of the library, asks the preferences how each one is chosen to save, saves through the library (with `auto`, so that the
 * history is not used up) and tells the windows what came of it. `stop` leaves nothing running or listening.
 */
export function followLibrary(deps: { library: DocumentLibrary; preferences?: { autosaveOf(docId: string): AutosaveMode | undefined }; push: Push; timers?: Timers; quietMs?: number; longestMs?: number; report?: (error: unknown) => void }): { autosaver: Autosaver; stop(): void } {
  const { library, preferences, push, report } = deps;
  const host: AutosaveHost = {
    mode: (id) => {
      let docId: string;
      try { docId = library.view(id).docId; } catch { return undefined; } // not open any more
      try { return preferences?.autosaveOf(docId); } catch (error) { report?.(error); return undefined; } // the preferences failed: that is something to be heard of
    },
    state: (id) => { try { const view = library.view(id); return { dirty: view.dirty, conflicts: view.conflicts }; } catch { return undefined; } }, // not open any more
    save: async (id) => {
      const outcome = await library.save(id, { auto: true });
      try { push('documents:delta', outcome.delta); } catch (error) { report?.(error); } // the file is written: a window that cannot be told is not a failed save
      return { saved: outcome.saved, conflicts: outcome.conflicts };
    },
    say: (id, what, code) => {
      const base = messageFor(`autosave-${what}`);
      push('documents:event', { id, code: `autosave-${what}`, message: what === 'failed' && code ? `${base} ${messageFor(code)}` : base });
    },
  };
  const autosaver = new Autosaver(host, deps.timers, deps.quietMs, deps.longestMs, report);
  const unsubscribe = library.onChange((event) => autosaver.changed(event));
  return { autosaver, stop: () => { unsubscribe(); autosaver.dispose(); } };
}
