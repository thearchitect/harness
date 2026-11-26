// Subagents on the claude engine against a fake Claude Code (plan 12.10): a run with harness's MCP
// tool and an approved change; a rejected change reaches Claude with the operator's reason; a limit
// wait asks the operator and "continue in harness" stops Claude; a background task of Claude is a
// task of the session and stops from there; Claude missing, logged out or too old stops the call
// with the reason; the agreed plan reaches Claude whole, then as its changes. Invariants: no API
// billing variables reach Claude; Claude sees neither ctx_*, subagent nor pi's read/edit/write among
// harness's tools (the bridge's token: claude.test.ts of the engine); its prompt carries the session's
// project context, the mode's policy and harness's rules with Claude's names; it loads no instruction
// files or memory of its own.

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

async function delegate(raw: RawDriver, agent: string, model: AgentModel, script: (turns: unknown[]) => void, instruction: string, more: Record<string, unknown> = {}): Promise<string> {
  const before = lastResult(model);
  script([{ toolCalls: [{ name: "subagent", args: { agent: "builder", instruction, ...more } }] }, { text: "reviewed" }]);
  await raw.api.call(agent, { type: "harness_prompt", text: `delegate: ${instruction}`, mode: "build" });
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
        writeFileSync(join(stand.project, "AGENTS.md"), "Project rule: run the local checks.\n");
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
        assert.ok(!tools.some((name) => name.startsWith("ctx_") || ["subagent", "read", "edit", "write"].includes(name)), tools.join(","));

        const flag = (name: string): string => start.argv[start.argv.indexOf(name) + 1] ?? "";
        const settings = JSON.parse(flag("--settings")) as { pluginConfigs?: Record<string, { options?: { instructionFiles?: string } }>; autoMemoryEnabled?: boolean; hooks?: unknown };
        assert.equal(settings.pluginConfigs?.["cc-plugin-agents-md@builtin"]?.options?.instructionFiles, "managed-only");
        assert.equal(settings.autoMemoryEnabled, false);
        assert.ok(settings.hooks !== undefined);
        const prompt = flag("--append-system-prompt");
        assert.match(prompt, /<project_instructions path="[^"]*AGENTS\.md">\nProject rule: run the local checks\./);
        assert.match(prompt, /harness runs you in BUILD mode/);
        assert.match(prompt, /Change file contents only with the `Edit` and `Write` tools/);
        assert.match(prompt, /<skills>/);
        assert.doesNotMatch(prompt, /subagent-builder|`(read|edit|write)`/);
        assert.match(prompt, /<code_exploration>/);
        assert.match(stand.claudeInputs().at(-1) ?? "", /^implement the plan$/);
      },
    },
    {
      name: "the plan reaches Claude whole, then its changes; the handover names it",
      async run({ stand, clients: { raw }, memo }) {
        const agent = memo.agent as string;
        const model = memo.model as AgentModel;
        const plan = join(stand.project, "plan.md");
        writeFileSync(plan, "# Plan\n\n## A\n\nWrite a.txt.\n\n## B\n\nWrite b.txt.\n");
        stand.claude([[{ text: "did A" }]]);
        const first = await delegate(raw, agent, model, (turns) => stand.script(turns as never), "Do section A.", { plan: "plan.md" });
        assert.match(first, /Plan: .*plan\.md/);
        assert.equal(stand.claudeInputs().at(-1), `Do section A.\n\n<plan path="${plan}">\n# Plan\n\n## A\n\nWrite a.txt.\n\n## B\n\nWrite b.txt.\n</plan>`);
        assert.equal(model.state.subagents.at(-1)?.plan, plan);

        writeFileSync(plan, "# Plan\n\n## A\n\nWrite a.txt.\n\n## B\n\nWrite b.md.\n");
        stand.claude([[{ text: "did B" }]]); // a continued session is a new Claude process
        await delegate(raw, agent, model, (turns) => stand.script(turns as never), "Now section B.", { plan: "plan.md", continue: true });
        const second = stand.claudeInputs().at(-1) ?? "";
        assert.match(second, /^Now section B\.\n\n<plan-update path="[^"]*plan\.md">/);
        assert.match(second, /-Write b\.txt\.\n\+Write b\.md\./);
        assert.doesNotMatch(second, /<plan path=/);

        const outside = await delegate(raw, agent, model, (turns) => stand.script(turns as never), "x", { plan: "/etc/hostname.md" });
        assert.match(outside, /no such file|outside the project/);
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
      name: "Claude's run is a transcript like a session's: thinking, pi's edit, its subagent's steps inside the Task; kept for later; live",
      async run({ stand, clients: { raw }, memo }) {
        const agent = memo.agent as string;
        const model = memo.model as AgentModel;
        const target = join(stand.project, "t.txt");
        const raw1 = (line: Record<string, unknown>): Record<string, unknown> => ({ parent_tool_use_id: null, ...line });
        stand.claude([
          [
            {
              raw: [
                raw1({ type: "stream_event", event: { type: "message_start" } }),
                raw1({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } } }),
                raw1({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "weighing it" } } }),
                raw1({ type: "assistant", message: { id: "m1", content: [{ type: "thinking", thinking: "weighing it" }, { type: "text", text: "Plan **ready**" }] } }),
                raw1({ type: "assistant", message: { id: "m2", content: [{ type: "tool_use", id: "t1", name: "Task", input: { description: "Check", subagent_type: "general-purpose" } }] } }),
                { type: "system", subtype: "task_started", task_id: "ag1", tool_use_id: "t1", task_type: "local_agent", description: "Check" },
                { type: "assistant", parent_tool_use_id: "t1", message: { id: "s1", content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test" } }] } },
                { type: "user", parent_tool_use_id: "t1", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "3 passing" }] } },
                raw1({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "all good" }] }] } }),
                { type: "system", subtype: "task_notification", task_id: "ag1", status: "completed" },
              ],
            },
            { edit: { file_path: target, old_string: "", new_string: "x" } },
            { text: "transcribed" },
          ],
        ]);
        const resultPromise = delegate(raw, agent, model, (turns) => stand.script(turns as never), "transcribe");
        await until(model, () => model.interactions.length > 0);
        await raw.api.call(agent, { type: "harness_interaction_response", interactionId: model.interactions[0]?.id ?? "", answer: { action: "allow" } });
        await resultPromise;
        const session = model.state.subagents.findLast((row) => row.engine === "claude")?.session ?? "";
        assert.ok(!("steps" in (model.state.subagents.find((row) => row.session === session) ?? {})), "no steps in the state any more");

        // the transcript, read back from the subagent's log
        const transcript = raw.client.claudeTranscript(raw.node, agent, session);
        assert.ok(transcript !== undefined);
        await until(transcript, () => transcript.items.some((item) => item.kind === "custom"));
        const roles = transcript.items.map((item) => (item.kind === "message" ? item.message.role : item.kind));
        assert.deepEqual(roles.slice(0, 2), ["user", "assistant"], "the instruction first, once");
        const all = JSON.stringify(transcript.items);
        assert.match(all, /"thinking":"weighing it"/);
        assert.match(all, /"name":"edit","arguments":\{"path":"[^"]*t\.txt","edits"/, "Edit as pi's edit");
        const task = transcript.items.find((item) => item.kind === "message" && item.message.role === "toolResult" && item.message.toolCallId === "t1");
        assert.deepEqual(task?.kind === "message" ? task.message.details : undefined, { steps: [{ kind: "tool", id: "t2", name: "bash", args: { command: "npm test" }, result: "3 passing", isError: false }], running: false });
        assert.ok(!transcript.items.some((item) => item.kind === "message" && JSON.stringify(item.message).includes("t2") && item !== task), "the subagent's step only inside its Task");
        assert.ok(
          model.state.tasks.some((row) => row.id === "ag1" && row.toolUseId === "t1"),
          "the subagent of Claude's names its Task call",
        );

        // live: the next run's messages reach the open transcript as they come
        const before = transcript.items.length;
        stand.claude([[{ text: "and live" }]]);
        await delegate(raw, agent, model, (turns) => stand.script(turns as never), "more", { session });
        await until(transcript, () => transcript.items.length > before && JSON.stringify(transcript.items.slice(before)).includes("and live"));
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
        assert.match(await delegate(raw, agent, model, (turns) => stand.script(turns as never), "b"), /older than 2\.1\.285/);
        stand.claude([[{ text: "x" }]], { keySource: "ANTHROPIC_API_KEY" });
        assert.match(await delegate(raw, agent, model, (turns) => stand.script(turns as never), "c"), /uses an API key/);
      },
    },
  ],
});

runScenario(scenario);
