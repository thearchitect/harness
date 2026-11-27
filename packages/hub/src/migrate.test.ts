// Moving a home of the flat layout: pi's files to agent/, the hub's to hub/ (the tabs of ui.tabs and
// the window's drafts into its workspace, a hand-written configuration into its network access),
// the clients' to client/ (the window's state without drafts, this machine's hub named local), the
// old multi-user files gone; a backup first; a second run does nothing; a run stopped halfway goes
// on; an older hub running stops it.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { layoutOf } from "#protocol/layout.ts";
import { migrateHome, needsMigration } from "./migrate.ts";

function flatHome(): string {
  const home = join(mkdtempSync(join(tmpdir(), "mig-")), ".harness");
  const put = (path: string, value: unknown): void => {
    mkdirSync(join(home, path, ".."), { recursive: true });
    writeFileSync(join(home, path), typeof value === "string" ? value : JSON.stringify(value));
  };
  const session = join(home, "sessions", "--p--", "a.jsonl");
  put("auth.json", { openai: { type: "api_key", key: "k" } });
  put("settings.json", { defaultModel: "m" });
  put("mcp.json", { mcpServers: {} });
  put("keybindings.json", {});
  put("themes/mine.json", {});
  put("sessions/--p--/a.jsonl", "{}\n");
  put("harness.json", { variant: "simple" });
  put("ui-settings.json", {
    "ui.theme": "light",
    "ui.tabs": [
      { node: "default", sessionId: "a", sessionFile: session, cwd: "/p", seen: 5 },
      { node: "fly", sessionId: "r", sessionFile: "/remote/r.jsonl", cwd: "/q" },
    ],
  });
  put("ui-state/tui.json", { version: 1, tabs: { "default/a": { draft: "half written", scroll: "follow", expanded: true, selected: "session" } }, active: { node: "default", sessionId: "a" }, node: "default", drafts: [] });
  put("remotes.json", [{ name: "fly", url: "wss://fly", token: "t" }]);
  put("nodes/default.json", { hub: { listen: "127.0.0.1:8790", url: "https://h" } });
  put("users/alice/ui-settings.json", {});
  put("hub/users.json", []);
  put("hub/devices.json", []);
  put("sockets/default.sock", "");
  put("locks/x.lock", "1");
  put("log/node-default.jsonl", "");
  return home;
}

test("a flat home moves to its layout, with a backup; a second run does nothing", () => {
  const home = flatHome();
  const layout = layoutOf(home);
  assert.ok(needsMigration(home));
  const migration = migrateHome(home, false);

  assert.ok(migration.backup !== undefined && existsSync(migration.backup), "a backup next to it");
  assert.deepEqual(readdirSync(home).sort(), ["agent", "client", "hub", "log", "run"]);
  assert.deepEqual(readdirSync(layout.agent).sort(), ["auth.json", "keybindings.json", "mcp.json", "settings.json", "themes"]);
  assert.ok(existsSync(join(layout.sessions, "--p--", "a.jsonl")));
  assert.deepEqual(JSON.parse(readFileSync(layout.defaults, "utf8")), { variant: "simple" });
  assert.deepEqual(JSON.parse(readFileSync(layout.hubSettings, "utf8")), { "ui.theme": "light", "hub.network": { enabled: true, listen: "127.0.0.1:8790", proxy: false, url: "https://h" } });

  const workspace = JSON.parse(readFileSync(layout.workspace, "utf8")) as { tabs: { sessionId: string; sessionFile: string; draft?: { text: string } }[] };
  assert.deepEqual(
    workspace.tabs.map((tab) => [tab.sessionId, tab.sessionFile, tab.draft?.text]),
    [["a", join(layout.sessions, "--p--", "a.jsonl"), "half written"]],
    "this machine's tabs, at their sessions' new place, with the drafts the window kept",
  );
  assert.deepEqual(JSON.parse(readFileSync(layout.window, "utf8")), {
    version: 2,
    tabs: { "local/a": { scroll: "follow", expanded: true, selected: "session" } },
    active: { hub: "local", sessionId: "a" },
    hub: "local",
  });
  assert.deepEqual(JSON.parse(readFileSync(layout.remotes, "utf8")), [{ name: "fly", url: "wss://fly", token: "t" }]);
  assert.deepEqual(readdirSync(layout.hub).sort(), ["defaults.json", "devices.json", "sessions", "settings.json", "workspace.json"]);
  assert.ok(migration.notes.some((note) => /users\/ removed/.test(note)));

  assert.equal(needsMigration(home), false);
  assert.deepEqual(migrateHome(home, false), { moved: [], notes: [] });
});

test("a run stopped halfway goes on; an older hub running stops it before anything moves", () => {
  const home = flatHome();
  assert.throws(() => migrateHome(home, true), /an older harness hub still runs/);
  assert.ok(existsSync(join(home, "ui-settings.json")), "nothing moved");

  // halfway: the sessions moved already, the rest not
  const layout = layoutOf(home);
  mkdirSync(layout.hub, { recursive: true });
  renameSync(join(home, "sessions"), layout.sessions);
  const rest = migrateHome(home, false);
  assert.ok(rest.moved.includes("ui-settings.json → hub/settings.json"));
  assert.ok(existsSync(join(layout.sessions, "--p--", "a.jsonl")));
  assert.ok(existsSync(join(layout.agent, "auth.json")));
  assert.equal(needsMigration(home), false);
});
