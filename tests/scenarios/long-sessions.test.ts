// Long sessions (plan polish-3 D): sessions are loaded ahead whole in the background — the window's
// tabs and the sessions of the hub's list, read from their files without agents — and a frame draws
// what is in sight, so scrolling costs the same in a session of 5000 entries as in one of 50, and the
// whole session is there to scroll and search to its first message. A session opened from the list
// shows at once from what was read; its agent starts meanwhile and carries on with the same items.

import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { cwdSessionsDir } from "#protocol/layout.ts";
import { after, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { HubConnection } from "#client/connection.ts";
import { agentKey } from "#client/model/client-model.ts";
import { inProcessTransport } from "#hub/endpoints/transports.ts";
import { TuiDriver } from "#testkit/drivers/tui.ts";
import { createStand, type Stand } from "#testkit/stand/stand.ts";

const ENTRIES = 5000;

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

/** A stored session of `ENTRIES` messages (user and assistant in turn), as pi writes it. */
function longSession(stand: Stand, name: string): { id: string; path: string } {
  const dir = cwdSessionsDir(stand.layout.sessions, resolve(stand.project));
  const session = SessionManager.create(stand.project, dir);
  for (let index = 0; index < ENTRIES / 2; index += 1) {
    session.appendMessage({ role: "user", content: [{ type: "text", text: `${name} question ${index}` }], timestamp: Date.now() });
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `${name} answer ${index}: **some** markdown\n\n- a\n- b` }],
      api: "openai-completions",
      provider: "scenario",
      model: "scripted",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    } as never);
  }
  const path = session.getSessionFile();
  assert.ok(path !== undefined);
  return { id: session.getSessionId(), path };
}

test("long sessions: loaded ahead whole, a frame draws what is in sight, the first message is a search away", async () => {
  const stand = await createStand({});
  stands.push(stand);
  const sessions = [longSession(stand, "alpha"), longSession(stand, "beta"), longSession(stand, "gamma"), longSession(stand, "listed")];
  const tui = await TuiDriver.start(() => HubConnection.open(inProcessTransport(stand.hub), "tui", undefined, ["component-bridge"]), { cwd: stand.project });
  drivers.push(tui);
  const node = tui.client.home ?? "";

  // three tabs of long sessions
  for (const session of sessions.slice(0, 3)) {
    await tui.workbench.openSession(node, { id: session.id, path: session.path, cwd: stand.project });
  }
  await tui.waitForText((screen) => screen.includes(`gamma answer ${ENTRIES / 2 - 1}`));

  // loaded ahead whole: the tabs' agents to their first entries, the listed session from its file
  await tui.waitForText(() => {
    const long = tui.workbench.tabs().filter((tab) => sessions.some((session) => session.id === tab.sessionId));
    const whole = long.length === 3 && long.every((tab) => tab.agent !== undefined && tui.client.full.get(agentKey(node, tab.agent.id))?.cursor === undefined && (tui.client.full.get(agentKey(node, tab.agent.id))?.items.length ?? 0) === ENTRIES);
    const listed = tui.client.storedModel(node, sessions[3]?.path);
    return whole && listed !== undefined && listed.cursor === undefined && listed.items.length === ENTRIES;
  }, 60_000);

  // a frame draws what is in sight: paging up draws a few blocks, not the session (the background done first)
  const drawing = Date.now();
  await tui.waitForText(() => tui.app.drawnAhead, 120_000);
  console.log(`drawn ahead in ${Date.now() - drawing} ms`);
  for (let page = 0; page < 5; page += 1) {
    const before = tui.app.blockDraws;
    await tui.press("\x1b[5~");
    await tui.settle();
    assert.ok(tui.app.blockDraws - before < 60, `a page up drew ${tui.app.blockDraws - before} blocks`);
  }

  // the first message, a search away
  await tui.press("\x06");
  await tui.type("gamma question 0");
  await tui.waitForText((screen) => screen.includes("gamma question 0") && screen.includes("gamma answer 0:"));
  await tui.press("\x1b");

  // the listed session opens at once from what was read; its agent carries on with the same items
  const listed = sessions[3];
  assert.ok(listed !== undefined);
  const read = tui.client.storedModel(node, listed.path);
  const first = read?.items[0];
  await tui.workbench.openSession(node, { id: listed.id, path: listed.path, cwd: stand.project });
  await tui.waitForText((screen) => screen.includes(`listed answer ${ENTRIES / 2 - 1}`));
  const tab = tui.workbench.activeTab();
  assert.ok(tab?.agent !== undefined);
  const model = tui.client.full.get(agentKey(node, tab.agent.id));
  assert.equal(model, read, "the model read from the file is the agent's");
  assert.equal(model?.items[0], first, "its items stay");
  assert.equal(model?.items.length, ENTRIES);
});
