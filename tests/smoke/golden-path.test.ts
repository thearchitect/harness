// The golden path, on the product as the operator runs it (HARNESS_BUNDLE's bin/harness in a
// pseudo-terminal, the web app its hub serves; skipped without the bundle): a window starts on a
// session that answers; the browser pairs by a one-time link and works on the same session; a new
// session in each client answers; a tab closes; a draft is the hub's; the session's terminal shows
// one screen in both; the window quits and starts again with its sessions alive in both clients;
// the log has one request id through the window, the hub and the agent, and no error. The same
// window on a kitty terminal takes its keys as such a terminal sends them.

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { readLogs } from "#hub/log-files.ts";
import { ProductTui } from "#testkit/drivers/product.ts";
import type { WebDriver } from "#testkit/drivers/web.ts";
import { WebDriver as Web } from "#testkit/drivers/web.ts";
import { createStandHome, type StandHome } from "#testkit/stand/stand.ts";

const bundle = process.env.HARNESS_BUNDLE;
const skip = bundle === undefined || bundle === "" ? "HARNESS_BUNDLE is not set (nix/check.nix sets it)" : (Web.available() ?? false);

/** How many tabs the user's workspace on the window's hub has. */
async function sharedTabs(tui: ProductTui): Promise<{ sessionId: string; draft?: { text: string } }[]> {
  const hub = await tui.hub();
  try {
    return (await hub.request("workspace_get", {})).tabs;
  } finally {
    hub.close();
  }
}

async function until(check: () => Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    assert.ok(Date.now() - started < timeoutMs, what);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("the golden path", { skip }, () => {
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
      if (process.env.HARNESS_KEEP_HOMES === "1") {
        process.stderr.write(`kept: ${home.root}\n`);
      } else {
        home.remove();
      }
    }
  });

  test("the TUI and the web app on one hub: sessions answer, survive a restart, the log ties them", { timeout: 240_000 }, async () => {
    const home = createStandHome();
    homes.push(home);
    const root = bundle ?? "";

    // `harness <project>`: a new session there, its model in the footer, an answer
    const tui = await ProductTui.start({ bundle: root, home });
    tuis.push(tui);
    await tui.waitForText((text) => text.includes("scripted"));
    home.script([{ text: "the first answer" }]);
    await tui.type("hello from the terminal");
    await tui.submit();
    await tui.waitForText((text) => text.includes("the first answer"));

    // the browser pairs by a one-time link and shows the same session; its message answers in both
    const web = await tui.web();
    webs.push(web);
    await web.waitForText((text) => text.includes("the first answer"));
    home.script([{ text: "answered for the web" }]);
    await web.page.getByRole("textbox", { name: "Message" }).click();
    await web.keys("asked in the browser");
    await web.key("ctrl+enter");
    await web.waitForText((text) => text.includes("answered for the web"));
    await tui.waitForText((text) => text.includes("answered for the web"));

    // a new session from the TUI: its folder by typing, an answer, the browser lists it
    await tui.act("tabs.new");
    await tui.waitForText((text) => text.includes("folder ⇒"));
    await tui.type("project");
    await tui.key("enter");
    home.script([{ text: "the second session answers" }]);
    await tui.waitForText((text) => !text.includes("folder ⇒"));
    await tui.type("a second session");
    await tui.submit();
    await tui.waitForText((text) => text.includes("the second session answers"));
    await web.waitForScreen((screen) => screen.tabs.length === 2);

    // a new session from the browser (Alt+N: a browser keeps Ctrl+N), in a folder of the project
    mkdirSync(join(home.project, "web"), { recursive: true });
    await web.key("alt+n");
    const folders = web.page.getByRole("list", { name: "new session folder" });
    await folders.waitFor();
    await web.keys("project");
    await folders.getByText("filter project▏").waitFor();
    await web.key("right");
    await folders.getByText("web", { exact: true }).waitFor();
    await web.keys("web");
    await folders.getByText("filter web▏").waitFor();
    await web.key("enter");
    await web.waitForScreen((screen) => screen.tabs.length === 3);
    home.script([{ text: "the browser's session answers" }]);
    await web.page.getByRole("textbox", { name: "Message" }).click();
    await web.keys("from the browser's own session");
    await web.key("ctrl+enter");
    await web.waitForText((text) => text.includes("the browser's session answers"));
    await until(async () => (await sharedTabs(tui)).length === 3, "three sessions among the user's tabs");

    // Ctrl+W closes the TUI's tab: the user's tabs lose it
    await tui.act("tabs.close");
    await until(async () => (await sharedTabs(tui)).length === 2, "the closed tab leaves the user's tabs");

    // a draft typed in the TUI is the hub's
    await tui.type("a draft for later");
    await until(async () => (await sharedTabs(tui)).some((tab) => tab.draft?.text === "a draft for later"), "the draft reaches the hub");

    // the session's terminal: one screen in both clients
    await tui.act("terminal.toggle");
    await tui.waitForText((text) => text.includes("terminal ·"));
    await tui.type("echo shared-$((6*7))\r");
    await tui.waitForText((text) => text.includes("shared-42"));
    await tui.act("terminal.toggle");
    await tui.waitForText((text) => !text.includes("terminal ·"));

    // quit and start again: the window as it was, its sessions alive
    assert.equal(await tui.quit(), 0);
    const again = await ProductTui.start({ bundle: root, home, args: [] });
    tuis.push(again);
    await again.waitForText((text) => text.includes("scripted"));
    home.script([{ text: "alive after the restart" }]);
    await again.type(" and more");
    await again.submit();
    await again.waitForText((text) => text.includes("alive after the restart"));
    // the browser reconnects to the hub of the new window; on that session it sees the answer
    await web.page.reload();
    await web.page.getByRole("tablist", { name: "sessions" }).getByText("a draft for later and more").click({ timeout: 30_000 });
    await web.waitForText((text) => text.includes("alive after the restart"), 30_000);

    // the log: one request id from the window through the hub to the agent, and no error anywhere
    await again.quit();
    const records = readLogs(home.layout.log);
    const sent = records.find((record) => record.source === "tui" && record.event === "res" && record.op === "harness_prompt");
    assert.ok(sent !== undefined, "the window logged its prompt");
    const passed = records.find((record) => record.source === "hub" && record.event === "hap" && record.req === sent.req);
    assert.ok(passed !== undefined, "the hub passed it on");
    assert.ok(records.some((record) => record.source === "agent" && record.event === "request" && record.req === passed.forwarded), "the agent took it");
    assert.ok(records.some((record) => record.source === "app"), "the browser's log reached the hub");
    assert.deepEqual(
      records.filter((record) => record.level === "error").map((record) => `${record.source} ${record.event} ${JSON.stringify(record).slice(0, 300)}`),
      [],
    );
  });

  test("a kitty terminal: its keys as it sends them", { timeout: 120_000 }, async () => {
    const home = createStandHome();
    homes.push(home);
    const tui = await ProductTui.start({ bundle: bundle ?? "", home, kitty: true });
    tuis.push(tui);
    await tui.waitForText((text) => text.includes("scripted"));
    home.script([{ text: "kitty answered" }]);
    await tui.type("over kitty");
    await tui.submit();
    await tui.waitForText((text) => text.includes("kitty answered"));
    await tui.act("tabs.new");
    await tui.waitForText((text) => text.includes("folder ⇒"));
    await tui.key("escape");
    await tui.waitForText((text) => !text.includes("folder ⇒"));
    await tui.act("terminal.toggle");
    await tui.waitForText((text) => text.includes("terminal ·"));
    await tui.act("terminal.toggle");
    await tui.waitForText((text) => !text.includes("terminal ·"));
    assert.equal(await tui.quit(), 0);
  });
});
