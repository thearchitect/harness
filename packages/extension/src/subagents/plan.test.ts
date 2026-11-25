// A subagent's plan: which files are taken (a markdown file in the project or the session workspace,
// not too large), and what the subagent's message carries (the plan whole, its diff, or nothing).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { splitPlanMessage } from "#protocol/plan.ts";
import { PLAN_MAX_BYTES, planMessage, readPlan } from "./plan.ts";

function project(): { ctx: ExtensionContext; root: string; outside: string } {
  const base = mkdtempSync(join(tmpdir(), "plan-"));
  const root = join(base, "project");
  const outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  const ctx = { cwd: root, sessionManager: { getHeader: () => null } } as unknown as ExtensionContext;
  return { ctx, root, outside };
}

test("a plan is a markdown file in the project or the session workspace, at most PLAN_MAX_BYTES", async () => {
  const { ctx, root, outside } = project();
  writeFileSync(join(root, "plan.md"), "# Plan\n");
  assert.deepEqual(await readPlan(ctx, "plan.md"), { path: join(root, "plan.md"), text: "# Plan\n" });
  mkdirSync(join(root, ".agent-workspace-tmp", "handover"), { recursive: true });
  writeFileSync(join(root, ".agent-workspace-tmp", "handover", "p.md"), "x");
  assert.equal((await readPlan(ctx, ".agent-workspace-tmp/handover/p.md")).text, "x");

  await assert.rejects(readPlan(ctx, "missing.md"), /no such file/);
  writeFileSync(join(root, "plan.txt"), "x");
  await assert.rejects(readPlan(ctx, "plan.txt"), /not a markdown file/);
  writeFileSync(join(outside, "plan.md"), "x");
  await assert.rejects(readPlan(ctx, join(outside, "plan.md")), /outside the project/);
  writeFileSync(join(root, "big.md"), "x".repeat(PLAN_MAX_BYTES + 1));
  await assert.rejects(readPlan(ctx, "big.md"), /more than/);
});

test("the message carries the plan whole when the subagent has not seen it, its diff when it changed, nothing when the same", () => {
  const plan = { path: "/p/plan.md", text: "# Plan\n\nA\n\nB\n" };
  assert.equal(planMessage("Do A.", undefined, undefined), "Do A.");

  const first = planMessage("Do A.", plan, undefined);
  assert.equal(first, "Do A.\n\n<plan path=\"/p/plan.md\">\n# Plan\n\nA\n\nB\n</plan>");
  assert.deepEqual(splitPlanMessage(first), { instruction: "Do A.", plan: { path: "/p/plan.md", text: "# Plan\n\nA\n\nB" } });
  assert.equal(planMessage("Do A.", plan, { path: "/p/other.md", text: "x" }), first, "another plan goes whole");

  assert.equal(planMessage("Now B.", plan, plan), "Now B.");

  const changed = planMessage("Now B.", { path: plan.path, text: "# Plan\n\nA\n\nB2\n" }, plan);
  assert.match(changed, /^Now B\.\n\n<plan-update path="\/p\/plan\.md">\nThe plan changed since your last instruction:/);
  assert.match(changed, /-B\n\+B2/);
  assert.deepEqual(splitPlanMessage("just text"), { instruction: "just text" });
});
