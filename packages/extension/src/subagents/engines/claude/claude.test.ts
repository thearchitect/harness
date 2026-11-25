import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bridge } from "./bridge.ts";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChangeAuthorization, ChangeRequest } from "../../../core/authorize.ts";
import { BILLING_VARIABLES, claudeArgs, claudeEnv, compareVersions, modelFlags } from "./launch.ts";
import { changeLines, decide } from "./policy.ts";
import { ClaudeStream } from "./stream.ts";

const FIXTURES = join(import.meta.dirname, "testdata");

function events(file: string) {
  const stream = new ClaudeStream();
  return { stream, events: readFileSync(join(FIXTURES, file), "utf8").split("\n").filter((line) => line !== "").flatMap((line) => stream.push(line)) };
}

test("a run that hit the usage limit: init, the limit's text, a failed result naming the error", () => {
  const { stream, events: list } = events("usage-limit.jsonl");
  assert.equal(stream.model, "claude-opus-5-5");
  assert.equal(stream.apiKeySource, "none");
  assert.ok(stream.capabilities.has("interrupt_receipt_v1"));
  assert.deepEqual(list[0], { kind: "init", model: "claude-opus-5-5" });
  const result = list.at(-1);
  assert.equal(result?.kind, "result");
  assert.ok(result?.kind === "result" && result.outcome === "failed" && result.error === "usage_limit_reached" && /weekly limit/.test(result.text));
});

test("the retry watchdog's long retry is a limit wait with its window and reset time", () => {
  const { events: list } = events("watchdog.jsonl");
  const wait = list.find((event) => event.kind === "rate_limit_wait");
  assert.deepEqual(wait, { kind: "rate_limit_wait", window: "seven_day", resetsAt: 1795572000 * 1000 });
});

test("a recorded run with background tasks: each runs with its command, then exits with its output file", () => {
  const { events: list } = events("background-tasks.jsonl");
  const tasks = list.filter((event) => event.kind === "task");
  const first = tasks.filter((event) => event.kind === "task" && event.id === "b1trb1kk5");
  assert.ok(first.length >= 3);
  // the live set comes before task_started: its description first, then the command from the Bash call
  assert.ok(first[0]?.kind === "task" && first[0].command === "Sleep 20 seconds then print finished");
  assert.ok(first.slice(1).every((event) => event.kind === "task" && event.command === "sleep 20; echo finished"), JSON.stringify(first));
  const last = first.at(-1);
  assert.ok(last?.kind === "task" && last.state === "exited" && last.outputFile?.endsWith("/tasks/b1trb1kk5.output"));
  assert.equal(list.at(-1)?.kind, "result");
});

test("steps, changed files, background tasks with their commands, and the end of a wait", () => {
  const stream = new ClaudeStream();
  const push = (message: object) => stream.push(JSON.stringify(message));
  push({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 9, retry_delay_ms: 3_600_000, error: "rate_limit", session_id: "s" });
  const after = push({
    type: "assistant",
    parent_tool_use_id: null,
    session_id: "s",
    message: {
      content: [
        { type: "text", text: "Editing" },
        { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/p/a.ts", old_string: "a", new_string: "b" } },
        { type: "tool_use", id: "t2", name: "Bash", input: { command: "npm run dev", run_in_background: true } },
      ],
    },
  });
  assert.deepEqual(after.map((event) => event.kind), ["rate_limit_over", "text", "step", "file", "step"]);
  assert.deepEqual(push({ type: "system", subtype: "task_started", task_id: "b1", tool_use_id: "t2", task_type: "local_bash", session_id: "s" }), [{ kind: "task", id: "b1", state: "running", command: "npm run dev" }]);
  assert.deepEqual(push({ type: "system", subtype: "task_notification", task_id: "b1", status: "completed", output_file: "/tmp/b1.out", session_id: "s" }), [
    { kind: "task", id: "b1", state: "exited", command: "npm run dev", outputFile: "/tmp/b1.out" },
  ]);
  assert.deepEqual(push({ type: "assistant", parent_tool_use_id: "t9", session_id: "s", message: { content: [{ type: "text", text: "inner" }] } }), [], "a Claude subagent's own turn");
  assert.deepEqual(push({ type: "brand_new_type" }), []);
  assert.deepEqual(stream.push("not json"), []);
});

test("model references become --model and --effort; versions compare as numbers", () => {
  assert.deepEqual(modelFlags("anthropic/opus:medium"), ["--model", "opus", "--effort", "medium"]);
  assert.deepEqual(modelFlags("anthropic/claude-opus-5-5"), ["--model", "claude-opus-5-5"]);
  assert.deepEqual(modelFlags(undefined), []);
  assert.ok(compareVersions("2.1.303 (Claude Code)", "2.1.259") > 0);
  assert.ok(compareVersions("2.1.99", "2.1.259") < 0);
  assert.equal(compareVersions("2.1.259", "2.1.259"), 0);
});

test("the command line: stream-json both ways, harness's hook and MCP bridge only, manual permissions answered by the host", () => {
  const args = claudeArgs({ sessionId: "11111111-1111-1111-1111-111111111111", resume: false, model: "anthropic/opus:high", bridge: ["/bin/node", "/x/claude bridge.ts"], workspace: "/w", systemPrompt: "rules" });
  const flag = (name: string): string | undefined => args[args.indexOf(name) + 1];
  assert.equal(flag("--input-format"), "stream-json");
  assert.equal(flag("--output-format"), "stream-json");
  assert.equal(flag("--permission-mode"), "manual");
  assert.equal(flag("--permission-prompt-tool"), "mcp__harness__permission");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(flag("--session-id"), "11111111-1111-1111-1111-111111111111");
  const settings = JSON.parse(flag("--settings") ?? "{}") as { hooks: { PreToolUse: { hooks: { command: string; timeout: number }[] }[] } };
  assert.equal(settings.hooks.PreToolUse[0]?.hooks[0]?.command, "/bin/node '/x/claude bridge.ts' hook");
  assert.equal(settings.hooks.PreToolUse[0]?.hooks[0]?.timeout, 2_592_000);
  const mcp = JSON.parse(flag("--mcp-config") ?? "{}") as { mcpServers: Record<string, { command: string; args: string[] }> };
  assert.deepEqual(Object.keys(mcp.mcpServers), ["harness"]);
  assert.deepEqual(mcp.mcpServers.harness?.args, ["/x/claude bridge.ts", "mcp"]);
  assert.ok(claudeArgs({ sessionId: "s", resume: true, model: undefined, bridge: ["b"], workspace: "/w", systemPrompt: "" }).includes("--resume"));
});

test("Claude's environment: no API billing variables, the bridge's address, the retry watchdog", () => {
  const base = Object.fromEntries([...BILLING_VARIABLES.map((name) => [name, "x"]), ["PATH", "/bin"], ["HOME", "/home/u"]]);
  const env = claudeEnv(base, { socket: "/s.sock", token: "t" });
  for (const name of BILLING_VARIABLES) {
    assert.equal(env[name], undefined, name);
  }
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HARNESS_BRIDGE_SOCKET, "/s.sock");
  assert.equal(env.HARNESS_BRIDGE_TOKEN, "t");
  assert.equal(env.CLAUDE_CODE_RETRY_WATCHDOG, "1");
});

function ask(socket: string, request: object): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const connection = createConnection(socket);
    let text = "";
    connection.on("data", (chunk: Buffer) => {
      text += String(chunk);
      if (text.includes("\n")) {
        connection.end();
        resolve(JSON.parse(text) as Record<string, unknown>);
      } else {
        // more to come
      }
    });
    connection.on("error", reject);
    connection.write(`${JSON.stringify(request)}\n`);
  });
}

test("the bridge: a private socket, its token only; the hook's decision; MCP with harness's tools and the permission tool", async () => {
  const bridge = await Bridge.open(mkdtempSync(join(tmpdir(), "bridge-")), {
    decide: async (input) => (input.tool_name === "Write" ? { behavior: "deny", reason: "not now" } : { behavior: "allow" }),
    tools: () => [{ name: "bash", description: "run", inputSchema: { type: "object" } }],
    callTool: async (name) => ({ text: `ran ${name}`, isError: false }),
  });
  try {
    assert.equal(statSync(join(bridge.socket, "..")).mode & 0o777, 0o700);
    assert.deepEqual(await ask(bridge.socket, { token: "forged", kind: "hook", input: {} }), { error: "unauthorized" });
    const denied = await ask(bridge.socket, { token: bridge.token, kind: "hook", input: { hook_event_name: "PreToolUse", session_id: "s", tool_name: "Write", tool_input: {} } });
    assert.deepEqual(denied, { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "not now" } });
    const list = await ask(bridge.socket, { token: bridge.token, kind: "mcp", message: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    assert.deepEqual((list.result as { tools: { name: string }[] }).tools.map((tool) => tool.name), ["bash", "permission"]);
    const permission = await ask(bridge.socket, { token: bridge.token, kind: "mcp", message: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "permission", arguments: { tool_name: "Write", input: { file_path: "/x" } } } } });
    assert.deepEqual(permission.result, { content: [{ type: "text", text: JSON.stringify({ behavior: "deny", message: "not now" }) }] });
    const called = await ask(bridge.socket, { token: bridge.token, kind: "mcp", message: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "bash", arguments: {} } } });
    assert.deepEqual(called.result, { content: [{ type: "text", text: "ran bash" }], isError: false });
  } finally {
    bridge.close();
  }
});

test("harness's rules for Claude's tools: changes ask harness's authorization, the rest passes", async () => {
  const asked: ChangeRequest[] = [];
  let answer: ChangeAuthorization = { kind: "allowed" };
  let stopped = false;
  const comments: string[] = [];
  const deps = {
    authorize: async (_ctx: ExtensionContext, request: ChangeRequest) => {
      asked.push(request);
      return answer;
    },
    ctx: {} as ExtensionContext,
    toolCallId: "call",
    profile: "builder",
    stop: () => {
      stopped = true;
    },
    comment: (text: string) => comments.push(text),
  };
  const hook = (tool_name: string, tool_input: Record<string, unknown>) => ({ hook_event_name: "PreToolUse", session_id: "s", tool_name, tool_input, tool_use_id: "u1" });

  assert.deepEqual(await decide(hook("Bash", { command: "ls" }), deps), { behavior: "allow" });
  assert.deepEqual(await decide(hook("Read", { file_path: "/p/a" }), deps), { behavior: "allow" });
  assert.deepEqual(await decide(hook("mcp__harness__write", { path: "/p/a" }), deps), { behavior: "allow" });
  assert.equal(asked.length, 0);

  answer = { kind: "allowed", comment: "keep the name" };
  assert.deepEqual(await decide(hook("Edit", { file_path: "/p/a.ts", old_string: "x", new_string: "y" }), deps), { behavior: "allow" });
  assert.deepEqual(asked[0], { tool: "edit", toolCallId: "call/u1", paths: ["/p/a.ts"], lines: ["Edit: /p/a.ts", "- x", "+ y"], by: "builder" });
  assert.deepEqual(comments, ["keep the name"]);

  answer = { kind: "blocked", reason: "File change rejected by user — not this file", terminate: false };
  assert.deepEqual(await decide(hook("Write", { file_path: "/p/b.ts", content: "z" }), deps), { behavior: "deny", reason: "File change rejected by user — not this file" });
  assert.equal(stopped, false);

  answer = { kind: "blocked", reason: "File change stopped by user", terminate: true };
  assert.equal((await decide(hook("Edit", { file_path: "/p/a.ts" }), deps)).behavior, "deny");
  assert.equal(stopped, true);

  assert.deepEqual(await decide(hook("Edit", {}), deps), { behavior: "deny", reason: "Edit without a file path" });
  assert.deepEqual(changeLines("MultiEdit", { edits: [{ old_string: "a", new_string: "b" }] }), ["- a", "+ b"]);
});
