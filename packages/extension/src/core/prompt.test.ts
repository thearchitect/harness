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
  const options = {
    cwd: "/p",
    selectedTools: ["read", "subagent"],
    hiddenTools: [],
    toolSnippets: {},
    toolGuidelines: {},
    promptGuidelines: [],
    appendSystemPrompt: "",
    sections: {},
    contextFiles: [],
    skills: [],
  } as unknown as NormalizedBuildSystemPromptOptions;
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

test("Claude's appended prompt: harness's preamble, the role, the rules, the tools' rules by their MCP names", () => {
  const prompt = claudeSystemPrompt("/w/s", "Implement the plan.", [{ name: "bash", guidelines: ["Use bash for commands."] }]);
  assert.match(prompt, /You work for harness/);
  assert.match(prompt, /Scratch files go to \/w\/s/);
  assert.match(prompt, /<role>\nImplement the plan\.\n<\/role>/);
  assert.match(prompt, /<engineering_principles>/);
  assert.match(prompt, /never pipe the\s+command's output directly into `grep`/);
  assert.match(prompt, /- bash \(mcp__harness__bash\): Use bash for commands\./);
});
