// Schemas of what a client may send: node frames, the arguments of each control operation, and
// harness's HAP requests. Every endpoint checks its input here before acting on it (a node checks
// every client frame, the agent every HAP request); pi's own RPC commands are checked by pi.
// Dispatch is by the discriminant (`k`, `op`, `type`), so an error names the one shape it broke.

import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { HapRequestType } from "./hap.ts";
import type { NodeOp } from "./node.ts";

const Str = Type.String();
const Int = Type.Integer({ minimum: 0 });
const Empty = Type.Object({});
const Opt = <T extends TSchema>(schema: T) => Type.Optional(schema);

export const FRAME_SCHEMAS = {
  hello: Type.Object({ k: Type.Literal("hello"), protocol: Type.Integer(), client: Str, token: Opt(Str) }),
  req: Type.Object({ k: Type.Literal("req"), id: Str, node: Opt(Str), op: Str, args: Type.Unknown() }),
  hap: Type.Object({ k: Type.Literal("hap"), node: Opt(Str), agent: Str, rec: Type.Object({ type: Str }) }),
} as const;

const Level = Type.Union([Type.Literal("full"), Type.Literal("summary")]);

export const OP_SCHEMAS: Record<NodeOp, TSchema> = {
  nodes_list: Empty,
  sessions_list: Type.Object({ cwd: Opt(Str) }),
  agents_list: Empty,
  agent_start: Type.Object({ cwd: Str, sessionFile: Opt(Str), parent: Opt(Str) }),
  agent_attach: Type.Object({ agent: Str, level: Level }),
  agent_detach: Type.Object({ agent: Str }),
  agent_close: Type.Object({ agent: Str }),
  files_list: Type.Object({ path: Str }),
  files_get: Type.Object({ path: Str }),
  files_put: Type.Object({ path: Str, base64: Str }),
  settings_get: Empty,
  settings_set: Type.Object({ key: Str, value: Type.Unknown() }),
};

const Mode = Type.Union([Type.Literal("plan"), Type.Literal("build"), Type.Literal("simple")]);
const Image = Type.Object({ type: Type.Literal("image"), data: Str, mimeType: Str });
const Request = <P extends Record<string, TSchema>>(type: HapRequestType, properties: P) => Type.Object({ type: Type.Literal(type), id: Str, ...properties });

export const HAP_REQUEST_SCHEMAS: Record<HapRequestType, TSchema> = {
  harness_snapshot: Request("harness_snapshot", { limit: Int }),
  harness_entries_before: Request("harness_entries_before", { cursor: Str, limit: Int }),
  harness_prompt: Request("harness_prompt", { text: Str, mode: Opt(Mode), images: Opt(Type.Array(Image)) }),
  harness_set: Request("harness_set", { variant: Opt(Str), madness: Opt(Type.Boolean()), implementer: Opt(Str) }),
  harness_interrupt: Request("harness_interrupt", { reason: Str }),
  harness_interaction_response: Request("harness_interaction_response", { interactionId: Str, answer: Type.Unknown() }),
  harness_task_stop: Request("harness_task_stop", { taskId: Str }),
  harness_task_input: Request("harness_task_input", { taskId: Str, data: Str }),
  harness_task_output: Request("harness_task_output", { taskId: Str, offset: Int, limit: Int }),
  harness_subagent_send: Request("harness_subagent_send", { session: Str, text: Str }),
  harness_complete: Request("harness_complete", { kind: Type.Union([Type.Literal("path"), Type.Literal("file")]), prefix: Str }),
};

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
