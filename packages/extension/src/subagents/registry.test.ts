import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_SUBAGENT_DEPTH } from "#protocol/state.ts";
import { BUNDLED_DIR, loadRegistry, toolAllowed } from "./registry.ts";

function profile(root: string, name: string, frontmatter: string, role = "Do the thing.", skill = true): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SUBAGENT.md"), `---\nname: ${name}\n${frontmatter}\n---\n${role}\n`);
  if (skill) {
    writeFileSync(join(dir, "SKILL.md"), `---\nname: subagent-${name}\ndescription: Only on the operator's explicit request — ${name}\n---\nBrief it.\n`);
  } else {
    // a profile without its briefing
  }
}

function sources(): { cwd: string; dataDir: string; project: string; user: string; bundle: string } {
  const root = mkdtempSync(join(tmpdir(), "registry-"));
  const cwd = join(root, "project");
  const dataDir = join(root, "home");
  return { cwd, dataDir, project: join(cwd, ".harness", "subagents"), user: join(dataDir, "subagents"), bundle: join(root, "bundle") };
}

test("sources: the project (trusted only) beats the user, the user beats the bundle", () => {
  const paths = sources();
  profile(paths.bundle, "alpha", "description: from the bundle\nengine: harness");
  profile(paths.user, "alpha", "description: from the user\nengine: harness");
  profile(paths.project, "alpha", "description: from the project\nengine: harness");
  profile(paths.bundle, "beta", "description: only bundled\nengine: claude");

  const trusted = loadRegistry({ cwd: paths.cwd, dataDir: paths.dataDir, projectTrusted: true, bundledDir: paths.bundle });
  assert.equal(trusted.profiles.get("alpha")?.source, "project");
  assert.equal(trusted.profiles.get("beta")?.source, "bundle");
  const untrusted = loadRegistry({ cwd: paths.cwd, dataDir: paths.dataDir, projectTrusted: false, bundledDir: paths.bundle });
  assert.equal(untrusted.profiles.get("alpha")?.source, "user");
  assert.deepEqual(trusted.problems, []);
});

test("a broken profile is left out with its reason", () => {
  const paths = sources();
  profile(paths.user, "noengine", "description: x");
  profile(paths.user, "badmode", "description: x\nengine: harness\nmode: wild");
  profile(paths.user, "badeffort", "description: x\nengine: claude\nmodel: anthropic/opus:turbo");
  profile(paths.user, "noskill", "description: x\nengine: harness", "Role.", false);
  profile(paths.user, "norole", "description: x\nengine: harness", "");
  profile(paths.user, "good", "description: fine\nengine: claude\nmodel: anthropic/opus:xhigh");
  const registry = loadRegistry({ cwd: paths.cwd, dataDir: paths.dataDir, projectTrusted: false, bundledDir: paths.bundle });
  assert.deepEqual([...registry.profiles.keys()], ["good"]);
  const problem = (name: string): string => registry.problems.find((line) => line.includes(`/${name}:`)) ?? "";
  assert.match(problem("noengine"), /engine must be harness or claude/);
  assert.match(problem("badmode"), /mode must be/);
  assert.match(problem("badeffort"), /thinking levels low, medium, high, xhigh, max/);
  assert.match(problem("noskill"), /SKILL\.md/);
  assert.match(problem("norole"), /role/);
});

test("subagents naming unknown profiles or forming a cycle are left out", () => {
  const paths = sources();
  profile(paths.user, "lead", "description: x\nengine: harness\nsubagents: [helper]");
  profile(paths.user, "helper", "description: x\nengine: harness");
  profile(paths.user, "orphan", "description: x\nengine: harness\nsubagents: [ghost]");
  profile(paths.user, "ping", "description: x\nengine: harness\nsubagents: [pong]");
  profile(paths.user, "pong", "description: x\nengine: harness\nsubagents: [ping]");
  const registry = loadRegistry({ cwd: paths.cwd, dataDir: paths.dataDir, projectTrusted: false, bundledDir: paths.bundle });
  assert.deepEqual([...registry.profiles.keys()].sort(), ["helper", "lead"]);
  assert.ok(registry.problems.some((line) => /orphan.*unknown profiles: ghost/.test(line)));
  assert.ok(registry.problems.some((line) => /cycle/.test(line)));
});

test("the bundled profiles load: builder (claude) and explorer (harness, PLAN); their briefings say when", () => {
  const registry = loadRegistry({ cwd: "/nonexistent", dataDir: "/nonexistent", projectTrusted: false, bundledDir: BUNDLED_DIR });
  assert.deepEqual(registry.problems, []);
  assert.equal(registry.profiles.get("builder")?.engine, "claude");
  assert.equal(registry.profiles.get("builder")?.model, "anthropic/opus:medium");
  assert.equal(registry.profiles.get("explorer")?.mode, "plan");
  assert.equal(registry.profiles.get("explorer")?.model, "openai-codex/sol:medium");
});

test("a subagent's tools: allow and deny masks; ctx_* never; subagent only with profiles below the depth limit", () => {
  const launch = { tools: { allow: ["read", "lsp_*", "ctx_*"], deny: ["lsp_refactor"] }, subagents: [], depth: 1 };
  assert.equal(toolAllowed("read", launch, MAX_SUBAGENT_DEPTH), true);
  assert.equal(toolAllowed("lsp_hover", launch, MAX_SUBAGENT_DEPTH), true);
  assert.equal(toolAllowed("lsp_refactor", launch, MAX_SUBAGENT_DEPTH), false);
  assert.equal(toolAllowed("write", launch, MAX_SUBAGENT_DEPTH), false);
  assert.equal(toolAllowed("ctx_reduce", launch, MAX_SUBAGENT_DEPTH), false);
  assert.equal(toolAllowed("subagent", launch, MAX_SUBAGENT_DEPTH), false);
  assert.equal(toolAllowed("subagent", { ...launch, subagents: ["helper"] }, MAX_SUBAGENT_DEPTH), true);
  assert.equal(toolAllowed("subagent", { ...launch, subagents: ["helper"], depth: 2 }, MAX_SUBAGENT_DEPTH), false);
  assert.equal(toolAllowed("write", { tools: {}, subagents: [], depth: 1 }, MAX_SUBAGENT_DEPTH), true, "no allow list: everything");
});
