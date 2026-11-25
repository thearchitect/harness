// Model references (plan 6.2): a family reference selects the newest model of the family and the
// session follows it; when that model leaves the catalog, opening the session again selects the
// successor and says so (M2); choosing an exact model drops the reference.

import assert from "node:assert/strict";
import { defineScenario, runScenario } from "#testkit/scenario/scenario.ts";
import type { RawDriver } from "#testkit/drivers/raw.ts";
import type { AgentModel } from "#client/model/agent-model.ts";

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

async function open(raw: RawDriver, cwd: string, sessionFile?: string): Promise<{ id: string; model: AgentModel; sessionFile?: string }> {
  const { agent } = await raw.api.request("agent_start", { cwd, sessionFile });
  return { id: agent.id, model: await raw.client.follow(raw.node, agent.id), sessionFile: agent.sessionFile };
}

export const scenario = defineScenario({
  name: "model references",
  clients: { raw: { kind: "raw" } },
  steps: [
    {
      name: "a family reference selects the newest of the family",
      async run({ stand, clients: { raw }, memo }) {
        stand.models(["probe-1", "probe-2", "probe-10"]);
        const agent = await open(raw, stand.project);
        await raw.api.call(agent.id, { type: "harness_set", model: "scenario/probe:low" });
        await until(agent.model, () => agent.model.state.model !== undefined);
        assert.deepEqual(agent.model.state.model, { ref: "scenario/probe:low", resolved: "scenario/probe-10" });
        await until(agent.model, () => agent.model.session?.model?.id === "probe-10" && agent.model.session.thinkingLevel === "low");
        // pi writes a session file with its first answer
        stand.script([{ text: "noted" }]);
        await raw.api.call(agent.id, { type: "harness_prompt", text: "hello", mode: "plan" });
        await until(agent.model, () => agent.model.items.some((item) => item.kind === "message" && item.message.role === "assistant"));
        memo.sessionFile = agent.sessionFile;
        await raw.api.request("agent_close", { agent: agent.id });
      },
    },
    {
      name: "the model left the catalog: the session opens with the successor and a notice",
      async run({ stand, clients: { raw }, memo }) {
        stand.models(["probe-1", "probe-2"]);
        const agent = await open(raw, stand.project, memo.sessionFile as string);
        await until(agent.model, () => agent.model.session?.model?.id === "probe-2");
        // the change stays in the transcript (a notice would reach only clients attached at that moment)
        await until(agent.model, () =>
          agent.model.items.some((item) => item.kind === "custom" && item.customType === "harness-model-ref" && (item.data as { previous?: string }).previous === "scenario/probe-10"),
        );
        assert.deepEqual(agent.model.state.model, { ref: "scenario/probe:low", resolved: "scenario/probe-2" });
        memo.agent = agent.id;
        memo.model = agent.model;
      },
    },
    {
      name: "an exact model drops the reference",
      async run({ clients: { raw }, memo }) {
        const model = memo.model as AgentModel;
        await raw.api.call(memo.agent as string, { type: "set_model", provider: "scenario", modelId: "probe-1" });
        await until(model, () => model.state.model === undefined);
      },
    },
  ],
});

runScenario(scenario);
