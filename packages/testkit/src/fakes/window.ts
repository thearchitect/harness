// A client window for tests of the local hub (local.ts): it connects to the user's hub or holds
// one, as the TUI does, and reconnects after a loss. It reports every welcome on stdout as a JSON
// line ({ pid, host, holding }) and takes commands on stdin: `restart` (hub_restart), `quit` (closes
// the hub it holds and exits).
//
//   node window.ts <home> <harness version>

import { createInterface } from "node:readline";
import { HubConnection } from "#client/connection.ts";
import { ClientModel } from "#client/model/client-model.ts";
import { LocalHub } from "#hub/local.ts";

const [home = "", version = "test"] = process.argv.slice(2);
const local = new LocalHub({ home, name: "default", harnessVersion: version });
const client = new ClientModel();

function report(line: object): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

const open = async (): Promise<HubConnection> => {
  const connection = await HubConnection.open(await local.transport(), "test-window", undefined, []);
  const welcome = connection.welcome;
  if (welcome !== undefined) {
    local.observe(welcome.host);
    report({ pid: welcome.pid, host: welcome.host, harness: welcome.harness, holding: local.hub !== undefined });
  } else {
    // refused: the open rejects instead
  }
  return connection;
};

await client.addEndpoint(open, { home: true }).catch((error: unknown) => report({ error: error instanceof Error ? error.message : String(error) }));

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line === "restart") {
    void client
      .connection("default")
      .request("hub_restart", {})
      .catch((error: unknown) => report({ error: error instanceof Error ? error.message : String(error) }));
  } else if (line === "quit") {
    client.dispose();
    void local.close().then(() => process.exit(0));
  } else {
    report({ error: `unknown command ${line}` });
  }
});
process.on("SIGTERM", () => {
  client.dispose();
  void local.close().then(() => process.exit(0));
});
