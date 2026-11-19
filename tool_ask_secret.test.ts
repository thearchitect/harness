import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { MaskedSecretInput, SECRET_MASK, secretNameProblem, secretValueProblem, sessionSecrets } from "./tool_ask_secret.ts";

describe("ask_secret", () => {
  test("a secret's name is a variable name not already in pi's environment", () => {
    assert.equal(secretNameProblem("GITHUB_TOKEN"), undefined);
    assert.equal(secretNameProblem("_KEY2"), undefined);
    assert.match(secretNameProblem("2KEY") ?? "", /is not a variable name/);
    assert.match(secretNameProblem("github_token") ?? "", /is not a variable name/);
    assert.match(secretNameProblem("PATH") ?? "", /PATH is already set in pi's environment/);
  });

  test("a value has at least four characters, counted as characters, not UTF-16 units", () => {
    assert.match(secretValueProblem("abc") ?? "", /at least 4 characters/);
    assert.match(secretValueProblem("😀😀😀") ?? "", /at least 4 characters/);
    assert.equal(secretValueProblem("abcd"), undefined);
  });

  test("bash commands of a session get its secrets, the latest value of each, and no other session's", () => {
    const [session, other] = [randomUUID(), randomUUID()];
    sessionSecrets.set(session, "API_KEY", "first-value");
    sessionSecrets.set(session, "API_KEY", "second-value");
    sessionSecrets.set(session, "DB_PASSWORD", "hunter2-db");

    assert.deepEqual(sessionSecrets.env(session), { API_KEY: "second-value", DB_PASSWORD: "hunter2-db" });
    assert.equal(sessionSecrets.has(session, "API_KEY"), true);
    assert.deepEqual(sessionSecrets.env(other), {});
    assert.equal(sessionSecrets.has(other, "API_KEY"), false);
  });

  test("every occurrence of a session's secret in a tool result is masked, longer secrets first; other sessions' results stay as they are", () => {
    const [session, other] = [randomUUID(), randomUUID()];
    sessionSecrets.set(session, "SHORT", "token");
    sessionSecrets.set(session, "LONG", "token-extended");
    const result = {
      content: [{ type: "text", text: "a token-extended and a token, token" }],
      structuredContent: { output: ["token"], exitCode: 0 },
      details: { nested: { fullOutput: "x token-extended y" }, truncated: false, path: null },
    };

    assert.deepEqual(sessionSecrets.mask(session, result), {
      changed: true,
      value: {
        content: [{ type: "text", text: `a ${SECRET_MASK} and a ${SECRET_MASK}, ${SECRET_MASK}` }],
        structuredContent: { output: [SECRET_MASK], exitCode: 0 },
        details: { nested: { fullOutput: `x ${SECRET_MASK} y` }, truncated: false, path: null },
      },
    });
    assert.deepEqual(sessionSecrets.mask(session, { content: [{ type: "text", text: "nothing here" }] }), {
      changed: false,
      value: { content: [{ type: "text", text: "nothing here" }] },
    });
    assert.deepEqual(sessionSecrets.mask(other, result), { changed: false, value: result });
  });

  test("the input never renders what was typed or pasted, submits it on Enter and cancels on Escape", () => {
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
});
