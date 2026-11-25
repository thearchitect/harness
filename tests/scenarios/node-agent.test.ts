// A node runs an agent for a client: the client starts it, attaches with a snapshot, prompts in
// BUILD, answers the gate the agent opens for a file change, and sees the run settle. The same
// over a unix socket, with a second client that sees the first one's answer close its gate.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { InteractionRequest } from "#protocol/interactions.ts";
import { createStand, nextRecord, type Stand } from "#testkit/stand/stand.ts";

describe("node and agent", () => {
  const stands: Stand[] = [];
  after(async () => {
    for (const stand of stands) {
      await stand.down();
    }
  });

  test("a BUILD prompt's file change waits for the operator, is written on Allow, and the run settles", async () => {
    const stand = await createStand();
    stands.push(stand);
    stand.script([
      { text: "writing", toolCalls: [{ name: "write", args: { path: "hello.txt", content: "hi\n" } }] },
      { text: "done" },
    ]);
    const client = await stand.connect();
    const { agent } = await client.request("agent_start", { cwd: stand.project });
    const { snapshot } = await client.request("agent_attach", { agent: agent.id, level: "full" });
    assert.equal(snapshot?.session.cwd, stand.project);
    assert.equal(snapshot?.state.variant, "advanced");

    const gate = nextRecord(client, agent.id, (record) => record.type === "harness_interaction_request");
    await client.call(agent.id, { type: "harness_prompt", text: "write hello", mode: "build" });
    const request = (await gate).request as InteractionRequest;
    assert.equal(request.kind, "gate");
    assert.deepEqual(request.kind === "gate" && request.payload.paths, ["hello.txt"]);
    assert.equal(existsSync(join(stand.project, "hello.txt")), false);

    const settled = nextRecord(client, agent.id, (record) => record.type === "agent_settled");
    const answered = await client.call<{ accepted: boolean }>(agent.id, { type: "harness_interaction_response", interactionId: request.id, answer: { action: "allow" } });
    assert.equal(answered.accepted, true);
    await settled;
    assert.equal(readFileSync(join(stand.project, "hello.txt"), "utf8"), "hi\n");
  });

  test("two clients over the unix socket: the first answer closes the gate for both", async () => {
    const stand = await createStand();
    stands.push(stand);
    stand.script([{ toolCalls: [{ name: "write", args: { path: "a.txt", content: "a" } }] }, { text: "ok" }]);
    const first = await stand.connect("unix");
    const second = await stand.connect("unix");
    const { agent } = await first.request("agent_start", { cwd: stand.project });
    await first.request("agent_attach", { agent: agent.id, level: "full" });
    await second.request("agent_attach", { agent: agent.id, level: "full" });

    const seenBySecond = nextRecord(second, agent.id, (record) => record.type === "harness_interaction_request");
    await first.call(agent.id, { type: "harness_prompt", text: "write a", mode: "build" });
    const request = (await seenBySecond).request as InteractionRequest;

    const closedForFirst = nextRecord(first, agent.id, (record) => record.type === "harness_interaction_closed");
    await second.call(agent.id, { type: "harness_interaction_response", interactionId: request.id, answer: { action: "reject", comment: "not now" } });
    const closed = await closedForFirst;
    assert.equal(closed.reason, "answered");
    const late = await first.call<{ accepted: boolean }>(agent.id, { type: "harness_interaction_response", interactionId: request.id, answer: { action: "allow" } });
    assert.equal(late.accepted, false);
    assert.equal(existsSync(join(stand.project, "a.txt")), false);
  });

  test("PLAN refuses a project change without asking; the model is told where it may write", async () => {
    const stand = await createStand();
    stands.push(stand);
    stand.script([{ toolCalls: [{ name: "write", args: { path: "b.txt", content: "b" } }] }, { text: "understood" }]);
    const client = await stand.connect();
    const { agent } = await client.request("agent_start", { cwd: stand.project });
    await client.request("agent_attach", { agent: agent.id, level: "full" });
    const result = nextRecord(client, agent.id, (record) => record.type === "tool_execution_end");
    await client.call(agent.id, { type: "harness_prompt", text: "plan it", mode: "plan" });
    const end = await result;
    assert.equal(end.isError, true);
    assert.match(JSON.stringify(end.result), /PLAN allows write only inside/);
    assert.equal(existsSync(join(stand.project, "b.txt")), false);
  });
});
