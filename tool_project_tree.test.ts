/**
 * Tests of project_tree's listing (no pi session).
 *   node --test tool_project_tree.test.ts
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";
import { projectTree, renderProjectTree } from "./tool_project_tree.ts";

const execFileAsync = promisify(execFile);

let scratch: string;
let counter = 0;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "project-tree-test-"));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** A fresh project directory with the given files (a trailing / makes a directory). */
async function project(files: Record<string, string>): Promise<string> {
  const root = join(scratch, `p${counter++}`);
  await mkdir(root);
  for (const [path, content] of Object.entries(files)) {
    if (path.endsWith("/")) {
      await mkdir(join(root, path), { recursive: true });
    } else {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
  }
  return root;
}

async function gitInit(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "--quiet", dir]);
}

describe("projectTree", () => {
  test("the directory tree sorted by bytes: the root first with its files, file counts, descriptions from .dirinfo.md", async () => {
    const root = await project({
      ".dirinfo.md": "The project\nmore text",
      "setup.cfg": "",
      "b/.dirinfo.md": "Second\r\nmore",
      "b/x": "",
      "b/y": "",
      "a-b/": "",
      "a/c/": "",
      "a/empty-info/.dirinfo.md": "",
      ".hidden/": "",
      ".git/config": "",
      ".agent-workspace-tmp/x/": "",
      "a/file.ts": "",
    });
    assert.deepEqual(await projectTree(root, undefined, { files: false }), [
      "./ - The project",
      ".hidden/",
      "a-b/",
      "a/ (1 file)",
      "a/c/",
      "a/empty-info/",
      "b/ (2 files) - Second",
      "setup.cfg",
    ]);
  });

  test("files on request, without .dirinfo.md; paths start with path as given", async () => {
    const root = await project({ "src/.dirinfo.md": "Sources", "src/main.ts": "", "src/lib/util.ts": "", "README.md": "" });
    assert.deepEqual(await projectTree(root, `${root}/`, { files: true }), [
      `${root}/`,
      `${root}/README.md`,
      `${root}/src/ - Sources`,
      `${root}/src/lib/`,
      `${root}/src/lib/util.ts`,
      `${root}/src/main.ts`,
    ]);
  });

  test("a directory listed explicitly although the rules above ignore it is listed under its own rule files", async () => {
    const root = await project({
      ".gitignore": "node_modules\n*.log\n",
      "node_modules/pkg/.gitignore": "dist/\n",
      "node_modules/pkg/dist/x.js": "",
      "node_modules/pkg/a.log": "",
      "node_modules/pkg/index.js": "",
    });
    await gitInit(root);
    assert.deepEqual(await projectTree(join(root, "node_modules/pkg"), "node_modules/pkg", { files: true }), [
      "node_modules/pkg/",
      "node_modules/pkg/.gitignore",
      "node_modules/pkg/a.log",
      "node_modules/pkg/index.js",
    ]);
  });

  test("nested .gitignore files with negation; .ignore takes precedence over .gitignore", async () => {
    const root = await project({
      ".gitignore": "build/\n*.log\ndist/\n",
      ".ignore": "!dist/\n!dist/**\n!build/\nsecret/\n",
      "build/out.js": "",
      "dist/app.js": "",
      "secret/key": "",
      "src/a.log": "",
      "src/keep.log": "",
      "src/.gitignore": "!keep.log\n",
      "src/main.ts": "",
    });
    await gitInit(root);
    assert.deepEqual(await projectTree(root, undefined, { files: true }), [
      "./",
      ".gitignore",
      ".ignore",
      // re-included alone: its contents stay ignored by .gitignore's build/
      "build/",
      "dist/",
      "dist/app.js",
      "src/",
      "src/.gitignore",
      "src/keep.log",
      "src/main.ts",
    ]);
  });

  test("outside git, .gitignore has no effect and .ignore does", async () => {
    const root = await project({ ".gitignore": "a/\n", ".ignore": "b/\n", "a/": "", "b/": "" });
    assert.deepEqual(await projectTree(root, undefined, { files: false }), ["./", ".gitignore", ".ignore", "a/"]);
  });

  test("a subtree obeys the rule files above it up to the repository root", async () => {
    const root = await project({ ".gitignore": "*.log\n", "src/app/x.log": "", "src/app/x.ts": "" });
    await gitInit(root);
    assert.deepEqual(await projectTree(join(root, "src"), "src", { files: true }), ["src/", "src/app/", "src/app/x.ts"]);
  });

  test("info/exclude applies; a nested repository starts its own git rules", async () => {
    const root = await project({ ".gitignore": "gen/\n", "gen/": "", "excluded/": "", "sub/gen/": "", "sub/.ignore": "", "sub/other/": "" });
    await gitInit(root);
    await writeFile(join(root, ".git", "info", "exclude"), "excluded/\n");
    await gitInit(join(root, "sub"));
    await writeFile(join(root, "sub", ".git", "info", "exclude"), "other/\n");
    assert.deepEqual(await projectTree(root, undefined, { files: false }), ["./", ".gitignore", "sub/ (1 file)", "sub/gen/"]);
  });

  test("symlinks are not listed", async () => {
    const root = await project({ "real/f.txt": "" });
    await symlink(join(root, "real"), join(root, "link"));
    await symlink(join(root, "real", "f.txt"), join(root, "flink"));
    assert.deepEqual(await projectTree(root, undefined, { files: true }), ["./", "real/", "real/f.txt"]);
  });

  test("an unreadable directory is marked, not skipped", { skip: process.getuid?.() === 0 }, async () => {
    const root = await project({ "locked/inside/": "", "open/": "" });
    await chmod(join(root, "locked"), 0o000);
    try {
      const lines = await projectTree(root, undefined, { files: false });
      assert.equal(lines.length, 3);
      assert.equal(lines[0], "./");
      assert.match(lines[1]!, /^locked\/ \(unreadable: .*EACCES.*\)$/);
      assert.equal(lines[2], "open/");
    } finally {
      await chmod(join(root, "locked"), 0o755);
    }
  });

  test("a path that is not a directory is an error", async () => {
    const root = await project({ "f.txt": "" });
    await assert.rejects(projectTree(join(root, "f.txt"), "f.txt", { files: false }), /is not a directory/);
    await assert.rejects(projectTree(join(root, "missing"), "missing", { files: false }), /ENOENT/);
  });
});

describe("renderProjectTree", () => {
  test("short listings pass unchanged", () => {
    assert.equal(renderProjectTree(["./", "a/"]), "./\na/");
  });

  test("long listings are cut with a notice", () => {
    const lines = Array.from({ length: 3000 }, (_, index) => `dir${index}/`);
    const text = renderProjectTree(lines);
    assert.match(text, /\n\n\[Truncated: 2000 of 3000 lines shown; list the remaining directories' files with path and files: true\]$/);
  });
});
