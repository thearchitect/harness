// harness — the command line.
//
//   harness [-c | --continue] [--session <id>] [--model <ref>]   the TUI; a new session in the current directory
//   harness hub [--config <f>]                   the user's hub as a service: agents of this user, a unix
//                                                socket, devices over the network when it is on
//   harness hub attach                           stdio to this machine's running hub (ssh runs it)
//   harness hub device|network …                 the devices paired with the hub, its network access
//   harness connect <address>                    another machine's hub (ssh://, a pairing link)
//   harness remote list|remove                   other machines' hubs this client connects to
//
// The TUI connects to the user's running hub (~/.harness/run/hub.sock), or runs the hub
// itself — agents as its children, the same socket for other clients — while it is open.

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { KeybindingsConfig } from "@earendil-works/pi-tui";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { hostname } from "node:os";
import { appWebDir } from "#hub/endpoints/static.ts";
import { startWebApp } from "#hub/webapp.ts";
import type { Transport } from "#protocol/hub.ts";
import { parseArgs } from "node:util";
import { sessionDirectory } from "./args.ts";
import { HubConnection } from "#client/connection.ts";
import { ClientModel } from "#client/model/client-model.ts";
import { Workbench } from "#client/workbench/workbench.ts";
import { wsTransport } from "#client/ws-transport.ts";
import { readHubConfig } from "#hub/config.ts";
import { layoutOf } from "#protocol/layout.ts";
import { harnessHome, ensureHome } from "#hub/home.ts";
import { LocalHub, quitQuestion, versionProblem } from "#hub/local.ts";
import { Hub } from "#hub/hub.ts";
import { networkOf } from "#hub/network.ts";
import { listenUnix, socketAlive, socketPath } from "#hub/endpoints/unix.ts";
import { sshTransport } from "#hub/endpoints/transports.ts";
import { connect, hubAdmin, redeemPairing, remoteAdmin } from "./admin.ts";
import { claudeBridge } from "./claude-bridge.ts";
import { piCommand } from "./pi-command.ts";
import { canExecUpdate, checkUpdates, detectInstall, execUpdate, updateHint, updateLines, type Install, type UpdateState } from "./update.ts";
import { addRemote, readRemotes, type Remote } from "./remotes.ts";
import { App, clientThemes } from "#tui/app.ts";
import { loadRenderers } from "#tui/presentation.ts";
import { tuiViewStore } from "#tui/view-store.ts";
import { copyToClipboard } from "#tui/pi-internals.ts";

const DEFAULT_HUB = "default";
/** How a client names its own machine's hub (the strip reads `inprocess` while this window holds it). */
const LOCAL_HUB = "local";

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

/** The user's hub as a service: its socket, and its network endpoint when it listens. */
async function runHub(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { config: { type: "string" } } });
  const home = harnessHome();
  await openHome(home);
  const name = DEFAULT_HUB;
  const config = readHubConfig(home, values.config);
  const hub = new Hub({
    name,
    dataDir: home,
    harnessVersion: harnessVersion(),
    ...(config.server === true ? { agentEnv: { HARNESS_SERVER: "1" } } : {}),
    // the configuration's network access wins over the user's setting (the /hub dialog shows it read-only)
    ...(config.network !== undefined ? { network: networkOf({ enabled: true, ...config.network }) } : {}),
    // hub_restart: a service exits with a failure code; its supervisor (systemd, s6) starts it again
    restart: () => stop(EXIT_RESTART),
  });
  const path = socketPath(home);
  const server = await listenUnix(hub, path);
  process.stderr.write(`harness hub: ${path}\n`);
  await hub.network.apply();
  const network = hub.network.status();
  process.stderr.write(network.running ? `harness hub: network on ${hub.network.settings().listen}\n` : network.problem !== undefined ? `harness hub: network off: ${network.problem}\n` : "");
  hub.telemetry.log({ event: "hub_start", network: network.running });

  const stop = async (code: number): Promise<void> => {
    server.close();
    await hub.close();
    process.exit(code);
  };
  process.on("SIGTERM", () => void stop(0));
  process.on("SIGINT", () => void stop(0));

  // asleep when nobody is there and nothing works (a Fly machine stops with it; the next request wakes it)
  const idleExit = config.idleExit;
  if (idleExit !== undefined) {
    let idleSince = Date.now();
    setInterval(() => {
      if (!hub.asleepAllowed()) {
        idleSince = Date.now();
      } else if (Date.now() - idleSince >= idleExit * 60_000) {
        hub.telemetry.log({ event: "idle_exit", minutes: idleExit });
        void stop(EXIT_IDLE);
      } else {
        // idle, not long enough yet
      }
    }, IDLE_CHECK_MS).unref();
  } else {
    // always on
  }
}

/** How often an idle service checks whether to go to sleep. */
const IDLE_CHECK_MS = 15_000;

/** A service's exit when idle: a success, so its supervisor lets it be (s6's finish stops the machine). */
const EXIT_IDLE = 0;

/**
 * `harness hub attach`: this process's stdin and stdout joined to this machine's running hub (ssh
 * runs it for a client elsewhere). It never starts a hub; with none running it says so and fails.
 */
async function attachHub(home: string): Promise<void> {
  const path = socketPath(home);
  if (!(await socketAlive(path))) {
    process.stderr.write(`harness: no hub runs for ${process.env.USER ?? "this user"}@${hostname()} (start the service, or open harness there)\n`);
    process.exit(EXIT_NO_HUB);
  } else {
    const socket = createConnection(path);
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
    socket.on("close", () => process.exit(0));
    socket.on("error", (error) => {
      process.stderr.write(`harness: the hub's socket: ${error.message}\n`);
      process.exit(EXIT_NO_HUB);
    });
    process.stdin.on("end", () => socket.end());
  }
}

/** `harness hub attach` without a running hub. */
const EXIT_NO_HUB = 69;

/** Another machine's hub: over the network with this device's token, or over SSH (never asking: BatchMode). */
async function openRemote(remote: Remote): Promise<HubConnection> {
  const transport = "ssh" in remote ? await sshTransport(remote) : await wsTransport(remote.url);
  return await HubConnection.open(transport, "tui", "ssh" in remote ? undefined : remote.token, TUI_CAPABILITIES);
}

/**
 * The home ready for use, moved from the flat layout of earlier versions when it is one: what the
 * move did goes to stderr, and its lines are returned for the window to show.
 */
async function openHome(home: string): Promise<string[]> {
  const migration = await ensureHome(home);
  const lines =
    migration.moved.length > 0
      ? [`${home} moved to its new layout (${migration.moved.length} steps); the old one is in ${migration.backup ?? "no backup"}`, ...migration.notes]
      : migration.notes;
  for (const line of lines) {
    process.stderr.write(`harness: ${line}\n`);
  }
  return lines;
}

/** A service's exit for hub_restart: a failure, so `Restart=on-failure` starts it again. */
const EXIT_RESTART = 75;

/** Ends a client that cannot use the local hub (another version runs it). */
function refuse(problem: string): never {
  process.stderr.write(`${problem}\n`);
  process.exit(1);
}

/**
 * `harness web-app`: the app's web build in a window of the bundled browser (an app window: no tabs,
 * no address bar), served on 127.0.0.1 with a token only this window has, connected to this user's
 * hub. Closing the window ends it; a hub inside this process stops its agents with it.
 */
async function runWebApp(): Promise<void> {
  const home = harnessHome();
  await openHome(home);
  process.env.PI_CODING_AGENT_DIR = layoutOf(home).agent;
  const staticDir = appWebDir();
  const browser = process.env.HARNESS_BROWSER ?? manifestBin("browser");
  if (staticDir === undefined) {
    process.stderr.write("harness web-app: this bundle has no web build of the app (share/harness/app-web)\n");
    process.exit(1);
  } else if (browser === undefined) {
    process.stderr.write("harness web-app: no browser (the bundle's, or HARNESS_BROWSER)\n");
    process.exit(1);
  } else {
    const local = new LocalHub({ home, name: DEFAULT_HUB, harnessVersion: harnessVersion() });
    // the hub this window would use: another version's is refused before the window opens
    const probe = await HubConnection.open(await local.transport(), "web-app", undefined, []);
    const problem = probe.welcome !== undefined ? versionProblem(harnessVersion(), probe.welcome) : undefined;
    probe.close();
    if (problem !== undefined) {
      refuse(problem);
    } else {
      // this version's hub
    }
    const app = await startWebApp({ staticDir, open: () => local.transport() });
    const profile = mkdtempSync(join(tmpdir(), "harness-web-app-"));
    const window = spawn(browser, [`--app=${app.url}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--class=harness", "--window-size=1400,900"], { stdio: "ignore" });
    const end = async (code: number): Promise<void> => {
      app.close();
      await local.close();
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
  const moved = await openHome(home);
  const cwd = sessionDirectory(positionals);
  // pi's theme loader finds custom themes under its agent directory: ~/.harness/agent/themes
  const agentDir = layoutOf(home).agent;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const settings = SettingsManager.create(cwd, agentDir);
  const keybindingsFile = join(agentDir, "keybindings.json");
  const keybindings = existsSync(keybindingsFile) ? (JSON.parse(readFileSync(keybindingsFile, "utf8")) as KeybindingsConfig) : {};

  // the local node: another window's or a service's under the socket, or held in this process
  const local = new LocalHub({ home, name: DEFAULT_HUB, harnessVersion: harnessVersion() });
  let workbench: Workbench | undefined;
  let app: App | undefined;
  let last: { host: string; pid: number } | undefined;
  let interrupted = 0;
  const open = async (): Promise<HubConnection> => {
    const connection = await HubConnection.open(await local.transport(), "tui", undefined, TUI_CAPABILITIES);
    const welcome = connection.welcome;
    if (welcome === undefined) {
      throw new Error("the node did not welcome this client");
    } else {
      local.observe(welcome.host);
      const problem = versionProblem(harnessVersion(), welcome);
      if (problem !== undefined) {
        app?.stop();
        refuse(problem);
      } else if (last !== undefined && last.host === "client" && last.pid !== welcome.pid && workbench !== undefined) {
        workbench.notify("info", `hub ${welcome.hub} moved to ${local.hub !== undefined ? "this window" : "another window"}; ${interrupted} sessions were interrupted`);
      } else {
        // the first connection, or the same hub again
      }
      last = { host: welcome.host, pid: welcome.pid };
      // before the client model drops the hub's agents: how many were working when it went away
      connection.onClose(() => {
        interrupted = [...client.agents.values()].filter((agent) => agent.hub === welcome.hub && agent.summary.status !== "idle").length;
      });
      return connection;
    }
  };

  // the local hub, then the remote hubs: each reconnects by itself after a loss
  const client = new ClientModel();
  const localHub = await client.addEndpoint(open, { home: true, name: LOCAL_HUB });
  for (const remote of readRemotes(home)) {
    await client
      .addEndpoint(() => openRemote(remote), { home: false, name: remote.name })
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
  workbench = new Workbench(client, {
    cwd,
    holdsHome: () => local.hub !== undefined,
    // OSC 52: the terminal puts it on this machine's clipboard (over SSH too)
    copyText: (text) => void copyToClipboard(text),
    // + add in the strip: a hub's address and its one-time code; the token goes to remotes.json
    addHub: async (url, code) => {
      const name = new URL(url).hostname;
      const { token } = await redeemPairing(url, code, hostname());
      const remote: Remote = { name, url, token };
      addRemote(home, remote);
      await client.addEndpoint(() => openRemote(remote), { home: false, name });
    },
    themes: () => clientThemes(home),
    viewStore: tuiViewStore(home),
    update: {
      hint: () => updateHint(updateState, Date.now()),
      lines: () => updateLines(updateState, install, Date.now()),
      canRun: () => updateState.kind === "available" && install.kind === "profile" && canExecUpdate(),
      run: async () => upgrade?.(),
    },
  });
  const renderers = await loadRenderers(cwd, piExtensions());
  // the window as it was left: each tab's draft and scroll, the active tab, the hub
  await workbench.restoreViews();

  // What this start opens: the session asked for; the latest of this directory; a new one in the
  // directory given; else the window as it was, or choosing a new session's folder without tabs.
  if (values.session !== undefined || values.continue === true) {
    const sessions = await client.sessions(localHub);
    const wanted =
      values.session !== undefined
        ? sessions.find((session) => session.id.startsWith(values.session ?? ""))
        : sessions.filter((session) => session.cwd === cwd).sort((a, b) => b.modified - a.modified)[0];
    if (wanted !== undefined) {
      await workbench.openSession(localHub, wanted);
    } else {
      process.stderr.write(values.session !== undefined ? `no session ${values.session}\n` : "no session in this directory yet: starting a new one\n");
      await workbench.newTab(localHub, cwd);
    }
  } else if (positionals.length > 0) {
    await workbench.newTab(localHub, cwd);
  } else if (workbench.tabs().length === 0) {
    workbench.openNewSession(localHub);
  } else {
    // the window's tabs: the active one opens (start)
  }
  // --model: the session starts on this model reference (a family takes its newest model)
  const started = workbench.activeTab();
  if (values.model !== undefined && started?.agent !== undefined) {
    await client
      .connection(started.hub)
      .call(started.agent.id, { type: "harness_set", model: values.model })
      .catch((error: unknown) => process.stderr.write(`--model ${values.model}: ${error instanceof Error ? error.message : String(error)}\n`));
  } else {
    // the session's own model
  }

  // a window that holds the hub stops it with it: asked first when agents work or other windows use it
  const quit = async (confirmed: boolean): Promise<void> => {
    const question = quitQuestion(local.hub?.activity());
    if (!confirmed && question !== undefined && workbench !== undefined) {
      workbench.confirm(question, "Quit", () => quit(true));
    } else {
      await app?.keepWindow();
      app?.stop();
      client.dispose();
      await local.close();
      process.exit(0);
    }
  };
  upgrade = () => {
    if (install.kind === "profile") {
      const element = install.element;
      void app?.keepWindow();
      app?.stop();
      client.dispose();
      void local.close().then(() => execUpdate(element));
    } else {
      // a system configuration updates the bundle
    }
  };
  app = new App({ client, workbench, renderers, cwd, settings, keybindings, onQuit: () => void quit(false) });
  await app.start();
  // what moving the home to its layout did, where the window shows it
  if (moved.length > 0) {
    workbench.notify("warning", moved.join(" · "));
  } else {
    // the home was in its layout already
  }
  await app.loadCompletions().catch(() => undefined);
  process.on("SIGTERM", () => void quit(true));
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "hub":
      if (rest[0] === "device" || rest[0] === "network") {
        await hubAdmin(harnessHome(), rest);
      } else if (rest[0] === "attach") {
        await attachHub(harnessHome());
      } else {
        await runHub(rest);
      }
      break;
    case "connect":
      await openHome(harnessHome());
      await connect(harnessHome(), rest);
      break;
    case "remote":
      await openHome(harnessHome());
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
      await openHome(harnessHome());
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
          "harness [dir] [-c] [--session <id>] [-m <model>]   the TUI: without dir the window as it was (no tabs:",
          "                                            choose a folder); with dir a new session in it (. is here);",
          "                                            -c the latest of dir; model: provider/family[:thinking] or an id",
          "harness hub [--config F]                    the user's hub as a service (without a window)",
          "harness hub attach                          stdio to this machine's running hub (what ssh runs)",
          "harness hub device add|list|rename|revoke …  devices paired with the hub",
          "harness hub network [on|off] [--listen h:p] [--proxy] [--url U]   its network access (behind a TLS proxy)",
          "harness connect <ssh://user@host | link>    another machine's hub, over SSH or by a pairing link",
          "harness remote list|remove <name>           other machines' hubs this client connects to",
          "harness web-app                             the app in a window, on this user's hub",
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
