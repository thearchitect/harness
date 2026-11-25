import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GatePayload, InteractionKind } from "#protocol/interactions.ts";
import type { RunMode } from "#protocol/state.ts";
import type { Interactions } from "../host.ts";
import { createAuthorizer } from "./authorize.ts";
import { changeReview, type ChangeReach } from "./gate.ts";

describe("changeReview", () => {
  test("every mode by every reach", () => {
    const expected: Record<RunMode, Record<ChangeReach, string>> = {
      plan: { scratch: "allow", cwd: "refuse", outside: "refuse" },
      build: { scratch: "allow", cwd: "ask", outside: "ask" },
      simple: { scratch: "allow", cwd: "allow", outside: "ask" },
    };
    for (const mode of ["plan", "build", "simple"] as const) {
      for (const reach of ["scratch", "cwd", "outside"] as const) {
        assert.equal(changeReview(mode, reach), expected[mode][reach], `${mode}/${reach}`);
      }
    }
  });
});

describe("the change authorizer", () => {
  // The temp directory is scratch space in every mode: the project is its sibling, not inside it.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gate-test-")));
  const project = join(base, "project");
  const savedTmp = process.env.TMPDIR;
  mkdirSync(project);
  mkdirSync(join(base, "tmp"));
  process.env.TMPDIR = join(base, "tmp");
  after(() => {
    if (savedTmp === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = savedTmp;
    }
    rmSync(base, { recursive: true, force: true });
  });
  const ctx = {
    cwd: project,
    sessionManager: { getHeader: () => ({ id: "s1", timestamp: "2026-01-01T00:00:00Z" }) },
    signal: undefined,
  } as unknown as ExtensionContext;

  function setup(mode: RunMode, answer: unknown, madness = false) {
    const asked: GatePayload[] = [];
    const steered: string[] = [];
    const interactions: Interactions = {
      async ask(kind: InteractionKind, payload: unknown) {
        assert.equal(kind, "gate");
        asked.push(payload as GatePayload);
        return answer as never;
      },
    };
    const authorize = createAuthorizer({ interactions, mode: () => mode, madness: () => madness, steer: (text) => steered.push(text) });
    return { authorize, asked, steered };
  }

  const change = (path: string) => ({ tool: "write", toolCallId: "c1", paths: [path], lines: [`write: ${path}`] });

  test("scratch space is free in PLAN; the rest of the project is refused there without asking", async () => {
    const { authorize, asked } = setup("plan", undefined);
    assert.deepEqual(await authorize(ctx, change(join(tmpdir(), "x.txt"))), { kind: "allowed" });
    const refused = await authorize(ctx, change("src/a.ts"));
    assert.equal(refused.kind, "blocked");
    assert.equal(asked.length, 0);
  });

  test("BUILD asks; an approval's comment is steered and returned for the result", async () => {
    const { authorize, asked, steered } = setup("build", { action: "allow", comment: "keep it short" });
    const decision = await authorize(ctx, change("src/a.ts"));
    assert.deepEqual(decision, { kind: "allowed", comment: "keep it short" });
    assert.deepEqual(asked[0]?.paths, ["src/a.ts"]);
    assert.equal(asked[0]?.kind, "write");
    assert.deepEqual(steered, ["keep it short"]);
  });

  test("a rejection with a comment blocks the call, keeps the run and steers the comment", async () => {
    const { authorize, steered } = setup("build", { action: "reject", comment: "wrong file" });
    assert.deepEqual(await authorize(ctx, change("src/a.ts")), { kind: "blocked", terminate: false, reason: "File change rejected by user — wrong file" });
    assert.deepEqual(steered, ["wrong file"]);
  });

  test("Stop, and an interaction closed unanswered, end the run without a steer", async () => {
    for (const answer of [{ action: "stop" }, undefined]) {
      const { authorize, steered } = setup("build", answer);
      const decision = await authorize(ctx, change("src/a.ts"));
      assert.equal(decision.kind === "blocked" && decision.terminate, true);
      assert.deepEqual(steered, []);
    }
  });

  test("SIMPLE writes the current directory freely and asks for paths outside it", async () => {
    const { authorize, asked } = setup("simple", { action: "allow" });
    assert.deepEqual(await authorize(ctx, change("src/a.ts")), { kind: "allowed" });
    assert.equal(asked.length, 0);
    assert.deepEqual(await authorize(ctx, change("/etc/harness-gate-test")), { kind: "allowed" });
    assert.equal(asked.length, 1);
  });

  test("madness lets everything through in every mode", async () => {
    const { authorize, asked } = setup("plan", undefined, true);
    assert.deepEqual(await authorize(ctx, change("/etc/harness-gate-test")), { kind: "allowed" });
    assert.equal(asked.length, 0);
  });
});
