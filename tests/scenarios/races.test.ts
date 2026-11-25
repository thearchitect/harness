// Several clients of one node at the same time: two opening one session get one agent; two changing
// the tab set keep both changes; two messages with their own modes arriving together leave the run
// in the mode of the one it started with (the other one steers it).

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { ClientModel } from "#client/model/client-model.ts";
import { createStand, nextRecord, type Stand } from "#testkit/stand/stand.ts";

describe("clients at the same time", () => {
  const stands: Stand[] = [];
  after(async () => {
    for (const stand of stands) {
      await stand.down();
    }
  });

  test("two clients opening one session get one agent", async () => {
    const stand = await createStand();
    stands.push(stand);
    stand.script([{ text: "hello" }]);
    const first = await stand.connect();
    const { agent } = await first.request("agent_start", { cwd: stand.project });
    await first.request("agent_attach", { agent: agent.id, level: "full" });
    const settled = nextRecord(first, agent.id, (record) => record.type === "agent_settled");
    await first.call(agent.id, { type: "harness_prompt", text: "hi" });
    await settled;
    await first.request("agent_close", { agent: agent.id });

    const second = await stand.connect("unix");
    const [a, b] = await Promise.all([
      first.request("agent_start", { cwd: stand.project, sessionFile: agent.sessionFile }),
      second.request("agent_start", { cwd: stand.project, sessionFile: agent.sessionFile }),
    ]);
    assert.equal(a.agent.id, b.agent.id);
    assert.equal((await first.request("agents_list", {})).agents.filter((candidate) => candidate.sessionFile === agent.sessionFile).length, 1);
  });

  test("two clients changing the tab set at once keep both changes", async () => {
    const stand = await createStand();
    stands.push(stand);
    const clients = [new ClientModel(), new ClientModel()];
    for (const client of clients) {
      await client.addEndpoint(() => stand.connect("unix"), { home: true });
    }
    const tab = (id: string) => ({ node: "test", sessionId: id, cwd: stand.project });
    await Promise.all(
      clients.flatMap((client, index) =>
        [0, 1, 2].map((n) => client.updateSetting<unknown[]>("ui.tabs", (current) => [...(current ?? []), tab(`s${index}-${n}`)])),
      ),
    );
    const { settings } = await (await stand.connect()).request("settings_get", {});
    const ids = (settings["ui.tabs"] as { sessionId: string }[]).map((record) => record.sessionId).sort();
    assert.deepEqual(ids, ["s0-0", "s0-1", "s0-2", "s1-0", "s1-1", "s1-2"]);
    for (const client of clients) {
      client.dispose();
    }
  });

  test("two messages with their modes at once: the run keeps the first one's mode", async () => {
    const stand = await createStand();
    stands.push(stand);
    stand.script([{ text: "planned", delayMs: 300 }, { text: "more" }]);
    const client = await stand.connect();
    const { agent } = await client.request("agent_start", { cwd: stand.project });
    await client.request("agent_attach", { agent: agent.id, level: "full" });
    const settled = nextRecord(client, agent.id, (record) => record.type === "agent_settled");
    await Promise.all([
      client.call(agent.id, { type: "harness_prompt", text: "first", mode: "plan" }),
      client.call(agent.id, { type: "harness_prompt", text: "second", mode: "build" }),
    ]);
    await settled;
    const first = JSON.stringify(stand.requests()[0]);
    assert.match(first, /first/);
    assert.match(first, /active-mode mode=\\"plan\\"/);
  });
});
