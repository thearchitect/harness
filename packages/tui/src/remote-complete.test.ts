// @file mentions of a session on another machine complete from its node's paths; directories stay
// open, files end the mention; commands still complete.

import assert from "node:assert/strict";
import { test } from "node:test";
import { RemoteAutocompleteProvider } from "./remote-complete.ts";

const signal = new AbortController().signal;

test("a mention completes from the node's paths", async () => {
  const asked: string[] = [];
  const provider = new RemoteAutocompleteProvider([{ name: "tree", description: "the tree" }], async (prefix) => {
    asked.push(prefix);
    return ["src/", "src.md"];
  });
  const suggestions = await provider.getSuggestions(["look at @sr"], 0, 11, { signal });
  assert.deepEqual(asked, ["sr"]);
  assert.equal(suggestions?.prefix, "@sr");
  assert.deepEqual(suggestions?.items.map((item) => item.label), ["src/", "src.md"]);

  const directory = provider.applyCompletion(["look at @sr"], 0, 11, { value: "@src/", label: "src/" }, "@sr");
  assert.deepEqual(directory, { lines: ["look at @src/"], cursorLine: 0, cursorCol: 13 });
  const file = provider.applyCompletion(["look at @sr now"], 0, 11, { value: "@src.md", label: "src.md" }, "@sr");
  assert.deepEqual(file, { lines: ["look at @src.md  now"], cursorLine: 0, cursorCol: 16 });
});

test("commands complete; plain words do not ask the node", async () => {
  let asked = false;
  const provider = new RemoteAutocompleteProvider([{ name: "tree", description: "the tree" }], async () => {
    asked = true;
    return [];
  });
  const commands = await provider.getSuggestions(["/tr"], 0, 3, { signal });
  assert.ok(commands?.items.some((item) => item.value === "tree"));
  assert.equal(await provider.getSuggestions(["just words"], 0, 10, { signal }), null);
  assert.equal(asked, false);
  assert.equal(provider.shouldTriggerFileCompletion(["see @"], 0, 5), true);
  assert.equal(provider.shouldTriggerFileCompletion(["mail@x"], 0, 6), false);
});
