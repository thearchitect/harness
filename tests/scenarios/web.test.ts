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
      name: "the app's settings: a zone's font, the strips' widths; kept in the user's settings",
      async run({ clients: { web, tui } }) {
        const field = web.page.getByRole("textbox", { name: "Message" });
        await field.fill("/settings");
        await web.submit();
        await web.page.getByRole("button", { name: /^chat font: jetbrains-mono 13/ }).click();
        await web.page.getByRole("button", { name: "terminus", exact: true }).click();
        await web.page.getByRole("button", { name: "16px", exact: true }).click();
        await web.waitForScreen((screen) => screen.editor === "editor");
        await tui.client.homeRequest("settings_get", {}).then(({ settings }) => assert.deepEqual(settings["ui.font.chat"], { family: "terminus", size: 16 }));
        // the transcript's text takes the new font at once
        const family = await web.page.getByText("the web answer is seven").evaluate((element) => getComputedStyle(element).fontFamily);
        assert.match(family, /Terminus/);

        const edge = web.page.getByRole("slider", { name: "Resize the sessions strip" });
        const box = await edge.boundingBox();
        assert.ok(box !== null);
        await web.page.mouse.move(box.x + 2, box.y + 200);
        await web.page.mouse.down();
        await web.page.mouse.move(box.x + 82, box.y + 200, { steps: 4 });
        await web.page.mouse.up();
        for (let tries = 0; ; tries += 1) {
          const panes = (await tui.client.homeRequest("settings_get", {})).settings["ui.web.panes"] as { left?: number } | undefined;
          if (panes?.left !== undefined) {
            assert.ok(panes.left >= 280 && panes.left <= 320, String(panes.left));
            break;
          } else {
            assert.ok(tries < 100, "the strip's width was not kept");
            await web.page.waitForTimeout(50);
          }
        }
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
