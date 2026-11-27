// The keyboard's policy: every action routes in the modes it acts in; captors keep every key but
// their way out; global keys meet neither editing nor the chat's own; in every profile each action
// has a key that arrives, or a way named; a browser names keys by their place (any layout).

import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAT_ACTIONS, GLOBAL_ACTIONS, globalKeys, TAB_GOTO, type ActionId } from "./actions.ts";
import { editingKeys } from "./editing.ts";
import { domKeyName } from "./keys.ts";
import { modeOf, type Mode } from "./modes.ts";
import { PROFILES } from "./profiles.ts";
import { route, routedKeys } from "./policy.ts";

const CHAT: Mode = { kind: "chat" };
const DIALOG: Mode = { kind: "dialog" };
const PANEL: Mode = { kind: "panel" };

test("global actions act with Ctrl and with Alt in the chat, dialogs and the panel; the chat's own only in the chat", () => {
  for (const [action, spec] of Object.entries(GLOBAL_ACTIONS)) {
    for (const key of globalKeys(spec.key)) {
      assert.deepEqual(route(CHAT, key), { kind: "action", action }, key);
      const elsewhere = action === "clipboard.copy" || action === "clipboard.paste" ? { kind: "owner" } : { kind: "action", action };
      assert.deepEqual(route(DIALOG, key), elsewhere, key);
      assert.deepEqual(route(PANEL, key), elsewhere, key);
    }
  }
  for (const [action, spec] of Object.entries(CHAT_ACTIONS)) {
    for (const key of spec.keys) {
      assert.deepEqual(route(CHAT, key), { kind: "action", action }, key);
      assert.deepEqual(route(DIALOG, key), { kind: "owner" }, `${key} is the dialog's`);
    }
  }
  assert.deepEqual(route(CHAT, "alt+7"), { kind: "action", action: "tabs.goto.7" });
  assert.deepEqual(route(CHAT, "a"), { kind: "owner" });
  assert.deepEqual(route(CHAT, undefined), { kind: "owner" });
});

test("captors keep every key; the terminal leaves by its own key", () => {
  for (const owner of ["terminal", "prompt", "component"] as const) {
    const mode: Mode = { kind: "capture", owner };
    for (const key of routedKeys()) {
      const leaves = owner === "terminal" && (key === "ctrl+/" || key === "alt+/");
      assert.deepEqual(route(mode, key), leaves ? { kind: "action", action: "terminal.toggle" } : { kind: "owner" }, `${owner}: ${key}`);
    }
  }
});

test("global keys meet neither editing nor the chat's own keys", () => {
  const globals = new Set([...Object.values(GLOBAL_ACTIONS).flatMap((spec) => globalKeys(spec.key)), ...TAB_GOTO.flatMap((goto) => globalKeys(goto.key))]);
  for (const key of [...editingKeys(), ...Object.values(CHAT_ACTIONS).flatMap((spec) => [...spec.keys])]) {
    assert.ok(!globals.has(key), `${key} is global and also editing's or the chat's`);
  }
});

test("in every profile each action has a key that arrives, or a way named", () => {
  const actions: [ActionId, string[]][] = [
    ...Object.entries(GLOBAL_ACTIONS).map(([action, spec]) => [action as ActionId, globalKeys(spec.key)] as [ActionId, string[]]),
    ["tabs.goto.1", globalKeys("1")],
    ...Object.entries(CHAT_ACTIONS).map(([action, spec]) => [action as ActionId, [...spec.keys]] as [ActionId, string[]]),
  ];
  for (const profile of PROFILES) {
    for (const [action, keys] of actions) {
      const arrives = keys.some((key) => !profile.lost(key));
      assert.ok(arrives || profile.elsewhere[action] !== undefined, `${profile.name}: no key of ${action} arrives (${keys.join(", ")})`);
    }
  }
});

test("modes: one at a time, captors first", () => {
  const base = { input: "editor" as const, panel: false, strip: false, terminal: false, prompt: false };
  assert.deepEqual(modeOf(base), { kind: "chat" });
  assert.deepEqual(modeOf({ ...base, input: "picker" }), { kind: "dialog" });
  assert.deepEqual(modeOf({ ...base, input: "newSession" }), { kind: "dialog" });
  assert.deepEqual(modeOf({ ...base, panel: true }), { kind: "panel" });
  assert.deepEqual(modeOf({ ...base, strip: true, input: "dialog" }), { kind: "panel" });
  assert.deepEqual(modeOf({ ...base, input: "component" }), { kind: "capture", owner: "component" });
  assert.deepEqual(modeOf({ ...base, panel: true, terminal: true }), { kind: "capture", owner: "terminal" });
  assert.deepEqual(modeOf({ ...base, prompt: true }), { kind: "capture", owner: "prompt" });
});

test("a browser names keys by their place: Ctrl+N in a Russian layout too; Shift only where it is a key of its own", () => {
  const key = (code: string, key: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}) =>
    domKeyName({ code, key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });
  assert.equal(key("KeyN", "т", { ctrlKey: true }), "ctrl+n");
  assert.equal(key("KeyN", "˜", { altKey: true }), "alt+n", "a Mac's Option prints a character: its place still names it");
  assert.equal(key("Slash", ".", { ctrlKey: true }), "ctrl+/");
  assert.equal(key("Backslash", "\\", { altKey: true }), "alt+\\");
  assert.equal(key("Digit3", "3", { altKey: true }), "alt+3");
  assert.equal(key("Tab", "Tab", { shiftKey: true }), "shift+tab");
  assert.equal(key("Enter", "Enter", { ctrlKey: true }), "ctrl+enter");
  assert.equal(key("KeyA", "A", { shiftKey: true }), "a");
  assert.equal(key("PageDown", "PageDown", { metaKey: true }), "ctrl+pageDown");
  assert.equal(key("ShiftLeft", "Shift", { shiftKey: true }), undefined);
});
