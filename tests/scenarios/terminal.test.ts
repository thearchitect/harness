// The session's terminal: Ctrl/Alt+/ shows a shell in the session's directory over the main area;
// hidden, the shell runs on and what it printed meanwhile is there when it shows again; while it is
// shown every key is the shell's (Tab, Ctrl+C, Esc, Ctrl+\, Ctrl+N) but its way out; without the
// kitty protocol Ctrl+/ is the byte 0x1f and Alt+/ is ESC /; another tab hides it, coming back shows
// it; when the shell exits, Enter starts another.

import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { after, test } from "node:test";
import { setKittyProtocolActive } from "@earendil-works/pi-tui";
import { HubConnection } from "#client/connection.ts";
import { inProcessTransport } from "#hub/endpoints/transports.ts";
import { TuiDriver } from "#testkit/drivers/tui.ts";
import { createStand, type Stand } from "#testkit/stand/stand.ts";

const CTRL_SLASH = "\x1b[47;5u";
const ALT_SLASH = "\x1b/";

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

  // Ctrl+/: the frame, a shell in the session's directory
  setKittyProtocolActive(true);
  await tui.press(CTRL_SLASH);
  await tui.waitForText((text) => framed(text) && text.includes("Ctrl/Alt+/ hide"));
  await tui.type("PS1='$ '; cd \"$PWD\"; pwd\r");
  await tui.waitForText((text) => text.includes(`│${project}`) || text.includes(project));

  // Tab is the shell's: it completes
  await tui.type("echo hello > tabbed-file.txt\r");
  await tui.type("cat tabbed-f");
  await tui.press("\t");
  await tui.type("\r");
  await tui.waitForText((text) => text.includes("hello") && text.includes("tabbed-file.txt"));

  // an arrow in every form this terminal reports it (a repeat among them) reaches the program as the
  // arrow; Ctrl+C ends it
  await tui.type("cat -v\r");
  await tui.press("\x1b[1;1:2A");
  await tui.press("\x1b[1;1A");
  await tui.press("\x1b[1;5D");
  await tui.type("\r");
  await tui.waitForText((text) => text.includes("^[[A^[[A^[[1;5D"));
  await tui.press("\x1b[99;5u");
  await tui.type("echo after-$((2*3))\r");
  await tui.waitForText((text) => text.includes("after-6"));

  // the workbench's keys are the shell's too: Ctrl+\ and Ctrl+N open neither the panel nor a session
  const tabs = tui.workbench.tabs().length;
  await tui.press("\x1c");
  await tui.press("\x1b[110;5u");
  await tui.settle();
  assert.ok(framed(tui.text()) && !tui.screen().zones.overlays.includes("panel"));
  assert.equal(tui.workbench.tabs().length, tabs);
  assert.equal(tui.screen().input, "editor");

  // hidden, the shell runs on
  await tui.type("sleep 1; echo done-$((20+1))\r");
  await tui.press(CTRL_SLASH);
  await tui.waitForText((text) => !framed(text));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await tui.press(ALT_SLASH.replace("\x1b/", "\x1b[47;3u"));
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

  // without the kitty protocol: Tab stays the editor's; Ctrl+/ (0x1f) and Alt+/ (ESC /) toggle
  await tui.press(CTRL_SLASH);
  await tui.waitForText((text) => !framed(text));
  setKittyProtocolActive(false);
  await tui.press("\t");
  assert.ok(!framed(tui.text()), "Tab is not the terminal's key");
  await tui.press("\x1f");
  await tui.waitForText((text) => framed(text));
  await tui.press(ALT_SLASH);
  await tui.waitForText((text) => !framed(text));
});
