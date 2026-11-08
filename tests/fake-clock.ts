import type { Timers } from '../src/desktop/autosave.js';

export const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A clock that the test moves: timers run, in order, when it is moved past them (and what they start gets its turn after each one). */
export class FakeClock implements Timers {
  at = 0;
  #next = 1;
  #timers = new Map<number, { at: number; run: () => void }>();
  now = () => this.at;
  set = (run: () => void, ms: number): unknown => {
    if (ms < 0) throw new RangeError('A timer cannot wait a negative time'); // a real timer would wait none: the code that asks must have worked out a delay that is not negative
    const handle = this.#next++;
    this.#timers.set(handle, { at: this.at + ms, run });
    return handle;
  };
  clear = (handle: unknown): void => { this.#timers.delete(handle as number); };
  get pending() { return this.#timers.size; }
  async advance(ms: number): Promise<void> {
    const end = this.at + ms;
    for (;;) {
      const due = [...this.#timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.#timers.delete(due[0]);
      this.at = due[1].at;
      due[1].run();
      await flush();
    }
    this.at = end;
    await flush();
  }
}
