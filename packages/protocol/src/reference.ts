// The protocol reference (docs/protocol/reference/), generated from schemas.ts: one page per
// group of shapes, a table of fields per shape. `node packages/testkit/src/docs/write-reference.ts`
// writes the pages; a test compares the committed pages with these.

import type { TSchema } from "typebox";
import { PROTOCOL_VERSION } from "./version.ts";
import { FRAME_SCHEMAS, HAP_EVENT_SCHEMAS, HAP_REQUEST_SCHEMAS, HUB_EVENT_SCHEMAS, HUB_FRAME_SCHEMAS, OP_SCHEMAS } from "./schemas.ts";

type Json = { type?: string; const?: unknown; anyOf?: Json[]; items?: Json; properties?: Record<string, Json>; required?: string[]; description?: string; minimum?: number };

function typeOf(schema: Json): string {
  if (schema.const !== undefined) {
    return `\`${JSON.stringify(schema.const)}\``;
  } else if (schema.anyOf !== undefined) {
    return schema.anyOf.map(typeOf).join(" \\| ");
  } else if (schema.type === "array") {
    return `${typeOf(schema.items ?? {})}[]`;
  } else if (schema.type === "object") {
    return schema.properties !== undefined && Object.keys(schema.properties).length > 0 ? `{ ${Object.keys(schema.properties).join(", ")} }` : "object";
  } else {
    return schema.type ?? "any";
  }
}

function shape(name: string, schema: TSchema): string {
  const json = schema as unknown as Json;
  const rows = Object.entries(json.properties ?? {}).map(
    ([field, value]) => `| \`${field}\` | ${typeOf(value)} | ${json.required?.includes(field) === true ? "yes" : ""} | ${(value.description ?? "").replace(/\|/g, "\\|")} |`,
  );
  return [`### \`${name}\``, "", json.description ?? "", "", ...(rows.length > 0 ? ["| Field | Type | Required | Description |", "|---|---|---|---|", ...rows] : ["No fields."]), ""].join("\n");
}

function page(title: string, intro: string, groups: [string, Record<string, TSchema>][]): string {
  return [
    `# ${title}`,
    "",
    `<!-- Generated from packages/protocol/src/schemas.ts by packages/testkit/src/docs/write-reference.ts; do not edit. -->`,
    "",
    intro,
    "",
    `Protocol version: ${PROTOCOL_VERSION}.`,
    "",
    ...groups.flatMap(([heading, schemas]) => [`## ${heading}`, "", ...Object.entries(schemas).map(([name, schema]) => shape(name, schema))]),
  ].join("\n");
}

/** The pages, by file name. */
export function referencePages(): Record<string, string> {
  return {
    "hub.md": page("Hub protocol reference", "Frames between a client and a hub, one JSON object per line ([behavior](../hub.md)).", [
      ["Client frames", FRAME_SCHEMAS],
      ["Hub frames", HUB_FRAME_SCHEMAS],
      ["Operations", OP_SCHEMAS],
      ["Hub events", HUB_EVENT_SCHEMAS],
    ]),
    "hap.md": page("HAP reference", "The records harness adds to pi's RPC between a client and an agent ([behavior](../hap.md)).", [
      ["Requests", HAP_REQUEST_SCHEMAS],
      ["Events", HAP_EVENT_SCHEMAS],
    ]),
  };
}

