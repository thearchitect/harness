/**
 * harness - workflow dependencies.
 *
 * harness itself, pi, magic-context, codegraph, lightpanda and herdr are part
 * of this extension's workflow. The extension runs in one of two modes
 * (harnessMode()): "installed" as a pi git package (pi owns and resets the
 * checkout; pins come with harness releases) or "dev" from any other checkout
 * (folder / submodule; /deps bumps deps.lock.json). scripts/deps.sh owns the logic (check + update, usable
 * from a terminal); this module:
 *
 * - registers the codegraph and lightpanda MCP servers with the exact versions
 *   pinned in deps.lock.json (an mcp.json entry with the same name overrides);
 * - flags a missing/unpinned dependency in the status line at startup
 *   (no network);
 * - provides /deps (alt+u): a terminal-like dialog that streams
 *   `deps.sh check`, then offers the reported actions in a select list where a
 *   prompt would be. A chosen action streams its output into the same log,
 *   re-registers the MCP servers whose pinned version changed, and re-checks.
 */

import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  SelectList,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type SelectItem,
  type TUI,
} from "@earendil-works/pi-tui";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const LOCK_PATH = join(EXTENSION_DIR, "deps.lock.json");
const DEPS_SCRIPT = join(EXTENSION_DIR, "scripts", "deps.sh");
const STATUS_KEY = "harness-deps";
const SHORTCUT = "alt+u";

type DepsLock = Partial<Record<"codegraph" | "lightpanda", { version?: string }>>;

function readLock(): DepsLock {
  try {
    return JSON.parse(readFileSync(LOCK_PATH, "utf8")) as DepsLock;
  } catch {
    return {};
  }
}

/** Mirrors LP_ROOT in scripts/deps.sh. */
function lightpandaBinary(version: string): string {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(dataHome, "harness", "lightpanda", version, "lightpanda");
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * "installed" when pi manages this checkout as a git package (<agent-dir>/git
 * for installs, <agent-dir>/tmp/extensions for `pi -e` runs), else "dev".
 * Mirrors MODE in deps.sh.
 */
export function harnessMode(): "installed" | "dev" {
  const self = realOrSelf(EXTENSION_DIR);
  const managedRoots = [join(getAgentDir(), "git"), join(getAgentDir(), "tmp", "extensions")];
  return managedRoots.some((root) => {
    const rel = relative(realOrSelf(root), self);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  })
    ? "installed"
    : "dev";
}

/**
 * Double-load guard. With both a dev checkout and an installed package present,
 * pi loads two copies and their commands/tools collide. The first copy to load
 * claims the process; another checkout warns once and registers nothing.
 * The claim is reused on /reload (same path) and released when its checkout no
 * longer exists.
 */
export function claimHarnessInstance(): boolean {
  const key = Symbol.for("harness.extensionDir");
  const store = globalThis as Record<symbol, string | undefined>;
  const owner = store[key];
  if (owner && owner !== EXTENSION_DIR && existsSync(owner)) {
    console.warn(
      `[harness] another harness copy is already loaded from ${owner}; ignoring ${EXTENSION_DIR} (${harnessMode()}). Remove one of them and restart pi.`,
    );
    return false;
  }
  store[key] = EXTENSION_DIR;
  return true;
}

/* ----------------------------------------------------------------------------
 * MCP servers pinned by deps.lock.json
 * ------------------------------------------------------------------------- */

/** Registers (or re-registers, which reconnects) the pinned servers. Returns problems found. */
function registerPinnedServers(pi: ExtensionAPI, previous?: DepsLock): string[] {
  const lock = readLock();
  const problems: string[] = [];

  const codegraph = lock.codegraph?.version;
  if (!codegraph) {
    problems.push("codegraph is not pinned");
  } else if (previous?.codegraph?.version !== codegraph) {
    pi.registerMcpServer("codegraph", {
      description: "Code knowledge graph of the indexed project: symbols, call paths, impact",
      command: "bun",
      args: ["x", `@colbymchenry/codegraph@${codegraph}`, "serve", "--mcp"],
      env: { DO_NOT_TRACK: "1", CODEGRAPH_NO_UPDATE_CHECK: "1" },
      // codegraph exposes a single tool (codegraph_explore; the rest are hidden
      // by codegraph itself), so the whole server is direct and stays out of
      // the <mcp_servers> codemode listing.
      exposure: "direct",
    });
  }

  const lightpanda = lock.lightpanda?.version;
  if (!lightpanda) {
    problems.push("lightpanda is not pinned");
  } else if (!existsSync(lightpandaBinary(lightpanda))) {
    problems.push(`lightpanda ${lightpanda} is not installed`);
  } else if (previous?.lightpanda?.version !== lightpanda) {
    pi.registerMcpServer("lightpanda", {
      description:
        "Headless JS-capable browser: open pages, render to markdown, links, clicks, forms, fallback web search",
      command: lightpandaBinary(lightpanda),
      args: ["mcp"],
      env: { LIGHTPANDA_DISABLE_TELEMETRY: "true" },
      timeout: 60,
      toolExposure: { goto: "direct", markdown: "direct" },
    });
  }
  return problems;
}

/* ----------------------------------------------------------------------------
 * Terminal-like dialog
 * ------------------------------------------------------------------------- */

const ACTION_PREFIX = "ACTION ";
const NOTICE_PREFIX = "NOTICE ";
const CHECK_AGAIN = "__check";
const CLOSE = "__close";

class DepsDialog implements Component {
  private readonly log: string[] = [];
  private partial = "";
  private actions: SelectItem[] = [];
  private menu: SelectList | undefined;
  private child: ChildProcess | undefined;
  private scrollBack = 0;
  private disposed = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly onUpdated: () => void,
    private readonly close: () => void,
  ) {
    this.run(["check"]);
  }

  // -- process ---------------------------------------------------------------

  private run(args: string[]): void {
    this.menu = undefined;
    this.actions = [];
    this.scrollBack = 0;
    this.append(this.theme.fg("accent", `$ deps.sh ${args.join(" ")}`));
    const child = spawn(DEPS_SCRIPT, args, {
      cwd: homedir(),
      env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    const onData = (chunk: Buffer): void => this.ingest(chunk.toString("utf8"));
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (error) => this.finish(args, `failed to start: ${error.message}`));
    child.on("close", (code) => this.finish(args, code === 0 ? undefined : `exit ${code}`));
    this.tui.requestRender();
  }

  private finish(args: string[], failure: string | undefined): void {
    if (this.child === undefined || this.disposed) return;
    this.child = undefined;
    if (this.partial) this.ingestLine(this.partial);
    this.partial = "";
    if (failure) this.append(this.theme.fg("error", `[${failure}]`));
    if (args[0] === "update") {
      this.onUpdated();
      this.append("");
      this.run(["check"]);
      return;
    }
    this.showMenu();
  }

  private ingest(text: string): void {
    const lines = (this.partial + text).split("\n");
    this.partial = lines.pop() ?? "";
    for (const line of lines) this.ingestLine(line);
    this.tui.requestRender();
  }

  private ingestLine(raw: string): void {
    // Keep only what a terminal would show after carriage returns.
    const line = (raw.split("\r").pop() ?? "").replace(/\t/g, "  ");
    if (line.startsWith(ACTION_PREFIX)) {
      const rest = line.slice(ACTION_PREFIX.length);
      const space = rest.indexOf(" ");
      const id = space < 0 ? rest : rest.slice(0, space);
      const label = space < 0 ? rest : rest.slice(space + 1);
      this.actions.push({ value: id, label });
      return;
    }
    if (line.startsWith(NOTICE_PREFIX)) {
      this.append(this.theme.fg("warning", `! ${line.slice(NOTICE_PREFIX.length)}`));
      return;
    }
    this.append(line);
  }

  private append(line: string): void {
    this.log.push(line);
    if (this.scrollBack > 0) this.scrollBack++;
  }

  private showMenu(): void {
    const items: SelectItem[] = [
      ...this.actions,
      { value: CHECK_AGAIN, label: "Check again" },
      { value: CLOSE, label: "Close" },
    ];
    const menu = new SelectList(items, items.length, {
      selectedPrefix: (t) => this.theme.fg("accent", t),
      selectedText: (t) => this.theme.fg("accent", t),
      description: (t) => this.theme.fg("muted", t),
      scrollInfo: (t) => this.theme.fg("dim", t),
      noMatch: (t) => this.theme.fg("warning", t),
    });
    menu.onSelect = (item) => {
      if (item.value === CLOSE) this.close();
      else if (item.value === CHECK_AGAIN) {
        this.append("");
        this.run(["check"]);
      } else {
        const [verb, target] = item.value.split(":");
        this.append("");
        this.run([verb ?? "update", target ?? ""]);
      }
    };
    menu.onCancel = () => this.close();
    this.menu = menu;
    this.tui.requestRender();
  }

  // -- component -------------------------------------------------------------

  handleInput(data: string): void {
    if (matchesKey(data, Key.pageUp)) {
      this.scrollBack = Math.min(this.scrollBack + 10, Math.max(0, this.log.length - 1));
    } else if (matchesKey(data, Key.pageDown)) {
      this.scrollBack = Math.max(0, this.scrollBack - 10);
    } else if (this.menu) {
      this.menu.handleInput(data);
    }
    this.tui.requestRender();
  }

  invalidate(): void {
    this.menu?.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    this.child?.kill("SIGTERM");
  }

  render(width: number): string[] {
    const theme = this.theme;
    const inner = Math.max(10, width - 4);
    const height = Math.max(12, Math.floor(this.tui.terminal.rows * 0.85));
    const frame = (line: string): string =>
      theme.fg("border", "│ ") +
      truncateToWidth(line, inner, "…", true) +
      theme.fg("border", " │");

    const footer = this.menu
      ? this.menu.render(inner)
      : [theme.fg("muted", this.child ? "running…" : "")];
    const hints = this.child
      ? "PgUp/PgDn scroll"
      : "↑↓ choose · Enter run · PgUp/PgDn scroll · Esc close";
    const logHeight = Math.max(3, height - footer.length - 4);

    const wrapped = this.log.flatMap((line) =>
      line === "" ? [""] : wrapTextWithAnsi(line, inner),
    );
    const end = Math.max(0, wrapped.length - this.scrollBack);
    const visible = wrapped.slice(Math.max(0, end - logHeight), end);
    while (visible.length < logHeight) visible.push("");

    const title = " Workflow dependencies ";
    const top =
      theme.fg("border", "╭─") +
      theme.fg("accent", theme.bold(title)) +
      theme.fg("border", "─".repeat(Math.max(0, width - 3 - visibleWidth(title))) + "╮");
    const separator = theme.fg("border", "├" + "─".repeat(Math.max(0, width - 2)) + "┤");
    const hint = ` ${hints} `;
    const bottom =
      theme.fg("border", "╰" + "─".repeat(Math.max(0, width - 3 - visibleWidth(hint)))) +
      theme.fg("dim", hint) +
      theme.fg("border", "─╯");

    return [top, ...visible.map(frame), separator, ...footer.map(frame), bottom];
  }
}

async function openDepsDialog(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    ctx.ui.notify(`Run ${DEPS_SCRIPT} check | update <id|all> in a terminal.`, "info");
    return;
  }
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      let lock = readLock();
      return new DepsDialog(
        tui,
        theme,
        () => {
          const problems = registerPinnedServers(pi, lock);
          lock = readLock();
          ctx.ui.setStatus(STATUS_KEY, problems.length > 0 ? `deps: ${problems.join(", ")} - /deps` : undefined);
        },
        () => done(undefined),
      );
    },
    { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" } },
  );
}

export function installDeps(pi: ExtensionAPI): void {
  const problems = registerPinnedServers(pi);

  pi.on("session_start", (_event, ctx) => {
    if (problems.length > 0) {
      ctx.ui.setStatus(STATUS_KEY, `deps: ${problems.join(", ")} - /deps`);
    }
  });

  pi.registerCommand("deps", {
    description: "Check and update workflow dependencies (harness, pi, magic-context, codegraph, lightpanda, herdr)",
    handler: async (_args, ctx) => openDepsDialog(pi, ctx),
  });
  pi.registerShortcut(SHORTCUT, {
    description: "Workflow dependencies (/deps)",
    handler: (ctx) => {
      void openDepsDialog(pi, ctx);
    },
  });
}
