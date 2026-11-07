/**
 * The running pi processes, one per active topic: limits per user and in
 * total, reaping of idle processes, orderly stops.
 *
 * A process is busy while a run is in progress or a dialog waits for the user;
 * only idle processes are reaped or evicted. A stop closes stdin (pi's orderly
 * shutdown), then signals the process group if it lingers.
 */

import type { Clock, Timer } from "./clock.ts";

export type PoolProcess = {
  close(): void;
  kill(signal: NodeJS.Signals): void;
  readonly exited: Promise<unknown>;
};

export type PoolLimits = { perUser: number; total: number; idleMs: number };

const CLOSE_GRACE_MS = 10_000;
const TERM_GRACE_MS = 5_000;

type Entry<P> = {
  key: string;
  userId: number;
  proc: P;
  busy: boolean;
  idleSince: number;
  reapTimer?: Timer;
  /** Stop as soon as it is idle (the user's secrets or login changed). */
  stopWhenIdle: boolean;
};

export class SessionPool<P extends PoolProcess> {
  private readonly clock: Clock;
  private readonly limits: PoolLimits;
  private readonly entries = new Map<string, Entry<P>>();
  private readonly stopping = new Set<Promise<void>>();

  constructor(clock: Clock, limits: PoolLimits) {
    this.clock = clock;
    this.limits = limits;
  }

  get(key: string): P | undefined {
    return this.entries.get(key)?.proc;
  }

  get size(): number {
    return this.entries.size;
  }

  /** True when no process runs or waits for the user. */
  isQuiescent(): boolean {
    return [...this.entries.values()].every((e) => !e.busy);
  }

  /**
   * Makes room for one more process of the user, evicting the longest idle
   * process (of this user when the per-user limit is reached) when needed.
   */
  makeRoom(userId: number): { ok: true } | { ok: false; reason: string } {
    const own = [...this.entries.values()].filter((e) => e.userId === userId);
    if (own.length >= this.limits.perUser) {
      const victim = longestIdle(own);
      if (victim === undefined) {
        return { ok: false, reason: `limit reached: ${own.length} of your sessions are running` };
      } else {
        void this.stop(victim.key);
      }
    } else {
      // below the per-user limit
    }
    if (this.entries.size >= this.limits.total) {
      const victim = longestIdle([...this.entries.values()]);
      if (victim === undefined) {
        return { ok: false, reason: `limit reached: ${this.entries.size} sessions are running on the server` };
      } else {
        void this.stop(victim.key);
      }
    } else {
      // below the total limit
    }
    return { ok: true };
  }

  /** Registers a started process (idle); it leaves the pool when it exits. */
  add(key: string, userId: number, proc: P): void {
    const entry: Entry<P> = { key, userId, proc, busy: false, idleSince: this.clock.now(), stopWhenIdle: false };
    this.entries.set(key, entry);
    this.scheduleReap(entry);
    void proc.exited.then(() => {
      if (this.entries.get(key) === entry) {
        entry.reapTimer?.cancel();
        this.entries.delete(key);
      } else {
        // already removed by stop()
      }
    });
  }

  setBusy(key: string, busy: boolean): void {
    const entry = this.entries.get(key);
    if (entry === undefined || entry.busy === busy) {
      return;
    } else if (busy) {
      entry.busy = true;
      entry.reapTimer?.cancel();
    } else if (entry.stopWhenIdle) {
      entry.busy = false;
      void this.stop(key);
    } else {
      entry.busy = false;
      entry.idleSince = this.clock.now();
      this.scheduleReap(entry);
    }
  }

  /** The user's processes stop now when idle, the busy ones as soon as they settle. */
  restartUser(userId: number): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.userId !== userId) {
        // another user's process
      } else if (entry.busy) {
        entry.stopWhenIdle = true;
      } else {
        void this.stop(entry.key);
      }
    }
  }

  /** Removes the process from the pool at once and shuts it down in the background. */
  stop(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return Promise.resolve();
    } else {
      entry.reapTimer?.cancel();
      this.entries.delete(key);
      const done = this.shutdown(entry.proc);
      this.stopping.add(done);
      void done.then(() => this.stopping.delete(done));
      return done;
    }
  }

  /** Stops every process and waits for all stops in flight. */
  async stopAll(): Promise<void> {
    for (const key of [...this.entries.keys()]) void this.stop(key);
    await Promise.all([...this.stopping]);
  }

  private async shutdown(proc: P): Promise<void> {
    let exited = false;
    const exit = proc.exited.then(() => {
      exited = true;
    });
    proc.close();
    await Promise.race([exit, this.delay(CLOSE_GRACE_MS)]);
    if (!exited) {
      proc.kill("SIGTERM");
      await Promise.race([exit, this.delay(TERM_GRACE_MS)]);
    } else {
      // closed in time
    }
    if (!exited) {
      proc.kill("SIGKILL");
      await exit;
    } else {
      // gone
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => this.clock.after(ms, resolve));
  }

  private scheduleReap(entry: Entry<P>): void {
    entry.reapTimer?.cancel();
    entry.reapTimer = this.clock.after(this.limits.idleMs, () => {
      if (this.entries.get(entry.key) === entry && !entry.busy) {
        void this.stop(entry.key);
      } else {
        // busy again or already gone
      }
    });
  }
}

function longestIdle<P>(entries: Entry<P>[]): Entry<P> | undefined {
  return entries.filter((e) => !e.busy).sort((a, b) => a.idleSince - b.idleSince)[0];
}
