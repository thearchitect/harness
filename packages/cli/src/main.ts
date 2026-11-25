// harness — the command line.
//
//   harness [-c | --continue] [--session <id>]   the TUI; a new session in the current directory
//   harness node [--name <name>] [--config <f>]  a node: agents of this user, a unix socket,
//                                                links to the hubs of ~/.harness/nodes/<name>.json
//   harness hub [--name <name>] [--listen h:p]   a node with the hub role: devices and nodes over WebSocket
//   harness hub user|device|node …               the hub's users, devices and nodes
//   harness remote add|remove|list               the hubs this client connects to
//
// The TUI connects to the user's running node (~/.harness/sockets/default.sock), or runs a node of
// its own — agents as its children, the same socket for other clients — while it is open.

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { NodeConnection } from "#client/connection.ts";
import { ClientModel } from "#client/model/client-model.ts";
import { Workbench } from "#client/workbench/workbench.ts";
import { wsTransport } from "#client/ws-transport.ts";
import { hubKey, parseListen, readNodeConfig } from "#node/config.ts";
import { harnessHome, ensureHome } from "#node/home.ts";
import { Hub } from "#node/hub.ts";
import { HarnessNode } from "#node/node.ts";
import { inProcessTransport, unixTransport } from "#node/endpoints/transports.ts";
import { listenUnix, socketAlive, socketPath } from "#node/endpoints/unix.ts";
import { listenWs } from "#node/endpoints/ws.ts";
import { Uplink } from "#node/uplink.ts";
import { hubAdmin, remoteAdmin } from "./admin.ts";
import { readRemotes } from "./remotes.ts";
import { App, initClientTheme } from "#tui/app.ts";
import { loadRenderers } from "#tui/presentation.ts";

const DEFAULT_NODE = "default";

function harnessVersion(): string {
  const path = process.env.HARNESS_MANIFEST;
  if (path === undefined || path === "") {
    return "dev";
  } else {
    return (JSON.parse(readFileSync(path, "utf8")) as { harness: string }).harness;
  }
}

function piExtensions(): string[] {
  const path = process.env.HARNESS_MANIFEST;
  if (path === undefined || path === "") {
    return [];
  } else {
    return (JSON.parse(readFileSync(path, "utf8")) as { piExtensions?: string[] }).piExtensions ?? [];
  }
}

/** A node, and a hub too when asked: its socket, its WebSocket endpoint, its links to hubs. */
async function runNode(args: string[], asHub: boolean): Promise<void> {
  const { values } = parseArgs({ args, options: { name: { type: "string" }, listen: { type: "string" }, config: { type: "string" } } });
  const home = harnessHome();
  ensureHome(home);
  const name = values.name ?? (asHub ? "hub" : DEFAULT_NODE);
  const config = readNodeConfig(home, name, values.config);
  const node = new HarnessNode({ name, dataDir: home, harnessVersion: harnessVersion(), users: config.users });
  const path = socketPath(home, name);
  const server = await listenUnix(node, path);
  process.stderr.write(`harness node ${name}: ${path}\n`);

  const listen = values.listen ?? config.hub?.listen;
  const web = asHub || listen !== undefined ? await listenWs(node, new Hub(node), parseListen(listen ?? "8790")) : undefined;
  if (web !== undefined) {
    process.stderr.write(`harness hub ${name}: ws://${listen ?? "127.0.0.1:8790"}\n`);
  } else {
    // not a hub
  }

  const uplinks = (config.hubs ?? []).map((hub) => {
    const uplink = new Uplink(node, { url: hub.url, key: () => hubKey(hub), onState: (state, detail) => process.stderr.write(`hub ${hub.url}: ${state}${detail !== undefined ? ` (${detail})` : ""}\n`) });
    uplink.start();
    return uplink;
  });

  const stop = async (): Promise<void> => {
    for (const uplink of uplinks) {
      uplink.stop();
    }
    web?.close();
    server.close();
    await node.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
}

async function runTui(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { continue: { type: "boolean", short: "c" }, session: { type: "string" } } });
  const home = harnessHome();
  ensureHome(home);
  const cwd = process.cwd();
  initClientTheme(SettingsManager.create(cwd, home).getTheme());

  const path = socketPath(home, DEFAULT_NODE);
  let embedded: { node: HarnessNode; close(): Promise<void> } | undefined;
  let open: () => Promise<NodeConnection>;
  if (await socketAlive(path)) {
    open = async () => NodeConnection.open(await unixTransport(path), "tui");
  } else {
    const node = new HarnessNode({ name: DEFAULT_NODE, dataDir: home, harnessVersion: harnessVersion() });
    const server = await listenUnix(node, path).catch(() => undefined);
    embedded = {
      node,
      close: async () => {
        server?.close();
        await node.close();
      },
    };
    open = () => NodeConnection.open(inProcessTransport(node), "tui");
  }

  // the local node, then the remote hubs: each reconnects by itself after a loss
  const client = new ClientModel();
  const nodeName = await client.addEndpoint(open, { home: true });
  for (const remote of readRemotes(home)) {
    await client
      .addEndpoint(async () => NodeConnection.open(await wsTransport(remote.url), "tui", remote.token), { home: false })
      .catch((error: unknown) => client.offline.set(remote.name, error instanceof Error ? error.message : String(error)));
  }
  const workbench = new Workbench(client);
  const renderers = await loadRenderers(cwd, piExtensions());

  // What this start opens: the session asked for, the latest of this directory, or a new one.
  if (values.session !== undefined || values.continue === true) {
    const sessions = await client.sessions(nodeName);
    const wanted =
      values.session !== undefined
        ? sessions.find((session) => session.id.startsWith(values.session ?? ""))
        : sessions.filter((session) => session.cwd === cwd).sort((a, b) => b.modified - a.modified)[0];
    if (wanted !== undefined) {
      await workbench.openSession(nodeName, wanted);
    } else {
      process.stderr.write(values.session !== undefined ? `no session ${values.session}\n` : "no session in this directory yet: starting a new one\n");
      await workbench.newTab(nodeName, cwd);
    }
  } else {
    await workbench.newTab(nodeName, cwd);
  }

  let app: App | undefined;
  const quit = async (): Promise<void> => {
    app?.stop();
    client.dispose();
    await embedded?.close();
    process.exit(0);
  };
  app = new App({ client, workbench, renderers, cwd, onQuit: () => void quit() });
  await app.start();
  await app.loadCompletions().catch(() => undefined);
  process.on("SIGTERM", () => void quit());
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "node":
      await runNode(rest, false);
      break;
    case "hub":
      if (rest[0] !== undefined && ["user", "device", "node"].includes(rest[0])) {
        hubAdmin(harnessHome(), rest);
      } else {
        await runNode(rest, true);
      }
      break;
    case "remote":
      ensureHome(harnessHome());
      await remoteAdmin(harnessHome(), rest);
      break;
    case "--help":
    case "-h":
      process.stdout.write(
        [
          "harness [-c] [--session <id>]               the TUI",
          "harness node [--name <name>]                a node for this user",
          "harness hub [--name <name>] [--listen h:p]  a node with the hub role",
          "harness hub user|device|node add|remove|revoke|list …",
          "harness remote add|remove|list              hubs this client connects to",
          "",
        ].join("\n"),
      );
      break;
    default:
      await runTui(process.argv.slice(2));
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`harness: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
