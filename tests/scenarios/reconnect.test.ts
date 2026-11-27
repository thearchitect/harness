// A client that loses its hub comes back by itself: the hub shows offline meanwhile, and after
// the reconnection the agent it followed is followed again with a fresh snapshot.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { HubConnection } from "#client/connection.ts";
import { agentKey, ClientModel } from "#client/model/client-model.ts";
import { inProcessTransport } from "#hub/endpoints/transports.ts";
import { ManualClock } from "#protocol/clock.ts";
import type { Transport } from "#protocol/hub.ts";
import { createStand, type Stand } from "#testkit/stand/stand.ts";

const stands: Stand[] = [];
after(async () => {
  for (const stand of stands) {
    await stand.down();
  }
});

test("a lost connection is reopened; followed agents are followed again", async () => {
  const stand = await createStand();
  stands.push(stand);
  const clock = new ManualClock();
  let transport: Transport | undefined;
  const client = new ClientModel();
  const node = await client.addEndpoint(
    () => {
      transport = inProcessTransport(stand.hub);
      return HubConnection.open(transport, "test");
    },
    { home: true, clock },
  );
  const { agent } = await client.connection(node).request("agent_start", { cwd: stand.project });
  await client.follow(node, agent.id);
  const before = client.full.get(agentKey(node, agent.id));

  transport?.close();
  assert.ok(client.offline.has(node), "offline while the connection is lost");
  assert.equal(client.full.has(agentKey(node, agent.id)), false);

  clock.advance(500);
  await new Promise<void>((resolve) => {
    const off = client.onChange(() => {
      if (client.full.has(agentKey(node, agent.id))) {
        off();
        resolve();
      } else {
        // still reconnecting
      }
    });
  });
  assert.equal(client.offline.has(node), false);
  assert.notEqual(client.full.get(agentKey(node, agent.id)), before, "a fresh model from a new snapshot");
  client.dispose();
});
