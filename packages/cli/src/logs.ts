// `harness logs`: this machine's log (the hub's, its agents', the TUI windows', and what the hub's
// clients sent), every source merged by time.
//
//   harness logs [--since 1h|30m|2d|<ISO>] [--follow] [--source hub,agent,tui,app]
//                [--agent <id>] [--session <id>] [--json]

import { parseArgs } from "node:util";
import { layoutOf } from "#protocol/layout.ts";
import { LOG_SOURCES, type LogRecord, type LogSource } from "#protocol/log.ts";
import { formatLogRecord, readLogs, type LogQuery } from "#hub/log-files.ts";

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `--since`: a span back from now (`90m`, `2h`, `3d`) or a time. */
export function sinceOf(value: string, now: number): number {
  const span = /^(\d+)([smhd])$/.exec(value);
  const parsed = span !== null ? now - Number(span[1]) * (UNITS[span[2] ?? "h"] ?? 0) : Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`--since ${value}: a span (90m, 2h, 3d) or a time (2026-11-27T10:00)`);
  } else {
    return parsed;
  }
}

export async function logsCommand(home: string, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      since: { type: "string", default: "1h" },
      follow: { type: "boolean", short: "f", default: false },
      source: { type: "string" },
      agent: { type: "string" },
      session: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  const sources = values.source?.split(",").map((source) => source.trim()) as LogSource[] | undefined;
  const unknown = sources?.filter((source) => !LOG_SOURCES.includes(source)) ?? [];
  if (unknown.length > 0) {
    throw new Error(`--source ${unknown.join(",")}: one of ${LOG_SOURCES.join(", ")}`);
  } else {
    const root = layoutOf(home).log;
    const query: LogQuery = {
      since: sinceOf(values.since, Date.now()),
      ...(sources !== undefined ? { sources } : {}),
      ...(values.agent !== undefined ? { agent: values.agent } : {}),
      ...(values.session !== undefined ? { session: values.session } : {}),
    };
    const print = (record: LogRecord): void => {
      process.stdout.write(`${values.json ? JSON.stringify(record) : formatLogRecord(record)}\n`);
    };
    let shown = readLogs(root, query);
    shown.forEach(print);
    // --follow: what comes after, read again each second (records of the same time are told apart by their line)
    while (values.follow) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const last = shown.at(-1);
      const seen = new Set(shown.filter((record) => record.at === last?.at).map((record) => JSON.stringify(record)));
      const next = readLogs(root, { ...query, since: last !== undefined ? Date.parse(last.at) : query.since }).filter((record) => !seen.has(JSON.stringify(record)));
      next.forEach(print);
      shown = next.length > 0 ? next : shown;
    }
  }
}
