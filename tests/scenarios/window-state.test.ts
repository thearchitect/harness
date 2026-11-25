// What each tab leaves stays with it: the message being written and where its transcript was
// scrolled come back when the tab does, and a TUI started again (its state in ui-state/tui.json)
// has its tabs' drafts and scroll, its active tab and node as they were.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { NodeConnection } from "#client/connection.ts";
import { mergeWindowStates, type WindowState } from "#client/workbench/view-state.ts";
import { inProcessTransport } from "#node/endpoints/transports.ts";
import { TuiDriver } from "#testkit/drivers/tui.ts";
import { createStand, type Stand } from "#testkit/stand/stand.ts";
import { tuiViewStore } from "#tui/view-store.ts";

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

/** The transcript's lines on the screen (right of the strip, above the editor). */
function transcriptLines(tui: TuiDriver): string[] {
  return tui
    .text()
    .split("\n")
    .slice(0, 12)
    .map((line) => line.slice(19).trimEnd());
}

test("drafts and scroll stay with their tabs; a TUI started again has them, its active tab and node", async () => {
  const stand = await createStand({ snapshotEntries: 40 });
  stands.push(stand);
  const store = tuiViewStore(mkdtempSync(join(tmpdir(), "ws-")));
  const start = async (): Promise<TuiDriver> => {
    const driver = await TuiDriver.start(() => NodeConnection.open(inProcessTransport(stand.node), "tui", undefined, ["component-bridge"]), { cwd: stand.project, viewStore: store });
    drivers.push(driver);
    return driver;
  };
  const tui = await start();
  const node = tui.client.home ?? "";

  // tab A: a long session, kept by its first message
  stand.script([{ text: "answer A" }]);
  await tui.type("hello A");
  await tui.submit();
  await tui.waitForText((screen) => screen.includes("answer A"));
  for (let index = 0; index < 30; index += 1) {
    await tui.workbench.operatorBash(`echo line-${index}`, true);
  }
  const a = tui.workbench.activeTab();
  assert.ok(a !== undefined);

  // tab B
  await tui.workbench.newTab(node, stand.project);
  stand.script([{ text: "answer B" }]);
  await tui.type("hello B");
  await tui.submit();
  await tui.waitForText((screen) => screen.includes("answer B"));
  const b = tui.workbench.activeTab();
  assert.ok(b !== undefined && b.sessionId !== a.sessionId);

  // back to A: up a few pages, a draft
  await tui.workbench.activate(a.index);
  await tui.settle();
  for (let page = 0; page < 3; page += 1) {
    await tui.press("\x1b[5~");
  }
  await tui.type("draft of A");
  const scrolledA = transcriptLines(tui);
  assert.ok(!scrolledA.some((line) => line.includes("line-29")), "scrolled up from the end");

  // to B and back: each tab has its own editor and scroll
  await tui.workbench.activate(b.index);
  await tui.settle();
  const anchor = tui.workbench.view(a).scroll;
  assert.ok(anchor !== "follow" && anchor.key !== "", `A's scroll was kept: ${JSON.stringify(anchor)}`);
  assert.equal(tui.app.editorText(), "");
  await tui.type("draft of B");
  await tui.workbench.activate(a.index);
  await tui.settle();
  assert.equal(tui.app.editorText(), "draft of A");
  assert.deepEqual(transcriptLines(tui), scrolledA, "A's scroll came back");
  await tui.workbench.activate(b.index);
  await tui.settle();
  assert.equal(tui.app.editorText(), "draft of B");

  // A active, the TUI quits and starts again
  await tui.workbench.activate(a.index);
  await tui.settle();
  await tui.app.keepWindow();
  tui.stop();
  const again = await start();
  await again.settle();
  assert.equal(again.workbench.activeTab()?.sessionId, a.sessionId, "the active tab");
  assert.equal(again.screen().node, node, "the node");
  assert.equal(again.app.editorText(), "draft of A", "its draft (the cursor at its end)");
  await again.waitForText(() => transcriptLines(again).join("\n") === scrolledA.join("\n"));
  await again.workbench.activate(again.workbench.tabs().findIndex((tab) => tab.sessionId === b.sessionId));
  await again.settle();
  assert.equal(again.app.editorText(), "draft of B");
});

test("two windows' states merge by tab: each keeps the other's tabs; the last saved names the active tab", () => {
  const view = (draft: string) => ({ draft, scroll: "follow" as const, expanded: false, selected: "session" });
  const first: WindowState = { version: 1, tabs: { "n/a": view("a1"), "n/b": view("b1") }, active: { node: "n", sessionId: "a" }, drafts: [] };
  const second: WindowState = { version: 1, tabs: { "n/b": view("b2"), "n/c": view("c2") }, active: { node: "n", sessionId: "c" }, drafts: [] };
  const merged = mergeWindowStates(first, second);
  assert.deepEqual(Object.keys(merged.tabs).sort(), ["n/a", "n/b", "n/c"]);
  assert.equal(merged.tabs["n/b"]?.draft, "b2");
  assert.deepEqual(merged.active, { node: "n", sessionId: "c" });
});
