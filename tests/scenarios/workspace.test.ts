// The workspace across windows: a new session is its window's until it differs from a new one; a
// draft typed in one window is the other's too (not over the one being typed in); wiped back, the
// session is its window's again; after a restart a tab with a draft and no message comes back as a
// new session in its folder with the draft, and a tab whose session file is gone is removed and
// said so — no `starting…` forever.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { HubConnection } from "#client/connection.ts";
import { inProcessTransport } from "#hub/endpoints/transports.ts";
import { TuiDriver } from "#testkit/drivers/tui.ts";
import { createStand, type Stand } from "#testkit/stand/stand.ts";
import { tuiViewStore } from "#tui/view-store.ts";

async function closeAgents(stand: Stand): Promise<void> {
  const connection = await stand.connect();
  for (const agent of (await connection.request("agents_list", {})).agents) {
    await connection.request("agent_close", { agent: agent.id });
  }
}

const stands: Stand[] = [];
const drivers: TuiDriver[] = [];
after(async () => {
  for (const driver of drivers) {
    driver.stop();
  }
  for (const stand of stands) {
    await stand.down();
  }
});

test("drafts are the hub's: shared by windows, joining and leaving the workspace with the empty-session rule, surviving restarts", async () => {
  const stand = await createStand();
  stands.push(stand);
  const start = async (): Promise<TuiDriver> => {
    const driver = await TuiDriver.start(() => HubConnection.open(inProcessTransport(stand.hub), "tui", undefined, ["component-bridge"]), {
      cwd: stand.project,
      viewStore: tuiViewStore(mkdtempSync(join(tmpdir(), "ws-"))),
    });
    drivers.push(driver);
    return driver;
  };
  const first = await start();
  const hub = first.client.home ?? "";
  const shared = (tui: TuiDriver) => tui.client.workspaces.get(hub)?.tabs ?? [];

  // a new session: the first window's alone
  const fresh = first.workbench.activeTab();
  assert.ok(fresh !== undefined && fresh.draft);
  assert.deepEqual(shared(first), []);

  // a draft makes it differ: it joins, the other window has it with its draft
  await first.type("begun here");
  await first.workbench.flushDrafts();
  const second = await start();
  await second.waitForText(() => shared(second).some((tab) => tab.sessionId === fresh.sessionId && tab.draft?.text === "begun here"));
  const there = second.workbench.tabs().find((tab) => tab.sessionId === fresh.sessionId);
  assert.ok(there !== undefined && !there.draft);
  await second.workbench.activate(there.index);
  await second.settle();
  assert.equal(second.app.editorText(), "begun here", "finished on another device");

  // the second window writes on; the first shows it once it is not typing there (another tab shown)
  await second.type(", finished there");
  await second.workbench.flushDrafts();
  await first.waitForText(() => first.workbench.draftText(fresh) === "begun here, finished there");
  assert.equal(first.app.editorText(), "begun here", "the field being typed in is not overwritten");

  // wiped back to a new session: it leaves the workspace, the second window loses it, the first keeps it
  for (const _ of "begun here, finished there") {
    await second.press("\x7f");
  }
  await second.workbench.flushDrafts();
  await first.waitForText(() => !shared(first).some((tab) => tab.sessionId === fresh.sessionId));
  assert.ok(second.workbench.tabs().some((tab) => tab.sessionId === fresh.sessionId && tab.draft), "the window that wiped it keeps it as its own");

  // a draft and no message: after a restart a new session in its folder, the draft in it
  await second.type("kept across restarts");
  await second.workbench.flushDrafts();
  await first.waitForText(() => shared(first).some((tab) => tab.draft?.text === "kept across restarts"));
  first.stop();
  second.stop();
  await closeAgents(stand); // the hub starts again: no agent serves the session any more
  const third = await start();
  await third.waitForText(() => {
    const tab = shared(third).find((candidate) => candidate.draft?.text === "kept across restarts");
    return tab !== undefined && tab.sessionId !== fresh.sessionId && third.workbench.tabs().some((candidate) => candidate.sessionId === tab.sessionId && candidate.agent !== undefined);
  });

  // a session with a message whose file is gone: the tab goes, the status line says so
  stand.script([{ text: "answered" }]);
  const talked = await third.workbench.newTab(hub, stand.project);
  assert.ok(talked !== undefined);
  await third.type("hello");
  await third.submit();
  await third.waitForText((screen) => screen.includes("answered"));
  await third.waitForText(() => shared(third).some((tab) => tab.sessionId === talked.sessionId));
  const file = third.workbench.tabs().find((tab) => tab.sessionId === talked.sessionId)?.sessionFile ?? "";
  third.stop();
  await closeAgents(stand);
  rmSync(file);
  const fourth = await start();
  await fourth.workbench.activate(fourth.workbench.tabs().findIndex((tab) => tab.sessionId === talked.sessionId));
  await fourth.waitForText((screen) => screen.includes("its session file is gone, the tab was removed"));
  assert.ok(!shared(fourth).some((tab) => tab.sessionId === talked.sessionId));
  assert.ok(!fourth.text().includes("starting…"));
});
