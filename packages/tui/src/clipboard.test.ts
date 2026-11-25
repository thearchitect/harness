// Ctrl+V on a fake clipboard: copied files paste their paths (uploaded first for a session on
// another machine), an image the path of its file, text as text; pi's spacing around paths.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

const LOCAL: PasteTarget = { local: true };

function remote(): { target: PasteTarget; uploads: { name: string; data: string }[] } {
  const uploads: { name: string; data: string }[] = [];
  return {
    uploads,
    target: {
      local: false,
      upload: async (name, base64) => {
        uploads.push({ name, data: Buffer.from(base64, "base64").toString() });
        return `/node/uploads/${name}`;
      },
    },
  };
}

test("copied files paste their paths: as they are here, uploaded for another machine, quoted in a shell command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clip-"));
  const a = join(dir, "a b.txt");
  writeFileSync(a, "A");
  assert.deepEqual(await clipboardInsert(clipboard({ files: [a, "/x/y"] }), LOCAL, false), { text: `${a}\n/x/y`, paths: true });
  assert.deepEqual(await clipboardInsert(clipboard({ files: [a] }), LOCAL, true), { text: `'${a}'`, paths: true });

  const { target, uploads } = remote();
  assert.deepEqual(await clipboardInsert(clipboard({ files: [a] }), target, false), { text: "/node/uploads/a b.txt", paths: true });
  assert.deepEqual(uploads, [{ name: "a b.txt", data: "A" }]);
  await assert.rejects(clipboardInsert(clipboard({ files: ["/x\ny"] }), LOCAL, false), /control characters/);
});

test("an image pastes the path of its file: a temp file here, an upload for another machine", async () => {
  const image = new Uint8Array([137, 80, 78, 71]);
  const local = await clipboardInsert(clipboard({ image, text: "ignored" }), LOCAL, false);
  assert.match(local?.text ?? "", /pi-clipboard-.*\.png$/);
  assert.deepEqual([...readFileSync(local?.text ?? "")], [...image]);

  const { target, uploads } = remote();
  const uploaded = await clipboardInsert(clipboard({ image }), target, false);
  assert.match(uploaded?.text ?? "", /^\/node\/uploads\/pi-clipboard-.*\.png$/);
  assert.equal(uploads.length, 1);
});

test("text pastes as text; an empty clipboard pastes nothing; paths get pi's spaces", async () => {
  assert.deepEqual(await clipboardInsert(clipboard({ text: "hello" }), LOCAL, false), { text: "hello", paths: false });
  assert.equal(await clipboardInsert(clipboard({}), LOCAL, false), undefined);
  assert.equal(spaced("/p", "x", "y"), " /p ");
  assert.equal(spaced("/p", " ", ""), "/p");
});
