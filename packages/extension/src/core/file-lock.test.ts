// The lock file around a read-change-write: two processes changing one file lose none of each
// other's changes; a lock left by a process that is gone is taken over.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { withFileLock } from "./file-lock.ts";

const run = promisify(execFile);
const MODULE = fileURLToPath(new URL("./file-lock.ts", import.meta.url));

test("two processes counting in one file under the lock lose no count", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lock-"));
  const file = join(dir, "count");
  writeFileSync(file, "0");
  const script = `
    import { readFileSync, writeFileSync } from "node:fs";
    import { withFileLock } from ${JSON.stringify(MODULE)};
    for (let i = 0; i < 200; i += 1) {
      withFileLock(${JSON.stringify(`${file}.lock`)}, () => {
        const n = Number(readFileSync(${JSON.stringify(file)}, "utf8"));
        writeFileSync(${JSON.stringify(file)}, String(n + 1));
      });
    }`;
  await Promise.all([1, 2].map(() => run(process.execPath, ["--input-type=module", "-e", script])));
  assert.equal(readFileSync(file, "utf8"), "400");
});

test("a lock of a process that is gone is taken over", () => {
  const dir = mkdtempSync(join(tmpdir(), "lock-"));
  writeFileSync(join(dir, "f.lock"), "2147483646");
  assert.equal(
    withFileLock(join(dir, "f.lock"), () => "changed"),
    "changed",
  );
});
