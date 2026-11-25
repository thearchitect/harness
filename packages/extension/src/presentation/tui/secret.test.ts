import assert from "node:assert/strict";
import { test } from "node:test";
import { MaskedSecretInput } from "./secret.ts";

test("the secret input never renders what was typed or pasted, submits it on Enter and cancels on Escape", () => {
  const input = new MaskedSecretInput();
  const submitted: string[] = [];
  let escaped = false;
  input.onSubmit = (value) => submitted.push(value);
  input.onEscape = () => {
    escaped = true;
  };
  input.focused = true;

  for (const key of "s3cr") input.handleInput(key);
  input.handleInput("\x1b[200~et-pasted\x1b[201~");
  const rendered = input.render(80).join("\n");
  assert.equal(rendered.includes("s3cr"), false);
  assert.equal(rendered.includes("pasted"), false);
  assert.equal(rendered.split("•").length - 1, "s3cret-pasted".length);

  input.handleInput("\r");
  assert.deepEqual(submitted, ["s3cret-pasted"]);
  input.handleInput("\x1b");
  assert.equal(escaped, true);
});
