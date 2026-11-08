import type { OpenStored, StoredOpened } from './connections.js';
import type { State } from '../protocols/rdp/wire.js';

const aborted = (): Error => Object.assign(new Error('Connection start cancelled'), { name: 'AbortError' });
type QueueEntry = { controller: AbortController; run(signal: AbortSignal): Promise<unknown>; resolve(value: unknown): void; reject(error: unknown): void; detach(): void; started: boolean };
/** One main-process FIFO for every connect path, held through input/resolution/helper start, never until RDP connected. */
export class ConnectFifo {
  readonly #pending: QueueEntry[] = [];
  #active: QueueEntry | undefined;
  get activeSignal(): AbortSignal | undefined { return this.#active?.controller.signal; }
  run<T>(fn: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(aborted());
    if(this.#pending.length>=64)return Promise.reject(Object.assign(new Error('Connection queue is full'),{code:'busy'}));
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      const entry: QueueEntry = { controller, run: fn, resolve: value => resolve(value as T), reject, detach: () => signal?.removeEventListener('abort', cancel), started: false };
      const cancel = () => {
        controller.abort();
        if (!entry.started) {
          const index = this.#pending.indexOf(entry); if (index >= 0) this.#pending.splice(index, 1);
          entry.detach(); reject(aborted());
        }
      };
      signal?.addEventListener('abort', cancel, { once: true });
      this.#pending.push(entry); void this.#next();
    });
  }
  async #next(): Promise<void> {
    if (this.#active) return;
    const entry = this.#pending.shift(); if (!entry) return;
    entry.started = true; this.#active = entry;
    let value: unknown, failure: unknown, failed = false;
    try { value = await entry.run(entry.controller.signal); } catch (error) { failure = error; failed = true; }
    entry.detach(); this.#active = undefined;
    if (failed) entry.reject(failure); else entry.resolve(value);
    void this.#next();
  }
}
export type StoredStarted = { sessionId: string; established: Promise<'connected' | 'failed' | 'closed'>; close(): Promise<void> };
type Receipt = { handle: StoredStarted; state(state: State): void; connected(): boolean };
type Opening = { signal: AbortSignal; receipts: Map<string, Receipt> };

/** Retains early owner events before StoredConnections returns its public StoredOpened result. */
export class StoredBeginAdapter {
  #opening: Opening | undefined;
  constructor(private readonly deps: {
    queue: ConnectFifo;
    openStored(ref: OpenStored, signal: AbortSignal): Promise<StoredOpened>;
    // Must also handle an ID whose owner.open Promise is still pending, then close that exact session once ready.
    close(id: string): Promise<void>;
  }) {}
  beforeSpawn(sessionId: string): { state(state: State): void; failed(error?: unknown): void } {
    const opening = this.#opening;
    if (!opening) return { state() {}, failed() {} }; // manual paths need no retained bulk receipt
    if (opening.signal.aborted) throw aborted();
    if (opening.receipts.has(sessionId)) throw new Error('Duplicate connection receipt');
    let outcome: 'connected' | 'failed' | 'closed' | undefined;
    let finish!: (value: 'connected' | 'failed' | 'closed') => void;
    const established = new Promise<'connected' | 'failed' | 'closed'>(resolve => { finish = resolve; });
    let closing: Promise<void> | undefined;
    const close = () => closing ??= Promise.resolve().then(() => this.deps.close(sessionId));
    const cancel = () => { if (outcome === undefined) void close().catch(() => {}); };
    const state = (value: State) => {
      if (value === 'connecting' || outcome !== undefined) return;
      outcome = value; opening.signal.removeEventListener('abort', cancel); finish(value);
    };
    const handle: StoredStarted = { sessionId, established, close };
    opening.receipts.set(sessionId, { handle, state, connected: () => outcome === 'connected' });
    opening.signal.addEventListener('abort', cancel, { once: true });
    return { state, failed: () => state('failed') };
  }
  async beginStored(ref: OpenStored, signal: AbortSignal): Promise<StoredStarted> {
    const request = structuredClone(ref);
    return this.deps.queue.run(async scopedSignal => {
      // The receipt outlives the FIFO start: keep its caller signal after the queue removes its temporary relay.
      const opening: Opening = { signal, receipts: new Map() };
      if (this.#opening) throw new Error('Connection start already active');
      this.#opening = opening;
      try {
        const opened = await this.deps.openStored(request, scopedSignal);
        const receipt = opening.receipts.get(opened.sessionId);
        if (!receipt || opening.receipts.size !== 1) throw new Error('Missing connection receipt');
        opening.receipts.delete(opened.sessionId);
        return receipt.handle;
      } catch (error) {
        await Promise.allSettled([...opening.receipts.values()].map(async receipt => {
          if (!receipt.connected()) { receipt.state('failed'); await receipt.handle.close(); }
        }));
        throw error;
      } finally { opening.receipts.clear(); this.#opening = undefined; }
    }, signal);
  }
}
