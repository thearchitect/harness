// A client names its hubs itself (the TUI's own one is `local`, remotes by remotes.json), whatever
// a hub calls itself: a new session's tab finds its agent, follows it in full and answers; a stored
// session opened again does too. (The bundle af6df52 compared the hub's own name with the client's
// and every tab showed a session no agent served.)

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ClientModel } from "#client/model/client-model.ts";
import { Workbench } from "#client/workbench/workbench.ts";
import { createStand, type Stand } from "#testkit/stand/stand.ts";
import { Logger, type LogRecord } from "#protocol/log.ts";

const stands: Stand[] = [];
const clients: ClientModel[] = [];
after(async () => {
  for (const client of clients) {
    client.dispose();
  }
  for (const stand of stands) {
    await stand.down();
  }
});

async function until(check: () => boolean, what: string): Promise<void> {
  for (let tries = 0; !check(); tries += 1) {
    assert.ok(tries < 200, what);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("tabs find their agents on a hub the client names otherwise", async () => {
  const stand = await createStand({ name: "default" });
  stands.push(stand);
  const client = new ClientModel();
  clients.push(client);
  const errors: LogRecord[] = [];
  client.log = new Logger("tui", (record) => (record.level === "error" ? errors.push(record) : undefined));
  await client.addEndpoint(() => stand.connect("unix"), { home: true, name: "local" });
  const workbench = new Workbench(client, { cwd: stand.project, prefetch: false });
  stand.script([{ text: "an answer here" }]);

  const tab = await workbench.newTab("local", stand.project);
  assert.equal(tab?.agent?.hub, "local");
  assert.equal(tab?.agent?.sessionId, tab?.sessionId);
  const key = `local/${tab?.agent?.id ?? ""}`;
  await until(() => client.full.has(key), "the tab's agent is followed in full");

  await workbench.prompt("a question", "plan");
  await until(() => JSON.stringify(client.full.get(key)?.items ?? []).includes("an answer here"), "the answer arrives");
  const file = tab?.agent?.sessionFile ?? "";

  // the session closed and opened again from its file: the same
  await client.connection("local").request("agent_close", { agent: tab?.agent?.id ?? "" });
  await until(() => workbench.tabs().every((candidate) => candidate.agent === undefined), "its agent is gone");
  await workbench.openSession("local", { id: tab?.sessionId ?? "", path: file, cwd: stand.project });
  await until(() => workbench.activeTab()?.agent !== undefined, "the stored session's tab finds its new agent");
  assert.deepEqual(
    errors.map((record) => record.event),
    [],
  );
});
