// harness — the command line.
//
//   harness [-c | --continue] [--session <id>] [--model <ref>]   the TUI; a new session in the current directory
//   harness node [--name <name>] [--config <f>]  a node: agents of this user, a unix socket,
//                                                links to the hubs of ~/.harness/nodes/<name>.json
//   harness hub [--name <name>] [--listen h:p]   a node with the hub role: devices and nodes over WebSocket
//   harness hub user|device|node …               the hub's users, devices and nodes
//   harness remote add|remove|list               the hubs this client connects to
//
// The TUI connects to the user's running node (~/.harness/sockets/default.sock), or runs a node of
// its own — agents as its children, the same socket for other clients — while it is open.

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appWebDir, serveStatic } from "#node/endpoints/static.ts";
import { startWebApp } from "#node/webapp.ts";
import type { Transport } from "#protocol/node.ts";
import { parseArgs } from "node:util";
import { sessionDirectory } from "./args.ts";
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
import { claudeBridge } from "./claude-bridge.ts";
import { piCommand } from "./pi-command.ts";
import { canExecUpdate, checkUpdates, detectInstall, execUpdate, updateHint, updateLines, type Install, type UpdateState } from "./update.ts";
import { readRemotes } from "./remotes.ts";
import { App, clientThemes } from "#tui/app.ts";
import { loadRenderers } from "#tui/presentation.ts";

const DEFAULT_NODE = "default";

/** A terminal draws extensions' components (the component bridge). */
const TUI_CAPABILITIES = ["component-bridge" as const];

function harnessVersion(): string {
  const path = process.env.HARNESS_MANIFEST;
  if (path === undefined || path === "") {
    return "dev";
  } else {
    return (JSON.parse(readFileSync(path, "utf8")) as { harness: string }).harness;
  }
}

/** A tool of the bundle (its manifest's `bin`). */
function manifestBin(name: string): string | undefined {
  const path = process.env.HARNESS_MANIFEST;
  if (path === undefined || path === "") {
    return undefined;
  } else {
    return (JSON.parse(readFileSync(path, "utf8")) as { bin?: Record<string, string> }).bin?.[name];
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
  const node = new HarnessNode({ name, dataDir: home, harnessVersion: harnessVersion(), users: config.users, ...(config.server === true ? { agentEnv: { HARNESS_SERVER: "1" } } : {}) });
  const path = socketPath(home, name);
  const server = await listenUnix(node, path);
  process.stderr.write(`harness node ${name}: ${path}\n`);

  const listen = values.listen ?? config.hub?.listen;
  // a hub also serves the app's web build (devices open it in a browser)
  const appWeb = appWebDir();
  const web = asHub || listen !== undefined ? await listenWs(node, new Hub(node), { ...parseListen(listen ?? "8790"), ...(appWeb !== undefined ? { http: serveStatic(appWeb) } : {}) }) : undefined;
  if (web !== undefined) {
    process.stderr.write(`harness hub ${name}: ws://${listen ?? "127.0.0.1:8790"}\n`);
  } else {
    // not a hub
  }
  node.telemetry.log({ event: "node_start", roles: web !== undefined ? ["node", "hub"] : ["node"] });

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

/**
 * This user's node on this machine: the one running under its socket (a service, another client),
 * or one inside this process, which then also listens on the socket for the user's other clients.
 */
async function localNode(home: string): Promise<{ transport: () => Promise<Transport>; embedded: { node: HarnessNode; close(): Promise<void> } | undefined }> {
  const path = socketPath(home, DEFAULT_NODE);
  if (await socketAlive(path)) {
    return { transport: () => unixTransport(path), embedded: undefined };
  } else {
    const node = new HarnessNode({ name: DEFAULT_NODE, dataDir: home, harnessVersion: harnessVersion() });
    const server = await listenUnix(node, path).catch(() => undefined);
    return {
      transport: async () => inProcessTransport(node),
      embedded: {
        node,
        close: async () => {
          server?.close();
          await node.close();
        },
      },
    };
  }
}

/**
 * `harness web-app`: the app's web build in a window of the bundled browser (an app window: no tabs,
 * no address bar), served on 127.0.0.1 with a token only this window has, connected to this user's
 * node. Closing the window ends it; a node inside this process stops its agents with it.
 */
async function runWebApp(): Promise<void> {
  const home = harnessHome();
  ensureHome(home);
  process.env.PI_CODING_AGENT_DIR = home;
  const staticDir = appWebDir();
  const browser = process.env.HARNESS_BROWSER ?? manifestBin("browser");
  if (staticDir === undefined) {
    process.stderr.write("harness web-app: this bundle has no web build of the app (share/harness/app-web)\n");
    process.exit(1);
  } else if (browser === undefined) {
    process.stderr.write("harness web-app: no browser (the bundle's, or HARNESS_BROWSER)\n");
    process.exit(1);
  } else {
    const local = await localNode(home);
    const app = await startWebApp({ staticDir, open: local.transport });
    const profile = mkdtempSync(join(tmpdir(), "harness-web-app-"));
    const window = spawn(browser, [`--app=${app.url}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--class=harness", "--window-size=1400,900"], { stdio: "ignore" });
    const end = async (code: number): Promise<void> => {
      app.close();
      await local.embedded?.close();
      rmSync(profile, { recursive: true, force: true });
      process.exit(code);
    };
    window.on("exit", () => void end(0));
    window.on("error", (error) => {
      process.stderr.write(`harness web-app: ${error.message}\n`);
      void end(1);
    });
    process.on("SIGTERM", () => window.kill());
    process.on("SIGINT", () => window.kill());
  }
}

async function runTui(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { continue: { type: "boolean", short: "c" }, session: { type: "string" }, model: { type: "string", short: "m" } },
  });
  const home = harnessHome();
  ensureHome(home);
  const cwd = sessionDirectory(positionals);
  // pi's theme loader finds custom themes under its agent directory: ~/.harness/themes
  process.env.PI_CODING_AGENT_DIR = home;
  const settings = SettingsManager.create(cwd, home);

  const local = await localNode(home);
  const embedded = local.embedded;
  const open = async (): Promise<NodeConnection> => NodeConnection.open(await local.transport(), "tui", undefined, TUI_CAPABILITIES);

  // the local node, then the remote hubs: each reconnects by itself after a loss
  const client = new ClientModel();
  const nodeName = await client.addEndpoint(open, { home: true });
  for (const remote of readRemotes(home)) {
    await client
      .addEndpoint(async () => NodeConnection.open(await wsTransport(remote.url), "tui", remote.token, TUI_CAPABILITIES), { home: false })
      .catch((error: unknown) => client.offline.set(remote.name, error instanceof Error ? error.message : String(error)));
  }
  // the bundle's update: checked in the background, upgraded from the panel
  let updateState: UpdateState = { kind: "checking" };
  let install: Install = { kind: "system" };
  let upgrade: (() => void) | undefined;
  const manifestPath = process.env.HARNESS_MANIFEST;
  if (manifestPath !== undefined && manifestPath !== "") {
    void Promise.all([checkUpdates(harnessVersion(), fetch), detectInstall(manifestPath)]).then(([state, found]) => {
      updateState = state;
      install = found;
      client.changed();
    });
  } else {
    updateState = { kind: "dev" };
  }
  const workbench = new Workbench(client, {
    cwd,
    themes: () => clientThemes(home),
    update: {
      hint: () => updateHint(updateState, Date.now()),
      lines: () => updateLines(updateState, install, Date.now()),
      canRun: () => updateState.kind === "available" && install.kind === "profile" && canExecUpdate(),
      run: async () => upgrade?.(),
    },
  });
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
  // --model: the session starts on this model reference (a family takes its newest model)
  const started = workbench.activeTab();
  if (values.model !== undefined && started?.agent !== undefined) {
    await client
      .connection(started.node)
      .call(started.agent.id, { type: "harness_set", model: values.model })
      .catch((error: unknown) => process.stderr.write(`--model ${values.model}: ${error instanceof Error ? error.message : String(error)}\n`));
  } else {
    // the session's own model
  }

  let app: App | undefined;
  const quit = async (): Promise<void> => {
    app?.stop();
    client.dispose();
    await embedded?.close();
    process.exit(0);
  };
  upgrade = () => {
    if (install.kind === "profile") {
      const element = install.element;
      app?.stop();
      client.dispose();
      void (embedded?.close() ?? Promise.resolve()).then(() => execUpdate(element));
    } else {
      // a system configuration updates the bundle
    }
  };
  app = new App({ client, workbench, renderers, cwd, settings, onQuit: () => void quit() });
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
        await hubAdmin(harnessHome(), rest);
      } else {
        await runNode(rest, true);
      }
      break;
    case "remote":
      ensureHome(harnessHome());
      await remoteAdmin(harnessHome(), rest);
      break;
    case "web-app":
      await runWebApp();
      break;
    case "claude-bridge":
      await claudeBridge(rest[0]);
      break;
    case "auth":
    case "config":
    case "mcp":
    case "install":
    case "remove":
    case "uninstall":
    case "list":
    case "update":
      process.exitCode = piCommand(harnessHome(), [command, ...rest]);
      break;
    case "--version":
    case "-v":
      process.stdout.write(`${harnessVersion()}\n`);
      break;
    case "--help":
    case "-h":
      process.stdout.write(
        [
          "harness [dir] [-c] [--session <id>] [-m <model>]   the TUI: a new session in dir (default: here);",
          "                                            -c the latest of dir; model: provider/family[:thinking] or an id",
          "harness node [--name <name>]                a node for this user",
          "harness hub [--name <name>] [--listen h:p]  a node with the hub role",
          "harness hub user|device|node add|remove|revoke|list …",
          "harness remote add|remove|list              hubs this client connects to",
          "harness web-app                             the app in a window, on this user's node",
          "harness auth|config|mcp|install|remove|list|update …   pi's commands on ~/.harness",
          "harness claude-bridge mcp|hook              run by Claude Code for harness (subagents)",
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
