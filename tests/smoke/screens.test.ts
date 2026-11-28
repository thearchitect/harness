// The product's screens, compared with their reviewed baselines (tests/fixtures/screens/) and
// checked against the rules of layout (capture/screens.ts): the bundle's real TUI and the web app
// its hub serves, the same screens in both — a session with an answer and a tool, choosing a new
// session's folder, the model list, the panel, the session's terminal — at three terminal sizes and
// three windows (phone, tablet, desktop), in the dark and the light theme. The sheet of the run
// (.test-reports/<run>/screens/<theme>/sheet.png) is for looking at; HARNESS_UPDATE_SCREENS=1
// accepts what it shows as the new baselines.

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GLOBAL_ACTIONS, type GlobalActionId } from "#client/input/actions.ts";
import { ScreenBook } from "#testkit/capture/screens.ts";
import { DARK_TERMINAL, LIGHT_TERMINAL } from "#testkit/capture/rasterize.ts";
import { ProductTui } from "#testkit/drivers/product.ts";
import { WebDriver } from "#testkit/drivers/web.ts";
import { reportsRoot } from "#testkit/report/report.ts";
import { createStandHome, type StandHome } from "#testkit/stand/stand.ts";

const bundle = process.env.HARNESS_BUNDLE;
const skip = bundle === undefined || bundle === "" ? "HARNESS_BUNDLE is not set (nix/check.nix sets it)" : (WebDriver.available() ?? false);

const TERMINALS = [
  { name: "80x24", columns: 80, rows: 24 },
  { name: "120x40", columns: 120, rows: 40 },
  { name: "200x60", columns: 200, rows: 60 },
] as const;
const WINDOWS = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "desktop", width: 1280, height: 800 },
] as const;

/** A screen state of both clients: how each reaches it, how it shows it is there, how each leaves it. */
type State = { name: string; action?: GlobalActionId; shows: string; then?: string; leave: "escape" | GlobalActionId | undefined };

const STATES: State[] = [
  { name: "answer", shows: "all done here", leave: undefined },
  { name: "new-session", action: "tabs.new", shows: "folder", leave: "escape" },
  { name: "models", action: "model.select", shows: "scripted", leave: "escape" },
  { name: "panel", action: "panel.toggle", shows: "HARNESS", leave: "panel.toggle" },
  { name: "terminal", action: "terminal.toggle", shows: "terminal", then: "echo screens-$((40+2))\r", leave: "terminal.toggle" },
];

/**
 * The session terminal's program on these screens: a prompt and `echo` with arithmetic, the same
 * bytes on every machine (a system's sh prints its own prompt and redraws it on a resize its own way).
 */
function plainShell(home: StandHome): string {
  const path = join(home.root, "plain-shell");
  writeFileSync(
    path,
    `#!${process.execPath}
const lines = require("node:readline").createInterface({ input: process.stdin });
process.stdout.write("$ ");
lines.on("line", (line) => {
  const echoed = /^echo (.*)$/.exec(line);
  if (echoed) {
    process.stdout.write(echoed[1].replace(/\\$\\(\\((\\d+)\\+(\\d+)\\)\\)/g, (_, a, b) => String(Number(a) + Number(b))) + "\\r\\n");
  } else {
    process.stdout.write("plain-shell: only echo\\r\\n");
  }
  process.stdout.write("$ ");
});
lines.on("close", () => process.exit(0));
`,
  );
  chmodSync(path, 0o755);
  return path;
}

describe("the product's screens", { skip }, () => {
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

  for (const theme of ["dark", "light"] as const) {
    test(`${theme}: as reviewed, and by the rules`, { timeout: 300_000 }, async () => {
      const home = createStandHome();
      homes.push(home);
      const book = new ScreenBook({
        baselines: join(import.meta.dirname, "..", "fixtures", "screens", theme),
        report: join(reportsRoot(), process.env.HARNESS_TEST_RUN ?? "screens", "screens", theme),
        // the light theme is for a light terminal: its screens drawn in one
        terminal: theme === "light" ? LIGHT_TERMINAL : DARK_TERMINAL,
      });
      const tui = await ProductTui.start({ bundle: bundle ?? "", home, columns: 120, rows: 40, shell: plainShell(home) });
      tuis.push(tui);
      {
        const hub = await tui.hub();
        await hub.request("settings_set", { key: "ui.theme", value: theme });
        hub.close();
      }

      // a session with a message, a tool's run and an answer; the browser opens on it
      home.script([{ toolCalls: [{ name: "bash", args: { command: "printf 'line one\\nline two\\n'" } }] }, { text: "all done here" }]);
      await tui.type("run a command and answer");
      await tui.submit();
      await tui.waitForText((text) => text.includes("all done here"));
      const web = await tui.web({ width: 1280, height: 800 });
      webs.push(web);
      await web.waitForText((text) => text.includes("all done here"));

      for (const state of STATES) {
        // the TUI: there, at each size
        if (state.action !== undefined) {
          await tui.act(state.action);
        } else {
          // the session itself
        }
        if (state.then !== undefined) {
          await tui.waitForText((text) => text.includes(state.shows));
          await tui.type(state.then);
          await tui.waitForText((text) => text.includes("screens-42"));
        } else {
          await tui.waitForText((text) => text.includes(state.shows));
        }
        for (const size of TERMINALS) {
          await tui.resize(size.columns, size.rows);
          await book.tui(`${state.name}.${size.name}`, tui.cells());
        }
        await tui.resize(120, 40);
        if (state.leave === "escape") {
          await tui.key("escape");
        } else if (state.leave !== undefined) {
          await tui.act(state.leave);
        } else {
          // nothing to leave
        }

        // the web: the same, at each window (a browser tab keeps Ctrl+letter: Alt alike)
        if (state.action !== undefined) {
          await web.key(`alt+${GLOBAL_ACTIONS[state.action].key}`);
        } else {
          // the session itself
        }
        if (state.then !== undefined) {
          await web.waitForText((text) => text.toLowerCase().includes(state.shows.toLowerCase()));
          await web.waitForText((text) => text.includes("screens-42"));
        } else {
          await web.waitForText((text) => text.toLowerCase().includes(state.shows.toLowerCase()));
        }
        for (const size of WINDOWS) {
          await web.page.setViewportSize({ width: size.width, height: size.height });
          await web.page.waitForTimeout(300);
          await book.web(`${state.name}.${size.name}`, web.page);
        }
        await web.page.setViewportSize({ width: 1280, height: 800 });
        if (state.leave === "escape") {
          await web.key("escape");
        } else if (state.leave !== undefined) {
          await web.key(`alt+${GLOBAL_ACTIONS[state.leave].key}`);
        } else {
          // nothing to leave
        }
      }

      const sheet = await book.sheet(`harness screens, ${theme}`);
      process.stderr.write(`sheet: ${sheet.png}\n`);
      assert.deepEqual(book.problems(), []);
    });
  }
});
