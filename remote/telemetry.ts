/**
 * The gateway's telemetry: every event is one JSON line in a daily journal on
 * the volume (`<dir>/YYYY-MM-DD.jsonl`, UTC, root, 0600) and a short line on
 * stderr (`fly logs`). The journal is the source for retrospectives: files
 * older than the retention are removed at start and when the day changes.
 *
 * Events carry a level, a kind (`agent.exit`, `tg.call`, ...) and fields; never
 * message texts, transcripts, file contents or secret values. Values the
 * gateway knows to be secret (bot token, webhook secret) are masked in
 * everything written.
 *
 * Errors also go to the gateway's admins in Telegram (Alerts below), throttled:
 * the same kind and message at most once per DEDUPE_MS, at most
 * ALERTS_PER_MINUTE a minute, the rest summed up in one message.
 */

import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Clock, Timer } from "./core/clock.ts";

export type Level = "info" | "warn" | "error";
export type Fields = Record<string, unknown>;
export type Event = { ts: string; level: Level; kind: string } & Fields;

/** What every module gets: structured events. */
export type Telemetry = {
  info(kind: string, fields?: Fields): void;
  warn(kind: string, fields?: Fields): void;
  error(kind: string, fields?: Fields): void;
};

const FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 24 * 60 * 60_000;

export class Journal implements Telemetry {
  private readonly dir: string;
  private readonly clock: Clock;
  private readonly retentionDays: number;
  private readonly stderr: (line: string) => void;
  private readonly secrets = new Set<string>();
  private readonly errorListeners: ((event: Event) => void)[] = [];
  private day = "";

  constructor(options: { dir: string; clock: Clock; retentionDays: number; stderr: (line: string) => void }) {
    this.dir = options.dir;
    this.clock = options.clock;
    this.retentionDays = options.retentionDays;
    this.stderr = options.stderr;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  /** A value never to appear in the journal (masked as ***). */
  addSecret(value: string): void {
    if (value.length >= 8) this.secrets.add(value);
  }

  onError(listener: (event: Event) => void): void {
    this.errorListeners.push(listener);
  }

  info(kind: string, fields: Fields = {}): void {
    this.write("info", kind, fields);
  }

  warn(kind: string, fields: Fields = {}): void {
    this.write("warn", kind, fields);
  }

  error(kind: string, fields: Fields = {}): void {
    const event = this.write("error", kind, fields);
    for (const listener of this.errorListeners) {
      try {
        listener(event);
      } catch (error) {
        this.stderr(`telemetry: an error listener failed: ${String(error)}`);
      }
    }
  }

  /** Events with ts in [fromMs, toMs], oldest first. */
  read(fromMs: number, toMs: number): Event[] {
    const events: Event[] = [];
    for (const file of this.files()) {
      const dayStart = Date.parse(`${file.day}T00:00:00Z`);
      if (dayStart + DAY_MS < fromMs || dayStart > toMs) {
        continue; // outside the range
      } else {
        for (const event of this.parse(file.name)) {
          const ts = Date.parse(event.ts);
          if (ts >= fromMs && ts <= toMs) events.push(event);
        }
      }
    }
    return events;
  }

  /**
   * How the previous run of the gateway ended, read before this run writes
   * anything: undefined when there was none, otherwise whether it stopped
   * cleanly and its last error.
   */
  previousRun(): { clean: boolean; lastError?: Event } | undefined {
    const files = this.files().slice(-2);
    const events = files.flatMap((file) => this.parse(file.name));
    const start = events.map((e) => e.kind).lastIndexOf("gateway.start");
    if (start === -1) {
      return undefined;
    } else {
      const run = events.slice(start);
      const lastError = run.filter((e) => e.level === "error").at(-1);
      return { clean: run.some((e) => e.kind === "gateway.stop"), ...(lastError !== undefined ? { lastError } : {}) };
    }
  }

  /* ------------------------------------------------------------------------ */

  private write(level: Level, kind: string, fields: Fields): Event {
    const now = this.clock.now();
    const ts = new Date(now).toISOString();
    const event: Event = { ts, level, kind, ...fields };
    const line = this.mask(JSON.stringify(event));
    const day = ts.slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.prune(now);
    } else {
      // the same day's file
    }
    try {
      appendFileSync(join(this.dir, `${day}.jsonl`), `${line}\n`, { mode: 0o600 });
    } catch (error) {
      this.stderr(`telemetry: cannot write the journal: ${String(error)}`);
    }
    const { ts: _ts, level: _level, kind: _kind, ...rest } = event;
    this.stderr(this.mask(`${ts} ${level} ${kind}${Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : ""}`));
    return JSON.parse(line) as Event;
  }

  private mask(text: string): string {
    let masked = text;
    for (const secret of this.secrets) {
      masked = masked.split(secret).join("***");
      const escaped = JSON.stringify(secret).slice(1, -1);
      if (escaped !== secret) masked = masked.split(escaped).join("***");
    }
    return masked;
  }

  private prune(now: number): void {
    const oldest = new Date(now - this.retentionDays * DAY_MS).toISOString().slice(0, 10);
    for (const file of this.files()) {
      if (file.day < oldest) {
        rmSync(join(this.dir, file.name), { force: true });
      } else {
        // within the retention
      }
    }
  }

  private files(): { name: string; day: string }[] {
    return readdirSync(this.dir)
      .map((name) => ({ name, match: FILE.exec(name) }))
      .filter((f): f is { name: string; match: RegExpExecArray } => f.match !== null)
      .map((f) => ({ name: f.name, day: f.match[1] as string }))
      .sort((a, b) => a.day.localeCompare(b.day));
  }

  private parse(name: string): Event[] {
    const events: Event[] = [];
    for (const line of readFileSync(join(this.dir, name), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        events.push(JSON.parse(line) as Event);
      } catch {
        // a line cut by a crash: skipped
      }
    }
    return events;
  }
}

export const DEDUPE_MS = 10 * 60_000;
export const ALERTS_PER_MINUTE = 10;

/** Sends error events to the admins' private chats, throttled; queued until a sender is set. */
export class Alerts {
  private readonly clock: Clock;
  private send: ((text: string) => Promise<void>) | undefined;
  private readonly queue: string[] = [];
  private readonly lastSent = new Map<string, number>();
  private windowStart = Number.NEGATIVE_INFINITY;
  private inWindow = 0;
  private suppressed = 0;
  private summaryTimer: Timer | undefined;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  /** The admins can be reached: queued alerts go out. */
  ready(send: (text: string) => Promise<void>): void {
    this.send = send;
    for (const text of this.queue.splice(0)) void send(text);
  }

  /** An error event. */
  alert(event: Event): void {
    const message = alertText(event);
    const key = `${event.kind}\n${String(event.message ?? "")}`;
    const now = this.clock.now();
    const last = this.lastSent.get(key);
    if (last !== undefined && now - last < DEDUPE_MS) {
      return; // the same alert went out recently
    }
    if (now - this.windowStart >= 60_000) {
      this.windowStart = now;
      this.inWindow = 0;
    } else {
      // the current minute
    }
    if (this.inWindow >= ALERTS_PER_MINUTE) {
      this.suppressed += 1;
      this.summaryTimer ??= this.clock.after(this.windowStart + 60_000 - now, () => this.summary());
    } else {
      this.inWindow += 1;
      this.lastSent.set(key, now);
      this.deliver(message);
    }
  }

  private summary(): void {
    this.summaryTimer = undefined;
    const count = this.suppressed;
    this.suppressed = 0;
    if (count > 0) this.deliver(`+${count} more errors, see /logs`);
  }

  private deliver(text: string): void {
    if (this.send !== undefined) {
      void this.send(text);
    } else {
      this.queue.push(text);
    }
  }
}

/** "error · oksana · ~/proj · agent.exit: pi exited unexpectedly (SIGKILL)" */
export function alertText(event: Event): string {
  const parts = ["error", event.user, event.dir, `${event.kind}${event.message !== undefined ? `: ${String(event.message)}` : ""}`];
  return parts.filter((p) => p !== undefined && p !== "").join(" · ").slice(0, 3500);
}
