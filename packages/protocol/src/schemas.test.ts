import assert from "node:assert/strict";
import { test } from "node:test";
import { HAP_REQUEST_TYPES } from "./hap.ts";
import { NODE_OPS } from "./node.ts";
import { checkClientFrame, checkHapRequest, HAP_REQUEST_SCHEMAS, OP_SCHEMAS } from "./schemas.ts";

test("every operation and every harness request has a schema", () => {
  assert.deepEqual(Object.keys(OP_SCHEMAS).sort(), [...NODE_OPS].sort());
  assert.deepEqual(Object.keys(HAP_REQUEST_SCHEMAS).sort(), [...HAP_REQUEST_TYPES].sort());
});

test("client frames: well-formed pass; a broken one names the frame or operation it broke", () => {
  assert.deepEqual(checkClientFrame({ k: "hello", protocol: 1, client: "tui" }), { ok: true });
  assert.deepEqual(checkClientFrame({ k: "req", id: "1", op: "agent_attach", args: { agent: "a", level: "full" } }), { ok: true });
  assert.deepEqual(checkClientFrame({ k: "hap", agent: "a", rec: { type: "prompt" } }), { ok: true });

  const cases: [unknown, RegExp][] = [
    [{ k: "nope" }, /unknown frame "nope"/],
    [null, /unknown frame/],
    [{ k: "hello", protocol: "1", client: "tui" }, /hello frame/],
    [{ k: "req", id: "1", op: "agent_attach", args: { agent: "a", level: "most" } }, /agent_attach.*\/level/],
    [{ k: "req", id: "1", op: "drop_tables", args: {} }, /unknown operation drop_tables/],
    [{ k: "hap", agent: "a", rec: {} }, /hap frame/],
  ];
  for (const [frame, error] of cases) {
    const checked = checkClientFrame(frame);
    assert.equal(checked.ok, false, JSON.stringify(frame));
    assert.match(checked.ok ? "" : checked.error, error);
  }
});

test("harness requests", () => {
  assert.deepEqual(checkHapRequest({ type: "harness_prompt", id: "1", text: "hi", mode: "plan" } as never), { ok: true });
  const bad = checkHapRequest({ type: "harness_prompt", id: "1", text: "hi", mode: "yolo" } as never);
  assert.match(bad.ok ? "" : bad.error, /harness_prompt.*\/mode/);
  const missing = checkHapRequest({ type: "harness_task_output", id: "1", taskId: "t" } as never);
  assert.equal(missing.ok, false);
});
