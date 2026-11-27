// Ctrl+V on a fake clipboard: copied files paste their paths (uploaded first for a session on
// another machine), an image the path of its attachment on the hub (never a temp file), text as
// text; pi's spacing around paths.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clipboardInsert, spaced, type Clipboard, type PasteTarget } from "./clipboard.ts";

function clipboard(content: { files?: string[]; image?: Uint8Array; text?: string }): Clipboard {
  return {
    filePaths: async () => content.files ?? null,
    image: async () => (content.image !== undefined ? { bytes: content.image, mimeType: "image/png" } : null),
    text: async () => content.text ?? null,
    extensionOf: (mimeType) => (mimeType === "image/png" ? "png" : undefined),
  };
}

function target(local: boolean): { target: PasteTarget; uploads: { name: string; data: string }[] } {
  const uploads: { name: string; data: string }[] = [];
  return {
    uploads,
    target: {
      local,
      upload: async (name, base64) => {
        uploads.push({ name, data: Buffer.from(base64, "base64").toString() });
        return `/hub/attachments/s/${name}`;
      },
    },
  };
}

test("copied files paste their paths: as they are here, uploaded for another machine, quoted in a shell command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clip-"));
  const a = join(dir, "a b.txt");
  writeFileSync(a, "A");
  const here = target(true);
  assert.deepEqual(await clipboardInsert(clipboard({ files: [a, "/x/y"] }), here.target, false), { text: `${a}\n/x/y`, paths: true });
  assert.deepEqual(await clipboardInsert(clipboard({ files: [a] }), here.target, true), { text: `'${a}'`, paths: true });
  assert.equal(here.uploads.length, 0);

  const there = target(false);
  assert.deepEqual(await clipboardInsert(clipboard({ files: [a] }), there.target, false), { text: "/hub/attachments/s/a b.txt", paths: true });
  assert.deepEqual(there.uploads, [{ name: "a b.txt", data: "A" }]);
  await assert.rejects(clipboardInsert(clipboard({ files: ["/x\ny"] }), here.target, false), /control characters/);
});

test("an image pastes the path of its attachment on the hub, here as for another machine", async () => {
  const image = new Uint8Array([137, 80, 78, 71]);
  for (const local of [true, false]) {
    const { target: to, uploads } = target(local);
    const pasted = await clipboardInsert(clipboard({ image, text: "ignored" }), to, false);
    assert.match(pasted?.text ?? "", /^\/hub\/attachments\/s\/pi-clipboard-.*\.png$/);
    assert.equal(uploads.length, 1);
  }
});

test("text pastes as text; an empty clipboard pastes nothing; paths get pi's spaces", async () => {
  const { target: here } = target(true);
  assert.deepEqual(await clipboardInsert(clipboard({ text: "hello" }), here, false), { text: "hello", paths: false });
  assert.equal(await clipboardInsert(clipboard({}), here, false), undefined);
  assert.equal(spaced("/p", "x", "y"), " /p ");
  assert.equal(spaced("/p", " ", ""), "/p");
});
