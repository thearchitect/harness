// A test stand: a temporary user (its ~/.harness), a project directory, a node with agents that
// answer from a scripted model, and clients connected to it. Everything lives under one temporary
// directory removed by `down()` unless the test keeps it for its report.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Clock } from "#protocol/clock.ts";
import type { HapRecord } from "#protocol/hap.ts";
import { NodeConnection } from "#client/connection.ts";
import { HarnessNode } from "#node/node.ts";
import { inProcessTransport, unixTransport } from "#node/endpoints/transports.ts";
import { listenUnix, socketPath } from "#node/endpoints/unix.ts";
import type { ScriptedTurn } from "./scenario-model.ts";
import type { Server } from "node:net";

const SCENARIO_MODEL_PATH = fileURLToPath(new URL("./scenario-model.ts", import.meta.url));
const PROBE_EXTENSION_PATH = fileURLToPath(new URL("./probe-extension.ts", import.meta.url));
const FAKE_CLAUDE_PATH = fileURLToPath(new URL("../fakes/claude.ts", import.meta.url));

export type Stand = {
  root: string;
  dataDir: string;
  project: string;
  node: HarnessNode;
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
  /** The requests the model received, in order: { agent: "main" | <profile>, context }. */
  requests(): unknown[];
  connect(via?: "inproc" | "unix"): Promise<NodeConnection>;
  down(): Promise<void>;
};

export type StandOptions = {
  name?: string;
  /** A built bundle (its directory): agents run its sources with its manifest — packages, MCP servers, tools. */
  bundle?: string;
  /** Hub users allowed on the stand's node through a hub. */
  users?: string[];
  /** The node's clock (summaries, idle unloading, backoff); the system's by default. */
  clock?: Clock;
  maxAgents?: number;
  /** Entries of an attach's snapshot (the node's default when absent): small, to test loading older ones. */
  snapshotEntries?: number;
};

export async function createStand(options: StandOptions = {}): Promise<Stand> {
  // short: unix socket paths are limited to about 100 bytes
  const root = mkdtempSync(join(tmpdir(), "hs-"));
  const dataDir = join(root, "h");
  const project = join(root, "project");
  // the agents' temp directory is scratch space in every mode: a sibling of the project, so the project is not inside it
  const agentTmp = join(root, "tmp");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(agentTmp, { recursive: true });
  writeFileSync(join(dataDir, "settings.json"), JSON.stringify({ defaultProvider: "scenario", defaultModel: "scripted" }));
  // a configured key: pi checks the provider's auth before every prompt
  writeFileSync(join(dataDir, "auth.json"), JSON.stringify({ scenario: { type: "api_key", key: "scripted" } }), { mode: 0o600 });
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

  const node = new HarnessNode({
    name: options.name ?? "test",
    dataDir,
    harnessVersion: "test",
    agentCommand: options.bundle !== undefined ? [process.execPath, join(options.bundle, "share/harness/src/packages/agent/src/main.ts")] : undefined,
    agentEnv: {
      TMPDIR: agentTmp,
      // agents of a stand run the checkout without the bundle's MCP servers and packages, or a bundle with all of them
      HARNESS_MANIFEST: options.bundle !== undefined ? join(options.bundle, "share/harness/manifest.json") : "",
      // no model catalog refresh from the network: the scripted model is the only one
      PI_OFFLINE: "1",
      HARNESS_EXTRA_EXTENSIONS: `${SCENARIO_MODEL_PATH}:${PROBE_EXTENSION_PATH}`,
      HARNESS_TEST_SCENARIO: scenarioPath,
      HARNESS_TEST_REQUESTS: requestsPath,
      HARNESS_TEST_MODELS: modelsPath,
      HARNESS_CLAUDE: claudeCommand,
      HARNESS_FAKE_CLAUDE_SCRIPT: claudeScript,
      HARNESS_FAKE_CLAUDE_LOG: claudeLog,
      // must never reach Claude: harness runs it on the user's subscription only
      ANTHROPIC_API_KEY: "sk-must-not-pass",
    },
    summaryIntervalMs: 20,
    users: options.users,
    clock: options.clock,
    maxAgents: options.maxAgents,
    snapshotEntries: options.snapshotEntries,
  });
  const connections: NodeConnection[] = [];
  let server: Server | undefined;

  return {
    root,
    dataDir,
    project,
    node,
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
    async connect(via = "inproc") {
      let connection: NodeConnection;
      if (via === "unix") {
        const path = socketPath(dataDir, node.config.name);
        server ??= await listenUnix(node, path);
        connection = await NodeConnection.open(await unixTransport(path), "test");
      } else {
        connection = await NodeConnection.open(inProcessTransport(node), "test");
      }
      connections.push(connection);
      return connection;
    },
    async down() {
      for (const connection of connections) {
        connection.close();
      }
      server?.close();
      await node.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Waits for the first HAP record of an agent that matches; the timeout only guards against a hang. */
export function nextRecord(connection: NodeConnection, agent: string, match: (record: HapRecord & { type: string; [key: string]: unknown }) => boolean, timeoutMs = 20_000): Promise<HapRecord & { [key: string]: unknown }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`no matching record from ${agent} within ${timeoutMs} ms`));
    }, timeoutMs);
    const off = connection.onHap((_node, from, record) => {
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
