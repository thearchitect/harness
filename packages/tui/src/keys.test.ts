// The TUI names the policy's keys from what terminals send: legacy bytes without the kitty protocol
// (ESC letter for Alt, control bytes for Ctrl, 0x1f for Ctrl+/), CSI u with it — a Russian layout's
// Ctrl+N by its base key; ESC p is Alt+P (pi-tui also reads it as Alt+↑).

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setKittyProtocolActive } from "@earendil-works/pi-tui";
import { GLOBAL_ACTIONS, globalKeys, TAB_GOTO } from "#client/input/actions.ts";
import { keyNameOf } from "./app.ts";

after(() => setKittyProtocolActive(false));

const LETTERS = Object.values(GLOBAL_ACTIONS)
  .map((spec) => spec.key)
  .filter((key) => key.length === 1);

test("without the kitty protocol: ESC letter, control bytes, 0x1f", () => {
  setKittyProtocolActive(false);
  for (const key of [...LETTERS, ...TAB_GOTO.map((goto) => goto.key)]) {
    assert.equal(keyNameOf(`\x1b${key}`), `alt+${key}`, `alt+${key}`);
  }
  for (const key of LETTERS.filter((key) => /[a-z]/.test(key))) {
    assert.equal(keyNameOf(String.fromCharCode(key.charCodeAt(0) - 96)), `ctrl+${key}`, `ctrl+${key}`);
  }
  assert.equal(keyNameOf("\x1c"), "ctrl+\\");
  assert.equal(keyNameOf("\x1f"), "ctrl+/");
  assert.equal(keyNameOf("\x1b[6;3~"), "alt+pageDown");
  assert.equal(keyNameOf("\x1b[1;3A"), "alt+up");
  assert.equal(keyNameOf("\x1b\r"), "alt+enter");
  assert.equal(keyNameOf("\t"), undefined, "Tab is the editor's");
  assert.equal(keyNameOf("\x08"), undefined, "Ctrl+Backspace's byte is editing's");
});

test("with it: CSI u, a Russian layout's keys by their base", () => {
  setKittyProtocolActive(true);
  for (const key of LETTERS) {
    for (const [modifier, name] of [[5, "ctrl"], [3, "alt"]] as const) {
      assert.equal(keyNameOf(`\x1b[${key.charCodeAt(0)};${modifier}u`), `${name}+${key}`, `${name}+${key}`);
    }
  }
  assert.equal(keyNameOf("\x1b[1090::110;5u"), "ctrl+n", "Ctrl+т is Ctrl+N");
  assert.equal(keyNameOf("\x1b[13;5u"), "ctrl+enter");
  assert.deepEqual(globalKeys("/"), ["ctrl+/", "alt+/"]);
});
