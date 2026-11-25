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

  test("nothing saved yet: advanced, no madness, no problem", () => {
    assert.deepEqual(loadDefaults(path), { defaults: { variant: "advanced", madness: false } });
  });

  test("saved values are read back; a missing one takes its built-in default; an implementer left by an earlier harness is not read", () => {
    writeFileSync(path, JSON.stringify({ variant: "simple", madness: true, implementer: "builder" }));
    assert.deepEqual(loadDefaults(path), { defaults: { variant: "simple", madness: true } });
    writeFileSync(path, JSON.stringify({ variant: "simple" }));
    assert.deepEqual(loadDefaults(path), { defaults: { variant: "simple", madness: false } });
  });

  for (const [name, content, problem] of [
    ["broken JSON", "{ variant", /JSON/],
    ["not an object", "[]", /not a JSON object/],
    ["unknown variant", JSON.stringify({ variant: "plan" }), /variant must be/],
    ["madness not a boolean", JSON.stringify({ madness: "yes" }), /madness must be/],
  ] as const) {
    test(`${name}: built-in defaults and the problem`, () => {
      writeFileSync(path, content);
      const result = loadDefaults(path);
      assert.deepEqual(result.defaults, BUILTIN_DEFAULTS);
      assert.match(result.problem ?? "", problem);
    });
  }

  test("saving one default keeps the others, drops an earlier harness's implementer, leaves no temporary or lock file", () => {
    writeFileSync(path, JSON.stringify({ implementer: "builder" }));
    saveDefault(path, "madness", true);
    saveDefault(path, "variant", "simple");
    saveDefault(path, "madness", false);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { variant: "simple", madness: false });
    assert.deepEqual(readdirSync(dir), [DEFAULTS_FILE]);
  });

  test("an unwritable place throws", () => {
    assert.throws(() => saveDefault(join(dir, "missing", DEFAULTS_FILE), "madness", true));
  });
});
