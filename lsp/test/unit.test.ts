/**
 * Unit tests of the facade's language-independent parts (no servers).
 *   node --test lsp/test/unit.test.ts
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { addMoves, applyTextEdits, commitChanges, planEdit, unifiedDiff, type LockPaths } from "../edits.ts";
import { identifierColumns } from "../facade.ts";
import { parseJsonc } from "../jsonc.ts";
import { compareGoVersions, parseBuildTags } from "../profiles/go.ts";
import { diffSnapshots, stampFiles } from "../snapshot.ts";

const noLock: LockPaths = (_paths, fn) => fn();

describe("parseJsonc", () => {
  test("comments and trailing commas outside strings", () => {
    const text = `{
      // line comment
      "a": "x // not a comment", /* block */
      "b": [1, 2,],
      "c": { "d": "/* kept */", },
    }`;
    assert.deepEqual(parseJsonc(text), { a: "x // not a comment", b: [1, 2], c: { d: "/* kept */" } });
  });
  test("escaped quotes", () => {
    assert.deepEqual(parseJsonc(`{"a": "say \\"hi\\" // still string"}`), { a: 'say "hi" // still string' });
  });
});

describe("identifierColumns", () => {
  test("whole identifiers only", () => {
    assert.deepEqual(identifierColumns("const greet = greeting(greet);", "greet"), [6, 23]);
    assert.deepEqual(identifierColumns("$greet greet_x greet", "greet"), [15]);
  });
  test("UTF-16 columns", () => {
    // the emoji is two UTF-16 code units
    assert.deepEqual(identifierColumns('"😀" + name', "name"), [7]);
  });
});

describe("applyTextEdits", () => {
  test("UTF-16 positions, CRLF lines, insertion order", () => {
    const text = 'a 😀 b\r\nsecond line\r\n';
    const result = applyTextEdits("x", text, [
      { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } }, newText: "2nd" },
      { range: { start: { line: 0, character: 5 }, end: { line: 0, character: 6 } }, newText: "B" },
    ]);
    assert.equal(result, "a 😀 B\r\n2nd line\r\n");
  });
  test("overlapping edits are refused", () => {
    assert.throws(() =>
      applyTextEdits("x", "abcdef", [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "" },
        { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 4 } }, newText: "" },
      ]),
    );
  });
});

describe("unifiedDiff", () => {
  test("hunks with one line of context", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g"].join("\n");
    const after = ["a", "B", "c", "d", "e", "f", "G"].join("\n");
    assert.equal(unifiedDiff({ path: "p", before, after, mode: undefined }, "p"), ["--- p", "@@ -1,3 +1,3 @@", " a", "-b", "+B", " c", "@@ -6,2 +6,2 @@", " f", "-g", "+G"].join("\n"));
  });
});

describe("planEdit / commitChanges", () => {
  test("text edits and a rename replayed in order, committed atomically", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harness-lsp-unit-"));
    try {
      const a = join(dir, "a.ts");
      const b = join(dir, "b.ts");
      const c = join(dir, "sub", "c.ts");
      await writeFile(a, "import { x } from './b';\nx();\n");
      await writeFile(b, "export const x = () => 1;\n");
      const basis = await stampFiles([a, b]);
      const set = await planEdit(
        {
          documentChanges: [
            { textDocument: { uri: pathToFileURL(a).href, version: null }, edits: [{ range: { start: { line: 0, character: 19 }, end: { line: 0, character: 22 } }, newText: "./sub/c" }] },
            { kind: "rename", oldUri: pathToFileURL(b).href, newUri: pathToFileURL(c).href },
          ],
        },
        basis,
      );
      assert.deepEqual(set.moves, [{ from: b, to: c }]);
      await commitChanges(set, noLock);
      assert.equal(await readFile(a, "utf8"), "import { x } from './sub/c';\nx();\n");
      assert.equal(await readFile(c, "utf8"), "export const x = () => 1;\n");
      await assert.rejects(readFile(b, "utf8"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a file changed after planning is not overwritten", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harness-lsp-unit-"));
    try {
      const a = join(dir, "a.ts");
      await writeFile(a, "one\n");
      const set = await planEdit({ changes: { [pathToFileURL(a).href]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "two" }] } }, new Map());
      await writeFile(a, "changed meanwhile\n");
      await assert.rejects(commitChanges(set, noLock), /changed while the edit was under review/);
      assert.equal(await readFile(a, "utf8"), "changed meanwhile\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a file changed after the server's snapshot is refused while planning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harness-lsp-unit-"));
    try {
      const a = join(dir, "a.ts");
      await writeFile(a, "one\n");
      const basis = await stampFiles([a]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await writeFile(a, "one!\n");
      await assert.rejects(planEdit({ changes: { [pathToFileURL(a).href]: [] } }, basis), /changed after the language server computed the edit/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("moves refuse to overwrite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harness-lsp-unit-"));
    try {
      const a = join(dir, "a.go");
      const b = join(dir, "b.go");
      await writeFile(a, "package x\n");
      await writeFile(b, "package x\n");
      await assert.rejects(addMoves(await planEdit({}, new Map()), [{ from: a, to: b }]), /already exists/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("snapshots", () => {
  test("created, changed, deleted", () => {
    const before = new Map([
      ["/a", { mtimeNs: 1n, size: 1 }],
      ["/b", { mtimeNs: 1n, size: 1 }],
    ]);
    const after = new Map([
      ["/b", { mtimeNs: 2n, size: 1 }],
      ["/c", { mtimeNs: 1n, size: 1 }],
    ]);
    assert.deepEqual(diffSnapshots(before, after), { created: ["/c"], changed: ["/b"], deleted: ["/a"] });
  });
});

describe("go", () => {
  test("user-defined build tags", () => {
    assert.deepEqual(parseBuildTags("// Copyright\n\n//go:build (integration || stand) && linux && !go1.22 && amd64\n\npackage x\n//go:build later"), ["integration", "stand"]);
  });
  test("version order", () => {
    assert.ok(compareGoVersions("1.26.5", "1.26") > 0);
    assert.ok(compareGoVersions("1.9", "1.22") < 0);
    assert.equal(compareGoVersions("1.22.0", "1.22"), 0);
  });
});
