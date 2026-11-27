// The live check of the claude engine (plan G5) against the real Claude Code of this machine, with
// its user's login: a builder subagent runs under harness's runtime — its Write asks the operator
// (the PreToolUse hook through `--settings`), harness's bash reaches it through the stdio MCP bridge,
// the change lands once allowed; a second run is interrupted from harness. Not part of
// `nix flake check` (it needs the subscription and the network):
//
//   HARNESS_LIVE_CLAUDE=$(command -v claude) node --test tests/live/claude.live.ts

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { AgentModel } from "#client/model/agent-model.ts";
import { RawDriver } from "#testkit/drivers/raw.ts";
import { createStand, type Stand } from "#testkit/stand/stand.ts";

const CLAUDE = process.env.HARNESS_LIVE_CLAUDE;

function until(model: AgentModel, condition: () => boolean, what: string, ms = 300_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
    const check = (): void => {
      if (condition()) {
        clearTimeout(timer);
        resolve();
      } else {
        // not yet
      }
    };
    model.onChange(check);
    check();
  });
}

function subagentResults(model: AgentModel): string[] {
  return model.items.flatMap((item) =>
    item.kind === "message" && item.message.role === "toolResult" && (item.message as { toolName?: string }).toolName === "subagent"
      ? [(item.message.content as { text?: string }[]).map((block) => block.text ?? "").join("")]
      : [],
  );
}

/** What went wrong: the session's subagents and latest items, the agents' logs (the stand is gone after). */
function evidence(stand: Stand, model: AgentModel | undefined): string {
  const logs = join(stand.dataDir, "log", "agents");
  const files = existsSync(logs) ? readdirSync(logs) : [];
  return [
    `subagents: ${JSON.stringify(model?.state.subagents ?? [])}`,
    `items: ${JSON.stringify(model?.items.slice(-4) ?? []).slice(0, 3000)}`,
    ...files.map((file) => `--- ${file}\n${readFileSync(join(logs, file), "utf8").slice(-6000)}`),
  ].join("\n");
}

async function run(stand: Stand, follow: (model: AgentModel) => void): Promise<void> {
  const raw = await RawDriver.open(() => stand.connect());
  const { agent } = await raw.api.request("agent_start", { cwd: stand.project });
  const model = await raw.client.follow(raw.hub, agent.id);
  follow(model);
  const call = (record: object): Promise<unknown> => raw.api.call(agent.id, record as never);

  // 1: harness's bash through the bridge, then a Write that the operator allows
  const target = join(stand.project, "live.txt");
  const instruction =
    `First run \`echo bridged-$((6*7))\` with the mcp__harness__bash tool and remember its output. ` +
    `Then create the file ${target} with the Write tool; its whole content is that output. Then reply with the single word: done.`;
  stand.script([{ toolCalls: [{ name: "subagent", args: { agent: "builder", instruction } }] }, { text: "reviewed" }]);
  await call({ type: "harness_prompt", text: "delegate the file", mode: "build" });
  await until(model, () => model.interactions.some((request) => request.kind === "gate") || subagentResults(model).length > 0, "the gate of Claude's Write", 180_000);
  const gate = model.interactions.find((request) => request.kind === "gate");
  assert.ok(gate?.kind === "gate", `no gate; the subagent said: ${subagentResults(model).join(" | ")}`);
  assert.equal(gate.payload.by, "builder");
  assert.equal(existsSync(target), false, "nothing is written before the operator allows it");
  await call({ type: "harness_interaction_response", interactionId: gate.id, answer: { action: "allow" } });
  await until(model, () => subagentResults(model).length === 1, "the subagent's report");
  assert.equal(readFileSync(target, "utf8").trim(), "bridged-42");
  assert.match(subagentResults(model)[0] ?? "", /done/i);
  assert.equal(stand.claudeStarts().length, 0, "the fake was not used");

  // 2: a long run stops when the operator interrupts the parent
  stand.script([{ toolCalls: [{ name: "subagent", args: { agent: "builder", instruction: "Run `sleep 120` with your Bash tool, then reply: slept." } }] }, { text: "stopped" }]);
  await call({ type: "harness_prompt", text: "delegate a long wait", mode: "build" });
  await until(model, () => model.state.subagents.some((subagent) => subagent.state === "running"), "the running subagent", 120_000);
  await new Promise((resolve) => setTimeout(resolve, 15_000)); // Claude starts its Bash
  const started = Date.now();
  await call({ type: "abort" });
  await until(model, () => !model.state.subagents.some((subagent) => subagent.state === "running"), "the stop", 60_000);
  assert.ok(Date.now() - started < 60_000, "the interrupt stopped Claude well before its sleep ended");
}

const stands: Stand[] = [];
after(async () => {
  for (const stand of stands) {
    await stand.down();
  }
});

test("the claude engine against the real Claude Code", { skip: CLAUDE === undefined ? "HARNESS_LIVE_CLAUDE is not set" : false }, async () => {
  const stand = await createStand({ claudeCommand: CLAUDE });
  stands.push(stand);
  let model: AgentModel | undefined;
  try {
    await run(stand, (followed) => {
      model = followed;
    });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${evidence(stand, model)}`);
  }
});
