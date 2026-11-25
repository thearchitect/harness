// How harness runs the user's own, unmodified Claude Code (plan 12.5): the command line, the
// environment (no API billing variables, no session secrets), the model and effort from the
// profile's reference, and the checks before a start (installed, new enough, logged in with a
// Claude subscription).

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The oldest Claude Code with what harness uses: --permission-prompts (2.1.259), background task
 * messages (2.1.203), the instruction files setting under cc-plugin-agents-md@builtin (2.1.285).
 */
export const MIN_CLAUDE_VERSION = "2.1.285";

/**
 * Claude's settings for a harness run: the PreToolUse hook through the bridge; no instruction files
 * of its own (`managed-only`: no CLAUDE.md, AGENTS.md or rules of the user and project; the prompt
 * carries the project context harness loaded) and no auto memory of its own.
 * https://code.claude.com/docs/en/memory
 */
export function claudeSettings(hookCommand: string): object {
  return {
    hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hookCommand, timeout: 2_592_000 }] }] },
    pluginConfigs: { "cc-plugin-agents-md@builtin": { options: { instructionFiles: "managed-only" } } },
    autoMemoryEnabled: false,
  };
}

/** Variables that would bill an API account or reroute Claude: never passed to it. */
export const BILLING_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
];

export function compareVersions(a: string, b: string): number {
  const parts = (version: string): number[] => (version.match(/\d+(\.\d+)*/)?.[0] ?? "0").split(".").map(Number);
  const [left, right] = [parts(a), parts(b)];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    } else {
      // equal so far
    }
  }
  return 0;
}

/**
 * A model reference → Claude's flags: a family (`anthropic/opus`) is Claude Code's alias (`--model
 * opus`, the newest of the family the account has), an exact id passes as is; `:thinking` is the
 * effort.
 */
export function modelFlags(ref: string | undefined): string[] {
  if (ref === undefined) {
    return [];
  } else {
    const [model, effort] = ref.slice(ref.indexOf("/") + 1).split(":") as [string, string | undefined];
    return [...(model !== "" ? ["--model", model] : []), ...(effort !== undefined ? ["--effort", effort] : [])];
  }
}

export type LaunchOptions = {
  sessionId: string;
  resume: boolean;
  model: string | undefined;
  /** The bridge's command (`harness claude-bridge` or its equivalent), as argv. */
  bridge: string[];
  workspace: string;
  systemPrompt: string;
};

function shellQuote(argument: string): string {
  return /^[\w@%+=:,./-]+$/.test(argument) ? argument : `'${argument.replace(/'/g, "'\\''")}'`;
}

export function claudeArgs(options: LaunchOptions): string[] {
  const bridge = options.bridge.map(shellQuote).join(" ");
  const settings = claudeSettings(`${bridge} hook`);
  const mcp = { mcpServers: { harness: { type: "stdio", command: options.bridge[0], args: [...options.bridge.slice(1), "mcp"] } } };
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    ...modelFlags(options.model),
    "--permission-mode",
    "manual",
    "--permission-prompts",
    "host",
    "--settings",
    JSON.stringify(settings),
    "--mcp-config",
    JSON.stringify(mcp),
    "--strict-mcp-config",
    "--permission-prompt-tool",
    "mcp__harness__permission",
    "--add-dir",
    options.workspace,
    "--append-system-prompt",
    options.systemPrompt,
    ...(options.resume ? ["--resume", options.sessionId] : ["--session-id", options.sessionId]),
  ];
}

/** The process environment for Claude: without billing variables and harness's secrets, with the bridge's address. */
export function claudeEnv(base: Record<string, string | undefined>, bridge: { socket: string; token: string }): Record<string, string | undefined> {
  return { ...withoutBilling(base), CLAUDE_CODE_RETRY_WATCHDOG: "1", HARNESS_BRIDGE_SOCKET: bridge.socket, HARNESS_BRIDGE_TOKEN: bridge.token };
}

/** An environment without the variables that would bill Claude Code by API key instead of the subscription. */
function withoutBilling(base: Record<string, string | undefined>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(base)) {
    if (!BILLING_VARIABLES.includes(name)) {
      env[name] = value;
    } else {
      // never passed
    }
  }
  return env;
}

export type Preflight = { ok: true; version: string } | { ok: false; message: string };

/**
 * Claude Code installed, new enough, and logged in with a Claude subscription — asked in the
 * environment Claude will run in (an API key variable would make it report key authentication).
 */
export async function preflight(command: string, base: Record<string, string | undefined> = process.env): Promise<Preflight> {
  const env = withoutBilling(base);
  let version: string;
  try {
    version = (await run(command, ["--version"], { timeout: 20_000, env })).stdout.trim();
  } catch {
    return { ok: false, message: "Claude Code is not installed (no `claude` on PATH): install it as Anthropic documents (https://code.claude.com/docs/en/setup), then log in with `claude auth login`." };
  }
  if (compareVersions(version, MIN_CLAUDE_VERSION) < 0) {
    return { ok: false, message: `Claude Code ${version} is older than ${MIN_CLAUDE_VERSION}: update Claude Code (\`claude update\`).` };
  } else {
    try {
      const status = JSON.parse((await run(command, ["auth", "status"], { timeout: 20_000, env })).stdout) as { loggedIn?: boolean; authMethod?: string; apiProvider?: string };
      if (status.loggedIn === true && status.authMethod === "claude.ai" && status.apiProvider === "firstParty") {
        return { ok: true, version };
      } else {
        return { ok: false, message: "Claude Code is not logged in with a Claude subscription: run `claude auth login` (harness runs Claude only on your own subscription)." };
      }
    } catch (error) {
      return { ok: false, message: `\`claude auth status\` failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}
