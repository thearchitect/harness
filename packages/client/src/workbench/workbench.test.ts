import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentSummary } from "#protocol/node.ts";
import { glyphOf } from "./workbench.ts";

const base: AgentSummary = { status: "idle", mode: "plan", title: "t", waiting: 0, tasks: { running: 0, failed: 0 }, lastActivity: 100, costUsd: 0 };

describe("the row glyph", () => {
  test("one glyph by priority: unavailable, waiting, failed unseen, running, done unseen, nothing", () => {
    const cases: [Partial<AgentSummary> | undefined, number | undefined, string | undefined, string][] = [
      [{ waiting: 1, status: "running" }, undefined, "node offline", "⊘"],
      [{ waiting: 1, status: "waiting", lastOutcome: "error" }, undefined, undefined, "◆"],
      [{ lastOutcome: "error", status: "running" }, undefined, undefined, "✗"],
      [{ status: "running", lastOutcome: "ok" }, undefined, undefined, "●"],
      [{ lastOutcome: "ok" }, undefined, undefined, "✓"],
      [{}, undefined, undefined, " "],
      [undefined, undefined, undefined, " "],
    ];
    for (const [summary, seen, unavailable, glyph] of cases) {
      assert.equal(glyphOf(summary === undefined ? undefined : { ...base, ...summary }, seen, unavailable), glyph, JSON.stringify(summary));
    }
  });

  test("seeing the last activity clears ✓ and ✗, not ◆ or ●", () => {
    assert.equal(glyphOf({ ...base, lastOutcome: "ok" }, 100, undefined), " ");
    assert.equal(glyphOf({ ...base, lastOutcome: "error" }, 100, undefined), " ");
    assert.equal(glyphOf({ ...base, lastOutcome: "ok" }, 99, undefined), "✓");
    assert.equal(glyphOf({ ...base, waiting: 1 }, 100, undefined), "◆");
    assert.equal(glyphOf({ ...base, status: "running" }, 100, undefined), "●");
  });
});
