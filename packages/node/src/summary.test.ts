import assert from "node:assert/strict";
import { test } from "node:test";
import { initialHarnessState } from "#protocol/state.ts";
import { SummaryTracker } from "./summary.ts";

test("a summary follows runs, interactions, tasks and the outcome of the last run", () => {
  const tracker = new SummaryTracker(0);
  assert.equal(tracker.apply({ type: "agent_start" }, 1), true);
  assert.equal(tracker.current.status, "running");
  tracker.apply({ type: "harness_interaction_request", request: { id: "i1" } }, 2);
  assert.equal(tracker.current.status, "waiting");
  assert.equal(tracker.current.waiting, 1);
  tracker.apply({ type: "harness_interaction_closed", interactionId: "i1" }, 3);
  assert.equal(tracker.current.status, "running");
  tracker.apply({ type: "harness_state", state: { ...initialHarnessState(), mode: "build", tasks: [{ id: "t1", source: "own", command: "x", cwd: "/", state: "running", startedAt: 0, outputBytes: 0, notify: "wake" }] } }, 4);
  assert.deepEqual(tracker.current.tasks, { running: 1, failed: 0 });
  assert.equal(tracker.current.mode, "build");
  tracker.apply({ type: "agent_settled", aborted: false }, 5);
  assert.equal(tracker.current.status, "idle");
  assert.equal(tracker.current.lastOutcome, "ok");
  assert.equal(tracker.current.lastActivity, 5);
  assert.equal(tracker.apply({ type: "turn_start" }, 6), false);
});
