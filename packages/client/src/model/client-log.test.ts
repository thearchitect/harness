// A client's log: records gather and go to the hub in a batch; a hub that fails takes them later,
// in order; without a hub the client keeps them itself; a mirroring client keeps every record.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { LogRecord } from "#protocol/log.ts";
import { ClientLog, type LogStore } from "./client-log.ts";

function store(): LogStore & { kept: LogRecord[] } {
  const kept: LogRecord[] = [];
  return { kept, append: (records) => void kept.push(...records), sweep: () => undefined };
}

test("records go to the hub in a batch; a failed batch goes again before the newer ones", async () => {
  const sent: string[][] = [];
  let failing = true;
  const log = new ClientLog({
    source: "tui",
    base: { client: "c1" },
    upload: () => async (records) => {
      if (failing) {
        throw new Error("hub gone");
      } else {
        sent.push(records.map((record) => record.event));
      }
    },
    level: () => "info",
  });
  log.logger.info("one");
  log.logger.debug("hidden");
  await log.flush();
  assert.deepEqual(sent, []);
  failing = false;
  log.logger.info("two");
  await log.flush();
  assert.deepEqual(sent, [["one", "two"]]);
});

test("without a hub the client keeps its records; a mirror keeps every one", async () => {
  const own = store();
  let hub: ((records: LogRecord[]) => Promise<unknown>) | undefined;
  const log = new ClientLog({ source: "tui", base: {}, local: { store: own, mirror: false }, upload: () => hub, level: () => "info" });
  log.logger.info("alone");
  await log.flush();
  assert.deepEqual(
    own.kept.map((record) => record.event),
    ["alone"],
  );

  const mirror = store();
  const uploaded: string[] = [];
  hub = async (records) => uploaded.push(...records.map((record) => record.event));
  const app = new ClientLog({ source: "app", base: { client: "a" }, local: { store: mirror, mirror: true }, upload: () => hub, level: () => "info" });
  app.logger.warn("seen", { message: "x" });
  await app.flush();
  assert.deepEqual(
    mirror.kept.map((record) => [record.event, record.level, record.client]),
    [["seen", "warn", "a"]],
  );
  assert.deepEqual(uploaded, ["seen"]);
});
