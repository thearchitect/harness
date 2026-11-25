import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { DISPLAY_FILE_MAX_BYTES, DISPLAY_MAX_LINES, prepareDisplay } from "./display_file.ts";

/** A 3×2 red JPEG. */
const JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAMDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ADoDFU3/2Q==";

describe("display_file", () => {
  const dir = mkdtempSync(join(tmpdir(), "display-file-test-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const numbered = (count: number): string => Array.from({ length: count }, (_, i) => `line-${i + 1}`).join("\n") + "\n";

  test("a text file: the operator gets its lines, the model only what was shown", async () => {
    writeFileSync(join(dir, "notes.md"), "# Title\nsecret-sauce\n");
    writeFileSync(join(dir, "main.ts"), numbered(10));

    const whole = await prepareDisplay(dir, "notes.md");
    assert.deepEqual(whole.details, {
      kind: "text", path: "notes.md", text: "# Title\nsecret-sauce", language: "markdown", markdown: true, firstLine: 1, lastLine: 2, totalLines: 2,
    });
    assert.equal(whole.summary, "Displayed to the operator: notes.md, lines 1-2 of 2.");

    const slice = await prepareDisplay(dir, "main.ts", 4, 3);
    assert.deepEqual(slice.details, {
      kind: "text", path: "main.ts", text: "line-4\nline-5\nline-6", language: "typescript", markdown: false, firstLine: 4, lastLine: 6, totalLines: 10,
    });
    assert.equal(slice.summary, "Displayed to the operator: main.ts, lines 4-6 of 10.");
  });

  test("a text file longer than one display: the rest is offered from the next line", async () => {
    writeFileSync(join(dir, "long.txt"), numbered(DISPLAY_MAX_LINES + 5));
    const display = await prepareDisplay(dir, "long.txt");
    assert.equal(display.details.kind === "text" && display.details.lastLine, DISPLAY_MAX_LINES);
    assert.equal(
      display.summary,
      `Displayed to the operator: long.txt, lines 1-${DISPLAY_MAX_LINES} of ${DISPLAY_MAX_LINES + 5}. That is the display limit: call display_file with offset ${DISPLAY_MAX_LINES + 1} to show more.`,
    );
  });

  test("an empty file is shown as empty", async () => {
    writeFileSync(join(dir, "empty.txt"), "");
    const display = await prepareDisplay(dir, "empty.txt");
    assert.deepEqual(display.details, { kind: "text", path: "empty.txt", text: "", language: undefined, markdown: false, firstLine: 0, lastLine: 0, totalLines: 0 });
    assert.equal(display.summary, "Displayed to the operator: empty.txt (empty file).");
  });

  test("an image is stored as PNG for the terminal; the model gets its size", async () => {
    writeFileSync(join(dir, "photo.jpg"), Buffer.from(JPEG, "base64"));
    const display = await prepareDisplay(dir, "photo.jpg");
    assert.equal(display.details.kind, "image");
    if (display.details.kind === "image") {
      assert.equal(display.details.mimeType, "image/png");
      assert.deepEqual(Buffer.from(display.details.data, "base64").subarray(1, 4).toString(), "PNG");
      assert.deepEqual([display.details.width, display.details.height], [3, 2]);
    } else {
      // asserted above
    }
    assert.equal(display.summary, "Displayed to the operator: photo.jpg (image 3×2).");
  });

  test("what cannot be shown says why", async () => {
    writeFileSync(join(dir, "blob.bin"), Buffer.from([0x41, 0x00, 0x42]));
    writeFileSync(join(dir, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    writeFileSync(join(dir, "short.txt"), numbered(3));
    writeFileSync(join(dir, "huge.txt"), "");
    truncateSync(join(dir, "huge.txt"), DISPLAY_FILE_MAX_BYTES + 1);
    writeFileSync(join(dir, "pic.jpg"), Buffer.from(JPEG, "base64"));
    mkdirSync(join(dir, "folder"));

    await assert.rejects(prepareDisplay(dir, "missing.txt"), /missing\.txt does not exist/);
    await assert.rejects(prepareDisplay(dir, "folder"), /folder is a directory/);
    await assert.rejects(prepareDisplay(dir, "huge.txt"), /display_file reads at most 32 MB/);
    await assert.rejects(prepareDisplay(dir, "blob.bin"), /is neither text \(UTF-8\) nor an image/);
    await assert.rejects(prepareDisplay(dir, "latin1.txt"), /is neither text \(UTF-8\) nor an image/);
    await assert.rejects(prepareDisplay(dir, "short.txt", 4), /offset 4 is beyond the end of short\.txt \(3 lines\)/);
    await assert.rejects(prepareDisplay(dir, "short.txt", 0), /offset must be a whole number from 1/);
    await assert.rejects(prepareDisplay(dir, "short.txt", 1, 1.5), /limit must be a whole number from 1/);
    await assert.rejects(prepareDisplay(dir, "pic.jpg", 1), /offset and limit apply to text files/);
  });
});
