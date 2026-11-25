// Time, injected wherever behavior depends on it (summaries, backoff, pairing codes, task waits),
// so tests drive it instead of waiting. Isomorphic: the timers exist in Node and in browsers.

export type Clock = { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** A clock tests move by hand: timers fire in order of their due time as `advance` passes them. */
export class ManualClock implements Clock {
  private current: number;
  private timers: { id: number; due: number; fn: () => void }[] = [];
  private counter = 0;

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    this.counter += 1;
    this.timers.push({ id: this.counter, due: this.current + Math.max(0, ms), fn });
    return this.counter;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  }

  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const next = this.timers.filter((timer) => timer.due <= target).sort((a, b) => a.due - b.due || a.id - b.id)[0];
      if (next === undefined) {
        break;
      } else {
        this.timers = this.timers.filter((timer) => timer !== next);
        this.current = next.due;
        next.fn();
      }
    }
    this.current = target;
  }
}
