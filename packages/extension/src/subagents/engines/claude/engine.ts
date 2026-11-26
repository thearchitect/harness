// The `claude` engine (plan 12.4–12.8): the user's own Claude Code in headless stream-json mode,
// under harness's rules — its file changes pass harness's authorization (the PreToolUse hook through
// the bridge), harness's tools reach it over MCP (run in the calling tool's context), its limit
// waits become a choice for the operator, its background commands are mirrored into the session's
// tasks. Messages (the instruction with its plan, follow-ups, the operator's steering) go to its stdin; it stops with
// stop_task and interrupt control requests, or SIGTERM to its process group.

import type { ExtensionContext, ExtensionToolContext, NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ClaudeInput } from "#protocol/claude.ts";
import { LineDecoder } from "#protocol/framing.ts";
import type { TaskInfo } from "#protocol/state.ts";
import { createAuthorizer, scratchWorkspaceRoot } from "../../../core/authorize.ts";
import { CLAUDE_NATIVE_TOOLS, claudeSystemPrompt, HARNESS_SRC } from "../../../core/prompt.ts";
import type { ClaudeTranscripts } from "./transcripts.ts";
import type { Interactions } from "../../../host.ts";
import type { MirroredSource } from "../../../supervisor/supervisor.ts";
import type { SubagentEngine, SubagentEvent, SubagentSession, SubagentStart } from "../../engine.ts";
import { toolAllowed } from "../../registry.ts";
import { Bridge, type McpTool } from "./bridge.ts";
import { claudeArgs, claudeEnv, preflight } from "./launch.ts";
import { decide } from "./policy.ts";
import { ClaudeStream } from "./stream.ts";

/** SIGKILL this long after SIGTERM; an interrupt without an answer falls back to SIGTERM after this long. */
const STOP_GRACE_MS = 5_000;

export type ClaudeEngineDeps = {
  interactions: Interactions;
  dataDir: string;
  /** Mirrors Claude's background tasks into the session's tasks. */
  mirror(task: TaskInfo, source: MirroredSource): void;
  /** The claude executable (default `claude` on PATH; HARNESS_CLAUDE overrides it). */
  command?: string;
  /** How Claude runs the bridge (default: this node on cli/src/claude-bridge.ts). */
  bridge?: string[];
  /** The calling agent's system prompt options of its current run (its project context, skills, tool guidelines, sections). */
  promptRun: () => NormalizedBuildSystemPromptOptions | undefined;
  /** Where each subagent's stream and the messages sent to it are kept and shown as a transcript. */
  transcripts: ClaudeTranscripts;
};

function isToolContext(ctx: ExtensionContext): ctx is ExtensionToolContext {
  return typeof (ctx as Partial<ExtensionToolContext>).executeTool === "function";
}

class ClaudeSubagent implements SubagentSession {
  readonly engine = "claude" as const;
  readonly info: SubagentSession["info"];
  private readonly process: ChildProcess;
  private readonly bridge: Bridge;
  private readonly stream = new ClaudeStream();
  private readonly listeners = new Set<(event: SubagentEvent) => void>();
  private readonly tasks = new Map<string, TaskInfo>();
  private readonly outputs = new Map<string, string>();
  private readonly deps: ClaudeEngineDeps;
  private stopping = false;
  private exited = false;
  private resultPending = false;
  private stderr = "";
  private limitDialog: AbortController | undefined;
  private requestCounter = 0;

  private readonly start: SubagentStart;

  constructor(process: ChildProcess, bridge: Bridge, session: string, deps: ClaudeEngineDeps, start: SubagentStart) {
    this.start = start;
    this.process = process;
    this.bridge = bridge;
    this.deps = deps;
    this.info = { session, running: true };
    const decoder = new LineDecoder();
    process.stdout?.on("data", (chunk: Buffer) => {
      for (const line of decoder.push(chunk)) {
        this.transcribe(line);
        for (const event of this.stream.push(line)) {
          this.receive(event);
        }
      }
    });
    process.stderr?.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-4000);
    });
    process.on("exit", (code, signal) => {
      this.exited = true;
      this.bridge.close();
      this.limitDialog?.abort();
      if (this.resultPending) {
        this.resultPending = false;
        const stopped = this.stopping || signal !== null;
        this.emit({ kind: "result", outcome: stopped ? "stopped" : "failed", text: "", ...(stopped ? {} : { error: `Claude Code exited (${code ?? signal}): ${this.stderr.trim().split("\n").at(-1) ?? ""}` }) });
      } else {
        // it ended between runs
      }
    });
  }

  /** A line of Claude's stream into the subagent's transcript (malformed lines are left out). */
  private transcribe(line: string): void {
    try {
      this.deps.transcripts.record(this.info.session, JSON.parse(line) as { type: string }, line);
    } catch {
      // not a JSON line: Claude's stream has nothing else, the stream reader ignores it too
    }
  }

  private emit(event: SubagentEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private receive(event: SubagentEvent): void {
    switch (event.kind) {
      case "init":
        if (this.stream.apiKeySource !== undefined && this.stream.apiKeySource !== "none") {
          // harness runs Claude only on the user's subscription
          this.emit({ kind: "result", outcome: "failed", text: "", error: `Claude Code uses an API key (${this.stream.apiKeySource}), not your Claude subscription: remove it from its configuration` });
          this.resultPending = false;
          this.kill("SIGTERM");
          return;
        } else {
          break;
        }
      case "rate_limit_wait":
        void this.askAboutLimit(event.window, event.resetsAt);
        break;
      case "rate_limit_over":
        this.limitDialog?.abort();
        this.limitDialog = undefined;
        break;
      case "task":
        this.mirror(event);
        break;
      case "result":
        this.resultPending = false;
        this.stopping = false;
        break;
      default:
        break; // passed on as is
    }
    this.emit(event);
  }

  private mirror(event: Extract<SubagentEvent, { kind: "task" }>): void {
    const previous = this.tasks.get(event.id);
    const now = Date.now();
    const info: TaskInfo = {
      id: event.id,
      source: "claude",
      command: event.command ?? previous?.command ?? event.id,
      cwd: this.start.cwd,
      state: event.state,
      startedAt: previous?.startedAt ?? now,
      ...(event.state !== "running" ? { endedAt: previous?.endedAt ?? now } : {}),
      outputBytes: 0,
      notify: this.start.profile.notify,
      owner: this.info.session,
      ...((event.toolUseId ?? previous?.toolUseId) !== undefined ? { toolUseId: event.toolUseId ?? previous?.toolUseId } : {}),
    };
    this.tasks.set(event.id, info);
    if (event.outputFile !== undefined) {
      this.outputs.set(event.id, event.outputFile);
    } else {
      // no output file yet
    }
    this.deps.mirror(info, { stop: (id) => void this.stopTask(id), outputFile: (id) => this.outputs.get(id) });
  }

  /** Claude waits for its subscription limit: the operator chooses; the dialog closes when the wait ends. */
  private async askAboutLimit(window: string, resetsAt: number | undefined): Promise<void> {
    this.limitDialog?.abort();
    const controller = new AbortController();
    this.limitDialog = controller;
    const at = resetsAt !== undefined ? new Date(resetsAt).toLocaleString() : "later";
    const answer = await this.deps.interactions.ask(
      "choice",
      {
        title: `Claude (${this.start.profile.name}) waits for its ${window.replace(/_/g, " ")} limit to reset at ${at}`,
        options: [
          { id: "wait", title: "Wait" },
          { id: "continue", title: "Stop Claude, continue in harness" },
          { id: "stop", title: "Stop Claude and the run" },
        ],
      },
      { signal: controller.signal, toolCallId: this.start.toolCallId },
    );
    if (answer === undefined || "cancelled" in answer || answer.id === "wait") {
      return; // waits on, or the wait ended by itself
    } else if (answer.id === "continue") {
      this.emit({ kind: "operator", text: "stop Claude and continue in harness (Claude waited for its limit)" });
      await this.interrupt();
    } else {
      await this.interrupt();
      this.start.ctx.abort();
    }
  }

  private write(input: ClaudeInput): void {
    if (!this.exited && this.process.stdin !== null && !this.process.stdin.destroyed) {
      this.process.stdin.write(`${JSON.stringify(input)}\n`);
    } else {
      throw new Error("Claude Code has exited");
    }
  }

  private control(request: { subtype: "interrupt" } | { subtype: "stop_task"; task_id: string }): void {
    this.requestCounter += 1;
    this.write({ type: "control_request", request_id: `harness-${this.requestCounter}`, request });
  }

  private kill(signal: NodeJS.Signals): void {
    try {
      if (this.process.pid !== undefined) {
        process.kill(-this.process.pid, signal);
      } else {
        this.process.kill(signal);
      }
    } catch {
      // the group is gone
    }
  }

  onEvent(listener: (event: SubagentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async send(text: string, from: "caller" | "operator"): Promise<void> {
    if (from === "caller") {
      this.resultPending = true;
    } else {
      this.emit({ kind: "operator", text }); // Claude takes it at its next turn boundary
    }
    this.write({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id: this.info.session });
    this.deps.transcripts.record(this.info.session, { type: "harness_input", from, text });
  }

  async interrupt(): Promise<void> {
    if (this.exited) {
      return;
    } else {
      this.stopping = true;
      for (const task of this.tasks.values()) {
        if (task.endedAt === undefined) {
          await this.stopTask(task.id);
        } else {
          // ended
        }
      }
      if (this.stream.capabilities.has("interrupt_receipt_v1")) {
        this.control({ subtype: "interrupt" });
        // without an answer, the process group
        setTimeout(() => (this.resultPending ? this.kill("SIGTERM") : undefined), STOP_GRACE_MS).unref();
      } else {
        this.kill("SIGTERM");
      }
    }
  }

  async stopTask(id: string): Promise<void> {
    if (!this.exited) {
      this.control({ subtype: "stop_task", task_id: id });
    } else {
      // nothing runs any more
    }
  }

  private liveTasks(): boolean {
    return [...this.tasks.values()].some((task) => task.endedAt === undefined);
  }

  /** Keeps Claude while its background tasks run; ends it when they are done. */
  async detach(): Promise<void> {
    if (this.liveTasks()) {
      const check = (): void => {
        if (!this.liveTasks()) {
          void this.close();
        } else {
          setTimeout(check, 1000).unref();
        }
      };
      check();
    } else {
      await this.close();
    }
  }

  async close(): Promise<void> {
    if (!this.exited) {
      this.process.stdin?.end();
      this.kill("SIGTERM");
      setTimeout(() => (this.exited ? undefined : this.kill("SIGKILL")), STOP_GRACE_MS).unref();
    } else {
      // gone already
    }
  }

  async lastText(): Promise<string> {
    return "";
  }
}

export function claudeEngine(deps: ClaudeEngineDeps): SubagentEngine {
  return {
    async start(start: SubagentStart): Promise<SubagentSession> {
      const ctx = start.ctx;
      const command = deps.command ?? process.env.HARNESS_CLAUDE ?? "claude";
      if (!isToolContext(ctx)) {
        throw new Error("the claude engine runs inside a tool call");
      } else {
        const ready = await preflight(command);
        const run = deps.promptRun();
        if (!ready.ok) {
          throw new Error(`${start.profile.name} is unavailable: ${ready.message}`);
        } else if (run === undefined) {
          throw new Error("the claude engine starts within a run of the calling agent (its prompt options are unknown)");
        } else {
          const authorize = createAuthorizer({ interactions: deps.interactions, mode: () => start.mode, madness: () => start.madness, steer: () => undefined, by: start.profile.name });
          const launch = { tools: start.profile.tools, subagents: [], depth: 0 };
          // harness's tools for Claude: the profile's, never ctx_*, subagent or the ones Claude has natively
          const allowed = ctx.tools.filter((tool) => tool.name !== "subagent" && !(tool.name in CLAUDE_NATIVE_TOOLS) && toolAllowed(tool.name, launch, 0));
          let session: ClaudeSubagent | undefined;
          const bridge = await Bridge.open(deps.dataDir, {
            decide: (input) =>
              decide(input, {
                authorize,
                ctx,
                toolCallId: start.toolCallId,
                profile: start.profile.name,
                stop: () => {
                  void session?.interrupt();
                  ctx.abort();
                },
                comment: (text) => void session?.send(`The operator approved your change with a comment: ${text}`, "operator"),
              }),
            tools: (): McpTool[] => allowed.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })),
            callTool: async (name, args) => {
              if (!allowed.some((tool) => tool.name === name)) {
                return { text: `${name} is not available to ${start.profile.name}`, isError: true };
              } else {
                const outcome = await ctx.executeTool(name, args);
                const text = outcome.result.content.map((block) => (block.type === "text" ? block.text : `[${block.type}]`)).join("\n");
                return { text, isError: outcome.isError };
              }
            },
          });
          const sessionId = start.resume?.session ?? randomUUID();
          const workspace = await scratchWorkspaceRoot(ctx);
          const tools = allowed.map((tool) => ({ name: tool.name, guidelines: run.toolGuidelines[tool.name] ?? [] }));
          const args = claudeArgs({
            sessionId,
            resume: start.resume !== undefined,
            model: start.profile.model,
            bridge: deps.bridge ?? [process.execPath, join(HARNESS_SRC, "packages", "cli", "src", "claude-bridge.ts")],
            workspace,
            systemPrompt: claudeSystemPrompt({ workspaceRoot: workspace, role: start.profile.role, mode: start.mode, run, tools }),
          });
          const child = spawn(command, args, { cwd: start.cwd, env: claudeEnv(process.env, { socket: bridge.socket, token: bridge.token }), detached: true, stdio: ["pipe", "pipe", "pipe"] });
          session = new ClaudeSubagent(child, bridge, sessionId, deps, start);
          return session;
        }
      }
    },
  };
}
