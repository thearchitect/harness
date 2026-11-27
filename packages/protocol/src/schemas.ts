// Schemas of the protocols: what a client may send (hub frames, the arguments of each control
// operation, harness's HAP requests) and what it receives (hub frames and events, harness's HAP
// events). Every endpoint checks its input here before acting on it (a hub checks every client
// frame, the agent every HAP request); pi's own RPC commands are checked by pi. Dispatch is by the
// discriminant (`k`, `op`, `type`), so an error names the one shape it broke. The descriptions are
// the protocol reference (gen-reference.ts writes docs/protocol/reference/ from them).

import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { HapRequestType } from "./hap.ts";
import type { HubOp } from "./hub.ts";

const Str = (description?: string) => Type.String(description !== undefined ? { description } : {});
const Int = (description?: string) => Type.Integer({ minimum: 0, ...(description !== undefined ? { description } : {}) });
const Empty = Type.Object({});
const Opt = <T extends TSchema>(schema: T) => Type.Optional(schema);
const Any = (description: string) => Type.Unknown({ description });
const Obj = <P extends Record<string, TSchema>>(properties: P, description: string) => Type.Object(properties, { description });

/* ----- client → hub ----- */

export const FRAME_SCHEMAS = {
  hello: Obj(
    {
      k: Type.Literal("hello"),
      protocol: Type.Integer({ description: "PROTOCOL_VERSION of the client (version.ts)" }),
      client: Str("What the client is: tui, app, test"),
      token: Opt(Str("A device token on the network endpoint; none on local endpoints")),
      capabilities: Opt(Type.Array(Str(), { description: "What the client can draw besides typed data: component-bridge" })),
    },
    "The first frame of a connection; answered with welcome or refused.",
  ),
  req: Obj(
    {
      k: Type.Literal("req"),
      id: Str("Chosen by the client; the res frame carries it back"),
      op: Str("A control operation (see Operations)"),
      args: Any("The operation's arguments"),
    },
    "A control operation; answered with one res frame of the same id.",
  ),
  hap: Obj(
    {
      k: Type.Literal("hap"),
      agent: Str("The agent id"),
      rec: Type.Object({ type: Str("A pi RPC command or a harness request") }, { description: "The HAP record for the agent" }),
    },
    "A HAP record for an agent; requests are answered by the agent with the same id.",
  ),
} as const;

const Mode = Type.Union([Type.Literal("plan"), Type.Literal("build"), Type.Literal("simple")], { description: "The run's mode" });

const Level = Type.Union([Type.Literal("full"), Type.Literal("summary")], { description: "full: snapshot and live stream; summary: summaries only" });

export const OP_SCHEMAS: Record<HubOp, TSchema> = {
  sessions_list: Obj({ cwd: Opt(Str("Only sessions of this directory")) }, "Sessions stored on the hub, newest first, with the agent serving each. → { sessions }"),
  session_read: Obj(
    { file: Str("A session file from sessions_list"), cursor: Opt(Str("From an earlier answer: the entries before it")), limit: Opt(Int("How many entries (200 by default)")) },
    "A stored session's entries without its agent, as harness_snapshot and harness_entries_before give them: the current branch, oldest first. → { entries, cursor?, mtime }",
  ),
  agents_list: Obj({}, "The agents running on the hub with their summaries. → { agents }"),
  agent_start: Obj(
    {
      cwd: Str("The session's directory; ~ is the hub user's home"),
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
            depth: Type.Integer({ description: "Set by the hub from the chain of parents" }),
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
  files_list: Obj({ path: Str("A directory under the hub user's home") }, "Lists a directory. → { path, items }"),
  dirs_list: Obj(
    { path: Str("A directory of the hub's machine: absolute, ~ or ~/…"), hidden: Opt(Type.Boolean({ description: "Directories whose names start with a dot too" })) },
    "The directories in a directory, by name, each with hasChildren (it holds directories itself), for choosing where a session starts. → { path, parent, home, dirs }",
  ),
  files_get: Obj({ path: Str("A file under the hub user's home") }, "Reads a file. → { path, base64 }"),
  files_put: Obj({ path: Str("A file under the hub user's home"), base64: Str("The content") }, "Writes a file (directories are created). → { path }"),
  theme_get: Obj({ name: Opt(Str("A theme name; the user's ui.theme, else dark, when absent")) }, "A theme's colors as hex for clients that draw it themselves, with the names of the themes there are. → { name, appearance, colors, names }"),
  files_upload: Obj({ name: Str("The file's name"), base64: Str() }, "A file the operator hands to a session (dropped, shared, picked), kept in the hub's ~/.harness/uploads. → { path }"),
  transcribe: Obj({ base64: Str("The recording"), mime: Str("Its type, e.g. audio/webm") }, "Speech to text on the hub with its user's OpenAI login (gpt-4o-transcribe). → { text }"),
  logs_tail: Obj({ lines: Opt(Type.Integer({ minimum: 1, maximum: 2000 })) }, "The hub's event log, newest last. → { lines }"),
  terminal_open: Obj(
    { session: Str("The session's id"), cwd: Str("Its directory"), cols: Int(), rows: Int() },
    "Shows a session's terminal to this client: a shell in its directory on this hub, started at the first show (and again after it exited); the stream follows as terminal_output events. → { screen } (its screen with history as ANSI)",
  ),
  terminal_input: Obj({ session: Str(), data: Str("Bytes for the shell, as a terminal sends them") }, "Input to a session's terminal. → {}"),
  terminal_resize: Obj({ session: Str(), cols: Int(), rows: Int() }, "The terminal's size (the last client's wins). → {}"),
  terminal_detach: Obj({ session: Str() }, "Hides the terminal from this client; the shell runs on. → {}"),
  hub_restart: Obj({}, "Stops every agent and its processes and starts the hub again (its own user only): a client holding it restarts it in its process, a service exits for its supervisor to start it. Clients reconnect. → {}"),
  settings_get: Obj({}, "The user's UI settings (ui.tabs, ui.theme, …): the hub user's. → { settings }"),
  settings_set: Obj(
    {
      key: Str("A setting key"),
      value: Any("Its new value; null removes it"),
      ifRevision: Opt(Str("The revision (settings.ts settingRevision) of the value this change was made from: another current one answers conflict")),
    },
    "Changes one setting; every client of the user receives a settings event. → { settings }",
  ),
  hub_status: Obj({}, "The hub's network access (settings, where they come from, whether it runs and why not) and its paired devices and pairing codes. → HubStatus"),
  hub_network_set: Obj(
    {
      enabled: Opt(Type.Boolean()),
      listen: Opt(Str("host:port of the HTTP endpoint; off loopback only with proxy")),
      proxy: Opt(Type.Boolean({ description: "Only a TLS proxy in front reaches the port (Fly, tailscale serve, Caddy)" })),
      url: Opt(Str("The address devices use, for pairing links")),
    },
    "Changes the network access (the user's hub.network setting); refused when the service's configuration sets it. → HubStatus",
  ),
  device_pair: Obj({ name: Opt(Str("The device's name; else the one it gives when it pairs")) }, "A one-time code for a new device, for ten minutes. → { id, code, expires, link? }"),
  device_rename: Obj({ name: Str(), to: Str() }, "Renames a paired device. → HubStatus"),
  device_revoke: Obj({ name: Str() }, "Revokes a paired device; its connections close at once. → HubStatus"),
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
  harness_subagent_snapshot: Request(
    "harness_subagent_snapshot",
    { session: Str("A claude subagent's session"), limit: Opt(Type.Integer({ minimum: 1 })) },
    "A claude subagent's transcript as pi entries (claude-transcript.ts). → { entries, cursor?, streaming?, model?, costUsd }",
  ),
  harness_subagent_entries_before: Request(
    "harness_subagent_entries_before",
    { session: Str(), cursor: Str("From harness_subagent_snapshot or an earlier page"), limit: Opt(Type.Integer({ minimum: 1 })) },
    "Older entries of a claude subagent's transcript. → { entries, cursor? }",
  ),
  harness_complete: Request("harness_complete", { kind: Type.Union([Type.Literal("path"), Type.Literal("file")]), prefix: Str() }, "Completions of paths on the agent's machine."),
  harness_component_input: Request("harness_component_input", { componentId: Str(), data: Str("Keys as the terminal sends them") }, "Keys for a bridged component."),
  harness_component_resize: Request(
    "harness_component_resize",
    { componentId: Str(), width: Type.Integer({ minimum: 1 }), rows: Opt(Type.Integer({ minimum: 1, description: "The client's height for it (the component's terminal.rows)" })) },
    "The size a bridged component is drawn at.",
  ),
  harness_component_mouse: Request(
    "harness_component_mouse",
    {
      componentId: Str(),
      event: Type.Object({
        type: Type.Union(["press", "release", "move", "click", "wheel"].map((value) => Type.Literal(value))),
        button: Type.Union(["left", "middle", "right", "none"].map((value) => Type.Literal(value))),
        x: Type.Integer({ minimum: 0, description: "The column" }),
        y: Type.Integer({ minimum: 0, description: "The line of the component's drawn lines" }),
        wheelDelta: Opt(Type.Integer()),
      }),
    },
    "The pointer over a bridged component: a click, a move, the wheel at a cell.",
  ),
  harness_report: Request("harness_report", {}, "The agent's dependencies report: the bundle, Claude Code, subagent profiles, bundled versions. → { text }"),
  harness_login_providers: Request("harness_login_providers", {}, "Providers one can log in to on the agent's machine. → { providers }"),
  harness_login: Request(
    "harness_login",
    { provider: Str(), authType: Type.Union([Type.Literal("oauth"), Type.Literal("api_key")]) },
    "Logs in to a provider on the agent's machine; each step is a `login` interaction; answers when the login is done, or { back: true } when the operator went back from its first step. → { back? }",
  ),
  harness_navigate: Request(
    "harness_navigate",
    { entryId: Str(), summarize: Opt(Type.Boolean({ description: "Summarize the branch left behind" })) },
    "Moves the session to another point of its tree (pi's /tree); clients reload the transcript. → { editorText?, cancelled }",
  ),
  harness_logout: Request("harness_logout", { provider: Str() }, "Removes a provider's stored login on the agent's machine. → {}"),
  harness_subagents: Request("harness_subagents", {}, "The subagent profiles this session may call, with their resolved models, and the profiles left out. → { profiles, problems }"),
};

/* ----- hub → client ----- */

export const HUB_FRAME_SCHEMAS = {
  welcome: Obj(
    {
      k: Type.Literal("welcome"),
      protocol: Type.Integer(),
      harness: Str("The hub's harness version"),
      hub: Str("The hub's name"),
      host: Type.Union([Type.Literal("client"), Type.Literal("service")], { description: "Who runs the hub: a client window holding it, or a service (harness hub)" }),
      pid: Type.Integer({ description: "The hub's process" }),
    },
    "The answer to hello.",
  ),
  refused: Obj({ k: Type.Literal("refused"), error: Any("{ code, message } (errors.ts)") }, "The connection is refused; the hub closes it."),
  res: Obj({ k: Type.Literal("res"), id: Str(), ok: Type.Boolean(), data: Opt(Any("The operation's result")), error: Opt(Any("{ code, message }")) }, "The answer to a req."),
  evt: Obj({ k: Type.Literal("evt"), event: Any("A hub event (see Hub events)") }, "A hub event."),
  hap: Obj({ k: Type.Literal("hap"), agent: Str(), rec: Any("A HAP record of the agent") }, "A record of an agent this connection follows in full (and answers to its requests)."),
} as const;

export const HUB_EVENT_SCHEMAS = {
  agents: Obj({ ev: Type.Literal("agents"), agents: Any("AgentInfo[]") }, "The hub's agents changed (one started or exited)."),
  summary: Obj({ ev: Type.Literal("summary"), agent: Str(), summary: Any("AgentSummary: status, mode, title, waiting, tasks, lastOutcome, lastActivity, costUsd") }, "An agent's summary changed; at most 4 per second per agent."),
  agent_exited: Obj({ ev: Type.Literal("agent_exited"), agent: Str(), code: Type.Union([Type.Integer(), Type.Null()]), error: Opt(Str()) }, "An agent's process ended."),
  settings: Obj({ ev: Type.Literal("settings"), settings: Any("The user's settings") }, "The user's settings changed."),
  terminal_output: Obj({ ev: Type.Literal("terminal_output"), session: Str(), data: Str("Bytes of the shell as text") }, "Output of a session's terminal this client shows."),
  terminal_exit: Obj({ ev: Type.Literal("terminal_exit"), session: Str(), code: Type.Integer() }, "A session's terminal shell exited; terminal_open starts another."),
  hub: Obj({ ev: Type.Literal("hub"), status: Any("HubStatus") }, "The network access or the devices changed (one paired, connected, was revoked)."),
} as const;

export const HAP_EVENT_SCHEMAS = {
  harness_hello: Obj({ type: Type.Literal("harness_hello"), protocol: Type.Integer(), harness: Str(), session: Any("SessionView") }, "The agent is ready (hub only)."),
  harness_response: Obj({ type: Type.Literal("harness_response"), id: Str(), ok: Type.Boolean(), data: Opt(Any("The result")), error: Opt(Any("{ code, message }")) }, "The answer to a harness request."),
  harness_state: Obj({ type: Type.Literal("harness_state"), state: Any("HarnessState: variant, madness, implementer, mode, model, tasks, subagents") }, "The whole HarnessState after a change."),
  harness_session: Obj({ type: Type.Literal("harness_session"), session: Any("SessionView: id, file, name, cwd, model, thinking, activity, queue, usage") }, "pi's view of the session changed."),
  harness_interaction_request: Obj({ type: Type.Literal("harness_interaction_request"), request: Any("InteractionRequest: id, kind, payload, toolCallId?, openedAt") }, "An interaction opens for the operator."),
  harness_interaction_closed: Obj({ type: Type.Literal("harness_interaction_closed"), interactionId: Str(), reason: Str("answered, cancelled, expired or ended") }, "An interaction closed."),
  harness_task_output: Obj({ type: Type.Literal("harness_task_output"), taskId: Str(), offset: Int(), chunk: Str() }, "Output of a background task."),
  harness_ui: Obj({ type: Type.Literal("harness_ui"), method: Str("notify, status, widget, editor_text, title, open_url") }, "An extension's UI call that every client can show (the method's fields follow)."),
  harness_component_open: Obj({ type: Type.Literal("harness_component_open"), componentId: Str(), overlay: Type.Boolean() }, "A bridged component opens (terminal clients)."),
  harness_component_render: Obj({ type: Type.Literal("harness_component_render"), componentId: Str(), lines: Type.Array(Str(), { description: "ANSI lines" }) }, "A bridged component's new lines."),
  harness_component_close: Obj({ type: Type.Literal("harness_component_close"), componentId: Str() }, "A bridged component closed."),
  harness_subagent_entries: Obj(
    { type: Type.Literal("harness_subagent_entries"), session: Str(), entries: Type.Array(Any("A pi entry")), streaming: Any("The message being streamed, or null") },
    "A claude subagent's transcript changed: entries new or updated by id.",
  ),
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
