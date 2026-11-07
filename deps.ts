/**
 * harness - bundled dependencies.
 *
 * harness is distributed only as a Nix bundle (flake.nix, nix/package.nix):
 * its `pi` launcher loads this extension and the bundled pi packages and
 * points $HARNESS_MANIFEST at a JSON file with the absolute store paths and
 * versions of every pinned tool. This module describes the bundle and
 * registers nothing; index.ts wires it:
 *
 * - readManifest: the manifest, or why it is unusable (pi not started through
 *   the launcher);
 * - bundledMcpServers: the bundled MCP servers and their exposure policy (an
 *   mcp.json entry with the same name takes precedence, as for any
 *   extension-registered server);
 * - lspToolchain: the language servers lsp/ drives;
 * - depsReport: the /deps text - bundled versions, a duplicate herdr pi
 *   integration and how to update;
 * - claimHarnessInstance: the double-load guard.
 *
 * Updates are not done here: `nix profile upgrade harness` (or the user's
 * NixOS / home-manager flake update) replaces the whole bundle atomically.
 */

import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import type { Toolchain } from "./lsp/index.ts";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const UPDATE_HINT = "Update: `nix profile upgrade harness` (or update the harness flake input of your NixOS / home-manager config).";

type BinId =
  | "lightpanda"
  | "tsgo"
  | "gopls"
  | "rust-analyzer"
  | "playwright-mcp"
  | "chrome-devtools-mcp"
  | "herdr";

export type Manifest = {
  harness: string;
  versions: Record<string, string>;
  bin: Record<BinId, string>;
  /** Package directories: pi, the bundled pi packages, and typescript (the API lsp/ loads). */
  packages: Record<string, string>;
};

/** The manifest the launcher points at, or the reason it is unusable. */
export function readManifest(): { manifest: Manifest } | { problem: string } {
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
 * Language servers
 * ------------------------------------------------------------------------- */

/**
 * The language servers of code intelligence (lsp/): the native TypeScript 7
 * server and its API package, gopls and rust-analyzer. The projects'
 * toolchains (go, cargo) come from the user's PATH.
 */
export function lspToolchain(manifest: Manifest): { toolchain: Toolchain } | { problem: string } {
  const typescriptPackage = manifest.packages?.typescript;
  const missing = [
    ...(["tsgo", "gopls", "rust-analyzer"] as const).filter((id) => manifest.bin[id] === undefined),
    ...(typescriptPackage === undefined ? ["typescript package"] : []),
  ];
  if (missing.length > 0 || typescriptPackage === undefined) {
    return { problem: `the harness manifest lacks ${missing.join(", ")}` };
  } else {
    return {
      toolchain: {
        tsgo: manifest.bin.tsgo,
        typescriptPackage,
        gopls: manifest.bin.gopls,
        rustAnalyzer: manifest.bin["rust-analyzer"],
      },
    };
  }
}

/* ----------------------------------------------------------------------------
 * MCP servers
 * ------------------------------------------------------------------------- */

/**
 * Exposure policy: read-only tools go to codemode, where the model discovers
 * and batches them (fan-out over many symbols in one script); tools that write
 * files are direct, so every write is a visible call in the transcript.
 */
export function bundledMcpServers(bin: Manifest["bin"]): Record<string, McpServerConfig> {
  // The user's own browser. HARNESS_BROWSER (executable) and
  // HARNESS_BROWSER_USER_DATA_DIR (profile) are host settings; without them
  // the servers use their defaults (Chrome's standard locations).
  const browser = process.env.HARNESS_BROWSER;
  const userDataDir = process.env.HARNESS_BROWSER_USER_DATA_DIR;

  return {
    lightpanda: {
      description:
        "Headless JS-capable browser: open pages, render to markdown, links, clicks, forms, fallback web search",
      command: bin.lightpanda,
      args: ["mcp"],
      env: { LIGHTPANDA_DISABLE_TELEMETRY: "true" },
      timeout: 60,
      toolExposure: { goto: "direct", markdown: "direct" },
    },

    playwright: {
      description:
        "Control selected tabs in the user's running browser through the Playwright extension: snapshots, clicks, forms, screenshots, console and network",
      command: bin["playwright-mcp"],
      args: ["--extension"],
      env: browser ? { PLAYWRIGHT_MCP_EXECUTABLE_PATH: browser } : {},
      timeout: 180,
      exposure: "codemode",
    },

    "chromium-devtools": {
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
    },
  };
}

/* ----------------------------------------------------------------------------
 * /deps
 * ------------------------------------------------------------------------- */

/**
 * The launcher loads herdr's pi integration from the bundle; a copy installed
 * by `herdr integration install pi` would load in addition and report every
 * state change twice.
 */
function herdrIntegration(herdr: string): Promise<{ text: string; level: "info" | "warning" }> {
  return new Promise((resolve) => {
    execFile(herdr, ["integration", "status"], { timeout: 10_000 }, (error, stdout) => {
      if (error) {
        resolve({ text: `unknown (${error.message.split("\n")[0]})`, level: "warning" });
      } else {
        const line = stdout.split("\n").find((l) => l.startsWith("pi:"));
        const state = line ? line.slice(3).trim() : undefined;
        if (state === undefined) {
          resolve({ text: "unknown (herdr does not report a pi integration)", level: "warning" });
        } else if (state.startsWith("not installed")) {
          resolve({ text: "bundled", level: "info" });
        } else {
          resolve({
            text: `bundled, plus a copy installed by herdr: ${state} - it loads twice; run \`herdr integration uninstall pi\``,
            level: "warning",
          });
        }
      }
    });
  });
}

export async function depsReport(manifest: Manifest): Promise<{ text: string; level: "info" | "warning" }> {
  const width = Math.max(...Object.keys(manifest.versions).map((id) => id.length));
  const herdr = await herdrIntegration(manifest.bin.herdr);
  const lines = [
    `harness ${manifest.harness}`,
    ...Object.entries(manifest.versions)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, version]) => `  ${id.padEnd(width)}  ${version}`),
    `herdr pi integration: ${herdr.text}`,
    UPDATE_HINT,
  ];
  return { text: lines.join("\n"), level: herdr.level };
}
