// The hub's log (protocol/log.ts, log-files.ts): ~/.harness/log/hub/<day>.jsonl — what happened
// (connections, every operation with its time and error, agents starting and exiting, refusals,
// pairing, the network, terminals) with the ids that tie a request to the client's and the agent's
// records. The hub also keeps the logs its clients send (logs_put) and removes days older than
// `log.retentionDays`, at its start and every hour.

import { join } from "node:path";
import { LOG_RETENTION_DAYS, type LogLevel, type LogRecord } from "#protocol/log.ts";
import { formatLogRecord, LogFiles, readLogs, sweepLogs } from "./log-files.ts";

export type TelemetryEvent =
  | { event: "hub_start"; network: boolean }
  | { event: "hub_stop" }
  | { event: "hub_restart"; connection: string }
  | { event: "connect"; connection: string; client: string; device?: string }
  | { event: "disconnect"; connection: string }
  | { event: "refused"; connection: string; code: string }
  | { event: "op"; connection: string; req: string; op: string; ms: number; args?: unknown; error?: string }
  | { event: "hap"; connection: string; agent: string; req: string; type: string; forwarded?: string }
  | { event: "agent_start"; agent: string; session: string; cwd: string; requested?: string }
  | { event: "agent_exit"; agent: string; code: number | null; error?: string }
  | { event: "agent_unload"; agent: string }
  | { event: "terminal_started"; session: string; cwd: string; pid: number }
  | { event: "prompt_editor_opened"; session: string; command: string }
  | { event: "prompt_editor_closed"; session: string; code: number }
  | { event: "terminal_exited"; session: string; code: number }
  | { event: "network_started"; listen: string; proxy: boolean }
  | { event: "network_stopped" }
  | { event: "network_problem"; problem: string }
  | { event: "pairing_created"; pairing: string; name?: string }
  | { event: "paired"; pairing: string; device: string; address: string }
  | { event: "pairing_failed"; address: string; reason: string }
  | { event: "device_refused"; address: string; reason: string }
  | { event: "device_renamed"; device: string; to: string }
  | { event: "device_revoked"; device: string }
  | { event: "idle_exit"; minutes: number }
  | { event: "attachments_removed"; count: number }
  | { event: "logs_removed"; count: number };

/** Events that tell of something going wrong. */
const WARN = new Set(["refused", "network_problem", "pairing_failed", "device_refused"]);

/** Strings longer than this are logged by their length (a file's base64, a screen). */
const LONG = 4000;

/** Arguments as the log keeps them: long strings by their length. */
export function summarize(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > LONG ? `<${value.length} chars>` : value;
  } else if (Array.isArray(value)) {
    return value.map(summarize);
  } else if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, summarize(inner)]));
  } else {
    return value;
  }
}

export class Telemetry {
  readonly root: string;
  private readonly files: LogFiles;
  private readonly now: () => number;
  private readonly retention: () => number;
  /** The log's level now (`log.level`): agents start with it. */
  readonly level: () => LogLevel;

  constructor(dataDir: string, now: () => number, settings: { level: () => LogLevel; retentionDays: () => number } = { level: () => "info", retentionDays: () => LOG_RETENTION_DAYS }) {
    this.root = join(dataDir, "log");
    this.now = now;
    this.retention = settings.retentionDays;
    this.level = settings.level;
    this.files = new LogFiles(this.root, "hub", {}, { now, level: settings.level });
  }

  log(event: TelemetryEvent): void {
    const { event: name, ...fields } = event;
    const failed = (name === "op" && "error" in fields && fields.error !== undefined) || (name === "agent_exit" && "error" in fields && fields.error !== undefined);
    this.files.log(failed ? "error" : WARN.has(name) ? "warn" : "info", name, fields);
  }

  /** A debug record (the level decides whether it is written). */
  debug(event: string, fields: Record<string, unknown>): void {
    this.files.log("debug", event, fields);
  }

  /** Records a client sent (logs_put), with who sent them. */
  put(records: LogRecord[], from: Record<string, unknown>): void {
    this.files.append(records.map((record) => ({ ...record, ...from })));
  }

  /** The last `count` records of every source, oldest first, as lines for people. */
  tail(count: number): string[] {
    return readLogs(this.root, { last: count, since: this.now() - 24 * 3600 * 1000 }).map(formatLogRecord);
  }

  /** Days older than the retention go. */
  sweep(): void {
    const removed = sweepLogs(this.root, this.retention(), this.now());
    if (removed.length > 0) {
      this.log({ event: "logs_removed", count: removed.length });
    } else {
      // nothing old
    }
  }
}
