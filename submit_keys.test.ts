/**
 * Tests of the harness submit defaults on pi's own keybindings manager:
 * Ctrl+Enter submits unless keybindings.json assigns submit or new line.
 *   node --test submit_keys.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
// pi exports the manager's type only; its class lives behind the package's exports.
import { KeybindingsManager } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { applySubmitKeyDefaults } from "./index.ts";

const HARNESS = { submit: ["ctrl+enter"], newLine: ["enter", "shift+enter", "ctrl+j"] };
const PI = { submit: ["enter"], newLine: ["shift+enter", "ctrl+j"] };

function keysOf(keybindings: KeybindingsManager): { submit: string[]; newLine: string[] } {
  return { submit: keybindings.getKeys("tui.input.submit"), newLine: keybindings.getKeys("tui.input.newLine") };
}

function withAgentDir(run: (agentDir: string, keybindings: KeybindingsManager) => void): void {
  const agentDir = mkdtempSync(join(tmpdir(), "submit-keys-test-"));
  try {
    run(agentDir, KeybindingsManager.create(agentDir));
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
}

function writeBindings(agentDir: string, bindings: Record<string, string[]>): void {
  writeFileSync(join(agentDir, "keybindings.json"), JSON.stringify(bindings));
}

describe("submit key defaults", () => {
  test("no keybindings.json: Ctrl+Enter submits, Enter inserts a new line; repeated calls change nothing", () => {
    withAgentDir((_agentDir, keybindings) => {
      applySubmitKeyDefaults(keybindings);
      assert.deepEqual(keysOf(keybindings), HARNESS);
      applySubmitKeyDefaults(keybindings);
      assert.deepEqual(keysOf(keybindings), HARNESS);
    });
  });

  test("the user assigns submit only: new line keeps pi's default", () => {
    withAgentDir((agentDir, keybindings) => {
      writeBindings(agentDir, { "tui.input.submit": ["enter"] });
      applySubmitKeyDefaults(keybindings);
      assert.deepEqual(keysOf(keybindings), PI);
    });
  });

  test("the user assigns new line only: submit keeps pi's default", () => {
    withAgentDir((agentDir, keybindings) => {
      writeBindings(agentDir, { "tui.input.newLine": ["shift+enter"] });
      applySubmitKeyDefaults(keybindings);
      assert.deepEqual(keysOf(keybindings), { submit: PI.submit, newLine: ["shift+enter"] });
    });
  });

  test("keybindings.json appears before /reload: the file is reread and pi's defaults return", () => {
    withAgentDir((agentDir, keybindings) => {
      applySubmitKeyDefaults(keybindings);
      assert.deepEqual(keysOf(keybindings), HARNESS);
      writeBindings(agentDir, { "tui.input.submit": ["enter"] });
      applySubmitKeyDefaults(keybindings);
      assert.deepEqual(keysOf(keybindings), PI);
      keybindings.reload(); // pi's own reread after session_start
      assert.deepEqual(keysOf(keybindings), PI);
    });
  });
});
