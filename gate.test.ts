/**
 * Tests of the write/edit gate (each mode's review by reach and profile, the dialog outside
 * the TUI) and of the bundled MCP servers per profile.
 *   node --test gate.test.ts
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bundledMcpServers, readProfile, type Manifest } from "./deps.ts";
import {
  askGateViaDialogs,
  changeReview,
  type ChangeReach,
  type TurnMode,
  GATE_COMMENT_PROMPTS,
  GATE_OPTIONS,
  GATE_TITLE,
  type DialogUI,
  type GateDecision,
} from "./gate.ts";

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

describe("change review by mode, reach and profile", () => {
  // [mode, reach, desktop with UI, desktop without UI, server]
  const table: [TurnMode, ChangeReach, string, string, string][] = [
    ["plan", "scratch", "allow", "allow", "allow"],
    ["plan", "cwd", "refuse", "refuse", "refuse"],
    ["plan", "outside", "refuse", "refuse", "refuse"],
    ["normal", "scratch", "allow", "allow", "allow"],
    ["normal", "cwd", "ask", "no-ui", "allow"],
    ["normal", "outside", "ask", "no-ui", "allow"],
    ["simple", "scratch", "allow", "allow", "allow"],
    ["simple", "cwd", "allow", "allow", "allow"],
    ["simple", "outside", "ask", "no-ui", "allow"],
  ];
  for (const [mode, reach, desktop, desktopNoUI, server] of table) {
    test(`${mode} / ${reach}`, () => {
      assert.equal(changeReview(mode, reach, "desktop", true), desktop);
      assert.equal(changeReview(mode, reach, "desktop", false), desktopNoUI);
      assert.equal(changeReview(mode, reach, "server", true), server);
      assert.equal(changeReview(mode, reach, "server", false), server);
    });
  }
});

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
    node: "/node",
    browser: "/chromium",
  } as unknown as Manifest["bin"];

  test("desktop: lightpanda, the real browser and the user-browser servers", () => {
    assert.deepEqual(Object.keys(bundledMcpServers(bin, "desktop")).sort(), [
      "browser",
      "chromium-devtools",
      "lightpanda",
      "playwright",
    ]);
  });

  test("server: lightpanda and the real browser", () => {
    assert.deepEqual(Object.keys(bundledMcpServers(bin, "server")).sort(), ["browser", "lightpanda"]);
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
