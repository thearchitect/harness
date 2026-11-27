// The app's web build against a hub (plan 10, 16.4): a message from the field gets its answer;
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
      name: "the TUI's new session is its window's alone until its first message; then the web shows it too",
      async run({ stand, clients: { web, tui } }) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal((await web.screen()).tabs.length, 0, "a session without a message stays in its window");
        stand.script([{ text: "hello from the tui" }]);
        await tui.type("hello");
        await tui.submit();
        await web.waitForScreen((screen) => screen.tabs.length > 0);
      },
    },
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
      name: "the address names the active session; a dropped file goes to the hub as @path",
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
        assert.ok(path.startsWith(stand.layout.attachments), path);
        assert.equal(readFileSync(path, "utf8"), "dropped text");
        await field.fill("");
        // a pasted image goes the same way
        await web.page.evaluate(() => {
          const transfer = new DataTransfer();
          transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" }));
          document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer }));
        });
        // kept by its content: the attachment's name is its hash
        await web.page.waitForFunction(() => /\/attachments\/[^/]+\/[0-9a-f]{64}\.png/.test((document.querySelector("textarea") as HTMLTextAreaElement | null)?.value ?? ""));
        await field.fill("");
      },
    },
    {
      name: "/hub: adding a device shows its QR code and its link whole; Esc closes the dialog",
      async run({ stand, clients: { web } }) {
        const local = await stand.connect();
        await local.request("hub_network_set", { enabled: true, listen: "127.0.0.1:0" });
        const port = stand.hub.network.address()?.port;
        await local.request("hub_network_set", { url: `http://127.0.0.1:${port ?? 0}` });
        const field = web.page.getByRole("textbox", { name: "Message" });
        await field.fill("/hub");
        await web.submit();
        await web.page.getByText("network on").waitFor();
        await web.page.getByRole("button", { name: "+ add device" }).click();
        await web.page.getByRole("textbox", { name: "name (empty: the device's own)" }).fill("tablet");
        await web.page.getByRole("textbox", { name: "name (empty: the device's own)" }).press("Enter");
        await web.page.getByLabel("pairing QR code").waitFor();
        await web.page.getByText(new RegExp(`^http://127\\.0\\.0\\.1:${port ?? 0}/#pair=`)).waitFor();
        await web.page.keyboard.press("Escape");
        await web.waitForScreen((screen) => screen.editor === "editor");
        await local.request("hub_network_set", { enabled: false });
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

        const edge = web.page.getByRole("slider", { name: "Resize the strip" });
        const box = await edge.boundingBox();
        assert.ok(box !== null);
        await web.page.mouse.move(box.x + 2, box.y + 200);
        await web.page.mouse.down();
        await web.page.mouse.move(box.x + 82, box.y + 200, { steps: 4 });
        await web.page.mouse.up();
        for (let tries = 0; ; tries += 1) {
          const panes = (await tui.client.homeRequest("settings_get", {})).settings["ui.web.panes"] as { left?: number } | undefined;
          // 154 by default, 80 more (the drag's earlier steps may be kept first)
          if (panes?.left !== undefined && panes.left >= 214 && panes.left <= 254) {
            break;
          } else {
            assert.ok(tries < 100, `the strip's width was not kept: ${String(panes?.left)}`);
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
      name: "a voice message is transcribed on the session's hub into the message",
      async run({ stand, clients: { web } }) {
        const received: string[] = [];
        const server = createServer((request, response) => {
          received.push(String(request.headers.authorization));
          request.resume();
          request.on("end", () => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text: "spoken words" })));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        process.env.HARNESS_TRANSCRIBE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/audio/transcriptions`;
        writeFileSync(join(stand.layout.agent, "auth.json"), JSON.stringify({ scenario: { type: "api_key", key: "scripted" }, openai: { type: "api_key", key: "sk-voice" } }));
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
        mkdirSync(join(stand.project, "sub"), { recursive: true });
        await web.page.getByRole("button", { name: "New session" }).first().click();
        // the folder by keys alone: the project is a recent one, → opens it, typing finds sub, Enter starts there
        const folders = web.page.getByRole("list", { name: "new session folder" });
        await folders.waitFor();
        for (const key of "project") {
          await web.page.keyboard.press(key);
        }
        await folders.getByText("filter project▏").waitFor();
        await web.page.keyboard.press("ArrowRight");
        await folders.getByText("sub", { exact: true }).waitFor();
        for (const key of "sub") {
          await web.page.keyboard.press(key);
        }
        await folders.getByText("filter sub▏").waitFor();
        await web.page.keyboard.press("Enter");
        await web.waitForScreen((screen) => screen.tabs.length === before + 1);
        // its first message keeps it among the user's tabs
        stand.script([{ text: "in sub" }]);
        await web.type("hello sub");
        await web.submit();
        await web.page.getByText("in sub").waitFor({ timeout: 15_000 });
        for (let tries = 0; ; tries += 1) {
          const { tabs } = await tui.client.homeRequest("workspace_get", {});
          if (tabs.some((tab) => tab.cwd === join(stand.project, "sub"))) {
            break; // the session runs in the chosen folder, among the user's tabs
          } else {
            assert.ok(tries < 100, `the session in sub never joined the user's tabs: ${JSON.stringify(tabs)}`);
            await web.page.waitForTimeout(50);
          }
        }
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
        await panel.getByLabel("session name").fill("web-nmed");
        // the cursor moves with the arrows: the letter goes where it stands
        for (let step = 0; step < 3; step += 1) {
          await web.page.keyboard.press("ArrowLeft");
        }
        await web.page.keyboard.type("a");
        await web.page.getByText("web-named").first().waitFor();
        // ↑ leaves the field for the row above (simple)
        await web.page.keyboard.press("ArrowUp");
        assert.equal(await panel.getByLabel("session name").evaluate((node) => node === document.activeElement), false);
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
    {
      name: "the session's terminal: Ctrl+/ shows it over the main area, keys go to the shell (Ctrl+\\ too), the TUI on the same session sees the same screen",
      async run({ clients: { web, tui } }) {
        process.env.SHELL = "/bin/sh"; // the user's shell is theirs; this step speaks sh
        // from the message field: its keys do not bubble, the workbench takes them on the way down
        await web.page.getByRole("textbox", { name: "Message" }).focus();
        await web.page.keyboard.press("Control+Slash");
        const terminal = web.page.getByLabel("terminal", { exact: true });
        await terminal.waitFor();
        // the panel's key is the shell's while it is shown
        await web.page.keyboard.press("Control+Backslash");
        assert.equal((await web.screen()).overlays.includes("panel"), false);
        await web.page.keyboard.type("echo web-$((3+4))");
        await web.page.keyboard.press("Enter");
        await terminal.getByText(/^web-7\s*$/).waitFor();

        // the TUI shows the same session's terminal: the same screen (its tab is the web's active one)
        const shown = await web.screen();
        const title = shown.tabs[shown.active]?.title;
        const tab = tui.workbench.tabs().find((candidate) => candidate.title === title);
        assert.ok(tab !== undefined, `the TUI has the web's tab ${title}`);
        await tui.workbench.activate(tab.index);
        await tui.press("\x1b/");
        await tui.waitForText((text) => text.includes("╭─ terminal · ") && text.includes("web-7"));
        await tui.press("\x1b/");
        await tui.waitForText((text) => !text.includes("╭─ terminal · "));

        await web.page.keyboard.press("Alt+Slash");
        await terminal.waitFor({ state: "detached" });
      },
    },
    {
      name: "a login step: the options as rows, the link whole, Back one step, typing on a row goes to the field, Enter signs in",
      async run({ stand, clients: { web } }) {
        await web.type("/login");
        await web.submit();
        await web.page.getByRole("textbox", { name: /^Filter Log in on/ }).fill("probe");
        await web.page.getByText("Probe SSO").first().waitFor();
        await web.page.keyboard.press("Enter");
        await web.page.getByText("Choose the probe's login method:").waitFor();
        await web.page.getByRole("button", { name: "Browser" }).click();
        await web.page.getByText(/^https:\/\/sso\.example\/authorize.*state=run\d+$/).waitFor();
        await web.page.getByRole("button", { name: "open in browser" }).waitFor();
        // Back: the method again
        await web.page.getByRole("button", { name: "Back" }).click();
        await web.page.getByText("Choose the probe's login method:").waitFor();
        await web.page.getByRole("button", { name: "Browser" }).click();
        // on a row, typing goes to the field
        await web.page.getByRole("button", { name: "open in browser" }).focus();
        await web.page.keyboard.type("good");
        assert.equal(await web.page.getByLabel("login field").inputValue(), "good");
        await web.page.keyboard.press("Enter");
        await web.page.getByRole("textbox", { name: "Message" }).waitFor();
        const auth = JSON.parse(readFileSync(join(stand.layout.agent, "auth.json"), "utf8")) as Record<string, { access?: string }>;
        assert.equal(auth["probe-sso"]?.access, "probe-access");
      },
    },
    {
      name: "an extension's component shows as a remote terminal: its size, keys, paste and a click reach it",
      async run({ clients: { web } }) {
        await web.type("/probe-component");
        await web.submit();
        const view = web.page.getByLabel("extension component");
        await view.getByText(/^probe \(\d+x20\): $/).waitFor({ timeout: 15_000 });
        await web.page.keyboard.type("xy");
        await view.getByText(/^probe \(\d+x20\): xy$/).waitFor();
        await web.page.evaluate(() => {
          const data = new DataTransfer();
          data.setData("text/plain", "pasted");
          window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data }));
        });
        await view.getByText(/xy\|pasted\|$/).waitFor();
        // the cell under the click: the line "click here" is the third
        await view.getByText("click", { exact: true }).click();
        await web.page.getByText(/probe result: click \d+,2/).first().waitFor({ timeout: 15_000 });
        await view.waitFor({ state: "detached" });
      },
    },
    {
      name: "each tab keeps its message being written; the page opened again has it and its active tab",
      async run({ stand, clients: { web } }) {
        // a second tab to switch to
        stand.script([{ text: "second one" }]);
        await web.page.getByRole("button", { name: "New session" }).first().click();
        await web.page.getByRole("list", { name: "new session folder" }).waitFor();
        for (const key of "project") {
          await web.page.keyboard.press(key);
        }
        await web.page.keyboard.press("Enter");
        await web.type("second");
        await web.submit();
        await web.page.getByText("second one").waitFor({ timeout: 15_000 });
        const field = web.page.getByRole("textbox", { name: "Message" });
        const tabs = web.page.getByRole("tablist", { name: "sessions" }).getByRole("button").filter({ hasNotText: "+ new" });
        const count = (await web.waitForScreen((screen) => screen.tabs.length >= 2)).tabs.length;

        await web.type("draft of the last");
        await tabs.nth(0).click();
        await web.waitForScreen((screen) => screen.active === 0);
        assert.equal(await field.inputValue(), "");
        await web.type("draft of the first");
        await tabs.nth(count - 1).click();
        await web.waitForScreen((screen) => screen.active === count - 1);
        assert.equal(await field.inputValue(), "draft of the last");
        await tabs.nth(0).click();
        await web.waitForScreen((screen) => screen.active === 0);
        assert.equal(await field.inputValue(), "draft of the first");

        // kept within half a second; the page opened again
        await web.page.waitForTimeout(800);
        await web.page.reload();
        await web.waitForScreen((screen) => screen.tabs.length === count && screen.active === 0);
        await web.page.waitForFunction(() => (document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement | null)?.value === "draft of the first");
      },
    },
  ],
});

if (unavailable !== undefined) {
  test("web app", { skip: unavailable }, () => undefined);
} else {
  runScenario(scenario);
}
