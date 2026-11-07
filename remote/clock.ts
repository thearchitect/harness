/**
 * Time as an input. Every timer of the gateway (draft throttling, card
 * updates, process reaping, idle shutdown) goes through a Clock, so tests
 * drive time explicitly with a fake one (test/fake-clock.ts).
 */

export type Timer = { cancel(): void };

export type Clock = {
  now(): number;
  /** Runs fn once after ms milliseconds, unless cancelled first. */
  after(ms: number, fn: () => void): Timer;
};

export const systemClock: Clock = {
  now: () => Date.now(),
  after: (ms, fn) => {
    const handle = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(handle) };
  },
};
