/**
 * Tests of the defaults of new sessions (settings.ts): the harness.json
 * contract, its failure modes and the partial update.
 *   node --test settings.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { BUILTIN_DEFAULTS, DEFAULTS_FILE, loadDefaults, saveDefault } from "./settings.ts";

describe("defaults of new sessions", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harness-settings-"));
    path = join(dir, DEFAULTS_FILE);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("nothing saved yet: advanced, no madness, implemented by the session itself, no problem", () => {
    assert.deepEqual(loadDefaults(path), { defaults: { variant: "advanced", madness: false, implementer: "self" } });
  });

  test("saved values are read back; a missing one takes its built-in default", () => {
    writeFileSync(path, JSON.stringify({ variant: "simple", madness: true, implementer: "builder" }));
    assert.deepEqual(loadDefaults(path), { defaults: { variant: "simple", madness: true, implementer: "builder" } });
    writeFileSync(path, JSON.stringify({ variant: "simple" }));
    assert.deepEqual(loadDefaults(path), { defaults: { variant: "simple", madness: false, implementer: "self" } });
  });

  for (const [name, content, problem] of [
    ["broken JSON", "{ variant", /JSON/],
    ["not an object", "[]", /not a JSON object/],
    ["unknown variant", JSON.stringify({ variant: "plan" }), /variant must be/],
    ["madness not a boolean", JSON.stringify({ madness: "yes" }), /madness must be/],
    ["implementer not a name", JSON.stringify({ implementer: "" }), /implementer must be/],
  ] as const) {
    test(`${name}: built-in defaults and the problem`, () => {
      writeFileSync(path, content);
      const result = loadDefaults(path);
      assert.deepEqual(result.defaults, BUILTIN_DEFAULTS);
      assert.match(result.problem ?? "", problem);
    });
  }

  test("saving one default keeps the others and leaves no temporary file", () => {
    saveDefault(path, "madness", true);
    saveDefault(path, "variant", "simple");
    saveDefault(path, "madness", false);
    saveDefault(path, "implementer", "builder");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { variant: "simple", madness: false, implementer: "builder" });
    assert.deepEqual(readdirSync(dir), [DEFAULTS_FILE]);
  });

  test("an unwritable place throws", () => {
    assert.throws(() => saveDefault(join(dir, "missing", DEFAULTS_FILE), "madness", true));
  });
});
