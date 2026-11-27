// The log on disk (protocol/log.ts): ~/.harness/log/<source>/<YYYY-MM-DD>.jsonl, a file per day for
// each source (hub, agent, tui, app), written by the hub, its agents and the TUI on this machine,
// and by the hub for the clients that send theirs (logs_put). Days older than `log.retentionDays`
// are removed (agents' raw stderr in log/agents too). Reading merges every source by time.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { levelAllows, LOG_RETENTION_DAYS, LOG_SOURCES, logDay, logLine, type LogLevel, type LogRecord, type LogSource } from "#protocol/log.ts";

export type LogFilesOptions = {
  now?: () => number;
  /** The level records are written from (`log.level`; info by default). */
  level?: () => LogLevel;
};

/** One source's writer: each record into its day's file, masked; best effort (a full disk stops nothing). */
export class LogFiles {
  readonly root: string;
  readonly source: LogSource;
  private readonly now: () => number;
  private readonly level: () => LogLevel;
  /** Fields every record of this writer carries (the agent's id, the TUI's pid and window). */
  private readonly base: Record<string, unknown>;

  constructor(root: string, source: LogSource, base: Record<string, unknown> = {}, options: LogFilesOptions = {}) {
    this.root = root;
    this.source = source;
    this.base = base;
    this.now = options.now ?? Date.now;
    this.level = options.level ?? (() => "info");
  }

  log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    if (levelAllows(this.level(), level)) {
      this.append([{ at: new Date(this.now()).toISOString(), level, source: this.source, event, ...this.base, ...fields }]);
    } else {
      // below the log's level
    }
  }

  /** Records made elsewhere (a client's, sent to the hub) into their sources' files. */
  append(records: LogRecord[]): void {
    for (const record of records) {
      try {
        const source = LOG_SOURCES.includes(record.source) ? record.source : this.source;
        const dir = join(this.root, source);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        appendFileSync(join(dir, `${logDay(record.at)}.jsonl`), `${logLine(record)}\n`, { mode: 0o600 });
      } catch {
        // best effort: the log never stops what it logs
      }
    }
  }
}

/** Removes the days older than `days` (by file name) and agents' stderr files older than that (by time). */
export function sweepLogs(root: string, days: number = LOG_RETENTION_DAYS, now: number = Date.now()): string[] {
  const oldest = logDay(now - days * 24 * 3600 * 1000);
  const removed: string[] = [];
  for (const source of [...LOG_SOURCES, "agents"]) {
    const dir = join(root, source);
    for (const file of existsSync(dir) ? readdirSync(dir) : []) {
      const path = join(dir, file);
      const day = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file)?.[1];
      const old = day !== undefined ? day < oldest : statSync(path).mtimeMs < now - days * 24 * 3600 * 1000;
      if (old) {
        rmSync(path, { force: true });
        removed.push(path);
      } else {
        // kept
      }
    }
  }
  return removed;
}

export type LogQuery = {
  /** From this time (ms). */
  since?: number;
  sources?: LogSource[];
  agent?: string;
  session?: string;
  /** At most this many, the newest. */
  last?: number;
};

/** The records of every source, merged by time, filtered. */
export function readLogs(root: string, query: LogQuery = {}): LogRecord[] {
  const since = query.since !== undefined ? logDay(query.since) : "";
  const records: LogRecord[] = [];
  for (const source of query.sources ?? LOG_SOURCES) {
    const dir = join(root, source);
    for (const file of existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".jsonl") && name.slice(0, 10) >= since) : []) {
      for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
        try {
          if (line !== "") {
            records.push(JSON.parse(line) as LogRecord);
          } else {
            // the file's last newline
          }
        } catch {
          // a line cut by a crash
        }
      }
    }
  }
  const kept = records
    .filter((record) => (query.since === undefined || Date.parse(record.at) >= query.since) && (query.agent === undefined || record.agent === query.agent) && (query.session === undefined || record.session === query.session))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return query.last !== undefined ? kept.slice(-query.last) : kept;
}

/** A record as a line for people: time, source, level, event, the rest. */
export function formatLogRecord(record: LogRecord): string {
  const { at, source, level, event, ...rest } = record;
  const fields = Object.entries(rest)
    .map(([key, value]) => `${key}=${typeof value === "string" ? (value.length > 200 ? `${JSON.stringify(value.slice(0, 200))}…` : JSON.stringify(value)) : JSON.stringify(value)}`)
    .join(" ");
  return `${at.slice(11, 23)} ${source.padEnd(5)} ${level === "info" ? "" : `${level.toUpperCase()} `}${event}${fields !== "" ? ` ${fields}` : ""}`;
}
