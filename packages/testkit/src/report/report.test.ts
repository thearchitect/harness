// The report of a failing scenario (a fixture that fails on purpose) holds what plan 16.3 lists:
// report.md with the step and the error, the protocol, the agents' logs, the sessions, each
// client's model, the screens at the failing step and at the last step that passed.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defineScenario, ScenarioRun } from "../scenario/scenario.ts";

test("a failing step leaves a complete report", async () => {
  process.env.HARNESS_TEST_REPORTS = mkdtempSync(join(tmpdir(), "reports-"));
  const run = await ScenarioRun.up(
    defineScenario({
      name: "fails on purpose",
      clients: { tui: { kind: "tui" }, raw: { kind: "raw" } },
      steps: [
        {
          name: "a turn",
          async run({ stand, clients: { tui } }) {
            stand.script([{ text: "first answer" }]);
            await tui.type("hello");
            await tui.submit();
            await tui.waitForText((screen) => screen.includes("first answer"));
          },
        },
        {
          name: "expects the impossible",
          async run({ clients: { tui } }) {
            assert.equal(tui.screen().tabs.length, 99, "ninety-nine tabs");
          },
        },
      ],
    }),
  );
  try {
    await run.step();
    await assert.rejects(run.step(), /ninety-nine tabs/);
    const dir = run.report.dir;
    const report = readFileSync(join(dir, "report.md"), "utf8");
    assert.match(report, /failed at "expects the impossible"/);
    assert.match(report, /✓ a turn/);
    assert.match(report, /ninety-nine tabs/);
    assert.ok(readFileSync(join(dir, "protocol", "tui.jsonl"), "utf8").includes('"op":"agent_start"'));
    assert.ok(existsSync(join(dir, "protocol", "raw.jsonl")));
    assert.ok(readdirSync(join(dir, "logs", "agents")).length > 0, "the agents' logs");
    assert.ok(existsSync(join(dir, "sessions")), "the sessions");
    assert.ok(JSON.parse(readFileSync(join(dir, "model", "tui.json"), "utf8")).screen.tabs.length === 1);
    assert.ok(existsSync(join(dir, "screens", "expects-the-impossible-tui.txt")));
    assert.ok(existsSync(join(dir, "screens", "a-turn-tui.txt")), "the last passed step's screen");
    assert.match(readFileSync(join(dir, "screens", "a-turn-tui.txt"), "utf8"), /first answer/);
  } finally {
    await run.down();
  }
});
