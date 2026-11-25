/**
 * harness - bundled dependencies.
 *
 * harness is distributed only as a Nix bundle (flake.nix, nix/package.nix): its `harness` entry
 * points $HARNESS_MANIFEST at a JSON file with the absolute store paths and versions of every
 * pinned tool. This module describes the bundle and registers nothing:
 *
 * - readManifest: the manifest, or why it is unusable;
 * - bundledMcpServers: the bundled MCP servers and their exposure policy (an mcp.json entry with
 *   the same name takes precedence, as for any extension-registered server);
 * - lspToolchain: the language servers tools/lsp drives;
 * - depsReport: the dependencies report (the panel's row).
 */

import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import type { Toolchain } from "./tools/lsp/index.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

type BinId = "lightpanda" | "tsgo" | "gopls" | "rust-analyzer" | "playwright-mcp" | "chrome-devtools-mcp" | "node" | "browser" | "cage";

export type Manifest = {
  harness: string;
  versions: Record<string, string>;
  bin: Record<BinId, string>;
  /** Package directories: pi, the bundled pi packages, and typescript (the API tools/lsp loads). */
  packages: Record<string, string>;
  /** SKILL.md files generated from bundled tools (cage: `cage skill`). */
  skills: Record<string, string>;
};

/** The manifest the bundle points at, or the reason it is unusable. */
export function readManifest(): { manifest: Manifest } | { problem: string } {
  const path = process.env.HARNESS_MANIFEST;
  if (path === undefined || path === "") {
    return { problem: "the agent was not started from the harness bundle (HARNESS_MANIFEST is unset)" };
  } else {
    try {
      return { manifest: JSON.parse(readFileSync(path, "utf8")) as Manifest };
    } catch (error) {
      return { problem: `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}

/* ----------------------------------------------------------------------------
 * Language servers
 * ------------------------------------------------------------------------- */

/**
 * The language servers of code intelligence (tools/lsp): the native TypeScript 7 server and its
 * API package, gopls and rust-analyzer. The projects' toolchains (go, cargo) come from PATH.
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
 * Exposure policy. A declared tool costs every request, and a change to the declared set
 * mid-session misses the prompt cache. So: direct only for the frequent tools of the main flow,
 * on a local server that is always enabled and connects at once (lightpanda `search`,
 * `markdown`); everything else codemode. Tools we cannot use are hidden, so scripts never find
 * them. The servers that attach to the user's own browser are registered disabled by the
 * extension (enabled in /mcp where the agent runs on the user's machine).
 */
export function bundledMcpServers(bin: Manifest["bin"]): Record<string, McpServerConfig> {
  return { lightpanda: lightpandaServer(bin), browser: browserServer(bin), ...userBrowserServers(bin) };
}

function lightpandaServer(bin: Manifest["bin"]): McpServerConfig {
  return {
    description: "Headless JS-capable browser: web search, open pages, render to markdown, links, clicks, forms",
    command: bin.lightpanda,
    args: ["mcp"],
    env: { LIGHTPANDA_DISABLE_TELEMETRY: "true" },
    timeout: 60,
    toolExposure: {
      search: "direct",
      markdown: "direct",
      // record-and-replay scripts: not part of our workflow
      save: "hidden",
      run: "hidden",
      // need TypeSafe (TYPESAFE_API_KEY), not provided
      acceptCookies: "hidden",
      login: "hidden",
      classify: "hidden",
      // HTTP transport only; lightpanda runs over stdio here
      session_new: "hidden",
      session_list: "hidden",
      session_close: "hidden",
    },
  };
}

/** A real Chromium for the hard cases of web research (browser/server.ts). HARNESS_BROWSER replaces the bundled browser. */
function browserServer(bin: Manifest["bin"]): McpServerConfig {
  return {
    description:
      "Real Chromium for hard cases: logins, bot checks, sites Lightpanda cannot render; Playwright code on a live page, shown to the operator on request",
    command: bin.node,
    args: [join(EXTENSION_DIR, "browser", "server.ts")],
    env: { HARNESS_BUNDLED_BROWSER: bin.browser },
    timeout: 120,
    exposure: "codemode",
  };
}

/** The servers that attach to the user's own running browser. */
function userBrowserServers(bin: Manifest["bin"]): Record<string, McpServerConfig> {
  // HARNESS_BROWSER (executable) and HARNESS_BROWSER_USER_DATA_DIR (profile) are host settings;
  // without them the servers use their defaults (Chrome's standard locations).
  const browser = process.env.HARNESS_BROWSER;
  const userDataDir = process.env.HARNESS_BROWSER_USER_DATA_DIR;
  return {
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
      description: "Control and inspect the user's running browser via DevTools: pages, DOM, console, network, screenshots",
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
 * The dependencies report
 * ------------------------------------------------------------------------- */

/** The dependencies report: the bundle, its update (the given lines), bundled versions. */
export function depsReport(manifest: Manifest, update: readonly string[]): string {
  const width = Math.max(...Object.keys(manifest.versions).map((id) => id.length));
  return [
    `harness ${manifest.harness}`,
    ...update,
    "Bundled:",
    ...Object.entries(manifest.versions)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, version]) => `  ${id.padEnd(width)}  ${version}`),
  ].join("\n");
}
