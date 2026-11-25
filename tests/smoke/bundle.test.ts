// Smoke tests of a built bundle (HARNESS_BUNDLE: its directory; skipped without it): the command
// runs, pi's account commands pass through, an agent of the bundle loads every bundled package
// and MCP server and runs a scripted turn, the bundled tools are where the manifest says.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { promisify } from "node:util";
import { createStand, nextRecord, type Stand } from "#testkit/stand/stand.ts";

const run = promisify(execFile);
const bundle = process.env.HARNESS_BUNDLE;
const skip = bundle === undefined || bundle === "" ? "HARNESS_BUNDLE is not set (nix/check.nix sets it)" : false;

describe("the bundle", { skip }, () => {
  const root = bundle ?? "";
  const manifest = skip === false ? (JSON.parse(readFileSync(join(root, "share/harness/manifest.json"), "utf8")) as { piExtensions: string[]; bundled: Record<string, { mode: string; bins: string[]; path?: string }>; bin: Record<string, string> }) : undefined;
  const stands: Stand[] = [];
  after(async () => {
    for (const stand of stands) {
      await stand.down();
    }
  });

  test("harness --help and pi's account commands run", async () => {
    const help = await run(join(root, "bin/harness"), ["--help"]);
    assert.match(help.stdout, /harness node/);
    const list = await run(join(root, "bin/harness"), ["list"], { env: { ...process.env, HARNESS_HOME: join(process.env.TMPDIR ?? "/tmp", "smoke-home") } });
    assert.equal(typeof list.stdout, "string");
  });

  test("an agent of the bundle loads every package and runs a turn with bash", async () => {
    const stand = await createStand({ bundle: root });
    stands.push(stand);
    stand.script([{ toolCalls: [{ name: "bash", args: { command: "echo smoke-ok" } }] }, { text: "done" }]);
    const client = await stand.connect();
    const { agent } = await client.request("agent_start", { cwd: stand.project });
    await client.request("agent_attach", { agent: agent.id, level: "full" });
    const end = nextRecord(client, agent.id, (record) => record.type === "tool_execution_end");
    await client.call(agent.id, { type: "harness_prompt", text: "smoke", mode: "plan" });
    assert.match(JSON.stringify((await end).result), /smoke-ok/);
    const logs = readdirSync(join(stand.dataDir, "log", "agents")).map((file) => readFileSync(join(stand.dataDir, "log", "agents", file), "utf8")).join("\n");
    assert.doesNotMatch(logs, /Failed to load extension/);
    assert.ok((manifest?.piExtensions.length ?? 0) > 0);
  });

  test("share/harness: the documents, the sources and pi's documents the documents link to", () => {
    for (const path of ["docs/index.md", "docs/protocol/reference/hap.md", "src/packages/extension/src/core/prompt.yaml", "pi/coding-agent/docs/extensions.md", "pi/tui/dist/index.d.ts"]) {
      assert.ok(existsSync(join(root, "share/harness", path)), path);
    }
    // the prompt's paths, as an agent of the bundle computes them
    assert.ok(existsSync(join(root, "share/harness/src/docs/index.md")));
    assert.ok(existsSync(join(root, "share/harness/src/pi/coding-agent/docs")));
  });

  test("bundled tools: installed ones exist where the manifest says, \"path\" ones are linked in bin/", () => {
    for (const [id, tool] of Object.entries(manifest?.bundled ?? {})) {
      for (const bin of tool.bins) {
        if (tool.mode !== "none") {
          assert.ok(tool.path?.split(":").some((dir) => existsSync(join(dir, bin))), `${id}: ${bin} on the agent's PATH`);
        } else {
          // left out of the bundle
        }
        assert.equal(existsSync(join(root, "bin", bin)), tool.mode === "path", `${id}: ${bin} in bin/ only in mode path`);
      }
    }
    for (const [id, path] of Object.entries(manifest?.bin ?? {})) {
      assert.ok(existsSync(path), `${id}: ${path}`);
    }
  });
});
