// The one log of harness: JSON records, one per line, from every part — the hub, its agents, the
// TUI and the app — each record naming its source and the ids that tie a request together from the
// client through the hub to the agent (`client`, `connection`, `req`, `agent`, `session`). Content
// is written (messages, answers, tool output, typing into a terminal); the values of secrets never
// are: `maskSecrets` replaces them wherever a record carries them.

export type LogLevel = "error" | "warn" | "info" | "debug";

export type LogSource = "hub" | "agent" | "tui" | "app";

export const LOG_SOURCES: readonly LogSource[] = ["hub", "agent", "tui", "app"];

export type LogRecord = {
  /** ISO time. */
  at: string;
  level: LogLevel;
  source: LogSource;
  event: string;
  [field: string]: unknown;
};

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/** Whether a record of `level` is written where the log's level is `threshold`. */
export function levelAllows(threshold: LogLevel, level: LogLevel): boolean {
  return ORDER[level] <= ORDER[threshold];
}

export function isLogLevel(value: unknown): value is LogLevel {
  return value === "error" || value === "warn" || value === "info" || value === "debug";
}

/** Days records are kept by default (`log.retentionDays`). */
export const LOG_RETENTION_DAYS = 3;

/** The day a record belongs to (its file): UTC, `YYYY-MM-DD`. */
export function logDay(at: string | number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * Field names whose string values are secrets: tokens, keys, passwords, pairing codes, a secret's
 * value (`secretValue`: a secret's answer is logged under it). Callers name a secret so.
 */
const SECRET = /^(token|accessToken|refreshToken|access|refresh|secret|secretValue|password|passphrase|apiKey|api_key|authorization|cookie|pairingCode)$/i;

const MASK = "••••";

/**
 * A record without secrets' values: any string field named as a secret is masked (at any depth), as
 * are strings that look like credentials (bearer tokens, provider keys, JWTs) wherever they stand.
 */
export function maskSecrets<T>(value: T): T {
  return mask(value, undefined) as T;
}

/** Credentials written into text: `Bearer …`, `sk-…`, `ghp_…`, `xoxb-…`, JWTs. */
const CREDENTIAL = /\b(Bearer\s+[A-Za-z0-9._~+/=-]{8,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g;

function mask(value: unknown, key: string | undefined): unknown {
  if (key !== undefined && SECRET.test(key) && typeof value === "string" && value !== "") {
    return MASK;
  } else if (typeof value === "string") {
    return value.replace(CREDENTIAL, MASK);
  } else if (Array.isArray(value)) {
    return value.map((item) => mask(item, undefined));
  } else if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([field, inner]) => [field, mask(inner, field)]));
  } else {
    return value;
  }
}

/** A record for its line: masked, the time first. */
export function logLine(record: LogRecord): string {
  return JSON.stringify(maskSecrets(record));
}

/**
 * Makes records of one source with the fields every one of them carries (an agent's id, a client's)
 * and gives them to where they are kept (`sink`: a file, the hub, both). Records below the log's
 * level are not made.
 */
export class Logger {
  readonly source: LogSource;
  private readonly base: Record<string, unknown>;
  private readonly sink: (record: LogRecord) => void;
  private readonly level: () => LogLevel;
  private readonly now: () => number;

  constructor(source: LogSource, sink: (record: LogRecord) => void, options: { base?: Record<string, unknown>; level?: () => LogLevel; now?: () => number } = {}) {
    this.source = source;
    this.sink = sink;
    this.base = options.base ?? {};
    this.level = options.level ?? (() => "info");
    this.now = options.now ?? Date.now;
  }

  log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    if (levelAllows(this.level(), level)) {
      this.sink({ at: new Date(this.now()).toISOString(), level, source: this.source, event, ...this.base, ...fields });
    } else {
      // below the log's level
    }
  }

  info(event: string, fields?: Record<string, unknown>): void {
    this.log("info", event, fields);
  }

  warn(event: string, fields?: Record<string, unknown>): void {
    this.log("warn", event, fields);
  }

  error(event: string, fields?: Record<string, unknown>): void {
    this.log("error", event, fields);
  }

  debug(event: string, fields?: Record<string, unknown>): void {
    this.log("debug", event, fields);
  }

  /** Whether debug records are made (to skip building them). */
  get debugging(): boolean {
    return this.level() === "debug";
  }
}

/** An error as a log keeps it: its message and stack. */
export function errorFields(error: unknown): { error: string; stack?: string } {
  return error instanceof Error ? { error: error.message, ...(error.stack !== undefined ? { stack: error.stack } : {}) } : { error: String(error) };
}
