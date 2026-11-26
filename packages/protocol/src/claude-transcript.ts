// Claude Code's stream-json as a pi session's transcript (plan polish-2 M), so clients draw a
// `claude` subagent with the same components as a session: Claude's assistant messages become pi
// assistant messages (text, thinking, tool calls), its tool results pi tool results, the messages
// harness wrote to it user messages, its result a banner entry. Claude's tools map to pi's
// renderers (Bash → bash, Edit → edit with its diff, mcp__harness__<tool> → <tool>); the others keep
// their names and get pi's generic view. Events of Claude's own subagents (parent_tool_use_id) do not
// reach the top level: they become the steps of the Task call that started them, in its result's
// details, updated while it runs. Partial messages (--include-partial-messages) make the message
// being streamed.
//
// Entries keep ids across updates: `push` says which ones changed, so a client upserts them.

import type { ClaudeOutput } from "./claude.ts";

/** A pi message as transcripts carry it. */
export type TranscriptMessage = { role: string; [key: string]: unknown };

export type TranscriptEntry =
  | { type: "message"; id: string; message: TranscriptMessage }
  | { type: "custom"; id: string; customType: string; data: unknown };

/** One step of a Claude subagent (a Task call), as its row draws it. */
export type TaskStep =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; args: Record<string, unknown>; result?: string; isError?: boolean; /** A nested Task's own steps. */ steps?: TaskStep[] };

/** The details of a Task call's result: its subagent's steps; `running` until its result came. */
export type TaskDetails = { steps: TaskStep[]; running: boolean };

/** A tool call's arguments on one line: the command, path, pattern or the like. */
export function argumentsLine(args: Record<string, unknown>): string {
  const first = args.command ?? args.path ?? args.pattern ?? args.url ?? args.description ?? args.query;
  return typeof first === "string" ? (first.split("\n")[0] ?? "").slice(0, 120) : "";
}

/** A step on one line: what a collapsed Task row shows of the latest. */
export function stepLine(step: TaskStep): string {
  switch (step.kind) {
    case "text":
      return (step.text.split("\n").find((line) => line.trim() !== "") ?? "").slice(0, 160);
    case "thinking":
      return `thinking: ${(step.text.split("\n").find((line) => line.trim() !== "") ?? "").slice(0, 150)}`;
    case "tool":
      return `${step.name} ${argumentsLine(step.args)}`.trim();
    default:
      throw new Error(`unknown step: ${JSON.stringify(step satisfies never)}`);
  }
}

/** A line harness writes into a Claude session's log next to Claude's own: what it sent Claude. */
export type ClaudeInputLine = { type: "harness_input"; from: "caller" | "operator"; text: string };

/** The tools whose calls start a Claude subagent. */
export const CLAUDE_TASK_TOOLS = new Set(["Task", "Agent"]);

/** The custom entries of a Claude transcript (harness's own renderers draw them). */
export const CLAUDE_RESULT_ENTRY = "harness-claude-result";
export const CLAUDE_NOTICE_ENTRY = "harness-claude-notice";

/** A Claude tool call as pi's renderers know it: the name and the arguments they read. */
export function piToolCall(name: string, input: Record<string, unknown>): { name: string; args: Record<string, unknown> } {
  const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
  switch (name) {
    case "Bash":
      return { name: "bash", args: { command: input.command, ...(input.timeout !== undefined ? { timeout: Number(input.timeout) / 1000 } : {}) } };
    case "Read":
      return { name: "read", args: { path: input.file_path, ...(input.offset !== undefined ? { offset: input.offset } : {}), ...(input.limit !== undefined ? { limit: input.limit } : {}) } };
    case "Edit":
      return { name: "edit", args: { path: input.file_path, edits: [{ oldText: text(input.old_string) ?? "", newText: text(input.new_string) ?? "" }] } };
    case "MultiEdit":
      return {
        name: "edit",
        args: { path: input.file_path, edits: ((input.edits as { old_string?: string; new_string?: string }[] | undefined) ?? []).map((edit) => ({ oldText: edit.old_string ?? "", newText: edit.new_string ?? "" })) },
      };
    case "Write":
      return { name: "write", args: { path: input.file_path, content: input.content } };
    case "Grep":
      return { name: "grep", args: { pattern: input.pattern, ...(input.path !== undefined ? { path: input.path } : {}), ...(input.glob !== undefined ? { glob: input.glob } : {}) } };
    case "Glob":
      return { name: "find", args: { pattern: input.pattern, ...(input.path !== undefined ? { path: input.path } : {}) } };
    default:
      return name.startsWith("mcp__harness__") ? { name: name.slice("mcp__harness__".length), args: input } : { name, args: input };
  }
}

/** A tool result's content as text. */
function resultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  } else if (Array.isArray(content)) {
    return (content as { type?: string; text?: string }[]).map((block) => (block.type === "text" ? (block.text ?? "") : `[${block.type ?? "?"}]`)).join("\n");
  } else {
    return "";
  }
}

type StreamEvent = {
  type: "stream_event";
  event: { type: string; index?: number; content_block?: { type: string; id?: string; name?: string }; delta?: { type: string; text?: string; thinking?: string; partial_json?: string } };
  parent_tool_use_id?: string | null;
};

type Block = { type: string; [key: string]: unknown };

export class ClaudeTranscript {
  readonly entries: TranscriptEntry[] = [];
  /** The message being streamed (partial messages), at the top level. */
  streaming: TranscriptMessage | undefined;
  /** The model Claude runs (its init), and the cost of its runs so far. */
  model: string | undefined;
  costUsd = 0;
  private readonly index = new Map<string, number>();
  /** Tool names by call id (results name their call's tool). */
  private readonly calls = new Map<string, { name: string; claude: string }>();
  /** The Task call each subagent event belongs to, by tool_use_id: its steps. */
  private readonly tasks = new Map<string, TaskStep[]>();
  /** The top-level Task call a nested Task belongs to: its steps show inside that call. */
  private readonly roots = new Map<string, string>();
  private inputs = 0;
  private results = 0;

  private upsert(entry: TranscriptEntry, changed: Set<string>): void {
    const at = this.index.get(entry.id);
    if (at !== undefined) {
      this.entries[at] = entry;
    } else {
      this.index.set(entry.id, this.entries.length);
      this.entries.push(entry);
    }
    changed.add(entry.id);
  }

  entry(id: string): TranscriptEntry | undefined {
    const at = this.index.get(id);
    return at !== undefined ? this.entries[at] : undefined;
  }

  /** One line of the log (Claude's stream-json, or what harness sent it); the ids of the entries it changed. */
  push(line: ClaudeOutput | ClaudeInputLine | StreamEvent | { type: string }): string[] {
    const changed = new Set<string>();
    const record = line as { type: string; [key: string]: unknown };
    switch (record.type) {
      case "harness_input": {
        const input = line as ClaudeInputLine;
        this.inputs += 1;
        this.upsert({ type: "message", id: `in-${this.inputs}`, message: { role: "user", content: input.text, ...(input.from === "operator" ? { harnessFrom: "operator" } : {}) } }, changed);
        break;
      }
      case "system": {
        const system = line as Extract<ClaudeOutput, { type: "system" }>;
        if (system.subtype === "init") {
          this.model = system.model;
        } else if (system.subtype === "api_retry" && system.retry_delay_ms >= 60_000) {
          this.notice(`Claude waits ${Math.round(system.retry_delay_ms / 60_000)} min to retry (${system.error ?? "API error"})`, changed);
        } else {
          // tasks and other system messages: the session's tasks show them
        }
        break;
      }
      case "stream_event":
        this.stream(line as StreamEvent);
        break;
      case "assistant":
        this.assistant(line as Extract<ClaudeOutput, { type: "assistant" }>, changed);
        break;
      case "user":
        this.user(line as Extract<ClaudeOutput, { type: "user" }>, changed);
        break;
      case "result": {
        const result = line as Extract<ClaudeOutput, { type: "result" }>;
        this.streaming = undefined;
        this.results += 1;
        this.costUsd = result.total_cost_usd ?? this.costUsd;
        const outcome = result.is_error ? (result.subtype === "error_during_execution" && result.api_error === undefined ? "stopped" : "failed") : "done";
        this.upsert(
          {
            type: "custom",
            id: `result-${this.results}`,
            customType: CLAUDE_RESULT_ENTRY,
            data: { outcome, turns: result.num_turns, costUsd: result.total_cost_usd, durationMs: result.duration_ms, error: result.api_error, denials: (result.permission_denials ?? []).map((denial) => denial.tool_name) },
          },
          changed,
        );
        break;
      }
      default:
        break; // rate limits, control answers, newer types: no entry
    }
    return [...changed];
  }

  private notice(text: string, changed: Set<string>): void {
    this.results += 1;
    this.upsert({ type: "custom", id: `notice-${this.results}`, customType: CLAUDE_NOTICE_ENTRY, data: { text } }, changed);
  }

  private assistant(message: Extract<ClaudeOutput, { type: "assistant" }>, changed: Set<string>): void {
    const blocks = message.message.content as Block[];
    const parent = message.parent_tool_use_id;
    if (parent !== null) {
      // a step of a Claude subagent: into its Task call's result
      const steps = this.tasks.get(parent) ?? [];
      for (const block of blocks) {
        if (block.type === "text") {
          steps.push({ kind: "text", text: String(block.text ?? "") });
        } else if (block.type === "thinking") {
          steps.push({ kind: "thinking", text: String(block.thinking ?? "") });
        } else if (block.type === "tool_use") {
          const id = String(block.id);
          const call = piToolCall(String(block.name), (block.input as Record<string, unknown>) ?? {});
          const nested = CLAUDE_TASK_TOOLS.has(String(block.name)) ? [] : undefined;
          steps.push({ kind: "tool", id, name: call.name, args: call.args, ...(nested !== undefined ? { steps: nested } : {}) });
          this.calls.set(id, { name: call.name, claude: String(block.name) });
          if (nested !== undefined) {
            // a Task of the subagent: its steps go into this step
            this.tasks.set(id, nested);
            this.roots.set(id, this.roots.get(parent) ?? parent);
          } else {
            // an ordinary tool of the subagent
          }
        } else {
          // another block kind: not drawn
        }
      }
      this.tasks.set(parent, steps);
      this.taskProgress(parent, changed);
    } else {
      const id = `a-${(message.message as { id?: string }).id ?? this.entries.length}`;
      const previous = this.entry(id);
      const content = previous?.type === "message" ? [...(previous.message.content as Block[])] : [];
      const started: string[] = [];
      for (const block of blocks) {
        if (block.type === "text") {
          content.push({ type: "text", text: block.text });
        } else if (block.type === "thinking") {
          content.push({ type: "thinking", thinking: block.thinking });
        } else if (block.type === "tool_use") {
          const call = piToolCall(String(block.name), (block.input as Record<string, unknown>) ?? {});
          this.calls.set(String(block.id), { name: call.name, claude: String(block.name) });
          content.push({ type: "toolCall", id: block.id, name: call.name, arguments: call.args });
          if (CLAUDE_TASK_TOOLS.has(String(block.name))) {
            this.tasks.set(String(block.id), this.tasks.get(String(block.id)) ?? []);
            started.push(String(block.id));
          } else {
            // an ordinary tool
          }
        } else {
          // another block kind: not drawn
        }
      }
      this.streaming = undefined;
      this.upsert({ type: "message", id, message: { role: "assistant", content, model: message.message.model ?? this.model, stopReason: "toolUse" } }, changed);
      // a Task's result row follows its call, showing its steps as they come
      for (const task of started) {
        this.taskProgress(task, changed);
      }
    }
  }

  private user(message: Extract<ClaudeOutput, { type: "user" }>, changed: Set<string>): void {
    const content = message.message.content;
    const parent = message.parent_tool_use_id;
    for (const block of Array.isArray(content) ? (content as Block[]) : []) {
      if (block.type !== "tool_result") {
        continue; // Claude's own echo of the text harness sent: harness wrote it already
      } else if (parent !== null) {
        const steps = this.tasks.get(parent) ?? [];
        const step = steps.find((candidate) => candidate.kind === "tool" && candidate.id === block.tool_use_id);
        if (step?.kind === "tool") {
          step.result = resultText(block.content);
          step.isError = block.is_error === true;
        } else {
          // a result of a call this log does not have
        }
        this.taskProgress(parent, changed);
      } else {
        const id = String(block.tool_use_id);
        const call = this.calls.get(id);
        const steps = this.tasks.get(id);
        this.upsert(
          {
            type: "message",
            id: `r-${id}`,
            message: {
              role: "toolResult",
              toolCallId: id,
              toolName: call?.name ?? "tool",
              content: [{ type: "text", text: resultText(block.content) }],
              isError: block.is_error === true,
              ...(steps !== undefined ? { details: { steps, running: false } satisfies TaskDetails } : {}),
            },
          },
          changed,
        );
      }
    }
  }

  /** A Task call's result while its subagent works: its steps so far (a nested Task's: its top-level call's). */
  private taskProgress(task: string, changed: Set<string>): void {
    const id = this.roots.get(task) ?? task;
    const done = this.entry(`r-${id}`);
    const steps = this.tasks.get(id) ?? [];
    if (done?.type === "message" && (done.message.details as TaskDetails | undefined)?.running === false) {
      return; // its result came: the steps are in it
    } else {
      this.upsert(
        { type: "message", id: `r-${id}`, message: { role: "toolResult", toolCallId: id, toolName: this.calls.get(id)?.name ?? "Task", content: [{ type: "text", text: "" }], isError: false, details: { steps: [...steps], running: true } satisfies TaskDetails } },
        changed,
      );
    }
  }

  private stream(line: StreamEvent): void {
    const event = line.event;
    if (line.parent_tool_use_id !== null && line.parent_tool_use_id !== undefined) {
      return; // a subagent's partials: its steps come whole
    } else if (event.type === "message_start") {
      this.streaming = { role: "assistant", content: [] };
    } else if (this.streaming === undefined) {
      return; // a partial of a message whose start this log lost
    } else if (event.type === "content_block_start" && event.index !== undefined) {
      const content = [...(this.streaming.content as Block[])];
      const block = event.content_block;
      content[event.index] =
        block?.type === "thinking" ? { type: "thinking", thinking: "" } : block?.type === "tool_use" ? { type: "toolCall", id: block.id, name: piToolCall(String(block.name), {}).name, arguments: {} } : { type: "text", text: "" };
      this.streaming = { ...this.streaming, content };
    } else if (event.type === "content_block_delta" && event.index !== undefined) {
      const content = [...(this.streaming.content as Block[])];
      const block = content[event.index] ?? { type: "text", text: "" };
      const delta = event.delta;
      content[event.index] =
        delta?.type === "thinking_delta"
          ? { ...block, thinking: `${String(block.thinking ?? "")}${delta.thinking ?? ""}` }
          : delta?.type === "text_delta"
            ? { ...block, text: `${String(block.text ?? "")}${delta.text ?? ""}` }
            : block;
      this.streaming = { ...this.streaming, content };
    } else if (event.type === "message_stop") {
      // the assistant message comes whole next
    } else {
      // block ends, usage: nothing to draw
    }
  }
}
