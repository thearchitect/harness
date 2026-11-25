// Subagents on the claude engine against a fake Claude Code (plan 12.10): a run with harness's MCP
// tool and an approved change; a rejected change reaches Claude with the operator's reason; a limit
// wait asks the operator and "continue in harness" stops Claude; a background task of Claude is a
// task of the session and stops from there; Claude missing, logged out or too old stops the call
// with the reason. Invariants: no API billing variables reach Claude; Claude sees neither ctx_* nor
// subagent among harness's tools (the bridge's token: claude.test.ts of the engine).

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentModel } from "#client/model/agent-model.ts";
import type { RawDriver } from "#testkit/drivers/raw.ts";
import { defineScenario, runScenario } from "#testkit/scenario/scenario.ts";

function until(model: AgentModel, condition: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (condition()) {
        resolve();
      } else {
        // not yet
      }
    };
    model.onChange(check);
    check();
  });
}

function lastResult(model: AgentModel): string | undefined {
  const item = model.items.findLast((candidate) => candidate.kind === "message" && candidate.message.role === "toolResult" && (candidate.message as { toolName?: string }).toolName === "subagent");
  return item?.kind === "message" ? (item.message.content as { text?: string }[]).map((block) => block.text ?? "").join("") : undefined;
}

async function delegate(raw: RawDriver, agent: string, model: AgentModel, script: (turns: unknown[]) => void, task: string): Promise<string> {
  const before = lastResult(model);
  script([{ toolCalls: [{ name: "subagent", args: { agent: "builder", task } }] }, { text: "reviewed" }]);
  await raw.api.call(agent, { type: "harness_prompt", text: `delegate: ${task}`, mode: "build" });
  await until(model, () => lastResult(model) !== undefined && lastResult(model) !== before);
  return lastResult(model) ?? "";
}

export const scenario = defineScenario({
  name: "claude engine",
  clients: { raw: { kind: "raw" } },
  steps: [
    {
      name: "a run uses harness's tool and an approved change; nothing billable reaches Claude",
      async run({ stand, clients: { raw }, memo }) {
        const { agent } = await raw.api.request("agent_start", { cwd: stand.project });
        const model = await raw.client.follow(raw.node, agent.id);
        memo.agent = agent.id;
        memo.model = model;
        const target = join(stand.project, "claude.txt");
        stand.claude([[{ mcp: { name: "bash", arguments: { command: "echo from-harness" } } }, { edit: { file_path: target, content: "by claude" } }, { text: "implemented the plan" }]]);
        const resultPromise = delegate(raw, agent.id, model, (turns) => stand.script(turns as never), "implement the plan");
        await until(model, () => model.interactions.length > 0);
        const gate = model.interactions[0];
        assert.equal(gate?.kind === "gate" ? gate.payload.by : undefined, "builder");
        await raw.api.call(agent.id, { type: "harness_interaction_response", interactionId: gate?.id ?? "", answer: { action: "allow" } });
        const result = await resultPromise;
        assert.match(result, /Subagent builder \(claude\)/);
        assert.match(result, /model claude-opus-5-5/);
        assert.match(result, /implemented the plan/);
        assert.match(result, /Files changed: .*claude\.txt/);
        assert.equal(readFileSync(target, "utf8"), "by claude");

        const start = stand.claudeStarts().at(-1);
        assert.ok(start !== undefined);
        assert.equal(start.env.ANTHROPIC_API_KEY, undefined, "no API key reaches Claude");
        assert.equal(start.env.CLAUDE_CODE_RETRY_WATCHDOG, "1");
        assert.deepEqual(start.argv.slice(start.argv.indexOf("--model"), start.argv.indexOf("--model") + 4), ["--model", "opus", "--effort", "medium"]);
        const tools = stand.claudeTools();
        assert.ok(tools.includes("bash") && tools.includes("permission"));
        assert.ok(!tools.some((name) => name.startsWith("ctx_") || name === "subagent"), tools.join(","));
      },
    },
    {
      name: "a rejected change reaches Claude with the operator's reason",
      async run({ stand, clients: { raw }, memo }) {
        const agent = memo.agent as string;
        const model = memo.model as AgentModel;
        const target = join(stand.project, "rejected.txt");
        stand.claude([[{ edit: { file_path: target, content: "nope" } }]]);
        const resultPromise = delegate(raw, agent, model, (turns) => stand.script(turns as never), "touch rejected.txt");
        await until(model, () => model.interactions.length > 0);
        await raw.api.call(agent, { type: "harness_interaction_response", interactionId: model.interactions[0]?.id ?? "", answer: { action: "reject", comment: "not this file" } });
        const result = await resultPromise;
        assert.match(result, /denied: File change rejected by user — not this file/);
        assert.match(result, /Refused: Write/);
        assert.equal(existsSync(target), false);
      },
    },
    {
      name: "a limit wait asks the operator; continue in harness stops Claude",
      async run({ stand, clients: { raw }, memo }) {
        const agent = memo.agent as string;
        const model = memo.model as AgentModel;
        stand.claude([[{ limit: true }]]);
        const resultPromise = delegate(raw, agent, model, (turns) => stand.script(turns as never), "wait for the limit");
        await until(model, () => model.interactions.some((request) => request.kind === "choice"));
        const choice = model.interactions.find((request) => request.kind === "choice");
        assert.match(choice?.kind === "choice" ? choice.payload.title : "", /five hour limit/);
        await raw.api.call(agent, { type: "harness_interaction_response", interactionId: choice?.id ?? "", answer: { id: "continue" } });
        const result = await resultPromise;
        assert.match(result, /State: stopped/);
        assert.match(result, /continue in harness/);
      },
    },
    {
      name: "Claude's background task is a task of the session and stops from there",
      async run({ stand, clients: { raw }, memo }) {
        const agent = memo.agent as string;
        const model = memo.model as AgentModel;
        stand.claude([[{ task: { id: "bg1", command: "npm run dev" } }, { text: "server started" }]]);
        await delegate(raw, agent, model, (turns) => stand.script(turns as never), "start the dev server");
        await until(model, () => model.state.tasks.some((task) => task.id === "bg1" && task.source === "claude" && task.state === "running"));
        assert.equal(model.state.tasks.find((task) => task.id === "bg1")?.command, "npm run dev");
        await raw.api.call(agent, { type: "harness_task_stop", taskId: "bg1" });
        await until(model, () => model.state.tasks.some((task) => task.id === "bg1" && task.state === "stopped"));
      },
    },
    {
      name: "Claude logged out, too old, or on an API key: the call stops with the reason",
      async run({ stand, clients: { raw }, memo }) {
        const agent = memo.agent as string;
        const model = memo.model as AgentModel;
        stand.claude([], { auth: "out" });
        assert.match(await delegate(raw, agent, model, (turns) => stand.script(turns as never), "a"), /not logged in with a Claude subscription/);
        stand.claude([], { version: "2.1.10" });
        assert.match(await delegate(raw, agent, model, (turns) => stand.script(turns as never), "b"), /older than 2\.1\.259/);
        stand.claude([[{ text: "x" }]], { keySource: "ANTHROPIC_API_KEY" });
        assert.match(await delegate(raw, agent, model, (turns) => stand.script(turns as never), "c"), /uses an API key/);
      },
    },
  ],
});

runScenario(scenario);
