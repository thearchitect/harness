// The app's web build against a node (plan 10, 16.4): a message from the field gets its answer;
// the gate asks in the editor's place and Allow lets the change through; the TUI and the web show
// the same tabs, glyphs and items — compared by meaning, never by pixels.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
        // the page's title counts the sessions waiting for the operator
        await web.page.waitForFunction(() => document.title === "◆ 1 · harness");
        await web.page.getByRole("button", { name: "Allow", exact: true }).click();
        await web.page.getByText("written").waitFor({ timeout: 15_000 });
        assert.equal(existsSync(target), true);
      },
    },
    {
      name: "the address names the active session; a dropped file goes to the node as @path",
      async run({ stand, clients: { web } }) {
        const screen = await web.screen();
        assert.match(new URL(web.page.url()).hash, new RegExp(`^#/test/`));
        assert.ok(screen.tabs.length > 0);
        const dropped = await web.page.evaluateHandle(() => {
          const transfer = new DataTransfer();
          transfer.items.add(new File(["dropped text"], "note.txt", { type: "text/plain" }));
          return transfer;
        });
        await web.page.dispatchEvent("body", "drop", { dataTransfer: dropped });
        const field = web.page.getByRole("textbox", { name: "Message" });
        await web.page.waitForFunction(() => (document.querySelector("textarea") as HTMLTextAreaElement | null)?.value.includes("@") === true);
        const path = /@(\S+)/.exec(await field.inputValue())?.[1] ?? "";
        assert.ok(path.startsWith(join(stand.dataDir, "uploads")), path);
        assert.equal(readFileSync(path, "utf8"), "dropped text");
        await field.fill("");
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
