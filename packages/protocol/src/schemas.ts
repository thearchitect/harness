// Schemas of the protocols: what a client may send (node frames, the arguments of each control
// operation, harness's HAP requests) and what it receives (node frames and events, harness's HAP
// events). Every endpoint checks its input here before acting on it (a node checks every client
// frame, the agent every HAP request); pi's own RPC commands are checked by pi. Dispatch is by the
// discriminant (`k`, `op`, `type`), so an error names the one shape it broke. The descriptions are
// the protocol reference (gen-reference.ts writes docs/protocol/reference/ from them).

import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { HapRequestType } from "./hap.ts";
import type { NodeOp } from "./node.ts";

const Str = (description?: string) => Type.String(description !== undefined ? { description } : {});
const Int = (description?: string) => Type.Integer({ minimum: 0, ...(description !== undefined ? { description } : {}) });
const Empty = Type.Object({});
const Opt = <T extends TSchema>(schema: T) => Type.Optional(schema);
const Any = (description: string) => Type.Unknown({ description });
const Obj = <P extends Record<string, TSchema>>(properties: P, description: string) => Type.Object(properties, { description });

/* ----- client → node ----- */

export const FRAME_SCHEMAS = {
  hello: Obj(
    {
      k: Type.Literal("hello"),
      protocol: Type.Integer({ description: "PROTOCOL_VERSION of the client (version.ts)" }),
      client: Str("What the client is: tui, app, test, hub, node"),
      token: Opt(Str("A device token (hub) or a node key (uplink); none on local endpoints")),
      capabilities: Opt(Type.Array(Str(), { description: "What the client can draw besides typed data: component-bridge" })),
    },
    "The first frame of a connection; answered with welcome or refused.",
  ),
  req: Obj(
    {
      k: Type.Literal("req"),
      id: Str("Chosen by the client; the res frame carries it back"),
      node: Opt(Str("The node to run it on, through a hub; the connected node when absent")),
      op: Str("A control operation (see Operations)"),
      args: Any("The operation's arguments"),
    },
    "A control operation; answered with one res frame of the same id.",
  ),
  hap: Obj(
    {
      k: Type.Literal("hap"),
      node: Opt(Str("The agent's node, through a hub")),
      agent: Str("The agent id"),
      rec: Type.Object({ type: Str("A pi RPC command or a harness request") }, { description: "The HAP record for the agent" }),
    },
    "A HAP record for an agent; requests are answered by the agent with the same id.",
  ),
} as const;

const Mode = Type.Union([Type.Literal("plan"), Type.Literal("build"), Type.Literal("simple")], { description: "The run's mode" });

const Level = Type.Union([Type.Literal("full"), Type.Literal("summary")], { description: "full: snapshot and live stream; summary: summaries only" });

export const OP_SCHEMAS: Record<NodeOp, TSchema> = {
  nodes_list: Obj({}, "The nodes this connection reaches: the node itself (if the user may use it) and, through a hub, the user's nodes with presence. → { nodes }"),
  sessions_list: Obj({ cwd: Opt(Str("Only sessions of this directory")) }, "Sessions stored on the node, newest first, with the agent serving each. → { sessions }"),
  agents_list: Obj({}, "The agents running on the node with their summaries. → { agents }"),
  agent_start: Obj(
    {
      cwd: Str("The session's directory; ~ is the node user's home"),
      sessionFile: Opt(Str("Open this stored session; a new one when absent")),
      subagent: Opt(
        Obj(
          {
            profile: Str(),
            role: Str("An extra system prompt section of the child"),
            mode: Opt(Mode),
            model: Opt(Str("A model reference")),
            tools: Type.Object({ allow: Opt(Type.Array(Str())), deny: Opt(Type.Array(Str())) }),
            subagents: Type.Array(Str(), { description: "Profiles the child may call" }),
            madness: Type.Boolean(),
            depth: Type.Integer({ description: "Set by the node from the chain of parents" }),
          },
          "How the child runs as a subagent; only an agent's own connection may start one",
        ),
      ),
      background: Opt(Type.Boolean({ description: "A subagent that outlives its parent" })),
    },
    "Starts an agent (or returns the one serving the session already). → { agent }",
  ),
  agent_attach: Obj({ agent: Str("The agent id"), level: Level }, "Follows an agent; at the full level the answer carries the snapshot and the stream continues after it. → { agent, snapshot? }"),
  agent_detach: Obj({ agent: Str("The agent id") }, "Stops following an agent; it keeps running. → {}"),
  agent_close: Obj({ agent: Str("The agent id") }, "Stops an agent; its session stays. → {}"),
  files_list: Obj({ path: Str("A directory under the node user's home") }, "Lists a directory. → { path, items }"),
  files_get: Obj({ path: Str("A file under the node user's home") }, "Reads a file. → { path, base64 }"),
  files_put: Obj({ path: Str("A file under the node user's home"), base64: Str("The content") }, "Writes a file (directories are created). → { path }"),
  theme_get: Obj({ name: Opt(Str("A theme name; the user's ui.theme, else dark, when absent")) }, "A theme's colors as hex for clients that draw it themselves, with the names of the themes there are. → { name, appearance, colors, names }"),
  files_upload: Obj({ name: Str("The file's name"), base64: Str() }, "A file the operator hands to a session (dropped, shared, picked), kept in the node's ~/.harness/uploads. → { path }"),
  settings_get: Obj({}, "The user's UI settings (ui.tabs, ui.theme, …): the node user's, or the hub user's. → { settings }"),
  settings_set: Obj({ key: Str("A setting key"), value: Any("Its new value; null removes it") }, "Changes one setting; every client of the user receives a settings event. → { settings }"),
};

const Image = Type.Object({ type: Type.Literal("image"), data: Str("base64"), mimeType: Str() });
const Request = <P extends Record<string, TSchema>>(type: HapRequestType, properties: P, description: string) =>
  Type.Object({ type: Type.Literal(type), id: Str("Chosen by the client; harness_response carries it back"), ...properties }, { description });

export const HAP_REQUEST_SCHEMAS: Record<HapRequestType, TSchema> = {
  harness_snapshot: Request("harness_snapshot", { limit: Int("The newest entries to include") }, "The agent's state for a client that attaches: entries, the run in flight, the session view, HarnessState, open interactions and components."),
  harness_entries_before: Request("harness_entries_before", { cursor: Str("From a snapshot or an earlier answer"), limit: Int() }, "Older entries of the current branch, for scrolling up."),
  harness_prompt: Request(
    "harness_prompt",
    { text: Str("The message"), mode: Opt(Mode), images: Opt(Type.Array(Image, { description: "Attached images" })) },
    "A message in an explicit mode; steers when a run is on. Answered after pi's preflight with { disposition }.",
  ),
  harness_set: Request(
    "harness_set",
    {
      variant: Opt(Str("advanced (PLAN/BUILD) or simple")),
      madness: Opt(Type.Boolean({ description: "Changes without gates" })),
      implementer: Opt(Str("self or a subagent profile")),
      model: Opt(Str("A model reference (provider/family[:thinking]) to select and follow")),
    },
    "Changes the session's harness state; answered with the new HarnessState.",
  ),
  harness_interrupt: Request("harness_interrupt", { reason: Str("Steered to the model") }, "\"/-\": stops the long calls in flight and steers the reason."),
  harness_interaction_response: Request("harness_interaction_response", { interactionId: Str(), answer: Any("The answer of the interaction's kind") }, "Answers an open interaction; the first answer wins, others get closed: answered."),
  harness_task_stop: Request("harness_task_stop", { taskId: Str() }, "Stops a background task (its process group)."),
  harness_task_input: Request("harness_task_input", { taskId: Str(), data: Str("Written to the task's stdin") }, "Input for a background task."),
  harness_task_output: Request("harness_task_output", { taskId: Str(), offset: Int("Byte offset in the task's output"), limit: Int("Bytes at most") }, "A background task's output."),
  harness_subagent_send: Request("harness_subagent_send", { session: Str("A live subagent session"), text: Str() }, "Operator steering of a live subagent."),
  harness_complete: Request("harness_complete", { kind: Type.Union([Type.Literal("path"), Type.Literal("file")]), prefix: Str() }, "Completions of paths on the agent's machine."),
  harness_component_input: Request("harness_component_input", { componentId: Str(), data: Str("Keys as the terminal sends them") }, "Keys for a bridged component."),
  harness_component_resize: Request("harness_component_resize", { componentId: Str(), width: Type.Integer({ minimum: 1 }) }, "The width a bridged component is drawn at."),
  harness_report: Request("harness_report", {}, "The agent's dependencies report: the bundle, Claude Code, subagent profiles, bundled versions. → { text }"),
  harness_login_providers: Request("harness_login_providers", {}, "Providers one can log in to on the agent's machine. → { providers }"),
  harness_login: Request(
    "harness_login",
    { provider: Str(), authType: Type.Union([Type.Literal("oauth"), Type.Literal("api_key")]) },
    "Logs in to a provider on the agent's machine; its steps reach the operator as interactions; answers when the login is done. → {}",
  ),
  harness_navigate: Request(
    "harness_navigate",
    { entryId: Str(), summarize: Opt(Type.Boolean({ description: "Summarize the branch left behind" })) },
    "Moves the session to another point of its tree (pi's /tree); clients reload the transcript. → { editorText?, cancelled }",
  ),
  harness_logout: Request("harness_logout", { provider: Str() }, "Removes a provider's stored login on the agent's machine. → {}"),
  harness_subagents: Request("harness_subagents", {}, "The subagent profiles this session may call, with their resolved models, and the profiles left out. → { profiles, problems }"),
};

/* ----- node → client ----- */

export const NODE_FRAME_SCHEMAS = {
  welcome: Obj(
    { k: Type.Literal("welcome"), protocol: Type.Integer(), harness: Str("The node's harness version"), node: Str("The node's name"), user: Str("Who the connection is: the node's OS user or a hub user") },
    "The answer to hello.",
  ),
  refused: Obj({ k: Type.Literal("refused"), error: Any("{ code, message } (errors.ts)") }, "The connection is refused; the node closes it."),
  res: Obj({ k: Type.Literal("res"), id: Str(), ok: Type.Boolean(), data: Opt(Any("The operation's result")), error: Opt(Any("{ code, message }")) }, "The answer to a req."),
  evt: Obj({ k: Type.Literal("evt"), node: Str(), event: Any("A node event (see Node events)") }, "A node event."),
  hap: Obj({ k: Type.Literal("hap"), node: Str(), agent: Str(), rec: Any("A HAP record of the agent") }, "A record of an agent this connection follows in full (and answers to its requests)."),
} as const;

export const NODE_EVENT_SCHEMAS = {
  agents: Obj({ ev: Type.Literal("agents"), agents: Any("AgentInfo[]") }, "The node's agents changed (one started or exited)."),
  summary: Obj({ ev: Type.Literal("summary"), agent: Str(), summary: Any("AgentSummary: status, mode, title, waiting, tasks, lastOutcome, lastActivity, costUsd") }, "An agent's summary changed; at most 4 per second per agent."),
  agent_exited: Obj({ ev: Type.Literal("agent_exited"), agent: Str(), code: Type.Union([Type.Integer(), Type.Null()]), error: Opt(Str()) }, "An agent's process ended."),
  settings: Obj({ ev: Type.Literal("settings"), settings: Any("The user's settings") }, "The user's settings changed (sent only to that user's connections)."),
  nodes: Obj({ ev: Type.Literal("nodes"), nodes: Any("NodeInfo[]: name, online, roles") }, "A hub's nodes came online or went offline."),
  refused: Obj({ ev: Type.Literal("refused"), error: Any("{ code, message }") }, "A node behind a hub refused this client's channel."),
} as const;

export const HAP_EVENT_SCHEMAS = {
  harness_hello: Obj({ type: Type.Literal("harness_hello"), protocol: Type.Integer(), harness: Str(), session: Any("SessionView") }, "The agent is ready (node only)."),
  harness_response: Obj({ type: Type.Literal("harness_response"), id: Str(), ok: Type.Boolean(), data: Opt(Any("The result")), error: Opt(Any("{ code, message }")) }, "The answer to a harness request."),
  harness_state: Obj({ type: Type.Literal("harness_state"), state: Any("HarnessState: variant, madness, implementer, mode, model, tasks, subagents") }, "The whole HarnessState after a change."),
  harness_session: Obj({ type: Type.Literal("harness_session"), session: Any("SessionView: id, file, name, cwd, model, thinking, activity, queue, usage") }, "pi's view of the session changed."),
  harness_interaction_request: Obj({ type: Type.Literal("harness_interaction_request"), request: Any("InteractionRequest: id, kind, payload, toolCallId?, openedAt") }, "An interaction opens for the operator."),
  harness_interaction_closed: Obj({ type: Type.Literal("harness_interaction_closed"), interactionId: Str(), reason: Str("answered, cancelled, expired or ended") }, "An interaction closed."),
  harness_task_output: Obj({ type: Type.Literal("harness_task_output"), taskId: Str(), offset: Int(), chunk: Str() }, "Output of a background task."),
  harness_ui: Obj({ type: Type.Literal("harness_ui"), method: Str("notify, status, widget, editor_text, title") }, "An extension's UI call that every client can show (the method's fields follow)."),
  harness_component_open: Obj({ type: Type.Literal("harness_component_open"), componentId: Str(), overlay: Type.Boolean() }, "A bridged component opens (terminal clients)."),
  harness_component_render: Obj({ type: Type.Literal("harness_component_render"), componentId: Str(), lines: Type.Array(Str(), { description: "ANSI lines" }) }, "A bridged component's new lines."),
  harness_component_close: Obj({ type: Type.Literal("harness_component_close"), componentId: Str() }, "A bridged component closed."),
} as const;

export type Checked = { ok: true } | { ok: false; error: string };

function check(schema: TSchema, value: unknown, what: string): Checked {
  if (Value.Check(schema, value)) {
    return { ok: true };
  } else {
    const first = [...Value.Errors(schema, value)][0];
    const where = first?.instancePath !== undefined && first.instancePath !== "" ? ` at ${first.instancePath}` : "";
    return { ok: false, error: `${what}: ${first?.message ?? "invalid"}${where}` };
  }
}

/** A client frame, and for a request also its operation's arguments. */
export function checkClientFrame(frame: unknown): Checked {
  const k = (frame as { k?: unknown } | null)?.k;
  if (k !== "hello" && k !== "req" && k !== "hap") {
    return { ok: false, error: `unknown frame ${JSON.stringify(k)}` };
  } else {
    const shape = check(FRAME_SCHEMAS[k], frame, `${k} frame`);
    if (!shape.ok || k !== "req") {
      return shape;
    } else {
      const { op, args } = frame as { op: string; args: unknown };
      const schema = (OP_SCHEMAS as Record<string, TSchema>)[op];
      return schema === undefined ? { ok: false, error: `unknown operation ${op}` } : check(schema, args ?? {}, op);
    }
  }
}

/** A harness HAP request (other records are pi's and pi checks them). */
export function checkHapRequest(record: { type: string }): Checked {
  const schema = (HAP_REQUEST_SCHEMAS as Record<string, TSchema>)[record.type];
  return schema === undefined ? { ok: false, error: `unknown request ${record.type}` } : check(schema, record, record.type);
}
