// A client's log (protocol/log.ts): its records go to its home hub (logs_put, in batches, kept with
// the hub's under their source) and, where the client keeps a log of its own (the app: the browser's
// IndexedDB, a phone's files), there too; the TUI's hub is on its machine and keeps it. Records the
// hub has not taken yet wait in memory (at most MAX_PENDING) and go when it is back; a client without
// a hub keeps them in its own store.

import { Logger, type LogLevel, type LogRecord } from "#protocol/log.ts";

/** Where a client keeps its log itself: append records, remove days past the retention. */
export type LogStore = {
  append(records: LogRecord[]): void | Promise<void>;
  sweep(days: number): void | Promise<void>;
};

export type ClientLogOptions = {
  source: "tui" | "app";
  /** Fields every record carries: the client's id, its process, its window. */
  base: Record<string, unknown>;
  /** The client's own store; `mirror`: every record goes there too (else only what no hub took). */
  local?: { store: LogStore; mirror: boolean };
  /** Sends records to the home hub; undefined while there is none to take them. */
  upload: () => ((records: LogRecord[]) => Promise<unknown>) | undefined;
  level: () => LogLevel;
};

/** How long records gather before they go to the hub. */
const BATCH_MS = 2000;
/** Records waiting for a hub at most (the oldest go first). */
const MAX_PENDING = 5000;

export class ClientLog {
  readonly logger: Logger;
  private readonly options: ClientLogOptions;
  private pending: LogRecord[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: ClientLogOptions) {
    this.options = options;
    this.logger = new Logger(options.source, (record) => this.take(record), { base: options.base, level: options.level });
  }

  private take(record: LogRecord): void {
    const local = this.options.local;
    if (local?.mirror === true) {
      void Promise.resolve(local.store.append([record])).catch(() => undefined);
    } else {
      // the hub keeps it
    }
    this.pending.push(record);
    if (this.pending.length > MAX_PENDING) {
      this.pending.splice(0, this.pending.length - MAX_PENDING);
    } else {
      // room enough
    }
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, BATCH_MS);
  }

  /** The records gathered go now (quitting, the page going away). */
  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    } else {
      // no batch waiting
    }
    const records = this.pending;
    this.pending = [];
    const upload = this.options.upload();
    const local = this.options.local;
    if (records.length === 0) {
      return;
    } else if (upload !== undefined) {
      try {
        await upload(records);
      } catch {
        // the hub went: the records wait for it again, before the newer ones
        this.pending = [...records, ...this.pending].slice(-MAX_PENDING);
      }
    } else if (local !== undefined && !local.mirror) {
      // no hub to take them: the client keeps them itself
      await Promise.resolve(local.store.append(records)).catch(() => undefined);
    } else {
      // kept locally already; they go to a hub when one is there
      this.pending = [...records, ...this.pending].slice(-MAX_PENDING);
    }
  }
}
