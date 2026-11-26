import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { initialHarnessState } from "#protocol/state.ts";
import type { SnapshotData } from "#protocol/hap.ts";
import { AgentModel } from "./agent-model.ts";

const session = {
  sessionId: "s",
  cwd: "/p",
  thinkingLevel: "off",
  activity: "idle" as const,
  queue: { steering: [], followUp: [] },
  usage: { costUsd: 0 },
};

function snapshot(entries: unknown[]): SnapshotData {
  return { entries, session, state: initialHarnessState(), interactions: [], status: {} };
}

describe("the agent model", () => {
  test("a snapshot's entries become transcript items; hidden and bookkeeping entries do not", () => {
    const model = new AgentModel("a1");
    model.loadSnapshot(
      snapshot([
        { type: "message", id: "1", message: { role: "user", content: "hi" } },
        { type: "custom", id: "2", customType: "harness-mode", data: { mode: "plan" } },
        { type: "custom_message", id: "3", customType: "x", content: "c", display: false },
        { type: "model_change", id: "4" },
        { type: "compaction", id: "5", summary: "s", tokensBefore: 10 },
      ]),
    );
    assert.deepEqual(model.items.map((item) => item.kind), ["message", "custom", "compaction"]);
  });

  test("a streamed message grows from deltas and becomes an item at its end; hidden context is not drawn", () => {
    const model = new AgentModel("a1");
    model.loadSnapshot(snapshot([]));
    model.apply({ type: "message_start", message: { role: "assistant", content: [] } });
    model.apply({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    model.apply({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" } });
    model.apply({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" } });
    assert.deepEqual(model.streaming?.content, [{ type: "text", text: "Hello" }]);
    model.apply({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hello" }] } });
    model.apply({ type: "message_end", message: { role: "custom", display: false, content: "<active-mode />" } });
    assert.equal(model.streaming, undefined);
    assert.equal(model.items.length, 1);
  });

  test("interactions open and close; statuses and notices follow harness_ui", () => {
    const model = new AgentModel("a1");
    model.loadSnapshot(snapshot([]));
    model.apply({ type: "harness_interaction_request", request: { id: "i1", kind: "choice", payload: { title: "t", options: [] }, openedAt: 1 } });
    assert.equal(model.interactions.length, 1);
    model.apply({ type: "harness_interaction_closed", interactionId: "i1", reason: "answered" });
    assert.equal(model.interactions.length, 0);
    model.apply({ type: "harness_ui", method: "status", key: "mc", text: "idle" });
    model.apply({ type: "harness_ui", method: "notify", message: "hello", level: "warning" });
    assert.deepEqual(model.status, { mc: "idle" });
    assert.equal(model.notices.at(-1)?.message, "hello");
    model.apply({ type: "harness_ui", method: "status", key: "mc" });
    assert.deepEqual(model.status, {});
  });

  test("a link for the operator's browser: once per request, and in the notices", () => {
    const model = new AgentModel("a1");
    model.apply({ type: "harness_ui", method: "open_url", url: "https://auth.example/a" });
    assert.deepEqual(model.openUrl, { seq: 1, url: "https://auth.example/a" });
    assert.match(model.notices.at(-1)?.message ?? "", /https:\/\/auth\.example\/a/);
    model.apply({ type: "harness_ui", method: "open_url", url: "https://auth.example/a" });
    assert.equal(model.openUrl?.seq, 2, "the same link asked again opens again");
  });
});
