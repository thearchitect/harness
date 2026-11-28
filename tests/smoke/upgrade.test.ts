// The way up from an older version, on the product: a user's home as the flat layout of before
// (pi's files at the top, sessions/, harness.json, ui-settings.json with ui.tabs on node
// "default", the window's ui-state/tui.json of version 1 with a draft, the old event log), made
// from a session the product itself wrote. The bundle's harness moves it on start (a backup next
// to it) and the golden path goes on: the tab is there with its draft, it answers, the browser
// shows it, and nothing is logged as an error.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { readLogs } from "#hub/log-files.ts";
import { ProductTui } from "#testkit/drivers/product.ts";
import { WebDriver } from "#testkit/drivers/web.ts";
import { createStandHome, type StandHome } from "#testkit/stand/stand.ts";

const bundle = process.env.HARNESS_BUNDLE;
const skip = bundle === undefined || bundle === "" ? "HARNESS_BUNDLE is not set (nix/check.nix sets it)" : (WebDriver.available() ?? false);

/** The home of today folded back into the flat layout of before, its tab and draft as the old window kept them. */
function flatten(home: StandHome, session: { id: string; file: string }): void {
  const root = home.dataDir;
  const layout = home.layout;
  const moved = (from: string, to: string): void => {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  };
  for (const name of readdirSync(layout.agent)) {
    moved(join(layout.agent, name), join(root, name));
  }
  moved(layout.sessions, join(root, "sessions"));
  const file = join(root, "sessions", session.file.slice(layout.sessions.length + 1));
  const settings = existsSync(layout.hubSettings) ? (JSON.parse(readFileSync(layout.hubSettings, "utf8")) as Record<string, unknown>) : {};
  writeFileSync(join(root, "ui-settings.json"), JSON.stringify({ ...settings, "ui.tabs": [{ node: "default", sessionId: session.id, sessionFile: file, cwd: home.project, seen: 1 }] }));
  writeFileSync(join(root, "harness.json"), "{}");
  mkdirSync(join(root, "ui-state"), { recursive: true });
  writeFileSync(
    join(root, "ui-state", "tui.json"),
    JSON.stringify({ version: 1, tabs: { [`default/${session.id}`]: { draft: "kept by the old window", scroll: "follow", expanded: false } }, active: { node: "default", sessionId: session.id }, node: "default", drafts: [] }),
  );
  for (const gone of [layout.agent, layout.hub, layout.client, layout.run, layout.log]) {
    rmSync(gone, { recursive: true, force: true });
  }
  mkdirSync(join(root, "log"), { recursive: true });
  writeFileSync(join(root, "log", "node-default.jsonl"), `${JSON.stringify({ at: 1, event: "node_start" })}\n`);
}

describe("the way up from an older version", { skip }, () => {
  const homes: StandHome[] = [];
  const tuis: ProductTui[] = [];
  const webs: WebDriver[] = [];
  after(() => {
    for (const web of webs) {
      web.stop();
    }
    for (const tui of tuis) {
      tui.kill();
    }
    for (const home of homes) {
      home.remove();
    }
  });

  test("a flat home moves on start; its tab, draft and session go on in both clients", { timeout: 180_000 }, async () => {
    const home = createStandHome();
    homes.push(home);
    const root = bundle ?? "";

    // a session the product wrote
    let session: { id: string; file: string };
    {
      const tui = await ProductTui.start({ bundle: root, home });
      tuis.push(tui);
      home.script([{ text: "written before the upgrade" }]);
      await tui.type("before");
      await tui.submit();
      await tui.waitForText((text) => text.includes("written before the upgrade"));
      const hub = await tui.hub();
      const tab = (await hub.request("workspace_get", {})).tabs[0];
      hub.close();
      assert.ok(tab !== undefined);
      session = { id: tab.sessionId, file: tab.sessionFile };
      assert.equal(await tui.quit(), 0);
    }
    flatten(home, session);

    // the bundle of now on it: moved, a backup next to it, the window as the old one left it
    const tui = await ProductTui.start({ bundle: root, home, args: [] });
    tuis.push(tui);
    assert.deepEqual(
      readdirSync(home.dataDir)
        .filter((name) => !name.startsWith("."))
        .sort(),
      ["agent", "client", "hub", "log", "run"],
    );
    assert.ok(readdirSync(dirname(home.dataDir)).some((name) => name.startsWith(".harness.backup-") || name.includes("backup")), "a backup next to the home");
    await tui.waitForText((text) => text.includes("written before the upgrade") && text.includes("kept by the old window"));
    home.script([{ text: "answered after the upgrade" }]);
    await tui.submit();
    await tui.waitForText((text) => text.includes("answered after the upgrade"));

    const web = await tui.web();
    webs.push(web);
    await web.waitForText((text) => text.includes("answered after the upgrade"));

    await tui.quit();
    assert.deepEqual(
      readLogs(home.layout.log)
        .filter((record) => record.level === "error")
        .map((record) => `${record.source} ${record.event} ${JSON.stringify(record).slice(0, 300)}`),
      [],
    );
  });
});
