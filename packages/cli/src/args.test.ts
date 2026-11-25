import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sessionDirectory } from "./args.ts";

test("harness [dir]: the current directory, a relative or absolute one; not a file, not two", () => {
  const base = mkdtempSync(join(tmpdir(), "args-"));
  writeFileSync(join(base, "file"), "");
  assert.equal(sessionDirectory([], base), base);
  assert.equal(sessionDirectory(["."], base), base);
  assert.equal(sessionDirectory([".."], join(base, "x")), base);
  assert.equal(sessionDirectory([base], "/"), base);
  assert.throws(() => sessionDirectory(["file"], base), /file is not a directory/);
  assert.throws(() => sessionDirectory(["missing"], base), /missing is not a directory/);
  assert.throws(() => sessionDirectory(["a", "b"], base), /one directory at most/);
});
