// Everything a client knows about one attached agent, built from its snapshot and the live HAP
// stream: the transcript, the run in flight (streaming message, tool calls), the session view, the
// HarnessState, the open interactions, statuses, notices. Pure data and a reducer; listeners learn
// that something changed and redraw.

import type { BridgedComponent, HapRecord, SessionView, SnapshotData } from "#protocol/hap.ts";
import type { InteractionRequest } from "#protocol/interactions.ts";
import { initialHarnessState, type HarnessState } from "#protocol/state.ts";

/** A pi message as the stream carries it (pi-ai's message shapes). */
export type Message = { role: string; [key: string]: unknown };

export type TranscriptItem =
  | { kind: "message"; key: string; message: Message }
  | { kind: "custom"; key: string; customType: string; data: unknown }
  | { kind: "compaction"; key: string; summary: string; tokensBefore?: number }
  | { kind: "branch"; key: string; summary: string };

export type ToolRun = { toolCallId: string; toolName: string; args: unknown; partialResult?: unknown; result?: unknown; isError?: boolean; done: boolean };

export type Notice = { id: number; level: "info" | "warning" | "error"; message: string; at: number };

type Entry = { type: string; id: string; [key: string]: unknown };

function itemOfEntry(entry: Entry): TranscriptItem | undefined {
  switch (entry.type) {
    case "message":
      return { kind: "message", key: entry.id, message: entry.message as Message };
    case "custom":
      return { kind: "custom", key: entry.id, customType: String(entry.customType), data: entry.data };
    case "custom_message":
      return entry.display === false
        ? undefined
        : { kind: "message", key: entry.id, message: { role: "custom", customType: entry.customType, content: entry.content, display: true, details: entry.details } };
    case "compaction":
      return { kind: "compaction", key: entry.id, summary: String(entry.summary ?? ""), tokensBefore: entry.tokensBefore as number | undefined };
    case "branch_summary":
      return { kind: "branch", key: entry.id, summary: String(entry.summary ?? "") };
    default:
      return undefined; // model and thinking changes, labels, session info: not drawn
  }
}

export class AgentModel {
  /** The agent's id; empty for a stored session read without its agent (adopt names it). */
  agentId: string;
  items: TranscriptItem[] = [];
  /** Cursor for older entries (harness_entries_before); undefined at the beginning. */
  cursor: string | undefined;
  streaming: Message | undefined;
  readonly tools = new Map<string, ToolRun>();
  session: SessionView | undefined;
  state: HarnessState = initialHarnessState();
  interactions: InteractionRequest[] = [];
  status: Record<string, string> = {};
  widgets: Record<string, string[]> = {};
  /** Components of extensions drawn in the agent (the component bridge), oldest first. */
  components: BridgedComponent[] = [];
  notices: Notice[] = [];
  /** Text an extension asked to put into the editor. */
  editorText: string | undefined;
  /** Counts the agent's editor texts, so a client puts each one into its editor once. */
  editorTextSeq = 0;
  private noticeCounter = 0;
  private liveCounter = 0;
  private readonly listeners = new Set<() => void>();

  constructor(agentId: string) {
    this.agentId = agentId;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  get running(): boolean {
    return this.session?.activity === "running";
  }

  /** A stored session read before its agent started becomes the agent's model. */
  adopt(agentId: string): void {
    this.agentId = agentId;
  }

  /**
   * The newest entries of the branch (a snapshot's, a page read from the file). The items loaded
   * before them stay when the branch still has them (the entries before an entry of a branch are its
   * ancestors), and items already known keep their objects: nothing of them is drawn again.
   */
  loadNewest(entries: unknown[], cursor: string | undefined): void {
    const fresh = (entries as Entry[]).map(itemOfEntry).filter((item): item is TranscriptItem => item !== undefined);
    const known = new Map(this.items.map((item) => [item.key, item]));
    const first = fresh[0]?.key;
    const at = first !== undefined ? this.items.findIndex((item) => item.key === first) : -1;
    this.items = [...(at > 0 ? this.items.slice(0, at) : []), ...fresh.map((item) => known.get(item.key) ?? item)];
    this.cursor = at > 0 ? this.cursor : cursor;
    this.changed();
  }

  /** Replaces everything with a snapshot (attach, or a resync after compaction); older items still on the branch stay. */
  loadSnapshot(snapshot: SnapshotData): void {
    this.loadNewest(snapshot.entries, snapshot.cursor);
    this.session = snapshot.session;
    this.state = snapshot.state;
    this.interactions = snapshot.interactions;
    this.status = snapshot.status;
    this.components = snapshot.components ?? [];
    this.streaming = snapshot.partial?.message as Message | undefined;
    this.tools.clear();
    for (const tool of snapshot.partial?.tools ?? []) {
      this.tools.set(tool.toolCallId, { ...tool, done: false });
    }
    this.changed();
  }

  /** The transcripts of this session's `claude` subagents a client opened, by their sessions (the stream keeps them current). */
  readonly claude = new Map<string, AgentModel>();
  /** A `claude` subagent's model and cost (its transcript's model only). */
  claudeInfo: { model?: string; costUsd: number } | undefined;

  /** A `claude` subagent's transcript: its entries (from its snapshot) and the message being streamed. */
  loadEntries(entries: unknown[], cursor: string | undefined, streaming: unknown): void {
    this.items = (entries as Entry[]).map(itemOfEntry).filter((item): item is TranscriptItem => item !== undefined);
    this.cursor = cursor;
    this.streaming = (streaming ?? undefined) as Message | undefined;
    this.changed();
  }

  /** Entries new or updated (by id) of a `claude` subagent's transcript, and the message being streamed now. */
  upsert(entries: unknown[], streaming: unknown): void {
    let items = this.items;
    for (const item of (entries as Entry[]).map(itemOfEntry)) {
      if (item === undefined) {
        // not drawn
      } else {
        const at = items.findIndex((candidate) => candidate.key === item.key);
        items = at >= 0 ? items.map((candidate, index) => (index === at ? item : candidate)) : [...items, item];
      }
    }
    this.items = items;
    this.streaming = (streaming ?? undefined) as Message | undefined;
    this.changed();
  }

  /** Older entries, loaded when the transcript scrolls to its top. */
  prepend(entries: unknown[], cursor: string | undefined): void {
    const items = (entries as Entry[]).map(itemOfEntry).filter((item): item is TranscriptItem => item !== undefined);
    this.items = [...items, ...this.items];
    this.cursor = cursor;
    this.changed();
  }

  /** One live record of the agent. */
  apply(record: HapRecord): void {
    const r = record as { type: string; [key: string]: unknown };
    switch (r.type) {
      case "message_start":
      case "message_update": {
        const message = r.message as Message | undefined;
        if (message?.role === "assistant") {
          this.streaming = message;
        } else if (r.type === "message_update" && this.streaming !== undefined) {
          // pi's JSON form strips the partial: apply the delta to the streamed copy
          this.streaming = applyDelta(this.streaming, r.assistantMessageEvent as Delta | undefined);
        } else {
          // a user or tool message starts: it arrives whole at message_end
        }
        break;
      }
      case "message_end": {
        const message = r.message as Message;
        if (message.role === "assistant") {
          this.streaming = undefined;
        } else {
          // the run continues
        }
        if (message.role === "custom" && message.display === false) {
          // hidden context (the mode selector): not drawn
        } else {
          this.liveCounter += 1;
          this.items = [...this.items, { kind: "message", key: `live-${this.liveCounter}`, message }];
        }
        break;
      }
      case "tool_execution_start":
        this.tools.set(String(r.toolCallId), { toolCallId: String(r.toolCallId), toolName: String(r.toolName), args: r.args, done: false });
        break;
      case "tool_execution_update": {
        const tool = this.tools.get(String(r.toolCallId));
        if (tool !== undefined) {
          tool.partialResult = r.partialResult;
        } else {
          // an update of a call this client did not see start
        }
        break;
      }
      case "tool_execution_end":
        this.tools.delete(String(r.toolCallId));
        break;
      case "entry_appended": {
        const entry = r.entry as Entry;
        const operatorCommand = entry.type === "message" && (entry.message as Message | undefined)?.role === "bashExecution";
        if ((entry.type === "message" && !operatorCommand) || entry.type === "custom_message") {
          // messages arrive as message_end (the operator's commands only as their entry)
        } else {
          const item = itemOfEntry(entry);
          if (item !== undefined) {
            this.items = [...this.items, item];
          } else {
            // not drawn
          }
        }
        break;
      }
      case "harness_hello":
      case "harness_session":
        this.session = r.session as SessionView;
        break;
      case "harness_state":
        this.state = r.state as HarnessState;
        break;
      case "harness_subagent_entries": {
        const transcript = this.claude.get(String(r.session));
        if (transcript !== undefined) {
          transcript.upsert(r.entries as unknown[], r.streaming);
          const subagent = this.state.subagents.find((candidate) => candidate.session === r.session);
          transcript.claudeInfo = { ...(subagent?.model !== undefined ? { model: subagent.model } : {}), costUsd: subagent?.costUsd ?? 0 };
        } else {
          // a transcript this client has not opened
        }
        break;
      }
      case "harness_interaction_request":
        this.interactions = [...this.interactions, r.request as InteractionRequest];
        break;
      case "harness_interaction_closed":
        this.interactions = this.interactions.filter((interaction) => interaction.id !== r.interactionId);
        break;
      case "harness_ui":
        this.applyUi(r);
        break;
      case "harness_component_open":
        this.components = [...this.components, { componentId: String(r.componentId), overlay: r.overlay === true, lines: [] }];
        break;
      case "harness_component_render":
        this.components = this.components.map((component) => (component.componentId === r.componentId ? { ...component, lines: r.lines as string[] } : component));
        break;
      case "harness_component_close":
        this.components = this.components.filter((component) => component.componentId !== r.componentId);
        break;
      case "agent_settled":
        this.streaming = undefined;
        this.tools.clear();
        break;
      case "extension_error":
        this.notice("error", `extension ${String(r.extensionPath)}: ${String(r.error)}`);
        break;
      default:
        break; // other pi events change nothing a client draws
    }
    this.changed();
  }

  private applyUi(r: { [key: string]: unknown }): void {
    switch (r.method) {
      case "notify":
        this.notice((r.level as Notice["level"]) ?? "info", String(r.message));
        break;
      case "status":
        if (r.text === undefined) {
          const { [String(r.key)]: _removed, ...rest } = this.status;
          this.status = rest;
        } else {
          this.status = { ...this.status, [String(r.key)]: String(r.text) };
        }
        break;
      case "widget":
        if (r.lines === undefined) {
          const { [String(r.key)]: _removed, ...rest } = this.widgets;
          this.widgets = rest;
        } else {
          this.widgets = { ...this.widgets, [String(r.key)]: r.lines as string[] };
        }
        break;
      case "editor_text":
        this.editorText = String(r.text);
        this.editorTextSeq += 1;
        break;
      case "open_url":
        // the operator's browser opens it where the client runs; the link stays in the status line too
        this.openUrl = { seq: (this.openUrl?.seq ?? 0) + 1, url: String(r.url) };
        this.notice("info", `open in your browser: ${String(r.url)}`);
        break;
      default:
        break; // a title: the client's own business
    }
  }

  /** The latest link for the operator's browser (an MCP sign-in), once per `seq`. */
  openUrl: { seq: number; url: string } | undefined;

  notice(level: Notice["level"], message: string): void {
    this.noticeCounter += 1;
    this.notices = [...this.notices.slice(-19), { id: this.noticeCounter, level, message, at: Date.now() }];
  }

  /** The tool call's result message in the transcript, if it has one. */
  toolResult(toolCallId: string): Message | undefined {
    for (let index = this.items.length - 1; index >= 0; index--) {
      const item = this.items[index];
      if (item?.kind === "message" && item.message.role === "toolResult" && item.message.toolCallId === toolCallId) {
        return item.message;
      } else {
        // keep looking
      }
    }
    return undefined;
  }
}

type Delta = { type: string; contentIndex?: number; delta?: string; id?: string; toolName?: string };

/** Applies one streaming delta (pi's JSON form) to a copy of the streamed assistant message. */
function applyDelta(message: Message, delta: Delta | undefined): Message {
  if (delta === undefined || delta.contentIndex === undefined) {
    return message;
  } else {
    const content = [...((message.content as { type: string; [key: string]: unknown }[] | undefined) ?? [])];
    const index = delta.contentIndex;
    const block = content[index];
    switch (delta.type) {
      case "text_start":
        content[index] = { type: "text", text: "" };
        break;
      case "text_delta":
        content[index] = { ...(block ?? { type: "text" }), text: `${String(block?.text ?? "")}${delta.delta ?? ""}` };
        break;
      case "thinking_start":
        content[index] = { type: "thinking", thinking: "" };
        break;
      case "thinking_delta":
        content[index] = { ...(block ?? { type: "thinking" }), thinking: `${String(block?.thinking ?? "")}${delta.delta ?? ""}` };
        break;
      case "toolcall_start":
        content[index] = { type: "toolCall", id: delta.id, name: delta.toolName, arguments: {}, partialJson: "" };
        break;
      case "toolcall_delta":
        content[index] = { ...(block ?? { type: "toolCall" }), partialJson: `${String(block?.partialJson ?? "")}${delta.delta ?? ""}` };
        break;
      default:
        break; // ends of blocks: the message_end carries the final form
    }
    return { ...message, content };
  }
}
