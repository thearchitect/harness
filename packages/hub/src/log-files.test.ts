// The log on disk: a file a day per source, masked; days past the retention removed (and agents'
// old stderr); every source merged by time and filtered; below the level nothing is written.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { maskSecrets, type LogRecord } from "#protocol/log.ts";
import { LogFiles, readLogs, sweepLogs } from "./log-files.ts";

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse("2026-11-27T12:00:00Z");

test("a file a day per source, secrets masked, below the level nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "log-"));
  let now = NOW - 2 * DAY;
  let level: "info" | "debug" = "info";
  const hub = new LogFiles(root, "hub", { hub: "local" }, { now: () => now, level: () => level });
  hub.log("info", "op", { req: "a-r1", token: "t0ps3cret", answer: { secretValue: "hunter2" }, text: "use Bearer abcdefghijklmnop please" });
  hub.log("debug", "key", { bytes: "x" });
  now = NOW;
  level = "debug";
  hub.log("debug", "key", { bytes: "y" });

  const older = readFileSync(join(root, "hub", "2026-11-25.jsonl"), "utf8");
  assert.ok(!older.includes("t0ps3cret") && !older.includes("hunter2") && !older.includes("abcdefghijklmnop"), older);
  assert.ok(older.includes('"req":"a-r1"') && older.includes('"hub":"local"'));
  assert.ok(!older.includes('"bytes"'), "debug below info is not written");
  assert.ok(readFileSync(join(root, "hub", "2026-11-27.jsonl"), "utf8").includes('"bytes":"y"'));
  assert.deepEqual(maskSecrets({ code: 1, key: "ui.theme", value: "dark" }), { code: 1, key: "ui.theme", value: "dark" }, "names of settings and exit codes stay");
});

test("days past the retention go, agents' old stderr with them", () => {
  const root = mkdtempSync(join(tmpdir(), "log-"));
  const files = new LogFiles(root, "agent");
  const record = (daysAgo: number): LogRecord => ({ at: new Date(NOW - daysAgo * DAY).toISOString(), level: "info", source: "agent", event: "x" });
  files.append([record(5), record(3), record(2), record(0)]);
  mkdirSync(join(root, "agents"), { recursive: true });
  writeFileSync(join(root, "agents", "old.stderr"), "");
  writeFileSync(join(root, "agents", "new.stderr"), "");
  utimesSync(join(root, "agents", "old.stderr"), (NOW - 5 * DAY) / 1000, (NOW - 5 * DAY) / 1000);
  utimesSync(join(root, "agents", "new.stderr"), NOW / 1000, NOW / 1000);
  const removed = sweepLogs(root, 3, NOW).map((path) => path.slice(root.length + 1)).sort();
  assert.deepEqual(removed, ["agent/2026-11-22.jsonl", "agents/old.stderr"]);
  assert.ok(existsSync(join(root, "agent", "2026-11-24.jsonl")), "three days back is kept");
});

test("every source merged by time, filtered by time, source, agent and session", () => {
  const root = mkdtempSync(join(tmpdir(), "log-"));
  const at = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();
  new LogFiles(root, "hub").append([{ at: at(2), level: "info", source: "hub", event: "hap", req: "x" }]);
  new LogFiles(root, "tui").append([{ at: at(1), level: "info", source: "tui", event: "req", req: "x" }]);
  new LogFiles(root, "agent").append([
    { at: at(3), level: "info", source: "agent", event: "request", req: "x", agent: "a1", session: "s1" },
    { at: at(-90), level: "info", source: "agent", event: "old", agent: "a1" },
  ]);
  assert.deepEqual(
    readLogs(root, { since: NOW }).map((record) => `${record.source}:${record.event}`),
    ["tui:req", "hub:hap", "agent:request"],
  );
  assert.deepEqual(
    readLogs(root, { agent: "a1" }).map((record) => record.event),
    ["old", "request"],
  );
  assert.deepEqual(
    readLogs(root, { sources: ["hub"], last: 1 }).map((record) => record.event),
    ["hap"],
  );
  assert.deepEqual(
    readLogs(root, { session: "s1" }).map((record) => record.event),
    ["request"],
  );
});
