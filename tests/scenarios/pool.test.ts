// The hub's pool: an agent nobody follows, with no run, interaction or task, is unloaded after the
// idle time (its session stays and opens again); a followed one stays; at the agent limit the
// oldest idle agent makes room, and with none idle the start is refused.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ManualClock } from "#protocol/clock.ts";
import { IDLE_UNLOAD_MS } from "#hub/hub.ts";
import { createStand, type Stand } from "#testkit/stand/stand.ts";

const stands: Stand[] = [];
after(async () => {
  for (const stand of stands) {
    await stand.down();
  }
});

function agentsGone(stand: Stand, count: number): Promise<void> {
  return new Promise((resolve) => {
    const check = async (): Promise<void> => {
      const client = await stand.connect();
      const { agents } = await client.request("agents_list", {});
      client.close();
      if (agents.length === count) {
        resolve();
      } else {
        setTimeout(() => void check(), 50);
      }
    };
    void check();
  });
}

test("idle agents are unloaded; followed ones stay", { timeout: 60_000 }, async () => {
  const clock = new ManualClock(1_000_000);
  const stand = await createStand({ clock });
  stands.push(stand);
  const client = await stand.connect();
  const idle = (await client.request("agent_start", { cwd: stand.project })).agent;
  const followed = (await client.request("agent_start", { cwd: stand.project })).agent;
  await client.request("agent_attach", { agent: followed.id, level: "full" });

  // the checks run every minute: step past the idle time one check at a time
  for (let passed = 0; passed <= IDLE_UNLOAD_MS + 120_000; passed += 60_000) {
    clock.advance(60_000);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await agentsGone(stand, 1);
  const { agents } = await client.request("agents_list", {});
  assert.deepEqual(
    agents.map((agent) => agent.id),
    [followed.id],
  );
  assert.notEqual(idle.id, followed.id);
});

test("at the limit the oldest idle agent makes room; with none idle the start is refused", { timeout: 60_000 }, async () => {
  const stand = await createStand({ maxAgents: 1 });
  stands.push(stand);
  const client = await stand.connect();
  const first = (await client.request("agent_start", { cwd: stand.project })).agent;
  const second = (await client.request("agent_start", { cwd: stand.project })).agent;
  const { agents } = await client.request("agents_list", {});
  assert.deepEqual(
    agents.map((agent) => agent.id),
    [second.id],
  );
  assert.notEqual(first.id, second.id);

  await client.request("agent_attach", { agent: second.id, level: "full" });
  await assert.rejects(client.request("agent_start", { cwd: stand.project }), /none is idle/);
});
