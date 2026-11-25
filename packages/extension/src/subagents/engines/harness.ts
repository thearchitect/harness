// The `harness` engine (plan 12.3): the subagent is a child agent on the same node — a pi session
// with harness, the profile's model, tools, role and mode — that this agent follows in full and
// prompts. Its records become SubagentEvents; its interactions reach the operator on their own.

import type { ChildAgent, ChildAgents, ChildRecord } from "../../host.ts";
import type { SubagentEngine, SubagentEvent, SubagentSession, SubagentStart } from "../engine.ts";

type Message = { role?: string; content?: unknown; stopReason?: string; errorMessage?: string; usage?: { cost?: { total?: number } } };

function textOf(message: Message): string {
  return Array.isArray(message.content)
    ? (message.content as { type?: string; text?: string }[])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("")
    : typeof message.content === "string"
      ? message.content
      : "";
}

function stepSummary(tool: string, args: unknown): string {
  const record = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  const first = record.path ?? record.command ?? record.file ?? record.query ?? record.url;
  return typeof first === "string" ? `${tool} ${first.split("\n")[0]?.slice(0, 120)}` : tool;
}

class HarnessSubagent implements SubagentSession {
  readonly engine = "harness" as const;
  private readonly child: ChildAgent;
  private readonly mode: SubagentStart["mode"];
  private readonly listeners = new Set<(event: SubagentEvent) => void>();
  private readonly off: () => void;
  private finalText = "";
  private turns = 0;
  /** Texts the caller sent; other user messages are the operator's steering. */
  private readonly ownMessages: string[] = [];
  private stopping = false;
  private model: string | undefined;

  constructor(child: ChildAgent, mode: SubagentStart["mode"]) {
    this.child = child;
    this.mode = mode;
    this.off = child.onRecord((record) => this.receive(record));
  }

  private emit(event: SubagentEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private receive(record: ChildRecord): void {
    switch (record.type) {
      case "message_end": {
        const message = record.message as Message;
        if (message.role === "assistant") {
          this.turns += 1;
          const text = textOf(message);
          if (text !== "") {
            this.finalText = text;
            this.emit({ kind: "text", text });
          } else {
            // a turn of tool calls only
          }
          const cost = message.usage?.cost?.total;
          if (typeof cost === "number" && cost > 0) {
            this.emit({ kind: "usage", costUsd: cost });
          } else {
            // free, or not reported
          }
        } else if (message.role === "user") {
          const text = textOf(message);
          const own = this.ownMessages.indexOf(text);
          if (own >= 0) {
            this.ownMessages.splice(own, 1);
          } else {
            this.emit({ kind: "operator", text });
          }
        } else {
          // tool results and custom messages
        }
        break;
      }
      case "harness_session": {
        const model = (record.session as { model?: { provider?: string; id?: string } } | undefined)?.model;
        if (model?.id !== undefined && `${model.provider}/${model.id}` !== this.model) {
          this.model = `${model.provider}/${model.id}`;
          this.emit({ kind: "init", model: this.model });
        } else {
          // the same model
        }
        break;
      }
      case "tool_execution_start": {
        const tool = String(record.toolName ?? "");
        this.emit({ kind: "step", tool, summary: stepSummary(tool, record.args) });
        const path = (record.args as { path?: unknown } | undefined)?.path;
        if ((tool === "write" || tool === "edit") && typeof path === "string") {
          this.emit({ kind: "file", path });
        } else {
          // not a file change
        }
        break;
      }
      case "harness_interaction_request":
        this.emit({ kind: "waiting", waiting: true });
        break;
      case "harness_interaction_closed":
        this.emit({ kind: "waiting", waiting: false });
        break;
      case "agent_end": {
        const messages = (record.messages as Message[] | undefined) ?? [];
        const last = messages.findLast((message) => message.role === "assistant");
        const stopReason = last?.stopReason;
        const outcome = this.stopping || stopReason === "aborted" ? "stopped" : stopReason === "error" ? "failed" : "done";
        this.stopping = false;
        this.emit({ kind: "result", outcome, text: this.finalText, turns: this.turns, ...(last?.errorMessage !== undefined ? { error: last.errorMessage } : {}) });
        break;
      }
      default:
        break; // other records do not change the subagent's story
    }
  }

  onEvent(listener: (event: SubagentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async send(text: string, from: "caller" | "operator"): Promise<void> {
    if (from === "caller") {
      this.ownMessages.push(text);
    } else {
      // the operator's steering shows as an operator event when the child takes it
    }
    await this.child.call({ type: "harness_prompt", text, mode: this.mode });
  }

  async interrupt(): Promise<void> {
    this.stopping = true;
    await this.child.call({ type: "abort" });
  }

  async stopTask(id: string): Promise<void> {
    await this.child.call({ type: "harness_task_stop", taskId: id });
  }

  async detach(): Promise<void> {
    this.off();
    await this.child.detach();
  }

  async close(): Promise<void> {
    this.off();
    await this.child.close();
  }

  get info(): SubagentSession["info"] {
    return { session: this.child.sessionId, sessionFile: this.child.sessionFile, agentId: this.child.agentId, running: this.child.running };
  }

  async lastText(): Promise<string> {
    const answer = await this.child.call<{ text?: string | null }>({ type: "get_last_assistant_text" });
    return answer?.text ?? "";
  }
}

export function harnessEngine(children: ChildAgents): SubagentEngine {
  return {
    async start(start: SubagentStart): Promise<SubagentSession> {
      const child = await children.start({
        cwd: start.cwd,
        sessionFile: start.resume?.sessionFile,
        background: start.background,
        subagent: {
          profile: start.profile.name,
          role: start.profile.role,
          mode: start.mode,
          ...(start.profile.model !== undefined ? { model: start.profile.model } : {}),
          tools: start.profile.tools,
          subagents: start.profile.subagents,
          madness: start.madness,
        },
      });
      return new HarnessSubagent(child, start.mode);
    },
  };
}
