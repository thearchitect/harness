// A provider's login step as rows, the same in every UI (plan polish-3 C): opening and copying the
// sign-in link (or the device code's page and code), the options of a choice, the field of a line or
// secret. The UIs draw the step's text above them and the hint line below; the keys are the same:
// ↑/↓ move between rows (and leave the field), Enter applies a row, typing goes to the field at once,
// ← outside the field goes back one step, Esc cancels.

import type { LoginPayload } from "#protocol/interactions.ts";
import type { KeyHint } from "./workbench.ts";

export type LoginRow =
  | { kind: "open"; label: string; url: string }
  | { kind: "copy"; label: string; text: string }
  | { kind: "option"; label: string; id: string; description?: string }
  | { kind: "field"; label: string; secret: boolean; placeholder?: string };

export function loginRows(payload: LoginPayload): LoginRow[] {
  const prompt = payload.prompt;
  const link: LoginRow[] =
    payload.url !== undefined
      ? [
          { kind: "open", label: "open in browser", url: payload.url },
          { kind: "copy", label: "copy link", text: payload.url },
        ]
      : [];
  const device: LoginRow[] =
    payload.deviceCode !== undefined
      ? [
          { kind: "open", label: "open the page", url: payload.deviceCode.uri },
          { kind: "copy", label: "copy code", text: payload.deviceCode.code },
        ]
      : [];
  let asked: LoginRow[];
  if (prompt === undefined) {
    asked = [];
  } else if (prompt.type === "select") {
    asked = prompt.options.map((option) => ({ kind: "option", label: option.label, id: option.id, ...(option.description !== undefined ? { description: option.description } : {}) }));
  } else {
    asked = [{ kind: "field", label: prompt.message, secret: prompt.type === "secret", ...(prompt.placeholder !== undefined ? { placeholder: prompt.placeholder } : {}) }];
  }
  return [...link, ...device, ...asked];
}

/** The row the step opens on: the first choice's option, else the first action, else the field. */
export function loginInitialRow(rows: LoginRow[]): number {
  const option = rows.findIndex((row) => row.kind === "option");
  return option >= 0 ? option : 0;
}

export function loginHints(rows: LoginRow[]): KeyHint[] {
  const field = rows.some((row) => row.kind === "field");
  return [
    { key: "←", does: "back" },
    { key: "↑↓", does: "select" },
    { key: "enter", does: field ? "apply or submit" : "apply" },
    ...(field ? [{ key: "type", does: "to the field" }] : []),
    { key: "esc", does: "cancel" },
  ];
}
