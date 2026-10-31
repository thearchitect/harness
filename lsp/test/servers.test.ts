/**
 * Integration tests against the real language servers of a bundle.
 *   HARNESS_MANIFEST=<bundle>/share/harness/manifest.json node --test lsp/test/servers.test.ts
 * (nix/lsp-test.sh runs them against a built bundle; go and cargo come from PATH.)
 *
 * Each language copies its fixture from lsp/testdata into a fresh git
 * repository and drives the facade as the tools do.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";
import { lspToolchain, type Manifest } from "../../deps.ts";
import type { LockPaths } from "../edits.ts";
import { Facade, type Place } from "../facade.ts";
import { readPlan, runRefactor, writePlan, type Operation } from "../refactor.ts";
import type { Toolchain } from "../profile.ts";
import { Workspace } from "../workspace.ts";

const execFileAsync = promisify(execFile);
const noLock: LockPaths = (_paths, fn) => fn();

const toolchain: Toolchain | undefined = await (async () => {
  const path = process.env.HARNESS_MANIFEST;
  if (path === undefined) {
    return undefined;
  } else {
    const resolved = lspToolchain(JSON.parse(await readFile(path, "utf8")) as Manifest);
    if ("problem" in resolved) {
      throw new Error(resolved.problem);
    } else {
      return resolved.toolchain;
    }
  }
})();
const skip = toolchain === undefined ? "HARNESS_MANIFEST is not set (nix/lsp-test.sh sets it)" : false;

async function fixture(name: string): Promise<{ root: string; facade: Facade; close: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), `harness-lsp-${name}-`));
  await cp(new URL(`../testdata/${name}`, import.meta.url), root, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  const workspace = await Workspace.open(root, toolchain!);
  return {
    root,
    facade: new Facade(workspace),
    close: async () => {
      await workspace.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const run = (facade: Facade, operations: readonly Operation[]) => runRefactor(facade, operations, { lock: noLock, signal: undefined, onProgress: () => {} });

const files = (places: readonly Place[]): string[] => [...new Set(places.map((place) => place.path))].sort();

/** Child processes of this test process (the language servers). */
async function children(): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-P", String(process.pid)]);
    return stdout.split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

describe("TypeScript", { skip }, () => {
  let env: Awaited<ReturnType<typeof fixture>>;
  before(async () => {
    env = await fixture("ts");
  });
  after(async () => {
    await env?.close();
  });

  test("references cross path aliases, solution configs and files outside every tsconfig", async () => {
    const places = await env.facade.references({ file: "packages/core/src/index.ts", line: 3, name: "greet" }, true);
    assert.deepEqual(files(places), ["packages/app/src/main.ts", "packages/core/src/index.ts", "packages/web/src/view.ts", "packages/web/ssr/render.ts"]);
  });

  test("JavaScript files go to the TypeScript server", async () => {
    const places = await env.facade.references({ file: "scripts/tool.mjs", line: 1, name: "toolMain" }, true);
    assert.deepEqual(files(places), ["scripts/run.mjs", "scripts/tool.mjs"]);
  });

  test("coverage lists projects, files outside them and missing references", async () => {
    const [ts] = await env.facade.summary();
    assert.equal(ts.language, "ts");
    assert.deepEqual((ts.facts as { projects: string[] }).projects, [
      "packages/app/tsconfig.json",
      "packages/core/tsconfig.json",
      "packages/web/tsconfig.app.json",
      "packages/web/tsconfig.json",
    ]);
    assert.deepEqual((ts.facts as { missingReferences: string[] }).missingReferences, ["packages/web/tsconfig.missing.json"]);
    assert.ok((ts.facts as { filesOutsideProjects: string[] }).filesOutsideProjects.includes("packages/web/ssr/render.ts"));
  });

  test("edits on disk and new files are seen by the next request", async () => {
    await appendFile(join(env.root, "packages/app/src/main.ts"), 'export const again = greet("again");\n');
    await writeFile(join(env.root, "packages/web/src/extra.ts"), 'import { greet } from "@core";\nexport const extra = greet("extra");\n');
    const places = await env.facade.references({ file: "packages/core/src/index.ts", line: 3, name: "greet" }, true);
    assert.ok(files(places).includes("packages/web/src/extra.ts"));
    assert.equal(places.filter((place) => place.path === "packages/app/src/main.ts").length, 3);
  });

  test("a plan runs in order, stops at a failure, and resumes from the cut plan", async () => {
    const plan = join(env.root, "..", `${basename(env.root)}-plan.json`);
    const operations: Operation[] = [
      { rename: { file: "packages/core/src/index.ts", line: 3, name: "greet", newName: "salute" } },
      { move: { from: "packages/core/src/util.ts", to: "packages/core/src/lib/util.ts" } },
      // addresses the state the move left
      { rename: { file: "packages/core/src/lib/util.ts", line: 1, name: "helper", newName: "assist" } },
      { edit: { file: "packages/web/src/view.ts", oldText: 'salute("web")', newText: 'salute("site")' } },
      // an unused import for the code action to remove
      { edit: { file: "packages/app/src/main.ts", oldText: 'import { salute } from "@core";', newText: 'import { salute } from "@core";\nimport { rendered } from "../../web/ssr/render";' } },
      { rename: { file: "packages/web/src/view.ts", line: 3, name: "missing", newName: "x" } },
      { codeAction: { file: "packages/app/src/main.ts", title: "Organize Imports" } },
    ];
    await writePlan(plan, operations);
    try {
      const first = await run(env.facade, await readPlan(plan));
      assert.equal(first.applied, 5);
      assert.equal(first.failure?.index, 5);
      assert.match(first.failure!.reason, /missing does not occur/);
      await writePlan(plan, operations.slice(first.failure!.index));

      const main = await readFile(join(env.root, "packages/app/src/main.ts"), "utf8");
      assert.match(main, /import \{ salute \} from "@core";\nimport \{ rendered \} from "\.\.\/\.\.\/web\/ssr\/render";\nimport \{ assist \} from "\.\.\/\.\.\/core\/src\/lib\/util";/);
      assert.match(await readFile(join(env.root, "packages/core/src/index.ts"), "utf8"), /export \{ assist \} from "\.\/lib\/util";/);
      assert.match(await readFile(join(env.root, "packages/web/src/view.ts"), "utf8"), /salute\("site"\)/);
      for (const path of ["packages/web/ssr/render.ts", "packages/web/src/extra.ts"]) {
        assert.match(await readFile(join(env.root, path), "utf8"), /salute\(/, path);
      }
      assert.deepEqual(first.net.moves.map((move) => basename(move.to)), ["util.ts"]);

      // fix the failed entry in place and run the same plan again
      const rest = await readPlan(plan);
      assert.equal(rest.length, 2);
      rest[0] = { rename: { file: "packages/web/src/view.ts", line: 3, name: "view", newName: "render" } };
      await writePlan(plan, rest);
      const second = await run(env.facade, await readPlan(plan));
      assert.equal(second.failure, undefined);
      assert.equal(second.applied, 2);
      assert.match(await readFile(join(env.root, "packages/web/src/view.ts"), "utf8"), /export function render\(\)/);
      // organize imports removed the unused import
      assert.match(await readFile(join(env.root, "packages/app/src/main.ts"), "utf8"), /^import \{ salute \} from "@core";\nimport \{ assist \} from "\.\.\/\.\.\/core\/src\/lib\/util";\n/);
    } finally {
      await rm(plan, { force: true });
    }
  });

  test("a change outside the repository is refused", async () => {
    await assert.rejects(run(env.facade, [{ edit: { file: "../outside.ts", oldText: "a", newText: "b" } }]).then((outcome) => {
      throw new Error(outcome.failure?.reason ?? "applied");
    }), /outside the workspace/);
  });

  test("a broken tsconfig is an error, not a partial answer", async () => {
    const config = join(env.root, "packages/web/tsconfig.json");
    const original = await readFile(config, "utf8");
    await writeFile(config, "{ broken");
    try {
      await assert.rejects(env.facade.references({ file: "packages/core/src/index.ts", line: 3, name: "salute" }, true), /tsconfig\.json/);
    } finally {
      await writeFile(config, original);
    }
    assert.ok((await env.facade.references({ file: "packages/core/src/index.ts", line: 3, name: "salute" }, true)).length > 0);
  });

  test("a killed server is restarted by the next request", async () => {
    const before = await children();
    assert.ok(before.length > 0);
    for (const pid of before) {
      process.kill(pid, "SIGKILL");
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok((await env.facade.references({ file: "packages/core/src/index.ts", line: 3, name: "salute" }, true)).length > 0);
  });

  test("closing the workspace leaves no server running", async () => {
    await env.facade.workspace.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(await children(), []);
  });
});

describe("Go", { skip }, () => {
  let env: Awaited<ReturnType<typeof fixture>>;
  before(async () => {
    // the fixture has no external dependencies: nothing may be downloaded
    process.env.GOPROXY = "off";
    env = await fixture("go");
  });
  after(async () => {
    await env?.close();
  });

  test("references cross modules outside go.work and files behind build tags", async () => {
    const places = await env.facade.references({ file: "lib/lib.go", line: 4, name: "Hello" }, true);
    assert.deepEqual(files(places), ["lib/lib.go", "svc/main.go", "svc/tagged.go"]);
  });

  test("coverage reports the duplicate module path and the tags", async () => {
    const go = (await env.facade.summary()).find((language) => language.language === "go")!;
    const facts = go.facts as { modules: { path: string; dir: string }[]; excluded: { dir: string }[]; buildTags: string[] };
    assert.deepEqual(facts.modules.map((module) => module.dir).sort(), ["lib", "svc"]);
    assert.deepEqual(facts.excluded.map((entry) => entry.dir), ["dup"]);
    assert.deepEqual(facts.buildTags, ["integration"]);
  });

  test("rename crosses modules", async () => {
    const outcome = await run(env.facade, [{ rename: { file: "lib/lib.go", line: 4, name: "Hello", newName: "Greet" } }]);
    assert.equal(outcome.failure, undefined);
    assert.deepEqual(outcome.warnings, []);
    assert.match(await readFile(join(env.root, "svc/main.go"), "utf8"), /lib\.Greet\(\)/);
    assert.match(await readFile(join(env.root, "svc/tagged.go"), "utf8"), /lib\.Greet\(\)/);
  });

  test("renaming a generated symbol warns to change its source", async () => {
    const outcome = await run(env.facade, [{ rename: { file: "svc/main.go", line: 6, name: "Generated", newName: "Produced" } }]);
    assert.equal(outcome.failure, undefined);
    assert.equal(outcome.warnings.length, 1);
    assert.match(outcome.warnings[0], /lib\/gen\.go, which looks generated \(its header says "\/\/ Code generated by the fixture\. DO NOT EDIT\."\)/);
  });

  test("files move within their package only", async () => {
    assert.equal((await run(env.facade, [{ move: { from: "svc/tagged.go", to: "svc/tagged_integration.go" } }])).failure, undefined);
    const across = await run(env.facade, [{ move: { from: "svc/main.go", to: "lib/main.go" } }]);
    assert.match(across.failure?.reason ?? "", /only within their directory/);
  });
});

describe("Rust", { skip }, () => {
  let env: Awaited<ReturnType<typeof fixture>>;
  before(async () => {
    env = await fixture("rust");
  });
  after(async () => {
    await env?.close();
  });

  test("references cross crates of a workspace and feature-gated code", async () => {
    const places = await env.facade.references({ file: "ws/core/src/lib.rs", line: 3, name: "compute" }, true);
    assert.deepEqual(files(places), ["ws/app/src/main.rs", "ws/core/src/lib.rs"]);
    assert.ok(places.some((place) => place.text.includes("compute(1)")), "the feature-gated call");
  });

  test("a nested Cargo workspace is linked", async () => {
    const places = await env.facade.references({ file: "tools/cli/src/main.rs", line: 2, name: "banner" }, true);
    assert.equal(places.length, 2);
  });

  test("moving a module file updates its mod declaration", async () => {
    assert.equal((await run(env.facade, [{ move: { from: "ws/core/src/util.rs", to: "ws/core/src/helpers.rs" } }])).failure, undefined);
    const lib = await readFile(join(env.root, "ws/core/src/lib.rs"), "utf8");
    assert.match(lib, /mod helpers;/);
    assert.match(lib, /helpers::double/);
  });
});
