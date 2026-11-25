// The gallery draws every fixture (it fails only on a drawing error) and compares with an earlier
// gallery for review.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { exhibits, runGallery } from "./gallery.ts";

test("every fixture draws; a comparison lists what changed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gallery-"));
  const first = await runGallery({ dir });
  assert.equal(first.exhibits.length, exhibits().length);
  for (const name of first.exhibits) {
    assert.ok(existsSync(join(dir, `${name}.txt`)), name);
  }
  assert.ok(existsSync(first.index));

  writeFileSync(join(dir, "tabs-all-glyphs.txt"), "something else\n");
  const second = await runGallery({ dir: mkdtempSync(join(tmpdir(), "gallery-")), compare: dir, filter: "tabs" });
  assert.deepEqual(second.changed, ["tabs-all-glyphs"]);
});
