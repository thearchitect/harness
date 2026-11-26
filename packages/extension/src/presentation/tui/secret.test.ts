import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { SecretDialog } from "./secret.ts";

const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const tui = { requestRender: () => undefined } as unknown as TUI;

test("the secret dialog never renders what was typed or pasted, submits it on Enter and cancels on Escape", () => {
  const answers: unknown[] = [];
  const dialog = new SecretDialog(tui, plain, { name: "TOKEN", description: "a token", replaces: false }, (answer) => answers.push(answer));
  dialog.focused = true;

  for (const key of "s3cr") dialog.handleInput(key);
  dialog.handleInput("\x1b[200~et-pasted\x1b[201~");
  const rendered = dialog.render(80);
  const text = rendered.join("\n");
  assert.equal(text.includes("s3cr"), false);
  assert.equal(text.includes("pasted"), false);
  assert.equal(text.split("•").length - 1, "s3cret-pasted".length);
  assert.ok(rendered.every((line) => visibleWidth(line) <= 80));

  dialog.handleInput("\r");
  assert.deepEqual(answers, [{ value: "s3cret-pasted" }]);
  dialog.handleInput("\x1b");
  assert.deepEqual(answers.at(-1), { cancelled: true });
});
