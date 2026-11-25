// A fake `claude` for tests of the claude engine: the same command line, stream-json in and out,
// the PreToolUse hook and the MCP server from its flags, control requests (interrupt, stop_task).
// Its behavior is a script (HARNESS_FAKE_CLAUDE_SCRIPT: a JSON array of runs, one per message it
// receives; each run an array of steps). Every start is logged to HARNESS_FAKE_CLAUDE_LOG (argv and
// environment) for invariants.
//
// Steps: { text } · { edit: { file_path, old_string?, new_string?, content? } } (asks the hook,
// writes when allowed) · { mcp: { name, arguments } } (calls harness's MCP tool) · { limit: true }
// (waits for its limit until interrupted) · { task: { id, command } } (a background task until
// stopped) · { sleep: ms }.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

type Step =
  | { text: string }
  | { edit: { file_path: string; old_string?: string; new_string?: string; content?: string } }
  | { mcp: { name: string; arguments: Record<string, unknown> } }
  | { limit: true }
  | { task: { id: string; command: string } }
  | { sleep: number };

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

function out(message: object): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** How this Claude Code presents itself: `${script}.state` (JSON) changes it between tests. */
type FakeState = { version?: string; auth?: "ok" | "out"; keySource?: string };
const state = ((): FakeState => {
  try {
    return JSON.parse(readFileSync(`${process.env.HARNESS_FAKE_CLAUDE_SCRIPT}.state`, "utf8")) as FakeState;
  } catch {
    return {};
  }
})();

if (argv[0] === "--version") {
  process.stdout.write(`${state.version ?? "2.1.303"} (Claude Code)\n`);
  process.exit(0);
} else if (argv[0] === "auth" && argv[1] === "status") {
  const loggedIn = state.auth !== "out";
  process.stdout.write(JSON.stringify({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none", apiProvider: "firstParty" }));
  process.exit(0);
} else {
  // the headless run below
}

const log = process.env.HARNESS_FAKE_CLAUDE_LOG;
if (log !== undefined) {
  appendFileSync(log, `${JSON.stringify({ argv, env: process.env })}\n`);
} else {
  // not logged
}

const session = flag("--session-id") ?? flag("--resume") ?? "fake-session";
const settings = JSON.parse(flag("--settings") ?? "{}") as { hooks?: { PreToolUse?: { hooks: { command: string }[] }[] } };
const hookCommand = settings.hooks?.PreToolUse?.[0]?.hooks[0]?.command;
const mcpServer = (JSON.parse(flag("--mcp-config") ?? "{}") as { mcpServers?: Record<string, { command: string; args: string[] }> }).mcpServers?.harness;
const runs = JSON.parse(readFileSync(process.env.HARNESS_FAKE_CLAUDE_SCRIPT ?? "/dev/null", "utf8") || "[]") as Step[][];
let runIndex = 0;
let initialized = false;
let interrupted = false;
let wake: (() => void) | undefined;
const tasks = new Set<string>();
let toolCounter = 0;

function hook(toolName: string, input: Record<string, unknown>): { decision: "allow" | "deny"; reason: string } {
  if (hookCommand === undefined) {
    return { decision: "allow", reason: "no hook" };
  } else {
    const result = spawnSync("sh", ["-c", hookCommand], { input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: session, tool_name: toolName, tool_input: input, tool_use_id: `u${toolCounter}` }), encoding: "utf8", env: process.env });
    const answer = JSON.parse(result.stdout || "{}") as { hookSpecificOutput?: { permissionDecision: "allow" | "deny"; permissionDecisionReason: string } };
    return { decision: answer.hookSpecificOutput?.permissionDecision ?? "deny", reason: answer.hookSpecificOutput?.permissionDecisionReason ?? "no answer" };
  }
}

let mcp: ChildProcess | undefined;
let mcpBuffer = "";
const mcpWaiters = new Map<number, (message: { result?: unknown; error?: unknown }) => void>();
let mcpCounter = 0;

function mcpCall(method: string, params: unknown): Promise<{ result?: unknown; error?: unknown }> {
  if (mcp === undefined && mcpServer !== undefined) {
    mcp = spawn(mcpServer.command, mcpServer.args, { stdio: ["pipe", "pipe", "inherit"], env: process.env });
    mcp.stdout?.on("data", (chunk: Buffer) => {
      mcpBuffer += String(chunk);
      let newline = mcpBuffer.indexOf("\n");
      while (newline >= 0) {
        const message = JSON.parse(mcpBuffer.slice(0, newline)) as { id: number; result?: unknown; error?: unknown };
        mcpBuffer = mcpBuffer.slice(newline + 1);
        mcpWaiters.get(message.id)?.(message);
        newline = mcpBuffer.indexOf("\n");
      }
    });
  } else {
    // running already
  }
  mcpCounter += 1;
  const id = mcpCounter;
  return new Promise((resolve) => {
    mcpWaiters.set(id, resolve);
    mcp?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });

async function play(steps: Step[]): Promise<void> {
  interrupted = false;
  let lastText = "";
  const denials: { tool_name: string; tool_use_id: string }[] = [];
  for (const step of steps) {
    if (interrupted) {
      break;
    } else if ("text" in step) {
      lastText = step.text;
      out({ type: "assistant", parent_tool_use_id: null, session_id: session, message: { content: [{ type: "text", text: step.text }] } });
    } else if ("edit" in step) {
      toolCounter += 1;
      const name = step.edit.content !== undefined ? "Write" : "Edit";
      out({ type: "assistant", parent_tool_use_id: null, session_id: session, message: { content: [{ type: "tool_use", id: `u${toolCounter}`, name, input: step.edit }] } });
      const { decision, reason } = hook(name, step.edit);
      if (decision === "allow") {
        writeFileSync(step.edit.file_path, step.edit.content ?? step.edit.new_string ?? "");
        out({ type: "user", parent_tool_use_id: null, session_id: session, message: { content: [{ type: "tool_result", tool_use_id: `u${toolCounter}`, content: "ok" }] } });
      } else {
        denials.push({ tool_name: name, tool_use_id: `u${toolCounter}` });
        lastText = `denied: ${reason}`;
        out({ type: "user", parent_tool_use_id: null, session_id: session, message: { content: [{ type: "tool_result", tool_use_id: `u${toolCounter}`, content: reason, is_error: true }] } });
        out({ type: "assistant", parent_tool_use_id: null, session_id: session, message: { content: [{ type: "text", text: lastText }] } });
      }
    } else if ("mcp" in step) {
      toolCounter += 1;
      out({ type: "assistant", parent_tool_use_id: null, session_id: session, message: { content: [{ type: "tool_use", id: `u${toolCounter}`, name: `mcp__harness__${step.mcp.name}`, input: step.mcp.arguments }] } });
      await mcpCall("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "1" } });
      const list = (await mcpCall("tools/list", {})).result as { tools: { name: string }[] };
      writeFileSync(`${process.env.HARNESS_FAKE_CLAUDE_LOG ?? "/dev/null"}.tools`, JSON.stringify(list.tools.map((tool) => tool.name)));
      const called = (await mcpCall("tools/call", { name: step.mcp.name, arguments: step.mcp.arguments })).result as { content: { text: string }[] };
      lastText = `mcp: ${called.content.map((block) => block.text).join("")}`;
      out({ type: "assistant", parent_tool_use_id: null, session_id: session, message: { content: [{ type: "text", text: lastText }] } });
    } else if ("limit" in step) {
      out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: "five_hour" } });
      out({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 300, retry_delay_ms: 3_600_000, error: "rate_limit", session_id: session });
      while (!interrupted) {
        await sleep(60_000);
      }
    } else if ("task" in step) {
      toolCounter += 1;
      out({ type: "assistant", parent_tool_use_id: null, session_id: session, message: { content: [{ type: "tool_use", id: `u${toolCounter}`, name: "Bash", input: { command: step.task.command, run_in_background: true } }] } });
      out({ type: "system", subtype: "task_started", task_id: step.task.id, tool_use_id: `u${toolCounter}`, task_type: "local_bash", session_id: session });
      tasks.add(step.task.id);
    } else {
      await sleep(step.sleep);
    }
  }
  out(
    interrupted
      ? { type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, session_id: session, permission_denials: denials }
      : { type: "result", subtype: "success", is_error: false, result: lastText, num_turns: steps.length, total_cost_usd: 0.01, session_id: session, permission_denials: denials },
  );
}

let buffer = "";
process.stdin.on("data", (chunk: Buffer) => {
  buffer += String(chunk);
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const message = JSON.parse(buffer.slice(0, newline)) as { type: string; request?: { subtype: string; task_id?: string }; request_id?: string };
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (message.type === "user") {
      if (!initialized) {
        initialized = true;
        out({ type: "system", subtype: "init", session_id: session, model: "claude-opus-5-5", apiKeySource: state.keySource ?? "none", capabilities: ["interrupt_receipt_v1"], claude_code_version: "2.1.303" });
      } else {
        // initialized at the first message
      }
      const steps = runs[runIndex] ?? [{ text: "(no scripted run)" }];
      runIndex += 1;
      void play(steps);
    } else if (message.type === "control_request" && message.request?.subtype === "interrupt") {
      interrupted = true;
      wake?.();
      out({ type: "control_response", response: { subtype: "success", request_id: message.request_id } });
    } else if (message.type === "control_request" && message.request?.subtype === "stop_task" && message.request.task_id !== undefined) {
      tasks.delete(message.request.task_id);
      out({ type: "system", subtype: "task_notification", task_id: message.request.task_id, status: "killed", session_id: session });
      out({ type: "control_response", response: { subtype: "success", request_id: message.request_id } });
    } else {
      // ignored
    }
  }
});
process.stdin.on("end", () => {
  mcp?.kill();
  process.exit(0);
});
