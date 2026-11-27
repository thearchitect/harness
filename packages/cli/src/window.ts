// A TUI window, put together the one way: the client model with its hubs named by this client
// (this machine's `local`, remotes by remotes.json), its log, the workbench, the window as it was
// left, what this start opens, the app. `harness` runs it on the process's terminal and this
// machine's hub; the tests run the very same with a virtual terminal and a stand's hub — only the
// effects outside the window (terminal, clipboard, browser, where views are kept) are given.

import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { KeybindingsConfig, Terminal } from "@earendil-works/pi-tui";
import { hostname } from "node:os";
import type { HubConnection } from "#client/connection.ts";
import { ClientLog } from "#client/model/client-log.ts";
import { ClientModel } from "#client/model/client-model.ts";
import type { ViewStateStore } from "#client/workbench/view-state.ts";
import { Workbench, type UpdateHook } from "#client/workbench/workbench.ts";
import { LogFiles, sweepLogs } from "#hub/log-files.ts";
import { layoutOf } from "#protocol/layout.ts";
import { isLogLevel } from "#protocol/log.ts";
import { App, clientThemes } from "#tui/app.ts";
import type { Clipboard } from "#tui/clipboard.ts";
import { copyToClipboard } from "#tui/pi-internals.ts";
import { loadRenderers } from "#tui/presentation.ts";
import { redeemPairing } from "./admin.ts";
import { addRemote, type Remote } from "./remotes.ts";

/** This machine's hub, as every window names it. */
export const LOCAL_HUB = "local";

/** What a start opens (harness's arguments). */
export type WindowStart =
  /** The window as it was left: its tabs, or choosing a new session's folder without any. */
  | { kind: "as-left" }
  /** `harness <dir>`: a new session in the directory. */
  | { kind: "new" }
  /** `harness -c`: the latest session of the directory (a new one without). */
  | { kind: "continue" }
  /** `harness --session <id>`: that session. */
  | { kind: "session"; id: string };

export type WindowOptions = {
  /** The harness home (its layout: log/tui, client/, the themes). */
  home: string;
  /** Where new sessions start. */
  cwd: string;
  version: string;
  /** A connection to this machine's hub (each reconnect calls it again). */
  connectLocal: () => Promise<HubConnection>;
  remotes: Remote[];
  connectRemote: (remote: Remote) => Promise<HubConnection>;
  start: WindowStart;
  /** `--model`: the started session's model. */
  model?: string;
  settings: SettingsManager;
  keybindings?: KeybindingsConfig;
  /** pi extensions whose renderers the transcript uses. */
  extensions: string[];
  /** Whether this window holds the hub (it stops with it). */
  holdsHome: () => boolean;
  update?: UpdateHook;
  /** Where the window keeps its view (the TUI's file; none: not kept). */
  viewStore?: ViewStateStore;
  /** Whether the window keeps its log on disk while no hub takes it (the TUI: log/tui). */
  ownLog: boolean;
  onQuit(): void;
  /** What a start could not do (`--session` not found): the process's stderr. */
  onProblem(message: string): void;
  /** The effects outside the window; the process's terminal, the system clipboard, the browser by default. */
  terminal?: Terminal;
  clipboard?: Clipboard;
  openUrl?: (url: string) => void;
  copyText?: (text: string) => Promise<void>;
};

export type HarnessWindow = {
  client: ClientModel;
  workbench: Workbench;
  app: App;
  log: ClientLog;
};

export async function startWindow(options: WindowOptions): Promise<HarnessWindow> {
  const client = new ClientModel();
  const copyText = options.copyText ?? copyToClipboard;

  // the log first: everything after it is logged, to the hub (this machine's keeps log/tui)
  let log: ClientLog;
  {
    const files = new LogFiles(layoutOf(options.home).log, "tui");
    log = new ClientLog({
      source: "tui",
      base: { client: `tui-${hostname()}-${process.pid}`, pid: process.pid },
      ...(options.ownLog ? { local: { store: { append: (records) => files.append(records), sweep: (days) => void sweepLogs(files.root, days) }, mirror: false } } : {}),
      upload: () => (client.connections.has(LOCAL_HUB) ? (records) => client.connection(LOCAL_HUB).request("logs_put", { records }) : undefined),
      level: () => {
        const level = client.settings["log.level"];
        return isLogLevel(level) ? level : "info";
      },
    });
    client.log = log.logger;
    client.log.info("start", { harness: options.version, argv: process.argv.slice(2), cwd: options.cwd, columns: process.stdout.columns, rows: process.stdout.rows, term: process.env.TERM, program: process.env.TERM_PROGRAM });
  }

  // this machine's hub, then the remote ones: each reconnects by itself after a loss
  await client.addEndpoint(options.connectLocal, { home: true, name: LOCAL_HUB });
  for (const remote of options.remotes) {
    await client
      .addEndpoint(() => options.connectRemote(remote), { home: false, name: remote.name })
      .catch((error: unknown) => client.offline.set(remote.name, error instanceof Error ? error.message : String(error)));
  }

  const workbench = new Workbench(client, {
    cwd: options.cwd,
    holdsHome: options.holdsHome,
    copyText: (text) => void copyText(text),
    // + add in the strip: a hub's address and its one-time code; the token goes to remotes.json
    addHub: async (url, code) => {
      const name = new URL(url).hostname;
      const { token } = await redeemPairing(url, code, hostname());
      const remote: Remote = { name, url, token };
      addRemote(options.home, remote);
      await client.addEndpoint(() => options.connectRemote(remote), { home: false, name });
    },
    themes: () => clientThemes(options.home),
    ...(options.viewStore !== undefined ? { viewStore: options.viewStore } : {}),
    ...(options.update !== undefined ? { update: options.update } : {}),
  });
  const renderers = await loadRenderers(options.cwd, options.extensions);
  // the window as it was left: each tab's scroll and expanded output, the active tab, the hub
  await workbench.restoreViews();
  await openStart(client, workbench, options);

  const app = new App({
    client,
    workbench,
    renderers,
    cwd: options.cwd,
    settings: options.settings,
    ...(options.keybindings !== undefined ? { keybindings: options.keybindings } : {}),
    onQuit: options.onQuit,
    ...(options.terminal !== undefined ? { terminal: options.terminal } : {}),
    ...(options.clipboard !== undefined ? { clipboard: options.clipboard } : {}),
    ...(options.openUrl !== undefined ? { openUrl: options.openUrl } : {}),
    copyText,
  });
  await app.start();
  return { client, workbench, app, log };
}

/** What this start opens, then `--model` on the session it started. */
async function openStart(client: ClientModel, workbench: Workbench, options: WindowOptions): Promise<void> {
  const start = options.start;
  switch (start.kind) {
    case "session":
    case "continue": {
      const sessions = await client.sessions(LOCAL_HUB);
      const wanted =
        start.kind === "session"
          ? sessions.find((session) => session.id.startsWith(start.id))
          : sessions.filter((session) => session.cwd === options.cwd).sort((a, b) => b.modified - a.modified)[0];
      if (wanted !== undefined) {
        await workbench.openSession(LOCAL_HUB, wanted);
      } else {
        options.onProblem(start.kind === "session" ? `no session ${start.id}` : "no session in this directory yet: starting a new one");
        await workbench.newTab(LOCAL_HUB, options.cwd);
      }
      break;
    }
    case "new":
      await workbench.newTab(LOCAL_HUB, options.cwd);
      break;
    case "as-left":
      if (workbench.tabs().length === 0) {
        workbench.openNewSession(LOCAL_HUB);
      } else {
        // the window's tabs: the active one opens
      }
      break;
    default:
      throw new Error(`unknown start: ${JSON.stringify(start satisfies never)}`);
  }

  const started = workbench.activeTab();
  if (options.model !== undefined && started?.agent !== undefined) {
    await client
      .connection(started.hub)
      .call(started.agent.id, { type: "harness_set", model: options.model })
      .catch((error: unknown) => options.onProblem(`--model ${options.model}: ${error instanceof Error ? error.message : String(error)}`));
  } else {
    // the session's own model
  }
}
