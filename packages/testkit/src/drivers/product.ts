// The product as the operator runs it: the real `harness` of a bundle (or the checkout's) in a
// pseudo-terminal on a stand's home, its hub held by that window as on any machine, and the real
// web app that hub serves, paired by a one-time link like any browser. Nothing of the window is put
// together by the test: keys go in as a terminal sends them (legacy bytes, or the kitty protocol
// when the driver answers pi-tui's query for it), the screen comes back through a headless xterm.

import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import nodePty from "node-pty";
import xterm from "@xterm/headless";
import { HubConnection } from "#client/connection.ts";
import { GLOBAL_ACTIONS, globalKeys, type GlobalActionId } from "#client/input/actions.ts";
import { unixTransport } from "#hub/endpoints/transports.ts";
import { socketPath } from "#hub/endpoints/unix.ts";
import { encodeKey, keyFromId, type KeyModes } from "#client/terminal-keys.ts";
import type { StandHome } from "../stand/stand.ts";
import { screenCells, screenText, type Cell } from "./terminal.ts";
import { WebDriver, type WebDriverOptions } from "./web.ts";

const run = promisify(execFile);

export type ProductOptions = {
  /** The bundle's directory (HARNESS_BUNDLE); its bin/harness runs. */
  bundle: string;
  home: StandHome;
  /** `harness`'s arguments: a new session in the stand's project by default (`harness <dir>`). */
  args?: string[];
  columns?: number;
  rows?: number;
  /** The terminal speaks the kitty keyboard protocol (Ghostty, kitty, WezTerm); legacy bytes otherwise (tmux, Terminal.app). */
  kitty?: boolean;
  /** The session terminal's shell: /bin/sh by default. */
  shell?: string;
};

/** Where the product's agents look: the stand's scripted model, no user configuration. */
function productEnv(options: ProductOptions): Record<string, string> {
  const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  // the session's terminal runs a plain shell, not the user's (fish greetings, prompts and syntax are theirs);
  // the update is not asked for: the answer depends on the network and the day
  return { ...inherited, ...options.home.env, HARNESS_HOME: options.home.dataDir, TERM: "xterm-256color", COLORTERM: "truecolor", SHELL: options.shell ?? "/bin/sh", HARNESS_UPDATE_CHECK: "off" };
}

export class ProductTui {
  readonly options: ProductOptions;
  readonly term: InstanceType<typeof xterm.Terminal>;
  private readonly pty: nodePty.IPty;
  /** Resolves with the process's exit code. */
  readonly exited: Promise<number>;
  private pending: Promise<void> = Promise.resolve();
  /** Everything the window wrote, for reports. */
  ansi = "";

  private constructor(options: ProductOptions) {
    this.options = options;
    const columns = options.columns ?? 140;
    const rows = options.rows ?? 40;
    this.term = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true, scrollback: 0 });
    this.pty = nodePty.spawn(join(options.bundle, "bin/harness"), options.args ?? [options.home.project], {
      name: "xterm-256color",
      cols: columns,
      rows,
      cwd: options.home.project,
      env: productEnv(options),
    });
    // the terminal's own answers (device attributes, cursor reports) go back as a terminal's would
    this.term.onData((data) => this.pty.write(data));
    this.pty.onData((data) => {
      this.ansi += data;
      // pi-tui asks for the kitty protocol: a kitty terminal says which flags it took
      if (options.kitty === true && data.includes("\x1b[?u")) {
        this.pty.write("\x1b[?7u");
      } else {
        // a legacy terminal does not answer: pi-tui reads legacy bytes
      }
      this.pending = this.pending.then(() => new Promise<void>((resolve) => this.term.write(data, resolve)));
    });
    this.exited = new Promise((resolve) => this.pty.onExit(({ exitCode }) => resolve(exitCode)));
  }

  /** `harness` in the pseudo-terminal, once its window shows (its strip's hub block). */
  static async start(options: ProductOptions): Promise<ProductTui> {
    const tui = new ProductTui(options);
    await tui.waitForText((text) => text.includes("+ add"), 30_000);
    return tui;
  }

  private get modes(): KeyModes {
    return { applicationCursor: false, kitty: this.options.kitty === true };
  }

  /** Text as typed. */
  async type(text: string): Promise<void> {
    this.pty.write(text);
    await this.settle();
  }

  /** A key by pi-tui's name (`ctrl+n`, `alt+/`, `escape`, `pageDown`), as this terminal sends it. */
  async key(id: string): Promise<void> {
    const bytes = id === "escape" && this.options.kitty === true ? "\x1b[27u" : encodeKey(keyFromId(id), this.modes);
    if (bytes === undefined) {
      throw new Error(`a terminal sends nothing for ${id}`);
    } else {
      this.pty.write(bytes);
      await this.settle();
    }
  }

  /** A global action by its first key (Ctrl+letter), as the operator presses it. */
  async act(action: GlobalActionId): Promise<void> {
    const key = globalKeys(GLOBAL_ACTIONS[action].key)[0];
    if (key === undefined) {
      throw new Error(`no key for ${action}`);
    } else {
      await this.key(key);
    }
  }

  /** Sends the message: Ctrl+Enter where the terminal tells it apart (kitty), Alt+Enter where it cannot. */
  async submit(): Promise<void> {
    await this.key(this.options.kitty === true ? "ctrl+enter" : "alt+enter");
  }

  /** This window's hub (its socket in the home), for looking at what the window did. */
  async hub(): Promise<HubConnection> {
    return await HubConnection.open(await unixTransport(socketPath(this.options.home.dataDir)), "test");
  }

  /** What was written so far is on the screen, and a moment more for the window to answer. */
  async settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 60));
    await this.pending;
  }

  text(): string {
    return screenText(this.term).join("\n");
  }

  /** The terminal takes another size, as a window resized does. */
  async resize(columns: number, rows: number): Promise<void> {
    this.term.resize(columns, rows);
    this.pty.resize(columns, rows);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await this.pending;
  }

  cells(): Cell[][] {
    return screenCells(this.term);
  }

  async waitForText(predicate: (text: string) => boolean, timeoutMs = 20_000): Promise<string> {
    const started = Date.now();
    for (;;) {
      await this.pending;
      const text = this.text();
      if (predicate(text)) {
        return text;
      } else if (Date.now() - started > timeoutMs) {
        throw new Error(`the product's screen never matched; it is:\n${text}`);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  /** Runs `harness <args>` of the same bundle on the same home (the hub's admin commands). */
  async command(args: string[]): Promise<string> {
    const { stdout } = await run(join(this.options.bundle, "bin/harness"), args, { env: productEnv(this.options), cwd: this.options.home.project });
    return stdout;
  }

  /** The web app this window's hub serves, on a free loopback port, paired by a one-time link. */
  async web(options: WebDriverOptions = {}): Promise<WebDriver> {
    const port = await freePort();
    await this.command(["hub", "network", "on", "--listen", `127.0.0.1:${port}`, "--url", `http://127.0.0.1:${port}`]);
    const added = await this.command(["hub", "device", "add", "--name", "browser"]);
    const link = /https?:\/\/\S+#pair=\S+/.exec(added)?.[0];
    if (link === undefined) {
      throw new Error(`no pairing link in:\n${added}`);
    } else {
      return await WebDriver.open(link, options);
    }
  }

  /** Quits as the operator does (Ctrl+Q; confirmed when asked), and waits for the process. */
  async quit(): Promise<number> {
    await this.act("app.quit");
    const code = await Promise.race([this.exited, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 3000))]);
    if (code !== undefined) {
      return code;
    } else {
      // asked first (agents work): Enter confirms
      await this.key("enter");
      return await this.exited;
    }
  }

  kill(): void {
    this.pty.kill();
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}
