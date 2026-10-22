/**
 * harness - bundled dependencies.
 *
 * harness is distributed only as a Nix bundle (flake.nix, nix/package.nix):
 * its `pi` launcher loads this extension and the bundled pi packages and
 * points $HARNESS_MANIFEST at a JSON file with the absolute store paths and
 * versions of every pinned tool. This module:
 *
 * - registers the bundled MCP servers from the manifest (an mcp.json entry
 *   with the same name takes precedence, as for any extension-registered
 *   server);
 * - reports a missing manifest (pi not started through the launcher) in the
 *   status line;
 * - provides /deps (alt+u): bundled versions, herdr integration state and how
 *   to update.
 *
 * Updates are not done here: `nix profile upgrade harness` (or the user's
 * NixOS / home-manager flake update) replaces the whole bundle atomically.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const STATUS_KEY = "harness-deps";
const SHORTCUT = "alt+u";
const UPDATE_HINT = "Update: `nix profile upgrade harness` (or update the harness flake input of your NixOS / home-manager config).";

type BinId =
  | "codegraph"
  | "lightpanda"
  | "agent-lsp"
  | "gopls"
  | "typescript-language-server"
  | "mcp-refactor-typescript"
  | "playwright-mcp"
  | "chrome-devtools-mcp"
  | "herdr";

type Manifest = {
  harness: string;
  versions: Record<string, string>;
  bin: Record<BinId, string>;
};

/** The manifest the launcher points at, or the reason it is unusable. */
function readManifest(): { manifest: Manifest } | { problem: string } {
  const path = process.env.HARNESS_MANIFEST;
  if (!path) return { problem: "pi was not started through the harness launcher (HARNESS_MANIFEST is unset)" };
  try {
    return { manifest: JSON.parse(readFileSync(path, "utf8")) as Manifest };
  } catch (error) {
    return { problem: `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Double-load guard. pi-dev loads the working tree with `-e`; with an
 * mcp.json/settings.json leftover (old pi-package install) a second copy could
 * load too, and their commands/tools would collide. The first copy to load
 * claims the process; another copy warns once and registers nothing. The claim
 * is reused on /reload (same path).
 */
export function claimHarnessInstance(): boolean {
  const key = Symbol.for("harness.extensionDir");
  const store = globalThis as Record<symbol, string | undefined>;
  const owner = store[key];
  if (owner && owner !== EXTENSION_DIR) {
    console.warn(
      `[harness] another harness copy is already loaded from ${owner}; ignoring ${EXTENSION_DIR}. Remove the extra copy (old pi package entry in ~/.pi/agent/settings.json?) and restart pi.`,
    );
    return false;
  }
  store[key] = EXTENSION_DIR;
  return true;
}

/* ----------------------------------------------------------------------------
 * MCP servers
 * ------------------------------------------------------------------------- */

/**
 * Exposure policy: read-only tools go to codemode, where the model discovers
 * and batches them (fan-out over many symbols in one script); tools that write
 * files are direct, so every write is a visible call in the transcript.
 */
function registerServers(pi: ExtensionAPI, bin: Manifest["bin"]): void {
  pi.registerMcpServer("codegraph", {
    description: "Code knowledge graph of the indexed project: symbols, call paths, callers/callees, impact",
    command: bin.codegraph,
    args: ["serve", "--mcp"],
    env: {
      DO_NOT_TRACK: "1",
      CODEGRAPH_NO_UPDATE_CHECK: "1",
      // codegraph lists only `explore` by default; the narrower tools are
      // re-enabled for codemode fan-out (impact/callers over many symbols).
      CODEGRAPH_MCP_TOOLS: "explore,node,search,callers,callees,impact",
    },
    exposure: "codemode",
    toolExposure: { codegraph_explore: "direct" },
  });

  pi.registerMcpServer("lsp", {
    description:
      "Language servers (gopls, typescript-language-server) via agent-lsp: type-resolved references, implementations, call/type hierarchy, diagnostics, rename, simulated edits",
    command: bin["agent-lsp"],
    args: [`go:${bin.gopls}`, `typescript:${bin["typescript-language-server"]},--stdio`],
    timeout: 120,
    exposure: "codemode",
    toolExposure: {
      apply_edit: "direct",
      safe_apply_edit: "direct",
      safe_edit: "direct",
      replace_symbol_body: "direct",
      insert_after_symbol: "direct",
      insert_before_symbol: "direct",
      safe_delete_symbol: "direct",
      commit_session: "direct",
      execute_command: "direct",
      // Builds and tests go through the project's own entry points (make, ...);
      // agent-lsp's skill tools belong to its own agent integrations.
      run_build: "hidden",
      run_tests: "hidden",
      activate_skill: "hidden",
      deactivate_skill: "hidden",
      get_skill_phase: "hidden",
      export_cache: "hidden",
      import_cache: "hidden",
      set_log_level: "hidden",
    },
  });

  pi.registerMcpServer("ts-refactor", {
    description:
      "TypeScript refactoring through tsserver: move/rename files with import updates, move declarations, extract, organize imports",
    command: bin["mcp-refactor-typescript"],
    timeout: 120,
    // Every tool of this server writes files.
    exposure: "direct",
  });

  pi.registerMcpServer("lightpanda", {
    description:
      "Headless JS-capable browser: open pages, render to markdown, links, clicks, forms, fallback web search",
    command: bin.lightpanda,
    args: ["mcp"],
    env: { LIGHTPANDA_DISABLE_TELEMETRY: "true" },
    timeout: 60,
    toolExposure: { goto: "direct", markdown: "direct" },
  });

  // The user's own browser. HARNESS_BROWSER (executable) and
  // HARNESS_BROWSER_USER_DATA_DIR (profile) are host settings; without them
  // the servers use their defaults (Chrome's standard locations).
  const browser = process.env.HARNESS_BROWSER;
  const userDataDir = process.env.HARNESS_BROWSER_USER_DATA_DIR;

  pi.registerMcpServer("playwright", {
    description:
      "Control selected tabs in the user's running browser through the Playwright extension: snapshots, clicks, forms, screenshots, console and network",
    command: bin["playwright-mcp"],
    args: ["--extension"],
    env: browser ? { PLAYWRIGHT_MCP_EXECUTABLE_PATH: browser } : {},
    timeout: 180,
    exposure: "codemode",
  });

  pi.registerMcpServer("chromium-devtools", {
    enabled: false,
    description:
      "Control and inspect the user's running browser via DevTools: pages, DOM, console, network, screenshots",
    command: bin["chrome-devtools-mcp"],
    args: [
      "--autoConnect",
      ...(userDataDir ? ["--userDataDir", userDataDir.replace(/^~(?=\/|$)/, homedir())] : []),
      "--no-usage-statistics",
      "--no-performance-crux",
      "--redact-network-headers",
      "--screenshotFormat=webp",
      "--screenshotQuality=80",
      "--screenshotMaxWidth=1920",
      "--screenshotMaxHeight=1200",
    ],
    env: { CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1" },
    timeout: 180,
    exposure: "codemode",
  });
}

/* ----------------------------------------------------------------------------
 * /deps
 * ------------------------------------------------------------------------- */

function herdrIntegration(herdr: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(herdr, ["integration", "status"], { timeout: 10_000 }, (error, stdout) => {
      if (error) {
        resolve(`unknown (${error.message.split("\n")[0]})`);
        return;
      }
      const line = stdout.split("\n").find((l) => l.startsWith("pi:"));
      resolve(line ? line.slice(3).trim() : "not reported");
    });
  });
}

async function showDeps(ctx: ExtensionContext): Promise<void> {
  const result = readManifest();
  if ("problem" in result) {
    ctx.ui.notify(`harness: ${result.problem}`, "error");
    return;
  }
  const { manifest } = result;
  const width = Math.max(...Object.keys(manifest.versions).map((id) => id.length));
  const herdr = await herdrIntegration(manifest.bin.herdr);
  const lines = [
    `harness ${manifest.harness}`,
    ...Object.entries(manifest.versions)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, version]) => `  ${id.padEnd(width)}  ${version}`),
    `herdr pi integration: ${herdr}${herdr.startsWith("current") ? "" : " - run `herdr integration install pi`"}`,
    UPDATE_HINT,
  ];
  ctx.ui.notify(lines.join("\n"), herdr.startsWith("current") ? "info" : "warning");
}

export function installDeps(pi: ExtensionAPI): void {
  const result = readManifest();
  if ("manifest" in result) registerServers(pi, result.manifest.bin);

  pi.on("session_start", (_event, ctx) => {
    if ("problem" in result) ctx.ui.setStatus(STATUS_KEY, `harness: ${result.problem}`);
  });

  pi.registerCommand("deps", {
    description: "Bundled dependency versions, herdr integration state, how to update",
    handler: async (_args, ctx) => showDeps(ctx),
  });
  pi.registerShortcut(SHORTCUT, {
    description: "Bundled dependencies (/deps)",
    handler: (ctx) => {
      void showDeps(ctx);
    },
  });
}
