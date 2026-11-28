// A test stand: a temporary user (its ~/.harness), a project directory, a hub with agents that
// answer from a scripted model, and clients connected to it. Everything lives under one temporary
// directory removed by `down()` unless the test keeps it for its report.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Clock } from "#protocol/clock.ts";
import { layoutOf, type Layout } from "#protocol/layout.ts";
import type { HapRecord } from "#protocol/hap.ts";
import { HubConnection } from "#client/connection.ts";
import { Hub } from "#hub/hub.ts";
import { inProcessTransport, unixTransport } from "#hub/endpoints/transports.ts";
import { listenUnix, socketPath } from "#hub/endpoints/unix.ts";
import type { ScriptedTurn } from "./scenario-model.ts";
import type { Server } from "node:net";

const SCENARIO_MODEL_PATH = fileURLToPath(new URL("./scenario-model.ts", import.meta.url));
const PROBE_EXTENSION_PATH = fileURLToPath(new URL("./probe-extension.ts", import.meta.url));
const FAKE_CLAUDE_PATH = fileURLToPath(new URL("../fakes/claude.ts", import.meta.url));
const MCP_PROBE_PATH = fileURLToPath(new URL("../fakes/mcp-server.ts", import.meta.url));

/**
 * A stand's home without its hub: a temporary user (its ~/.harness with the scripted model), a
 * project, and the environment its agents need. The product's own hub runs on it (product.ts): a
 * real `harness` with `HARNESS_HOME = dataDir` and `env`.
 */
export type StandHome = {
  root: string;
  dataDir: string;
  /** Where everything is under `dataDir` (pi's agent directory, the hub's files). */
  layout: Layout;
  project: string;
  /** What agents of this home need in their environment (the scripted model, no user configuration). */
  env: Record<string, string>;
  /** Queues the model's next turns (each request plays the next queued turn, across agents). */
  script(turns: ScriptedTurn[]): void;
  /** Models of the scenario provider besides `scripted`, for agents started from now on. */
  models(ids: string[]): void;
  /** The fake Claude Code's runs (one per message it gets) and how it presents itself (testkit/fakes/claude.ts). */
  claude(runs: unknown[][], state?: { version?: string; auth?: "ok" | "out"; keySource?: string }): void;
  /** Each start of the fake Claude Code: its argv and environment. */
  claudeStarts(): { argv: string[]; env: Record<string, string> }[];
  /** The MCP tools harness offered the fake Claude Code (its last tools/list). */
  claudeTools(): string[];
  /** The messages the fake Claude Code received, in order (their text). */
  claudeInputs(): string[];
  /** The requests the model received, in order: { agent: "main" | <profile>, context }. */
  requests(): unknown[];
  /** Removes the home. */
  remove(): void;
};

export type Stand = StandHome & {
  hub: Hub;
  connect(via?: "inproc" | "unix"): Promise<HubConnection>;
  down(): Promise<void>;
};

export type StandOptions = {
  name?: string;
  /** A built bundle (its directory): agents run its sources with its manifest — packages, MCP servers, tools. */
  bundle?: string;
  /** The hub's clock (summaries, idle unloading, backoff); the system's by default. */
  clock?: Clock;
  maxAgents?: number;
  /** Entries of an attach's snapshot (the hub's default when absent): small, to test loading older ones. */
  snapshotEntries?: number;
  /** A hub declared a shared server (its agents get the `server` skill). */
  server?: boolean;
  /** A real Claude Code instead of the fake (the live check, tests/live/): its path. */
  claudeCommand?: string;
  /** The agents' mcp.json configures the test MCP server `probe` (fakes/mcp-server.ts). */
  mcpProbe?: boolean;
};

export async function createStand(options: StandOptions = {}): Promise<Stand> {
  const home = createStandHome(options);
  const hub = new Hub({
    name: options.name ?? "test",
    dataDir: home.dataDir,
    harnessVersion: "test",
    agentCommand: options.bundle !== undefined ? [process.execPath, join(options.bundle, "share/harness/src/packages/agent/src/main.ts")] : undefined,
    agentEnv: {
      ...home.env,
      // agents of a stand run the checkout without the bundle's MCP servers and packages, or a bundle with all of them
      HARNESS_MANIFEST: options.bundle !== undefined ? join(options.bundle, "share/harness/manifest.json") : "",
    },
    summaryIntervalMs: 20,
    clock: options.clock,
    maxAgents: options.maxAgents,
    snapshotEntries: options.snapshotEntries,
  });
  const connections: HubConnection[] = [];
  let server: Server | undefined;
  return {
    ...home,
    hub,
    async connect(via = "inproc") {
      let connection: HubConnection;
      if (via === "unix") {
        const path = socketPath(home.dataDir);
        server ??= await listenUnix(hub, path);
        connection = await HubConnection.open(await unixTransport(path), "test");
      } else {
        connection = await HubConnection.open(inProcessTransport(hub), "test");
      }
      connections.push(connection);
      return connection;
    },
    async down() {
      for (const connection of connections) {
        connection.close();
      }
      server?.close();
      await hub.close();
      home.remove();
    },
  };
}

/** How long a stand's root is (`<tmpdir>/hs-…-XXXXXX`) where the temporary directory is short enough. */
export const STAND_ROOT_WIDTH = 24;

export function createStandHome(options: Pick<StandOptions, "server" | "claudeCommand" | "mcpProbe"> = {}): StandHome {
  // short: unix socket paths are limited to about 100 bytes; and of one width wherever the temporary
  // directory is (/tmp, a build's /build): screens show the project's path, and compare between machines
  const root = mkdtempSync(join(tmpdir(), `hs-${"-".repeat(Math.max(0, STAND_ROOT_WIDTH - tmpdir().length - 10))}`));
  const dataDir = join(root, "h");
  const project = join(root, "project");
  // the agents' temp directory is scratch space in every mode: a sibling of the project, so the project is not inside it
  const agentTmp = join(root, "tmp");
  const agentDir = layoutOf(dataDir).agent;
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(agentTmp, { recursive: true });
  const agentHome = join(root, "home");
  mkdirSync(agentHome, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "scenario", defaultModel: "scripted" }));
  // a configured key: pi checks the provider's auth before every prompt
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ scenario: { type: "api_key", key: "scripted" } }), { mode: 0o600 });
  if (options.mcpProbe === true) {
    writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { probe: { description: "The test MCP server", command: process.execPath, args: [MCP_PROBE_PATH] } } }));
  } else {
    // no MCP servers of the user
  }
  const scenarioPath = join(root, "scenario.json");
  const requestsPath = join(root, "requests.jsonl");
  const modelsPath = join(root, "models.json");
  writeFileSync(scenarioPath, "[]");
  // a fake Claude Code for the claude engine: its runs are scripted with stand.claude()
  const claudeScript = join(root, "claude.json");
  const claudeLog = join(root, "claude.log");
  const claudeCommand = join(root, "claude");
  writeFileSync(claudeScript, "[]");
  writeFileSync(claudeCommand, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CLAUDE_PATH)} "$@"\n`, { mode: 0o755 });

  const env: Record<string, string> = {
      ...(options.server === true ? { HARNESS_SERVER: "1" } : {}),
      // the user's own configuration (extensions' settings in ~/.config, ~/.claude) stays out of a stand;
      // a real Claude Code needs its login in the real home
      ...(options.claudeCommand === undefined
        ? {
            HOME: agentHome,
            XDG_CONFIG_HOME: join(agentHome, ".config"),
            XDG_DATA_HOME: join(agentHome, ".local/share"),
            XDG_STATE_HOME: join(agentHome, ".local/state"),
            XDG_CACHE_HOME: join(agentHome, ".cache"),
          }
        : {}),
      TMPDIR: agentTmp,
      // no model catalog refresh from the network: the scripted model is the only one
      PI_OFFLINE: "1",
      HARNESS_EXTRA_EXTENSIONS: `${SCENARIO_MODEL_PATH}:${PROBE_EXTENSION_PATH}`,
      HARNESS_TEST_SCENARIO: scenarioPath,
      HARNESS_TEST_REQUESTS: requestsPath,
      HARNESS_TEST_MODELS: modelsPath,
      HARNESS_CLAUDE: options.claudeCommand ?? claudeCommand,
      HARNESS_FAKE_CLAUDE_SCRIPT: claudeScript,
      HARNESS_FAKE_CLAUDE_LOG: claudeLog,
      // must never reach Claude: harness runs it on the user's subscription only
      ANTHROPIC_API_KEY: "sk-must-not-pass",
  };

  return {
    root,
    dataDir,
    layout: layoutOf(dataDir),
    project,
    env,
    models(ids) {
      writeFileSync(modelsPath, JSON.stringify(ids));
    },
    claude(runs, state = {}) {
      writeFileSync(claudeScript, JSON.stringify(runs));
      writeFileSync(`${claudeScript}.state`, JSON.stringify(state));
    },
    claudeStarts() {
      return existsSync(claudeLog)
        ? readFileSync(claudeLog, "utf8")
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => JSON.parse(line) as { argv: string[]; env: Record<string, string> })
        : [];
    },
    claudeTools() {
      return existsSync(`${claudeLog}.tools`) ? (JSON.parse(readFileSync(`${claudeLog}.tools`, "utf8")) as string[]) : [];
    },
    claudeInputs() {
      return existsSync(`${claudeLog}.inputs`)
        ? readFileSync(`${claudeLog}.inputs`, "utf8")
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => JSON.parse(line) as string)
        : [];
    },
    script(turns) {
      // the model plays turns in order across scripts: each script adds the next ones
      const queued = JSON.parse(readFileSync(scenarioPath, "utf8")) as unknown[];
      writeFileSync(scenarioPath, JSON.stringify([...queued, ...turns]));
    },
    requests() {
      return existsSync(requestsPath)
        ? readFileSync(requestsPath, "utf8")
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => JSON.parse(line) as unknown)
        : [];
    },
    remove() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Waits for the first HAP record of an agent that matches; the timeout only guards against a hang. */
export function nextRecord(connection: HubConnection, agent: string, match: (record: HapRecord & { type: string; [key: string]: unknown }) => boolean, timeoutMs = 20_000): Promise<HapRecord & { [key: string]: unknown }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`no matching record from ${agent} within ${timeoutMs} ms`));
    }, timeoutMs);
    const off = connection.onHap((from, record) => {
      if (from === agent && match(record as never)) {
        clearTimeout(timer);
        off();
        resolve(record as never);
      } else {
        // not this one
      }
    });
  });
}
