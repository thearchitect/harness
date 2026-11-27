// The session's terminal (plan polish-3 F): Ctrl+I (by the kitty protocol) shows a shell in the
// session's directory over the main area; hidden, the shell runs on and what it printed meanwhile is
// there when it shows again; Tab is the shell's while it is shown and the editor's otherwise; without
// the kitty protocol Alt+I toggles it; another tab hides it, coming back shows it; when the shell
// exits, Enter starts another.

import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { after, test } from "node:test";
import { setKittyProtocolActive } from "@earendil-works/pi-tui";
import { HubConnection } from "#client/connection.ts";
import { inProcessTransport } from "#hub/endpoints/transports.ts";
import { TuiDriver } from "#testkit/drivers/tui.ts";
import { createStand, type Stand } from "#testkit/stand/stand.ts";

const CTRL_I = "\x1b[105;5u";
const ALT_I = "\x1bi";

const stands: Stand[] = [];
const drivers: TuiDriver[] = [];
after(async () => {
  setKittyProtocolActive(false);
  for (const driver of drivers) {
    driver.stop();
  }
  for (const stand of stands) {
    await stand.down();
  }
});

test("the session's terminal: shown and hidden by its key, the shell runs on, Tab is its, Enter starts another", async () => {
  process.env.SHELL = "/bin/sh"; // the user's shell is theirs; this scenario speaks sh
  const stand = await createStand({});
  stands.push(stand);
  const tui = await TuiDriver.start(() => HubConnection.open(inProcessTransport(stand.hub), "tui", undefined, ["component-bridge"]), { cwd: stand.project });
  drivers.push(tui);
  const project = realpathSync(stand.project);
  const framed = (text: string): boolean => text.includes("╭─ terminal · ");

  // Ctrl+I: the frame, a shell in the session's directory
  setKittyProtocolActive(true);
  await tui.press(CTRL_I);
  await tui.waitForText((text) => framed(text) && text.includes("Ctrl+I hide"));
  await tui.type("PS1='$ '; cd \"$PWD\"; pwd\r");
  await tui.waitForText((text) => text.includes(`│${project}`) || text.includes(project));

  // Tab is the shell's: it completes
  await tui.type("echo hello > tabbed-file.txt\r");
  await tui.type("cat tabbed-f");
  await tui.press("\t");
  await tui.type("\r");
  await tui.waitForText((text) => text.includes("hello") && text.includes("tabbed-file.txt"));

  // hidden, the shell runs on
  await tui.type("sleep 1; echo done-$((20+1))\r");
  await tui.press(CTRL_I);
  await tui.waitForText((text) => !framed(text));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await tui.press(CTRL_I);
  await tui.waitForText((text) => framed(text) && text.includes("done-21"));

  // another tab hides it, coming back shows it
  const first = tui.workbench.active;
  await tui.workbench.newTab(tui.client.home ?? "", stand.project);
  await tui.waitForText((text) => !framed(text));
  await tui.workbench.activate(first);
  await tui.waitForText((text) => framed(text) && text.includes("done-21"));

  // the shell exits: Enter starts another
  await tui.type("exit\r");
  await tui.waitForText((text) => text.includes("[exited 0] · Enter restarts"));
  await tui.press("\r");
  await tui.type("echo again-$((1+1))\r");
  await tui.waitForText((text) => framed(text) && text.includes("again-2"));

  // without the kitty protocol: Tab stays the editor's, Alt+I toggles
  await tui.press(CTRL_I);
  await tui.waitForText((text) => !framed(text));
  setKittyProtocolActive(false);
  await tui.press("\t");
  assert.ok(!framed(tui.text()), "Tab is not the terminal's key");
  await tui.press(ALT_I);
  await tui.waitForText((text) => framed(text) && text.includes("Alt+I hide"));
  await tui.press(ALT_I);
  await tui.waitForText((text) => !framed(text));
});
