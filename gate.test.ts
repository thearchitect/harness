/**
 * Tests of the write/edit gate dialog outside the TUI (RPC clients) and of
 * the bundled MCP servers per profile.
 *   node --test gate.test.ts
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bundledMcpServers, readProfile, type Manifest } from "./deps.ts";
import {
  askGateViaDialogs,
  GATE_COMMENT_PROMPTS,
  GATE_OPTIONS,
  GATE_TITLE,
  type DialogUI,
  type GateDecision,
} from "./rpc-dialogs.ts";

type Recorded = { selects: { title: string; options: string[] }[]; inputs: string[] };

/** Dialogs that answer from the given script and record what was asked. */
function scriptedUI(select: string | undefined, input?: string): { ui: DialogUI; recorded: Recorded } {
  const recorded: Recorded = { selects: [], inputs: [] };
  const ui: DialogUI = {
    select: async (title: string, options: string[]): Promise<string | undefined> => {
      recorded.selects.push({ title, options });
      return select;
    },
    input: async (title: string): Promise<string | undefined> => {
      recorded.inputs.push(title);
      return input;
    },
  };
  return { ui, recorded };
}

async function decide(select: string | undefined, input?: string): Promise<{ decision: GateDecision; recorded: Recorded }> {
  const { ui, recorded } = scriptedUI(select, input);
  const decision = await askGateViaDialogs(ui, ["edit src/x.ts", "+ new line"]);
  return { decision, recorded };
}

describe("gate dialog outside the TUI", () => {
  test("one select with the contract title, details and options", async () => {
    const { recorded } = await decide(GATE_OPTIONS.allow);
    assert.deepEqual(recorded.selects, [
      {
        title: `${GATE_TITLE}\nedit src/x.ts\n+ new line`,
        options: [GATE_OPTIONS.allow, GATE_OPTIONS.allowWithComment, GATE_OPTIONS.rejectWithComment, GATE_OPTIONS.stop],
      },
    ]);
  });

  test("Allow asks for no comment", async () => {
    const { decision, recorded } = await decide(GATE_OPTIONS.allow);
    assert.deepEqual(decision, { action: "allow" });
    assert.deepEqual(recorded.inputs, []);
  });

  test("Allow with comment carries the comment; an empty one allows without it", async () => {
    const withComment = await decide(GATE_OPTIONS.allowWithComment, "  keep it short ");
    assert.deepEqual(withComment.decision, { action: "allow", comment: "keep it short" });
    assert.deepEqual(withComment.recorded.inputs, [GATE_COMMENT_PROMPTS.allowWithComment]);
    const empty = await decide(GATE_OPTIONS.allowWithComment, "   ");
    assert.deepEqual(empty.decision, { action: "allow", comment: undefined });
  });

  test("Reject with comment carries the comment; an empty one stops", async () => {
    const withComment = await decide(GATE_OPTIONS.rejectWithComment, "wrong file");
    assert.deepEqual(withComment.decision, { action: "reject", comment: "wrong file" });
    assert.deepEqual(withComment.recorded.inputs, [GATE_COMMENT_PROMPTS.rejectWithComment]);
    const empty = await decide(GATE_OPTIONS.rejectWithComment, "");
    assert.deepEqual(empty.decision, { action: "stop" });
    const cancelled = await decide(GATE_OPTIONS.rejectWithComment, undefined);
    assert.deepEqual(cancelled.decision, { action: "stop" });
  });

  test("Stop and a cancelled select stop", async () => {
    assert.deepEqual((await decide(GATE_OPTIONS.stop)).decision, { action: "stop" });
    assert.deepEqual((await decide(undefined)).decision, { action: "stop" });
  });
});

describe("profiles", () => {
  const bin = {
    lightpanda: "/lp",
    "playwright-mcp": "/pw",
    "chrome-devtools-mcp": "/cd",
  } as unknown as Manifest["bin"];

  test("desktop: lightpanda and the user-browser servers", () => {
    assert.deepEqual(Object.keys(bundledMcpServers(bin, "desktop")).sort(), ["chromium-devtools", "lightpanda", "playwright"]);
  });

  test("server: lightpanda only", () => {
    assert.deepEqual(Object.keys(bundledMcpServers(bin, "server")), ["lightpanda"]);
  });

  test("HARNESS_PROFILE selects the profile; an unknown value is a problem", () => {
    const saved = process.env.HARNESS_PROFILE;
    try {
      delete process.env.HARNESS_PROFILE;
      assert.deepEqual(readProfile(), { profile: "desktop" });
      process.env.HARNESS_PROFILE = "";
      assert.deepEqual(readProfile(), { profile: "desktop" });
      process.env.HARNESS_PROFILE = "server";
      assert.deepEqual(readProfile(), { profile: "server" });
      process.env.HARNESS_PROFILE = "laptop";
      assert.deepEqual(readProfile(), { problem: "unknown HARNESS_PROFILE=laptop (expected server)" });
    } finally {
      if (saved === undefined) delete process.env.HARNESS_PROFILE;
      else process.env.HARNESS_PROFILE = saved;
    }
  });
});
