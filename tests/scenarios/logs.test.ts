// The log across the parts: a message sent from the TUI is one request id in the TUI's records (sent,
// answered), the hub's (passed to the agent) and the agent's (taken, with its text), and the run's
// answer is in the agent's; `harness logs` reads them merged; a secret's value never is in the log.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { HubConnection } from "#client/connection.ts";
import { inProcessTransport } from "#hub/endpoints/transports.ts";
import { readLogs } from "#hub/log-files.ts";
import { TuiDriver } from "#testkit/drivers/tui.ts";
import { createStand, type Stand } from "#testkit/stand/stand.ts";

const stands: Stand[] = [];
const drivers: TuiDriver[] = [];
after(async () => {
  for (const driver of drivers) {
    driver.stop();
  }
  for (const stand of stands) {
    await stand.down();
  }
});

test("one request id from the TUI through the hub to the agent; the answer in the agent's log", async () => {
  const stand = await createStand();
  stands.push(stand);
  const tui = await TuiDriver.start(() => HubConnection.open(inProcessTransport(stand.hub), "tui", undefined, ["component-bridge"]), { cwd: stand.project, log: true });
  drivers.push(tui);
  stand.script([{ text: "the logged answer" }]);
  await tui.type("a message worth logging");
  await tui.submit();
  await tui.waitForText((screen) => screen.includes("the logged answer"));
  await tui.flushLog();

  const root = stand.layout.log;
  let records = readLogs(root);
  for (let tries = 0; !records.some((record) => record.source === "agent" && record.event === "answer") && tries < 100; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    records = readLogs(root);
  }
  const sent = records.find((record) => record.source === "tui" && record.event === "res" && record.op === "harness_prompt");
  assert.ok(sent !== undefined, `the TUI's record of the prompt: ${records.map((record) => `${record.source}:${record.event}:${String(record.op ?? record.type ?? "")}`).join(" ")}`);
  const req = String(sent.req);
  const passed = records.find((record) => record.source === "hub" && record.event === "hap" && record.req === req && record.type === "harness_prompt");
  assert.ok(passed !== undefined, "the hub passed it on");
  const taken = records.find((record) => record.source === "agent" && record.event === "request" && record.req === passed.forwarded);
  assert.equal(taken?.text, "a message worth logging", `the agent took it, with its text: ${JSON.stringify(records.filter((record) => record.source === "agent").map((record) => [record.event, record.req, record.type]))}`);
  assert.ok(typeof taken?.agent === "string" && typeof taken.session === "string", "the hub adds the agent and its session");
  assert.ok(records.some((record) => record.source === "agent" && record.event === "answer" && record.text === "the logged answer"), "the run's answer");
  assert.ok(records.some((record) => record.source === "hub" && record.event === "op" && record.op === "agent_start"), "operations with their times");

  // the scripted provider's key is in auth.json: it is nowhere in the log
  const everything = readdirSync(root, { recursive: true })
    .map(String)
    .filter((path) => path.endsWith(".jsonl"))
    .map((path) => readFileSync(join(root, path), "utf8"))
    .join("");
  assert.ok(!everything.includes('"key":"scripted"'));
});
