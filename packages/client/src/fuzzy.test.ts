// The client's fuzzy matching is pi-tui's: the same order and scores on the same inputs.

import assert from "node:assert/strict";
import { test } from "node:test";
import { fuzzyFilter as piFilter, fuzzyMatch as piMatch } from "@earendil-works/pi-tui";
import { fuzzyFilter, fuzzyMatch } from "./fuzzy.ts";

const ITEMS = ["harness", "dotfiles/.pi/harness", "projects/themakers/crea", "crea", "contrib", "scratch", "openrouter openrouter/anthropic/claude-opus", "gpt5", "5gpt", "Harness-Site"];
const QUERIES = ["", "har", "hrn", "cr", "crea", "opus", "gpt5", "5gpt", "h s", "dot/har", "xyz", "HAR"];

test("the same matches, scores and order as pi-tui's", () => {
  for (const query of QUERIES) {
    assert.deepEqual(fuzzyFilter(ITEMS, query, (item) => item), piFilter(ITEMS, query, (item) => item), `filter ${JSON.stringify(query)}`);
    for (const item of ITEMS) {
      assert.deepEqual(fuzzyMatch(query, item), piMatch(query, item), `match ${JSON.stringify(query)} in ${item}`);
    }
  }
});
