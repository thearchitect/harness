// The app's web build against a node (plan 10, 16.4): a message from the field gets its answer;
// the gate asks in the editor's place and Allow lets the change through; the TUI and the web show
// the same tabs, glyphs and items — compared by meaning, never by pixels.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
        // the write's row shows what it added
        assert.match(await web.page.getByLabel("diff").first().innerText(), /\+ web/);
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
        // a pasted image goes the same way
        await web.page.evaluate(() => {
          const transfer = new DataTransfer();
          transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" }));
          document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer }));
        });
        await web.page.waitForFunction(() => (document.querySelector("textarea") as HTMLTextAreaElement | null)?.value.includes("pasted-1.png") === true);
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
            // 154 by default, 80 more
            assert.ok(panes.left >= 214 && panes.left <= 254, String(panes.left));
            break;
          } else {
            assert.ok(tries < 100, "the strip's width was not kept");
            await web.page.waitForTimeout(50);
          }
        }
      },
    },
    {
      name: "@ completes the session's files in a block above the field; a directory stays open",
      async run({ stand, clients: { web } }) {
        mkdirSync(join(stand.project, "notes"), { recursive: true });
        writeFileSync(join(stand.project, "notes", "plan.md"), "");
        const field = web.page.getByRole("textbox", { name: "Message" });
        await field.fill("see @no");
        const completions = web.page.getByRole("list", { name: "completions" });
        await completions.getByRole("button", { name: "notes/" }).click();
        assert.equal(await field.inputValue(), "see @notes/");
        await completions.getByRole("button", { name: "notes/plan.md" }).click();
        assert.equal(await field.inputValue(), "see @notes/plan.md ");
        await field.fill("");
      },
    },
    {
      name: "a file the agent sends downloads to this device",
      async run({ stand, clients: { web } }) {
        const report = join(stand.project, "report.txt");
        writeFileSync(report, "the report");
        stand.script([{ toolCalls: [{ name: "send_file", args: { path: report, comment: "Your report" } }] }, { text: "sent" }]);
        await web.type("send me the report");
        await web.submit();
        const button = web.page.getByRole("button", { name: /^Download report\.txt/ });
        await button.waitFor({ timeout: 15_000 });
        const [download] = await Promise.all([web.page.waitForEvent("download"), button.click()]);
        assert.equal(download.suggestedFilename(), "report.txt");
        assert.equal(readFileSync(await download.path(), "utf8"), "the report");
      },
    },
    {
      name: "a voice message is transcribed on the session's node into the message",
      async run({ stand, clients: { web } }) {
        const received: string[] = [];
        const server = createServer((request, response) => {
          received.push(String(request.headers.authorization));
          request.resume();
          request.on("end", () => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text: "spoken words" })));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        process.env.HARNESS_TRANSCRIBE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/audio/transcriptions`;
        writeFileSync(join(stand.dataDir, "auth.json"), JSON.stringify({ scenario: { type: "api_key", key: "scripted" }, openai: { type: "api_key", key: "sk-voice" } }));
        try {
          await web.page.getByRole("button", { name: "Record a voice message" }).click();
          await web.page.getByRole("button", { name: "Stop recording" }).click();
          await web.page.waitForFunction(() => (document.querySelector("textarea") as HTMLTextAreaElement | null)?.value.includes("spoken words") === true, undefined, { timeout: 15_000 });
          assert.deepEqual(received, ["Bearer sk-voice"]);
          await web.page.getByRole("textbox", { name: "Message" }).fill("");
        } finally {
          server.close();
          delete process.env.HARNESS_TRANSCRIBE_URL;
        }
      },
    },
    {
      name: "tabs: a second one, reordered by dragging (every client sees it), closed from the context menu",
      async run({ stand, clients: { web, tui } }) {
        const before = (await web.screen()).tabs.length;
        await web.page.getByRole("button", { name: "New session" }).first().click();
        // a directory: the recent ones, the home, or typed
        const filter = web.page.getByRole("textbox", { name: /^Filter New session on/ });
        await filter.fill(join(stand.project, "sub"));
        mkdirSync(join(stand.project, "sub"), { recursive: true });
        await filter.press("Enter");
        await web.waitForScreen((screen) => screen.tabs.length === before + 1);
        const { settings } = await tui.client.homeRequest("settings_get", {});
        assert.ok((settings["ui.tabs"] as { cwd: string }[]).some((tab) => tab.cwd === join(stand.project, "sub")), "the session runs in the typed directory");
        const titles = (await web.screen()).tabs.map((tab) => tab.title);
        const strip = web.page.getByRole("tablist", { name: "sessions" });
        const rows = strip.getByRole("button").filter({ hasNotText: "+ new" });
        await rows.nth(titles.length - 1).dragTo(rows.nth(0));
        const moved = await web.waitForScreen((screen) => screen.tabs[0]?.title === titles.at(-1));
        assert.equal(moved.tabs.length, titles.length);
        await tui.settle();
        assert.equal(tui.screen().tabs[0]?.title, titles.at(-1), "the order is the user's: the TUI has it too");

        await rows.nth(0).click({ button: "right" });
        const menu = web.page.getByRole("menu");
        await menu.getByRole("button", { name: "Copy the session id" }).waitFor();
        await menu.getByRole("button", { name: "Close" }).click();
        await web.waitForScreen((screen) => screen.tabs.length === titles.length - 1);
      },
    },
    {
      name: "the harness panel: the TUI's sections; the keyboard comes in on its rows, Space toggles and keeps it open, Esc closes",
      async run({ clients: { web } }) {
        await web.page.keyboard.press("Control+Backslash");
        const panel = web.page.getByRole("menu", { name: "harness panel" });
        await panel.getByText("MODE", { exact: true }).waitFor();
        await panel.getByText("HARNESS", { exact: true }).waitFor();
        await panel.getByText("━━○ off").first().waitFor();
        // the first row (madness) has the focus
        await web.page.keyboard.press("Space");
        await panel.getByText("●━━  on").waitFor();
        await web.page.keyboard.press("ArrowDown");
        await web.page.keyboard.press("ArrowUp");
        await web.page.keyboard.press("Enter");
        await panel.getByText("●━━  on").waitFor({ state: "detached" });
        // SESSION: the name field names the tab as it is typed
        await panel.getByText("SESSION", { exact: true }).waitFor();
        await panel.getByLabel("session name").fill("web-named");
        await web.page.getByText("web-named").first().waitFor();
        await web.page.keyboard.press("Escape");
        await panel.waitFor({ state: "detached" });
      },
    },
    {
      name: "ask_user: the options as rows, a click answers as in pi-ask-user",
      async run({ stand, clients: { web } }) {
        stand.script([
          { toolCalls: [{ name: "ask_user", args: { question: "Which database?", options: [{ title: "PostgreSQL" }, { title: "SQLite" }], allowComment: true } }] },
          { text: "noted from the web" },
        ]);
        await web.type("ask me");
        await web.submit();
        await web.page.getByText("Type something.").waitFor();
        await web.page.getByRole("button", { name: "Add extra context after selection" }).click();
        await web.page.getByRole("button", { name: "SQLite" }).click();
        await web.page.getByRole("textbox", { name: "Comment" }).fill("one file");
        await web.page.getByRole("button", { name: "Submit" }).click();
        await web.page.getByText("noted from the web").waitFor({ timeout: 15_000 });
        assert.match(JSON.stringify(stand.requests().at(-1)), /User answered: SQLite — one file/);
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
