// The TUI driver: the real TUI (App) on a virtual terminal, connected to a stand's hub like any
// client. Tests act by keymap action ids (the same ids the app driver uses), type text, press raw
// keys, and read what the screen shows: the Workbench's screen (the verdict), the terminal's text,
// and captures (text, ANSI, PNG) for reports.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HubConnection } from "#client/connection.ts";
import type { ActionId } from "#client/input/actions.ts";
import { ClientModel } from "#client/model/client-model.ts";
import { Workbench, type Screen } from "#client/workbench/workbench.ts";
import type { ViewStateStore } from "#client/workbench/view-state.ts";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { App } from "#tui/app.ts";
import { loadRenderers } from "#tui/presentation.ts";
import { gridHtml, screenshot } from "../capture/rasterize.ts";
import { VirtualTerminal } from "./terminal.ts";

export type TuiDriverOptions = {
  columns?: number;
  rows?: number;
  cwd: string;
  /** Where the window keeps its state: given, it is restored at the start (a TUI started again). */
  viewStore?: ViewStateStore;
};

export class TuiDriver {
  readonly terminal: VirtualTerminal;
  readonly client: ClientModel;
  readonly workbench: Workbench;
  readonly app: App;
  /** Links the TUI opened in the browser, text it copied: recorded, never sent to this machine's. */
  readonly opened: string[];
  readonly copied: string[];

  private constructor(terminal: VirtualTerminal, client: ClientModel, workbench: Workbench, app: App, outside: { opened: string[]; copied: string[] }) {
    this.terminal = terminal;
    this.client = client;
    this.workbench = workbench;
    this.app = app;
    this.opened = outside.opened;
    this.copied = outside.copied;
  }

  /** A TUI on `connection` (the client's home hub), started on a new session in `cwd`. */
  static async start(open: () => Promise<HubConnection>, options: TuiDriverOptions): Promise<TuiDriver> {
    const terminal = new VirtualTerminal(options.columns ?? 140, options.rows ?? 40);
    const client = new ClientModel();
    const node = await client.addEndpoint(open, { home: true });
    const outside = { opened: [] as string[], copied: [] as string[] };
    const workbench = new Workbench(client, {
      cwd: options.cwd,
      themes: () => ["dark", "light"],
      copyText: (text) => outside.copied.push(text),
      ...(options.viewStore !== undefined ? { viewStore: options.viewStore } : {}),
    });
    await workbench.restoreViews();
    // pi's dark theme: the virtual terminal reports no colors of its own
    const settings = SettingsManager.inMemory({ theme: "dark" });
    const app = new App({
      client,
      workbench,
      renderers: await loadRenderers(options.cwd, []),
      cwd: options.cwd,
      settings,
      onQuit: () => undefined,
      terminal,
      openUrl: (url) => outside.opened.push(url),
      copyText: async (text) => {
        outside.copied.push(text);
      },
    });
    if (workbench.tabs().length === 0) {
      await workbench.newTab(node, options.cwd);
    } else {
      // tabs from the user's settings
    }
    await app.start();
    await terminal.flushed();
    return new TuiDriver(terminal, client, workbench, app, outside);
  }

  async act(action: ActionId): Promise<void> {
    await this.app.act(action);
    await this.settle();
  }

  /** Text into whatever has focus (the editor, a dialog, a list), as typed. */
  async type(text: string): Promise<void> {
    for (const char of text) {
      this.terminal.send(char);
    }
    await this.settle();
  }

  /** Raw key bytes (e.g. "\r", "\x1b[B"). */
  async press(data: string): Promise<void> {
    this.terminal.send(data);
    await this.settle();
  }

  /** Sends the editor's text (Ctrl+Enter as a kitty-less terminal reports Alt+Enter). */
  async submit(): Promise<void> {
    await this.press("\x1b\r");
  }

  screen(): Screen {
    return this.workbench.screen(this.terminal.columns, { mode: "plan" });
  }

  text(): string {
    return this.terminal.text().join("\n");
  }

  /** Resolves when `predicate` holds for the screen text after a render; rejects after `timeoutMs`. */
  async waitForText(predicate: (text: string) => boolean, timeoutMs = 15_000): Promise<string> {
    const started = Date.now();
    for (;;) {
      await this.settle();
      const text = this.text();
      if (predicate(text)) {
        return text;
      } else if (Date.now() - started > timeoutMs) {
        throw new Error(`the screen never matched; it shows:\n${text}`);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  /** Lets pending renders reach the virtual terminal. */
  async settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 20));
    this.app.ui.requestRender(true);
    await new Promise((resolve) => setImmediate(resolve));
    await this.terminal.flushed();
  }

  /** screen.txt, screen.ansi and, with a browser, screen.png into `dir`. */
  async capture(dir: string, name = "screen"): Promise<string[]> {
    await this.settle();
    const files = [join(dir, `${name}.txt`), join(dir, `${name}.ansi`)];
    writeFileSync(files[0] ?? "", `${this.text()}\n`);
    writeFileSync(files[1] ?? "", this.terminal.ansi);
    try {
      const png = join(dir, `${name}.png`);
      writeFileSync(png, await screenshot(gridHtml(this.terminal.cells())));
      files.push(png);
    } catch {
      // no browser here: text and ANSI only
    }
    return files;
  }

  stop(): void {
    this.app.stop();
    this.client.dispose();
  }
}
