import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { checkFile, SEND_LIMIT } from "./tool_send_file.ts";

describe("send_file", () => {
  test("a file: its real path, name, size and comment; anything else: why it cannot be sent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "send-file-test-"));
    writeFileSync(join(dir, "report.txt"), "hello");
    symlinkSync(join(dir, "report.txt"), join(dir, "link.txt"));
    mkdirSync(join(dir, "folder"));
    writeFileSync(join(dir, "huge.bin"), "");
    truncateSync(join(dir, "huge.bin"), SEND_LIMIT + 1);

    assert.deepEqual(await checkFile(dir, "link.txt", " the report "), { path: join(dir, "report.txt"), name: "report.txt", size: 5, comment: "the report" });
    await assert.rejects(checkFile(dir, "report.txt", " "), /comment is required/);
    await assert.rejects(checkFile(dir, "folder", "x"), /is a directory: zip it first \(zip -r \/tmp\/folder\.zip folder\)/);
    await assert.rejects(checkFile(dir, "missing", "x"), /missing does not exist/);
    await assert.rejects(checkFile(dir, "huge.bin", "x"), /50\.0 MB: Telegram takes at most 50 MB/);
    rmSync(dir, { recursive: true, force: true });
  });
});
