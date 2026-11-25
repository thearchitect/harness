// What a built bundle sends to models (HARNESS_BUNDLE: its directory; skipped without it): the
// system prompt and the tools of a session's agent, and the prompt appended to Claude Code for the
// builder, against golden files (tests/fixtures/), and the invariants behind them. A change of the
// prompt or of a tool's schema fails here until the golden files are written again on purpose:
//
//   HARNESS_BUNDLE=$(readlink -f result) HARNESS_UPDATE_GOLDEN=1 nix/check.sh tests/smoke/prompt.test.ts

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { getCurrentSystemPrompt, getCurrentTools, type Message } from "@earendil-works/pi-ai";
import { createStand, nextRecord, type Stand } from "#testkit/stand/stand.ts";

const bundle = process.env.HARNESS_BUNDLE;
const skip = bundle === undefined || bundle === "" ? "HARNESS_BUNDLE is not set (nix/check.nix sets it)" : false;
const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

/** A request the scenario model got: pi's transcript context (the prompt and tools are in its system messages). */
type Request = { agent: string; context: { messages: Message[] } };

/** The parts of a text that differ between builds and runs: store paths, the stand's directory, ids, dates. */
function normalized(text: string, stand: Stand): string {
  return text
    .replaceAll(bundle ?? "", "<bundle>")
    .replaceAll(stand.root, "<stand>")
    // a store path's hash and the harness version in its name (nix/package.nix harnessVersion)
    .replace(/\/nix\/store\/[0-9a-z]{32}-([^/\s"]*?)(-(?:[0-9a-f]{7}(?:-dirty)?|dev))?(?=[/\s"]|$)/g, "/nix/store/<hash>-$1")
    .replace(/\d{4}-\d{2}-\d{2}--\d{2}-\d{2}--[0-9a-f-]{36}/g, "<session-workspace>");
}

function golden(name: string, actual: string): void {
  const path = join(FIXTURES, name);
  if (process.env.HARNESS_UPDATE_GOLDEN === "1") {
    writeFileSync(path, actual);
  } else {
    assert.ok(existsSync(path), `${path} is missing: write it with HARNESS_UPDATE_GOLDEN=1`);
    const expected = readFileSync(path, "utf8").split("\n");
    const lines = actual.split("\n");
    const first = lines.findIndex((line, index) => line !== expected[index]);
    const at = first >= 0 ? first : lines.length !== expected.length ? Math.min(lines.length, expected.length) : -1;
    // the first differing line, not the whole text: the files are tens of kilobytes
    assert.ok(
      at < 0,
      `${name} changed at line ${at + 1} (if on purpose, write it again with HARNESS_UPDATE_GOLDEN=1):\n  expected: ${JSON.stringify(expected[at]?.slice(0, 400))}\n  actual:   ${JSON.stringify(lines[at]?.slice(0, 400))}`,
    );
  }
}

/** The top-level sections of a rendered prompt, in order. */
function sectionNames(prompt: string): string[] {
  return [...prompt.matchAll(/^<([a-z_]+)>$/gm)].map((match) => match[1] ?? "").filter((name, index, all) => prompt.includes(`\n</${name}>`) && all.indexOf(name) === index);
}

function section(prompt: string, name: string): string {
  return new RegExp(`^<${name}>\\n([\\s\\S]*?)\\n</${name}>$`, "m").exec(prompt)?.[1] ?? "";
}

describe("what the bundle sends to models", { skip }, () => {
  const stands: Stand[] = [];
  after(async () => {
    for (const stand of stands) {
      await stand.down();
    }
  });

  test("the session's system prompt and tools; the MCP server reached through codemode; the builder's prompt", async () => {
    const stand = await createStand({ bundle: bundle ?? "", mcpProbe: true });
    stands.push(stand);
    writeFileSync(join(stand.project, "AGENTS.md"), "Project rule: run the local checks.\n");
    stand.script([
      { toolCalls: [{ name: "codemode", args: { code: 'const r = await tools.mcp__probe__echo({ text: "hi" }); text(r.content[0].text);' } }] },
      { toolCalls: [{ name: "subagent", args: { agent: "builder", instruction: "Do it." } }] },
      { text: "done" },
    ]);
    stand.claude([[{ mcp: { name: "mcp__probe__echo", arguments: { text: "from claude" } } }, { text: "built" }]]);
    const client = await stand.connect();
    const { agent } = await client.request("agent_start", { cwd: stand.project });
    await client.request("agent_attach", { agent: agent.id, level: "full" });
    const codemode = nextRecord(client, agent.id, (record) => record.type === "tool_execution_end" && (record as { toolName?: string }).toolName === "codemode");
    const subagent = nextRecord(client, agent.id, (record) => record.type === "tool_execution_end" && (record as { toolName?: string }).toolName === "subagent");
    await client.call(agent.id, { type: "harness_prompt", text: "check", mode: "build" });
    assert.match(JSON.stringify((await codemode).result), /echo: hi/, "the MCP server's tool through codemode");
    assert.match(JSON.stringify((await subagent).result), /built/);

    const request = (stand.requests() as Request[]).find((candidate) => candidate.agent === "main");
    assert.ok(request !== undefined, "the session's model got a request");
    const prompt = getCurrentSystemPrompt(request.context.messages);
    const tools = getCurrentTools(request.context.messages);

    // the order of the sections: harness's, then the other extensions'
    const names = sectionNames(prompt);
    assert.deepEqual(names.slice(names.indexOf("tools"), names.indexOf("tools") + 6), ["tools", "rules", "mode_policies", "engineering_principles", "code_exploration", "harness_docs"]);
    for (const name of ["project_context", "skills", "cwd", "magic_context", "mcp_servers"]) {
      assert.ok(names.includes(name), `<${name}> in ${names.join(", ")}`);
    }
    assert.ok(names.indexOf("magic_context") > names.indexOf("harness_docs") && names.indexOf("mcp_servers") > names.indexOf("harness_docs"));
    // every tool the prompt lists is declared; the bundle's packages' tools are there
    const declared = tools.map((tool) => tool.name);
    for (const line of section(prompt, "tools").split("\n")) {
      const name = /^- ([a-z0-9_]+):/.exec(line)?.[1];
      assert.ok(name === undefined || declared.includes(name), `${name} listed but not declared`);
    }
    for (const name of ["read", "bash", "edit", "write", "codemode", "subagent", "ask_user", "ctx_search", "ctx_reduce", "web_search", "ollama_web_search"]) {
      assert.ok(declared.includes(name), `${name} among ${declared.join(", ")}`);
    }
    // skills and documents the prompt points at exist
    for (const location of section(prompt, "skills").matchAll(/<location>([^<]+)<\/location>/g)) {
      assert.ok(existsSync(location[1] ?? ""), location[1]);
    }
    assert.match(section(prompt, "mcp_servers"), /probe/);
    assert.match(section(prompt, "project_context"), /Project rule: run the local checks\./);

    golden("system-prompt.golden.md", normalized(prompt, stand));
    golden("tools.golden.json", `${normalized(JSON.stringify(tools.map(({ name, description, parameters }) => ({ name, description, parameters })).sort((a, b) => a.name.localeCompare(b.name)), null, 2), stand)}\n`);

    // the builder's prompt: Claude's names, the session's project context, the mode's policy
    const start = stand.claudeStarts().at(-1);
    assert.ok(start !== undefined, "Claude started");
    const claudePrompt = start.argv[start.argv.indexOf("--append-system-prompt") + 1] ?? "";
    assert.match(claudePrompt, /Project rule: run the local checks\./);
    assert.match(claudePrompt, /harness runs you in BUILD mode/);
    assert.match(section(claudePrompt, "mcp_servers"), /probe/);
    assert.doesNotMatch(claudePrompt, /`(read|edit|write)`|subagent-builder|Call `subagent` only/);
    // harness's tools as the bridge offers them (declared and codemode-only ones), never pi's read/edit/write, ctx_* or subagent
    assert.ok(!stand.claudeTools().some((name) => name.startsWith("ctx_") || ["subagent", "read", "edit", "write"].includes(name)), stand.claudeTools().join(", "));
    for (const tool of ["bash", "task_start", "ask_secret", "lsp_references", "mcp__probe__echo"]) {
      assert.ok(stand.claudeTools().includes(tool), `Claude gets ${tool}: ${stand.claudeTools().join(", ")}`);
    }
    golden("claude-prompt.golden.md", normalized(claudePrompt, stand));
  });
});
