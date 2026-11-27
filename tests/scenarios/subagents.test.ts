// Subagents on the harness engine (plan 12.3, 12.10): the report reaches the caller as a handover
// block; a PLAN profile cannot change the project; a BUILD profile's change asks the operator,
// signed with the subagent's name; the operator steers a live subagent; a background subagent
// outlives its caller and reports when the session opens again.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentModel } from "#client/model/agent-model.ts";
import type { AgentInfo } from "#protocol/hub.ts";
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

function subagentResult(model: AgentModel): string | undefined {
  const item = model.items.findLast((candidate) => candidate.kind === "message" && candidate.message.role === "toolResult" && (candidate.message as { toolName?: string }).toolName === "subagent");
  const content = item?.kind === "message" ? (item.message.content as { type: string; text?: string }[]) : undefined;
  return content?.map((block) => block.text ?? "").join("");
}

function profile(dataDir: string, name: string, frontmatter: string): void {
  const dir = join(dataDir, "subagents", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SUBAGENT.md"), `---\nname: ${name}\ndescription: a test subagent\nengine: harness\n${frontmatter}\n---\nDo what the brief says.\n`);
  writeFileSync(join(dir, "SKILL.md"), `---\nname: subagent-${name}\ndescription: Only on the operator's explicit request — the ${name} test subagent\n---\nBrief it.\n`);
}

async function session(raw: RawDriver, cwd: string, sessionFile?: string): Promise<{ id: string; model: AgentModel; info: AgentInfo }> {
  const { agent } = await raw.api.request("agent_start", { cwd, sessionFile });
  return { id: agent.id, model: await raw.client.follow(raw.hub, agent.id), info: agent };
}

/** The caller's subagent that waits for the operator. */
function askingChild(raw: RawDriver, parent: string): Promise<AgentInfo> {
  return new Promise((resolve) => {
    const check = (): void => {
      const child = [...raw.client.agents.values()].find((agent) => agent.parent === parent && agent.summary.waiting > 0);
      if (child !== undefined) {
        resolve(child);
      } else {
        setTimeout(check, 20);
      }
    };
    check();
  });
}

export const scenario = defineScenario({
  name: "subagents",
  clients: { raw: { kind: "raw" } },
  steps: [
    {
      name: "the subagent's report reaches the caller as a handover block",
      async run({ stand, clients: { raw }, memo }) {
        profile(stand.dataDir, "probe", "mode: build");
        profile(stand.dataDir, "planner", "mode: plan\ntools:\n  allow: [read, write]");
        const main = await session(raw, stand.project);
        memo.main = main;
        stand.script([
          { toolCalls: [{ name: "subagent", args: { agent: "probe", instruction: "Report the weather." } }] },
          { agent: "probe", text: "probe report: sunny" },
          { text: "got the report" },
        ]);
        await raw.api.call(main.id, { type: "harness_prompt", text: "delegate to probe", mode: "build" });
        await until(main.model, () => subagentResult(main.model) !== undefined);
        const result = subagentResult(main.model) ?? "";
        assert.match(result, /Subagent probe \(harness\)/);
        assert.match(result, /State: done/);
        assert.match(result, /probe report: sunny/);
        await until(main.model, () => main.model.state.subagents.some((row) => row.profile === "probe" && row.state === "done"));
      },
    },
    {
      name: "a PLAN profile cannot change the project",
      async run({ stand, clients: { raw }, memo }) {
        const main = memo.main as { id: string; model: AgentModel };
        const target = join(stand.project, "planned.txt");
        stand.script([
          { toolCalls: [{ name: "subagent", args: { agent: "planner", instruction: "Write planned.txt." } }] },
          { agent: "planner", toolCalls: [{ name: "write", args: { path: target, content: "x" } }] },
          { agent: "planner", text: "PLAN refused the write" },
          { text: "noted" },
        ]);
        const before = subagentResult(main.model);
        await raw.api.call(main.id, { type: "harness_prompt", text: "delegate to planner", mode: "build" });
        await until(main.model, () => subagentResult(main.model) !== before && subagentResult(main.model) !== undefined);
        assert.match(subagentResult(main.model) ?? "", /PLAN refused the write/);
        assert.equal(existsSync(target), false);
      },
    },
    {
      name: "a BUILD profile's change asks the operator, signed with its name",
      async run({ stand, clients: { raw }, memo }) {
        const main = memo.main as { id: string; model: AgentModel };
        const target = join(stand.project, "built.txt");
        stand.script([
          { toolCalls: [{ name: "subagent", args: { agent: "probe", instruction: "Write built.txt." } }] },
          { agent: "probe", toolCalls: [{ name: "write", args: { path: target, content: "built" } }] },
          { agent: "probe", text: "written" },
          { text: "done" },
        ]);
        const before = subagentResult(main.model);
        await raw.api.call(main.id, { type: "harness_prompt", text: "delegate the change", mode: "build" });
        const child = await askingChild(raw, main.id);
        const childModel = await raw.client.follow(raw.hub, child.id);
        await until(childModel, () => childModel.interactions.length > 0);
        const request = childModel.interactions[0];
        assert.equal(request?.kind, "gate");
        assert.equal(request?.kind === "gate" ? request.payload.by : undefined, "probe");
        await raw.api.call(child.id, { type: "harness_interaction_response", interactionId: request?.id ?? "", answer: { action: "allow" } });
        await until(main.model, () => subagentResult(main.model) !== before && subagentResult(main.model) !== undefined);
        assert.equal(existsSync(target), true);
        assert.match(subagentResult(main.model) ?? "", /Files changed: .*built\.txt/);
      },
    },
    {
      name: "the operator steers a live subagent",
      async run({ stand, clients: { raw }, memo }) {
        const main = memo.main as { id: string; model: AgentModel };
        stand.script([
          { toolCalls: [{ name: "subagent", args: { agent: "probe", instruction: "Think long." } }] },
          { agent: "probe", toolCalls: [{ name: "bash", args: { command: "echo looking" } }], delayMs: 3000 },
          { agent: "probe", text: "steered answer" },
          { text: "ok" },
        ]);
        const before = subagentResult(main.model);
        await raw.api.call(main.id, { type: "harness_prompt", text: "delegate a long one", mode: "build" });
        await until(main.model, () => main.model.state.subagents.some((row) => row.state === "running"));
        const row = main.model.state.subagents.find((candidate) => candidate.state === "running");
        await raw.api.call(main.id, { type: "harness_subagent_send", session: row?.session ?? "", text: "focus on tests" });
        await until(main.model, () => subagentResult(main.model) !== before && subagentResult(main.model) !== undefined);
        const result = subagentResult(main.model) ?? "";
        assert.match(result, /Operator → probe: focus on tests/);
        assert.match(result, /steered answer/);
        await assert.rejects(raw.api.call(main.id, { type: "harness_subagent_send", session: row?.session ?? "", text: "too late" }), /not running/);
      },
    },
    {
      name: "a background subagent outlives its caller and reports when the session opens again",
      async run({ stand, clients: { raw }, memo }) {
        const main = memo.main as { id: string; model: AgentModel; info: AgentInfo };
        stand.script([
          { toolCalls: [{ name: "subagent", args: { agent: "probe", instruction: "Report later.", background: true } }] },
          { text: "started it" },
          { agent: "probe", text: "background report", delayMs: 3000 },
          { text: "read the report" },
        ]);
        await raw.api.call(main.id, { type: "harness_prompt", text: "start it in the background", mode: "build" });
        await until(main.model, () => main.model.items.some((item) => item.kind === "message" && item.message.role === "assistant" && JSON.stringify(item.message.content).includes("started it")));
        const sessionFile = main.model.session?.sessionFile;
        const children = [...raw.client.agents.values()].filter((agent) => agent.parent === main.id && agent.subagent?.background === true);
        assert.equal(children.length, 1);
        await raw.api.request("agent_close", { agent: main.id });
        // the background child keeps running and finishes
        const child = children[0] as AgentInfo;
        const childModel = await raw.client.follow(raw.hub, child.id);
        await until(childModel, () => childModel.items.some((item) => item.kind === "message" && JSON.stringify(item.message.content).includes("background report")) && !childModel.running);
        const reopened = await session(raw, stand.project, sessionFile);
        await until(reopened.model, () => reopened.model.items.some((item) => item.kind === "custom" && item.customType === "harness-subagent" && (item.data as { state?: string }).state === "done"));
        await until(reopened.model, () => reopened.model.items.some((item) => item.kind === "message" && item.message.role === "custom" && JSON.stringify(item.message.content).includes("background report")));
        await until(reopened.model, () => reopened.model.state.subagents.some((row) => row.state === "done"));
      },
    },
  ],
});

runScenario(scenario);
