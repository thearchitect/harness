// The app's web build against a node (plan 10, 16.4): a message from the field gets its answer;
// the gate asks in the editor's place and Allow lets the change through; the TUI and the web show
// the same tabs, glyphs and items — compared by meaning, never by pixels.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { WebDriver } from "#testkit/drivers/web.ts";
import { defineScenario, runScenario } from "#testkit/scenario/scenario.ts";

const unavailable = WebDriver.available();

export const scenario = defineScenario({
  name: "web app",
  clients: { web: { kind: "web" }, tui: { kind: "tui" } },
  steps: [
    {
      name: "a message from the field gets its answer",
      async run({ stand, clients: { web } }) {
        stand.script([{ text: "the web answer is seven" }]);
        await web.waitForScreen((screen) => screen.tabs.length > 0 && screen.editor === "editor");
        await web.type("what is the answer?");
        await web.submit();
        await web.page.getByText("the web answer is seven").waitFor({ timeout: 15_000 });
        assert.match(await web.aria(), /what is the answer\?/);
      },
    },
    {
      name: "the gate asks in the editor's place; Allow lets the change through",
      async run({ stand, clients: { web } }) {
        const target = join(stand.project, "from-web.txt");
        stand.script([{ toolCalls: [{ name: "write", args: { path: target, content: "web" } }] }, { text: "written" }]);
        await web.type("!write the file");
        await web.submit();
        await web.waitForScreen((screen) => screen.editor === "interaction");
        await web.page.getByRole("button", { name: "Allow", exact: true }).click();
        await web.page.getByText("written").waitFor({ timeout: 15_000 });
        assert.equal(existsSync(target), true);
      },
    },
    {
      name: "the TUI and the web show the same tabs, glyphs and items",
      async run({ clients: { web, tui } }) {
        await tui.settle();
        const fromTui = tui.screen();
        const fromWeb = await web.waitForScreen((screen) => screen.tabs.length === fromTui.tabs.length);
        assert.deepEqual(
          fromWeb.tabs.map((tab) => tab.title),
          fromTui.tabs.map((tab) => tab.title),
        );
        assert.deepEqual(
          fromWeb.items.map((item) => item.kind),
          fromTui.items.map((item) => item.kind),
        );
      },
    },
  ],
});

if (unavailable !== undefined) {
  test("web app", { skip: unavailable }, () => undefined);
} else {
  runScenario(scenario);
}
