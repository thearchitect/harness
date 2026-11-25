// Claude Code's stream-json → SubagentEvents. Stateful only where the stream is: the session's
// capabilities, the last rate-limit window, the Bash commands by tool_use_id (the commands of
// background tasks), and whether Claude waits for its limit.

import type { ClaudeContent, ClaudeOutput, ClaudeTaskStatus } from "#protocol/claude.ts";
import type { TaskState } from "#protocol/state.ts";
import type { SubagentEvent } from "../../engine.ts";

/** A retry this long or longer is a wait for the subscription limit, not a hiccup. */
const LIMIT_WAIT_MS = 60_000;

export function taskState(status: ClaudeTaskStatus): TaskState {
  switch (status) {
    case "pending":
    case "running":
      return "running";
    case "completed":
      return "exited";
    case "failed":
      return "failed";
    case "killed":
      return "stopped";
    default:
      throw new Error(`unknown Claude task status: ${String(status satisfies never)}`);
  }
}

function stepSummary(name: string, input: Record<string, unknown>): string {
  const first = input.file_path ?? input.command ?? input.path ?? input.pattern ?? input.url ?? input.description;
  return typeof first === "string" ? `${name} ${first.split("\n")[0]?.slice(0, 120)}` : name;
}

export class ClaudeStream {
  session: string | undefined;
  model: string | undefined;
  apiKeySource: string | undefined;
  capabilities = new Set<string>();
  version: string | undefined;
  /** Bash commands by tool_use_id: a background task names the call that started it. */
  private readonly commands = new Map<string, string>();
  private readonly taskCommands = new Map<string, string>();
  private window = "limit";
  private resetsAt: number | undefined;
  private waiting = false;
  private lastText = "";

  /** One line of the stream; malformed lines and unknown types give nothing. */
  push(line: string): SubagentEvent[] {
    let message: ClaudeOutput;
    try {
      message = JSON.parse(line) as ClaudeOutput;
    } catch {
      return [];
    }
    return this.read(message);
  }

  private endWait(): SubagentEvent[] {
    if (this.waiting) {
      this.waiting = false;
      return [{ kind: "rate_limit_over" }];
    } else {
      return [];
    }
  }

  private read(message: ClaudeOutput): SubagentEvent[] {
    switch (message.type) {
      case "system":
        return this.system(message);
      case "rate_limit_event": {
        const info = message.rate_limit_info;
        this.window = info.rateLimitType ?? this.window;
        this.resetsAt = info.resetsAt !== undefined ? info.resetsAt * 1000 : this.resetsAt;
        return [...(info.status !== "rejected" ? this.endWait() : []), ...(info.isUsingOverage === true ? [{ kind: "overage" as const }] : [])];
      }
      case "assistant": {
        if (message.parent_tool_use_id !== null) {
          return []; // a Claude subagent's own turn
        } else {
          const events: SubagentEvent[] = [...this.endWait()];
          for (const block of message.message.content) {
            events.push(...this.content(block));
          }
          return events;
        }
      }
      case "user":
        return [];
      case "result": {
        const denials = (message.permission_denials ?? []).map((denial) => ({ kind: "denial" as const, tool: denial.tool_name, reason: "refused" }));
        const text = message.result ?? this.lastText;
        const outcome = message.is_error ? (message.subtype === "error_during_execution" && message.api_error === undefined ? "stopped" : "failed") : "done";
        return [
          ...this.endWait(),
          ...denials,
          ...(message.total_cost_usd !== undefined && message.total_cost_usd > 0 ? [{ kind: "usage" as const, costUsd: message.total_cost_usd }] : []),
          { kind: "result", outcome, text, turns: message.num_turns, ...(message.is_error && message.api_error !== undefined ? { error: message.api_error } : {}) },
        ];
      }
      case "control_response":
        return [];
      default:
        return []; // a message type of a newer Claude Code
    }
  }

  private content(block: ClaudeContent): SubagentEvent[] {
    if (block.type === "text" && typeof block.text === "string") {
      this.lastText = block.text;
      return [{ kind: "text", text: block.text }];
    } else if (block.type === "tool_use") {
      const { id, name, input } = block as { id: string; name: string; input: Record<string, unknown> };
      if (name === "Bash" && typeof input.command === "string") {
        this.commands.set(id, input.command);
      } else {
        // not a command
      }
      const path = input.file_path ?? input.notebook_path;
      const changes = (name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit") && typeof path === "string";
      return [{ kind: "step", tool: name, summary: stepSummary(name, input) }, ...(changes ? [{ kind: "file" as const, path: path as string }] : [])];
    } else {
      return [];
    }
  }

  private system(message: Extract<ClaudeOutput, { type: "system" }>): SubagentEvent[] {
    switch (message.subtype) {
      case "init":
        this.session = message.session_id;
        this.model = message.model;
        this.apiKeySource = message.apiKeySource;
        this.capabilities = new Set(message.capabilities ?? []);
        this.version = message.claude_code_version;
        return [{ kind: "init", model: message.model }];
      case "api_retry":
        if (message.error === "rate_limit" && message.retry_delay_ms >= LIMIT_WAIT_MS && !this.waiting) {
          this.waiting = true;
          return [{ kind: "rate_limit_wait", window: this.window, resetsAt: this.resetsAt ?? Date.now() + message.retry_delay_ms }];
        } else {
          return []; // a short retry
        }
      case "task_started": {
        const command = (message.tool_use_id !== undefined ? this.commands.get(message.tool_use_id) : undefined) ?? message.description ?? message.task_id;
        this.taskCommands.set(message.task_id, command);
        return [{ kind: "task", id: message.task_id, state: "running", command }];
      }
      case "task_updated":
        return message.patch.status !== undefined ? [{ kind: "task", id: message.task_id, state: taskState(message.patch.status), command: this.taskCommands.get(message.task_id) }] : [];
      case "task_notification":
        return [{ kind: "task", id: message.task_id, state: taskState(message.status), command: this.taskCommands.get(message.task_id), ...(message.output_file !== undefined ? { outputFile: message.output_file } : {}) }];
      case "background_tasks_changed":
        // the live set: each listed task runs; how one ended comes with its task_notification
        return message.tasks.map((task) => ({ kind: "task" as const, id: task.task_id, state: "running" as const, command: this.taskCommands.get(task.task_id) ?? task.description }));
      default:
        return []; // a system message harness does not read
    }
  }
}
