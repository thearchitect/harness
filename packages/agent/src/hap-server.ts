// The HAP server of one harness-agent: pi's RPC commands, responses and session events pass
// through as pi defines them (docs/rpc.md); harness requests (harness_*) are answered here. One
// ordered stream: a snapshot answered at some point is followed by every later event, which is
// what makes "snapshot + tail" consistent for a client the node attaches mid-run.

import type { AgentSession, AgentSessionEvent, AgentSessionRuntime, RpcCommand } from "@earendil-works/pi-coding-agent";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { EntriesBeforeData, HapEvent, HapRequest, SessionView, SnapshotData } from "#protocol/hap.ts";
import { isHapRequest } from "#protocol/hap.ts";
import { checkHapRequest } from "#protocol/schemas.ts";
import { PROTOCOL_VERSION } from "#protocol/version.ts";
import { HarnessError, toProtocolError } from "#protocol/errors.ts";
import type { HarnessController } from "#extension/index.ts";
import type { InteractionHub } from "./interactions.ts";
import { ensureTheme, createUiContext } from "./ui-context.ts";
import { getTheme } from "./theme.ts";

type Output = (record: object) => void;

type ToolInFlight = { toolCallId: string; toolName: string; args: unknown; partialResult?: unknown };

export type HapServerOptions = {
  runtime: AgentSessionRuntime;
  controller: HarnessController;
  hub: InteractionHub;
  harnessVersion: string;
  output: Output;
};

export class HapServer {
  private readonly runtime: AgentSessionRuntime;
  private readonly controller: HarnessController;
  private readonly hub: InteractionHub;
  private readonly harnessVersion: string;
  private readonly output: Output;
  private unsubscribe: (() => void) | undefined;
  private partialMessage: unknown;
  private readonly tools = new Map<string, ToolInFlight>();
  private readonly status: Record<string, string> = {};

  constructor(options: HapServerOptions) {
    this.runtime = options.runtime;
    this.controller = options.controller;
    this.hub = options.hub;
    this.harnessVersion = options.harnessVersion;
    this.output = options.output;
  }

  private get session(): AgentSession {
    return this.runtime.session;
  }

  /** Records from the harness side (state, interactions, ui) go through here; statuses are kept for snapshots. */
  emit(event: HapEvent): void {
    if (event.type === "harness_ui" && event.method === "status") {
      if (event.text === undefined) {
        delete this.status[event.key];
      } else {
        this.status[event.key] = event.text;
      }
    } else {
      // kept only in the stream
    }
    this.output(event);
  }

  async start(): Promise<void> {
    ensureTheme();
    this.runtime.setRebindSession(async () => {
      await this.bind();
      this.emit({ type: "harness_session", session: this.view() });
    });
    await this.bind();
    this.emit({ type: "harness_hello", protocol: PROTOCOL_VERSION, harness: this.harnessVersion, session: this.view() });
    this.emit({ type: "harness_state", state: this.controller.state() });
  }

  private async bind(): Promise<void> {
    this.unsubscribe?.();
    this.partialMessage = undefined;
    this.tools.clear();
    const session = this.session;
    this.unsubscribe = session.subscribe((event) => this.onSessionEvent(event));
    await session.bindExtensions({
      uiContext: createUiContext(this.hub, (event) => this.emit(event), getTheme),
      mode: "rpc",
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: async (options) => this.runtime.newSession(options),
        fork: async (entryId, forkOptions) => ({ cancelled: (await this.runtime.fork(entryId, forkOptions)).cancelled }),
        navigateTree: async (targetId, options) => ({
          cancelled: (
            await session.navigateTree(targetId, {
              summarize: options?.summarize,
              customInstructions: options?.customInstructions,
              replaceInstructions: options?.replaceInstructions,
              label: options?.label,
            })
          ).cancelled,
        }),
        switchSession: async (sessionPath, options) => this.runtime.switchSession(sessionPath, options),
        reload: async () => {
          await session.reload();
        },
      },
      onError: (error) => {
        this.output({ type: "extension_error", extensionPath: error.extensionPath, event: error.event, error: error.error });
      },
    });
  }

  private onSessionEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case "message_start":
      case "message_update":
        if (event.message.role === "assistant") {
          this.partialMessage = event.message;
        } else {
          // only the assistant streams
        }
        break;
      case "message_end":
        this.partialMessage = undefined;
        break;
      case "tool_execution_start":
        this.tools.set(event.toolCallId, { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
        break;
      case "tool_execution_update": {
        const tool = this.tools.get(event.toolCallId);
        if (tool !== undefined) {
          tool.partialResult = event.partialResult;
        } else {
          // an update of a call started before this agent bound the session
        }
        break;
      }
      case "tool_execution_end":
        this.tools.delete(event.toolCallId);
        break;
      default:
        break; // passed through below
    }
    this.output(toJsonEvent(event));
    switch (event.type) {
      case "agent_start":
      case "agent_settled":
      case "queue_update":
      case "compaction_start":
      case "compaction_end":
      case "thinking_level_changed":
      case "session_info_changed":
      case "turn_end":
        this.emit({ type: "harness_session", session: this.view() });
        break;
      default:
        break; // the session view did not change
    }
  }

  view(): SessionView {
    const session = this.session;
    const context = session.getContextUsage();
    return {
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      sessionName: session.sessionName,
      cwd: session.sessionManager.getCwd(),
      model: session.model !== undefined ? { provider: session.model.provider, id: session.model.id, contextWindow: session.model.contextWindow } : undefined,
      thinkingLevel: session.thinkingLevel,
      activity: session.isCompacting ? "compacting" : session.isIdle ? "idle" : "running",
      queue: { steering: [...session.getSteeringMessages()], followUp: [...session.getFollowUpMessages()] },
      usage: { costUsd: session.getSessionStats().cost, contextTokens: context?.tokens ?? undefined, contextPercent: context?.percent ?? undefined },
    };
  }

  /** One input line from the node. */
  async handle(record: Record<string, unknown>): Promise<void> {
    if (isHapRequest(record as { type?: unknown })) {
      const request = record as HapRequest;
      const checked = checkHapRequest(request);
      try {
        if (!checked.ok) {
          throw new HarnessError("invalid_record", checked.error);
        } else {
          // a well-formed request
        }
        const data = await this.handleHarness(request);
        this.output({ type: "harness_response", id: request.id, ok: true, data });
      } catch (error) {
        this.output({ type: "harness_response", id: request.id, ok: false, error: toProtocolError(error) });
      }
    } else if (record.type === "harness_response") {
      // answers to this agent's own requests to the node (spawn): routed by the caller
    } else {
      const command = record as unknown as RpcCommand;
      try {
        const response = await this.handlePi(command);
        if (response !== undefined) {
          this.output(response);
        } else {
          // prompt answers on its own after preflight
        }
      } catch (error) {
        this.output({ id: command.id, type: "response", command: command.type, success: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  private async handleHarness(request: HapRequest): Promise<unknown> {
    switch (request.type) {
      case "harness_snapshot":
        return this.snapshot(request.limit);
      case "harness_entries_before":
        return this.entriesBefore(request.cursor, request.limit);
      case "harness_prompt": {
        const session = this.session;
        if (request.mode !== undefined) {
          this.controller.setNextMode(request.mode);
        } else {
          // no mode named: the text decides (a leading "!" asks for BUILD)
        }
        return new Promise((resolveResponse, reject) => {
          let preflight = false;
          void session
            .prompt(request.text, {
              images: request.images,
              streamingBehavior: session.isStreaming ? "steer" : undefined,
              source: "rpc",
              preflightResult: (disposition) => {
                preflight = true;
                resolveResponse({ disposition });
              },
            })
            .catch((error: unknown) => {
              if (!preflight) {
                reject(error);
              } else {
                // the run failed after it was accepted: the stream reports it
              }
            });
        });
      }
      case "harness_set":
        this.controller.set({ variant: request.variant, madness: request.madness, implementer: request.implementer });
        return this.controller.state();
      case "harness_interrupt":
        return { stopped: this.controller.interrupt(request.reason) };
      case "harness_interaction_response":
        return { accepted: this.hub.answer(request.interactionId, request.answer) };
      case "harness_task_stop":
        return { task: this.controller.supervisor.stop(request.taskId) };
      case "harness_task_input":
        this.controller.supervisor.input(request.taskId, request.data);
        return {};
      case "harness_task_output":
        return this.controller.supervisor.output(request.taskId, { offset: request.offset });
      case "harness_subagent_send":
        throw new HarnessError("not_found", `no live subagent session ${request.session}`);
      case "harness_complete":
        return { items: await complete(this.session.sessionManager.getCwd(), request.prefix) };
      default:
        throw new HarnessError("invalid_record", `unknown request ${String((request satisfies never as { type: string }).type)}`);
    }
  }

  private snapshot(limit: number): SnapshotData {
    const branch = this.session.sessionManager.getBranch();
    const from = Math.max(0, branch.length - limit);
    return {
      entries: branch.slice(from),
      cursor: from > 0 ? branch[from]?.id : undefined,
      partial: this.partialMessage !== undefined || this.tools.size > 0 ? { message: this.partialMessage, tools: [...this.tools.values()] } : undefined,
      session: this.view(),
      state: this.controller.state(),
      interactions: this.hub.open(),
      status: { ...this.status },
    };
  }

  private entriesBefore(cursor: string, limit: number): EntriesBeforeData {
    const branch = this.session.sessionManager.getBranch();
    const end = branch.findIndex((entry) => entry.id === cursor);
    if (end === -1) {
      throw new HarnessError("not_found", `entry ${cursor} is not on the current branch`);
    } else {
      const from = Math.max(0, end - limit);
      return { entries: branch.slice(from, end), cursor: from > 0 ? branch[from]?.id : undefined };
    }
  }

  /** pi's RPC commands, as pi's rpc mode handles them. */
  private async handlePi(command: RpcCommand): Promise<object | undefined> {
    const session = this.session;
    const id = command.id;
    const ok = (data?: unknown) => (data === undefined ? { id, type: "response", command: command.type, success: true } : { id, type: "response", command: command.type, success: true, data });
    const fail = (message: string) => ({ id, type: "response", command: command.type, success: false, error: message });
    switch (command.type) {
      case "prompt": {
        let preflight = false;
        void session
          .prompt(command.message, {
            images: command.images,
            streamingBehavior: command.streamingBehavior,
            source: "rpc",
            preflightResult: (disposition) => {
              preflight = true;
              this.output(ok({ disposition }));
            },
          })
          .catch((error: unknown) => {
            if (!preflight) {
              this.output(fail(error instanceof Error ? error.message : String(error)));
            } else {
              // reported in the stream
            }
          });
        return undefined;
      }
      case "steer":
        return ok({ disposition: await session.steer(command.message, command.images, { source: "rpc" }) });
      case "follow_up":
        return ok({ disposition: await session.followUp(command.message, command.images, { source: "rpc" }) });
      case "abort":
        await session.abort();
        return ok();
      case "clear_queue":
        return ok(session.clearQueue());
      case "new_session":
        return ok(await this.runtime.newSession(command.parentSession !== undefined ? { parentSession: command.parentSession } : undefined));
      case "get_state":
        return ok({
          model: session.model,
          thinkingLevel: session.thinkingLevel,
          isStreaming: session.isStreaming,
          isCompacting: session.isCompacting,
          steeringMode: session.steeringMode,
          followUpMode: session.followUpMode,
          sessionFile: session.sessionFile,
          sessionId: session.sessionId,
          sessionName: session.sessionName,
          autoCompactionEnabled: session.autoCompactionEnabled,
          messageCount: session.messages.length,
          pendingMessageCount: session.pendingMessageCount,
        });
      case "set_model": {
        const model = session.modelRuntime.getAvailableSnapshot().find((m) => m.provider === command.provider && m.id === command.modelId);
        if (model === undefined) {
          return fail(`Model not found: ${command.provider}/${command.modelId}`);
        } else {
          await session.setModel(model);
          this.emit({ type: "harness_session", session: this.view() });
          return ok(model);
        }
      }
      case "cycle_model": {
        const result = await session.cycleModel();
        this.emit({ type: "harness_session", session: this.view() });
        return ok(result ?? null);
      }
      case "get_available_models":
        return ok({ models: session.modelRuntime.getAvailableSnapshot() });
      case "set_thinking_level":
        session.setThinkingLevel(command.level);
        return ok();
      case "cycle_thinking_level": {
        const level = session.cycleThinkingLevel();
        return ok(level === undefined ? null : { level });
      }
      case "get_available_thinking_levels":
        return ok({ levels: session.getAvailableThinkingLevels() });
      case "set_steering_mode":
        session.setSteeringMode(command.mode);
        return ok();
      case "set_follow_up_mode":
        session.setFollowUpMode(command.mode);
        return ok();
      case "compact":
        return ok(await session.compact(command.customInstructions));
      case "set_auto_compaction":
        session.setAutoCompactionEnabled(command.enabled);
        return ok();
      case "set_auto_retry":
        session.setAutoRetryEnabled(command.enabled);
        return ok();
      case "abort_retry":
        session.abortRetry();
        return ok();
      case "bash": {
        const eventResult = await session.extensionRunner.emitUserBash({
          type: "user_bash",
          command: command.command,
          excludeFromContext: command.excludeFromContext ?? false,
          cwd: session.sessionManager.getCwd(),
        });
        if (eventResult?.result !== undefined) {
          session.recordBashResult(command.command, eventResult.result, { excludeFromContext: command.excludeFromContext });
          return ok(eventResult.result);
        } else {
          return ok(await session.executeBash(command.command, undefined, { excludeFromContext: command.excludeFromContext, id, operations: eventResult?.operations }));
        }
      }
      case "abort_bash":
        session.abortBash();
        return ok();
      case "get_session_stats":
        return ok(session.getSessionStats());
      case "export_html":
        return ok({ path: await session.exportToHtml(command.outputPath) });
      case "switch_session":
        return ok(await this.runtime.switchSession(command.sessionPath));
      case "fork": {
        const result = await this.runtime.fork(command.entryId);
        return ok({ text: result.selectedText, cancelled: result.cancelled });
      }
      case "clone": {
        const leafId = session.sessionManager.getLeafId();
        if (leafId === null) {
          return fail("Cannot clone session: no current entry selected");
        } else {
          return ok({ cancelled: (await this.runtime.fork(leafId, { position: "at" })).cancelled });
        }
      }
      case "get_fork_messages":
        return ok({ messages: session.getUserMessagesForForking() });
      case "get_entries": {
        let entries = session.sessionManager.getEntries();
        if (command.since !== undefined) {
          const index = entries.findIndex((entry) => entry.id === command.since);
          if (index === -1) {
            return fail(`Entry not found: ${command.since}`);
          } else {
            entries = entries.slice(index + 1);
          }
        } else {
          // all entries
        }
        return ok({ entries, leafId: session.sessionManager.getLeafId() });
      }
      case "get_tree":
        return ok({ tree: session.sessionManager.getTree(), leafId: session.sessionManager.getLeafId() });
      case "get_last_assistant_text":
        return ok({ text: session.getLastAssistantText() });
      case "set_session_name": {
        const name = command.name.trim();
        if (name === "") {
          return fail("Session name cannot be empty");
        } else {
          session.setSessionName(name);
          return ok();
        }
      }
      case "get_messages":
        return ok({ messages: session.messages });
      case "get_commands":
        return ok({
          commands: [
            ...session.extensionRunner.getRegisteredCommands().map((c) => ({ name: c.invocationName, description: c.description, source: "extension", sourceInfo: c.sourceInfo })),
            ...session.promptTemplates.map((t) => ({ name: t.name, description: t.description, source: "prompt", sourceInfo: t.sourceInfo })),
            ...session.resourceLoader.getSkills().skills.map((s) => ({ name: `skill:${s.name}`, description: s.description, source: "skill", sourceInfo: s.sourceInfo })),
          ],
        });
      default:
        return fail(`Unknown command: ${(command satisfies never as { type: string }).type}`);
    }
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.();
    this.hub.endAll();
    await this.runtime.dispose();
  }
}

/** pi's JSON form of an event: a streaming update without the accumulated partial message (pi's json-event.ts). */
function toJsonEvent(event: AgentSessionEvent): object {
  if (event.type !== "message_update") {
    return event;
  } else {
    const inner = event.assistantMessageEvent as { type: string; partial?: { content: { type: string; id?: string; name?: string }[] }; contentIndex?: number };
    const { partial, ...delta } = inner;
    if (inner.type === "toolcall_start" && partial !== undefined && inner.contentIndex !== undefined) {
      const toolCall = partial.content[inner.contentIndex];
      return { type: "message_update", usage: (event.message as { usage?: unknown }).usage, assistantMessageEvent: { ...delta, id: toolCall?.id, toolName: toolCall?.name } };
    } else {
      return { type: "message_update", usage: (event.message as { usage?: unknown }).usage, assistantMessageEvent: delta };
    }
  }
}

/** Completion of paths on the agent's machine: entries of the prefix's directory that start with its last segment. */
async function complete(cwd: string, prefix: string): Promise<string[]> {
  const typedDir = prefix.endsWith("/") ? prefix : dirname(prefix) === "." && !prefix.startsWith("./") ? "" : `${dirname(prefix)}/`;
  const stem = prefix.endsWith("/") ? "" : prefix.slice(typedDir.length);
  const dir = resolve(cwd, typedDir === "" ? "." : typedDir);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.name.startsWith(stem) && (stem.startsWith(".") || !entry.name.startsWith(".")))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 100)
      .map((entry) => join(typedDir, entry.name) + (entry.isDirectory() ? "/" : ""));
  } catch {
    return []; // no such directory: nothing to complete
  }
}
