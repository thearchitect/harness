// The prompt's contracts: the rule on calling subagents (S5) and the implementer rule are in every
// assembled prompt (the prompt does not change with the mode); the bundled briefings say when they
// apply; Claude's appended prompt carries harness's preamble, the role, its rules and its tools'.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { BUNDLED_DIR } from "../subagents/registry.ts";
import { assembleSystemPrompt, claudeSystemPrompt } from "./prompt.ts";

test("every assembled prompt carries the subagent rule and the implementer rule", () => {
  const options = runOptions({ selectedTools: ["read", "subagent"] });
  assembleSystemPrompt(options, { activeTools: ["read", "subagent"], workspaceRoot: "/w" });
  assert.match(options.sections.rules ?? "", /Call `subagent` only when the operator explicitly asks for it in this conversation/);
  assert.match(options.sections.rules ?? "", /Never launch a subagent on your own initiative/);
  assert.match(options.sections.rules ?? "", /read the profile's briefing skill/);
  assert.match(options.sections.mode_policies ?? "", /implementer="<profile>"/);
});

test("the bundled briefings begin with when they apply", () => {
  for (const name of ["builder", "explorer"]) {
    const description = /description: (.*)/.exec(readFileSync(join(BUNDLED_DIR, name, "SKILL.md"), "utf8"))?.[1] ?? "";
    assert.match(description, /^Only on the operator's explicit request/, name);
  }
});

function runOptions(overrides: Partial<NormalizedBuildSystemPromptOptions> = {}): NormalizedBuildSystemPromptOptions {
  return {
    cwd: "/p",
    selectedTools: [],
    hiddenTools: [],
    toolSnippets: {},
    toolGuidelines: {},
    promptGuidelines: [],
    appendSystemPrompt: "",
    sections: {},
    contextFiles: [],
    skills: [],
    ...overrides,
  } as NormalizedBuildSystemPromptOptions;
}

test("harness's sections come first, then other extensions' in the order they came", () => {
  const options = runOptions({ selectedTools: ["read"], sections: { magic_context: "m", mcp_servers: "s" } });
  assembleSystemPrompt(options, { activeTools: ["read"], workspaceRoot: "/w" });
  assert.deepEqual(Object.keys(options.sections), ["tools", "rules", "mode_policies", "engineering_principles", "code_exploration", "harness_docs", "magic_context", "mcp_servers"]);
});

function skill(name: string): NormalizedBuildSystemPromptOptions["skills"][number] {
  return { name, description: `${name} skill`, filePath: `/skills/${name}/SKILL.md`, baseDir: `/skills/${name}`, disableModelInvocation: false } as NormalizedBuildSystemPromptOptions["skills"][number];
}

test("Claude's appended prompt: the same parts as harness's, with the names Claude calls", () => {
  const prompt = claudeSystemPrompt({
    workspaceRoot: "/w/s",
    role: "Implement the plan.",
    mode: "build",
    run: runOptions({
      contextFiles: [{ path: "/p/AGENTS.md", content: "Run the local checks." }],
      skills: [skill("testing"), skill("subagent-builder")],
      sections: { mcp_servers: "- mcp__github (codemode): GitHub" },
    }),
    tools: [
      { name: "bash", guidelines: ["Use a secret only as `$NAME` inside `bash` commands."] },
      { name: "lsp_refactor", guidelines: [] },
      { name: "send_file", guidelines: ["Deliver files with send_file."] },
    ],
  });
  assert.match(prompt, /^You work for harness/);
  assert.match(prompt, /Scratch files go to \/w\/s/);
  assert.match(prompt, /<role>\nImplement the plan\.\n<\/role>/);
  assert.match(prompt, /<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="\/p\/AGENTS.md">\nRun the local checks\.\n<\/project_instructions>\n<\/project_context>/);
  assert.match(prompt, /<name>testing<\/name>/);
  assert.doesNotMatch(prompt, /subagent-builder/, "briefings of the subagent tool, which Claude has not");
  // the rules: harness's, the tools' own, with Claude's names
  assert.match(prompt, /Change file contents only with the `Edit` and `Write` tools/);
  assert.match(prompt, /with `mcp__harness__lsp_refactor` for renames/);
  assert.match(prompt, /Use a secret only as `\$NAME` inside `mcp__harness__bash` commands\./);
  assert.match(prompt, /never pipe the\s+command's output directly into `grep`/);
  assert.match(prompt, /Deliver files with mcp__harness__send_file\./);
  assert.doesNotMatch(prompt, /`(read|edit|write)`/, "pi's names of the tools Claude has natively");
  assert.doesNotMatch(prompt, /Call `subagent` only|Questions to the operator/, "rules for harness's own models");
  // the mode's policy, the sections, the MCP servers
  assert.match(prompt, /<mode_policy>\nharness runs you in BUILD mode[\s\S]*# Build Mode[\s\S]*<\/mode_policy>/);
  assert.doesNotMatch(prompt, /# Plan Mode/);
  assert.match(prompt, /<engineering_principles>/);
  assert.match(prompt, /<code_exploration>[\s\S]*`mcp__harness__lsp_\*`[\s\S]*<\/code_exploration>/);
  assert.match(prompt, /<harness_docs>/);
  assert.match(prompt, /<mcp_servers>\n- mcp__github \(codemode\): GitHub[\s\S]*`mcp__harness__mcp__<server>__<tool>`/);
  assert.doesNotMatch(prompt, /In `codemode`, every value/, "codemode runs only for harness's own models");
});

test("Claude's prompt in PLAN mode carries the plan policy", () => {
  const prompt = claudeSystemPrompt({ workspaceRoot: "/w/s", role: "r", mode: "plan", run: runOptions(), tools: [] });
  assert.match(prompt, /harness runs you in PLAN mode[\s\S]*# Plan Mode[\s\S]*AGENT SESSION WORKSPACE `\/w\/s`/);
  assert.doesNotMatch(prompt, /<project_context>|<skills>|<mcp_servers>/);
});
