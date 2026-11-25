/**
 * Shutdown on idleness: the gateway exits (code 0, the machine stops) when
 * nothing has happened for the configured time and nothing waits — no run, no
 * dialog, no pending input. The next webhook wakes the machine up again.
 *
 * Activity is every incoming update; when the timer fires while something
 * still runs or waits, it is armed again for the full time.
 */

import type { Clock, Timer } from "./clock.ts";

export class IdleShutdown {
  private readonly clock: Clock;
  private readonly idleMs: number;
  private readonly quiescent: () => boolean;
  private readonly shutdown: () => void;
  private timer: Timer | undefined;
  private stopped = false;

  constructor(clock: Clock, idleMs: number, quiescent: () => boolean, shutdown: () => void) {
    this.clock = clock;
    this.idleMs = idleMs;
    this.quiescent = quiescent;
    this.shutdown = shutdown;
    this.arm();
  }

  activity(): void {
    if (!this.stopped) this.arm();
  }

  stop(): void {
    this.stopped = true;
    this.timer?.cancel();
  }

  private arm(): void {
    this.timer?.cancel();
    this.timer = this.clock.after(this.idleMs, () => {
      if (this.stopped) {
        // stopping already
      } else if (this.quiescent()) {
        this.stopped = true;
        this.shutdown();
      } else {
        this.arm();
      }
    });
  }
}
