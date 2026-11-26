// Claude Code's stream-json as a pi transcript: messages, tools mapped to pi's renderers, the steps
// of Claude's own subagents inside their Task call (nested ones inside theirs), partial messages,
// the run's end; and the fixtures recorded from the real Claude Code read without loss.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ClaudeTranscript, piToolCall, type TaskDetails, type TranscriptEntry } from "./claude-transcript.ts";

const TESTDATA = join(import.meta.dirname, "..", "..", "extension", "src", "subagents", "engines", "claude", "testdata");

function lines(name: string): { type: string }[] {
  return readFileSync(join(TESTDATA, name), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { type: string });
}

/** The messages, loosely typed: the test reads the shapes it checks. */
function messages(entries: TranscriptEntry[]): any[] {
  return entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
}

test("Claude's tools as pi's renderers know them", () => {
  assert.deepEqual(piToolCall("Bash", { command: "ls", timeout: 5000 }), { name: "bash", args: { command: "ls", timeout: 5 } });
  assert.deepEqual(piToolCall("Read", { file_path: "/a", offset: 2, limit: 3 }), { name: "read", args: { path: "/a", offset: 2, limit: 3 } });
  assert.deepEqual(piToolCall("Edit", { file_path: "/a", old_string: "x", new_string: "y" }), { name: "edit", args: { path: "/a", edits: [{ oldText: "x", newText: "y" }] } });
  assert.deepEqual(piToolCall("MultiEdit", { file_path: "/a", edits: [{ old_string: "1", new_string: "2" }] }), { name: "edit", args: { path: "/a", edits: [{ oldText: "1", newText: "2" }] } });
  assert.deepEqual(piToolCall("Write", { file_path: "/a", content: "c" }), { name: "write", args: { path: "/a", content: "c" } });
  assert.deepEqual(piToolCall("Grep", { pattern: "p", path: "/d" }), { name: "grep", args: { pattern: "p", path: "/d" } });
  assert.deepEqual(piToolCall("Glob", { pattern: "*.ts" }), { name: "find", args: { pattern: "*.ts" } });
  assert.deepEqual(piToolCall("mcp__harness__lsp_hover", { file: "a" }), { name: "lsp_hover", args: { file: "a" } });
  assert.deepEqual(piToolCall("WebFetch", { url: "u" }), { name: "WebFetch", args: { url: "u" } });
});

test("a transcript: the messages sent, Claude's messages with thinking and tools, the steps of its subagents inside their Task, the run's end", () => {
  const transcript = new ClaudeTranscript();
  for (const line of lines("transcript.jsonl")) {
    transcript.push(line);
  }
  const all = messages(transcript.entries);
  assert.deepEqual(
    all.map((message) => message.role),
    ["user", "assistant", "toolResult", "assistant", "toolResult", "user", "assistant", "toolResult", "assistant"],
  );
  assert.equal(transcript.model, "claude-opus-5-5");
  assert.equal(transcript.costUsd, 0.12);
  assert.equal(transcript.streaming, undefined);

  // one message of the blocks that came one by one under the same id
  const first = all[1] as { content: { type: string; [key: string]: unknown }[] };
  assert.deepEqual(
    first.content.map((block) => block.type),
    ["thinking", "text", "toolCall"],
  );
  assert.deepEqual(first.content[2], { type: "toolCall", id: "tu_edit", name: "edit", arguments: { path: "/p/a.ts", edits: [{ oldText: "let x = 1", newText: "let x = 2" }] } });
  assert.equal((all[2] as { toolName: string }).toolName, "edit");

  // the subagent's steps: inside the Task's result only, the nested Task's inside its step
  const task = all[4] as { toolCallId: string; details: TaskDetails; content: { text: string }[] };
  assert.equal(task.toolCallId, "tu_task");
  assert.equal(task.details.running, false);
  assert.equal(task.content[0]?.text, "Tests pass, lint is clean");
  assert.deepEqual(
    task.details.steps.map((step) => (step.kind === "tool" ? `${step.name}:${step.result ?? ""}` : `${step.kind}:${step.text}`)),
    ["text:Running the tests", "bash:3 passing", "Task:Lint is clean"],
  );
  const nested = task.details.steps[2];
  assert.ok(nested?.kind === "tool" && nested.steps !== undefined);
  assert.deepEqual(
    nested.steps.map((step) => (step.kind === "tool" ? `${step.name}:${step.result ?? ""}` : step.kind)),
    ["bash:clean"],
  );
  assert.ok(!JSON.stringify(transcript.entries.filter((entry) => entry.id !== "r-tu_task")).includes("npm test"), "no step of the subagent at the top level");

  // the operator's steering, harness's own tools by their names, the run's banner
  assert.deepEqual(all[5], { role: "user", content: "also update the docs", harnessFrom: "operator" });
  assert.equal(((all[6] as { content: { name: string }[] }).content[0] as { name: string }).name, "lsp_diagnostics");
  const banner = transcript.entries.at(-1);
  assert.equal(banner?.type, "custom");
  assert.deepEqual(banner?.type === "custom" ? banner.data : undefined, { outcome: "done", turns: 4, costUsd: 0.12, durationMs: 42000, error: undefined, denials: [] });
});

test("partials: the message being streamed grows, then the whole message replaces it; a Task's steps come as updates in order", () => {
  const transcript = new ClaudeTranscript();
  const all = lines("transcript.jsonl");
  const seen: string[] = [];
  for (const [index, line] of all.entries()) {
    const changed = transcript.push(line);
    if (index === 6) {
      assert.deepEqual(transcript.streaming, { role: "assistant", content: [{ type: "thinking", thinking: "Look at a.ts" }, { type: "text", text: "I will **fix** it" }] });
    } else if (index === 7) {
      assert.equal(transcript.streaming, undefined, "the whole message came");
    } else {
      // between
    }
    if (changed.includes("r-tu_task")) {
      const entry = transcript.entry("r-tu_task");
      const details = entry?.type === "message" ? (entry.message.details as TaskDetails) : undefined;
      seen.push(`${details?.steps.length}${details?.running === true ? "+" : ""}`);
    } else {
      // another entry
    }
  }
  assert.deepEqual(seen, ["0+", "2+", "2+", "3+", "3+", "3+", "3+", "3"]);
});

test("the recorded runs of the real Claude Code read without loss", () => {
  for (const name of ["background-tasks.jsonl", "usage-limit.jsonl", "watchdog.jsonl"]) {
    const transcript = new ClaudeTranscript();
    for (const line of lines(name)) {
      transcript.push(line);
    }
    const tools = messages(transcript.entries).flatMap((message) =>
      message.role === "assistant" ? (message.content as { type: string; name?: string }[]).filter((block) => block.type === "toolCall").map((block) => block.name) : [],
    );
    const results = messages(transcript.entries).filter((message) => message.role === "toolResult");
    assert.ok(results.length <= tools.length, `${name}: every result has its call`);
    if (name === "background-tasks.jsonl") {
      assert.ok(tools.includes("bash"), `${name}: Bash as bash`);
      assert.ok(transcript.entries.some((entry) => entry.type === "custom"), `${name}: the run's end`);
    } else if (name === "watchdog.jsonl") {
      assert.ok(transcript.entries.some((entry) => entry.type === "custom" && JSON.stringify(entry.data).includes("waits")), `${name}: the long wait shows`);
    } else {
      assert.ok(transcript.entries.length > 0, `${name}: something to show`);
    }
  }
});
