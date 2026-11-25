// Logging in to a provider from a client (plan 5.6, the agent's half of /login): the login runs on
// the node, its prompt reaches the operator as an interaction, the key lands in the node user's
// auth.json; cancelling the prompt fails the login with its reason.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentModel } from "#client/model/agent-model.ts";
import type { LoginProvider } from "#protocol/hap.ts";
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

export const scenario = defineScenario({
  name: "login",
  clients: { raw: { kind: "raw" } },
  steps: [
    {
      name: "an API key login asks for the key and stores it on the node",
      async run({ stand, clients: { raw }, memo }) {
        const { agent } = await raw.api.request("agent_start", { cwd: stand.project });
        const model = await raw.client.follow(raw.node, agent.id);
        memo.agent = agent.id;
        memo.model = model;
        const { providers } = await raw.api.call<{ providers: LoginProvider[] }>(agent.id, { type: "harness_login_providers" });
        const openai = providers.find((provider) => provider.id === "openai" && provider.authType === "api_key");
        assert.ok(openai !== undefined, providers.map((provider) => `${provider.id}:${provider.authType}`).join(" "));
        assert.equal(openai.configured, false);

        const done = raw.api.call(agent.id, { type: "harness_login", provider: "openai", authType: "api_key" });
        await until(model, () => model.interactions.some((request) => request.kind === "secret"));
        const prompt = model.interactions.find((request) => request.kind === "secret");
        assert.match(prompt?.kind === "secret" ? prompt.payload.name : "", /Log in to /);
        await raw.api.call(agent.id, { type: "harness_interaction_response", interactionId: prompt?.id ?? "", answer: { value: "sk-test-login-key" } });
        await done;

        const auth = JSON.parse(readFileSync(join(stand.dataDir, "auth.json"), "utf8")) as Record<string, { key?: string }>;
        assert.equal(auth.openai?.key, "sk-test-login-key");
        const after = await raw.api.call<{ providers: LoginProvider[] }>(agent.id, { type: "harness_login_providers" });
        assert.equal(after.providers.find((provider) => provider.id === "openai" && provider.authType === "api_key")?.configured, true);
      },
    },
    {
      name: "a cancelled prompt fails the login; logout removes a login",
      async run({ stand, clients: { raw }, memo }) {
        const agent = memo.agent as string;
        const model = memo.model as AgentModel;
        const done = raw.api.call(agent, { type: "harness_login", provider: "openai", authType: "api_key" });
        await until(model, () => model.interactions.some((request) => request.kind === "secret"));
        const prompt = model.interactions.find((request) => request.kind === "secret");
        await raw.api.call(agent, { type: "harness_interaction_response", interactionId: prompt?.id ?? "", answer: { cancelled: true } });
        await assert.rejects(done, /cancelled/i);

        await raw.api.call(agent, { type: "harness_logout", provider: "openai" });
        const auth = JSON.parse(readFileSync(join(stand.dataDir, "auth.json"), "utf8")) as Record<string, unknown>;
        assert.equal(auth.openai, undefined);
      },
    },
  ],
});

runScenario(scenario);
