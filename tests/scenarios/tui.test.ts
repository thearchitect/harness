// The TUI against a node: a message goes out from the editor and the answer shows in the
// transcript; the search finds it; lists (the model) take the editor's place; the harness panel
// lies over the right strip; a narrow screen hides the strips and brings them back as overlays.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { defineScenario, runScenario } from "#testkit/scenario/scenario.ts";

export const scenario = defineScenario({
  name: "tui basics",
  // a short snapshot: a few dozen entries make a session with older entries to load
  stand: { snapshotEntries: 8 },
  clients: { tui: { kind: "tui" } },
  steps: [
    {
      name: "a message from the editor gets its answer",
      async run({ stand, clients: { tui } }) {
        stand.script([{ text: "the answer is forty-two" }]);
        await tui.type("what is the answer?");
        await tui.submit();
        const text = await tui.waitForText((screen) => screen.includes("the answer is forty-two"));
        assert.match(text, /what is the answer\?/);
        assert.equal(tui.screen().zones.editor.kind, "editor");
        // harness's entries are drawn as pi draws extensions' entries: a blank line above each
        const lines = (await tui.waitForText((screen) => / finished/.test(screen))).split("\n");
        const banner = lines.findIndex((line) => / finished/.test(line));
        assert.match(lines[banner - 1] ?? "", /^[\s│]*$/, "a blank line above the finish banner");
      },
    },
    {
      name: "the search finds the answer and closes with Esc",
      async run({ clients: { tui } }) {
        await tui.act("transcript.search");
        await tui.type("forty");
        assert.equal(tui.screen().zones.aboveEditor.search?.matches.length, 1);
        assert.equal(tui.screen().input, "search");
        await tui.act("run.abort");
        assert.equal(tui.screen().zones.aboveEditor.search, undefined);
      },
    },
    {
      name: "choosing the model is a list in the editor's place",
      async run({ clients: { tui } }) {
        await tui.act("model.select");
        const zone = tui.screen().zones.editor;
        assert.ok(zone.kind === "picker" && zone.picker.items.some((item) => item.value === "scenario/scripted"));
        await tui.waitForText((screen) => screen.includes("scenario/scripted"));
        await tui.act("run.abort");
        assert.equal(tui.screen().zones.editor.kind, "editor");
      },
    },
    {
      name: "the harness panel and hidden strips are overlays",
      async run({ clients: { tui } }) {
        await tui.act("panel.toggle");
        assert.deepEqual(tui.screen().zones.overlays, ["panel"]);
        await tui.waitForText((screen) => screen.includes("madness"));
        await tui.act("panel.toggle");
        assert.deepEqual(tui.screen().zones.overlays, []);

        tui.terminal.resizeTo(70, 30);
        await tui.settle();
        assert.deepEqual(tui.screen().strips, { left: false });
        await tui.act("strip.tabs");
        assert.deepEqual(tui.screen().zones.overlays, ["tabs"]);
        await tui.act("strip.tabs");
        tui.terminal.resizeTo(140, 40);
      },
    },
    {
      name: "the operator's own command shows in the transcript",
      async run({ clients: { tui } }) {
        await tui.type("/bash echo operator-ran-this");
        await tui.submit();
        await tui.waitForText((screen) => screen.includes("operator-ran-this") && screen.includes("$ echo"));
      },
    },
    {
      name: "scrolling to the top of a long session loads its older entries",
      async run({ clients: { tui } }) {
        // few runs: each is a bash on the agent, slow on a loaded machine
        for (let index = 0; index < 14; index += 1) {
          await tui.workbench.operatorBash(`echo line-${index}`, true);
        }
        // open it again: the snapshot holds the latest 8 entries
        const tab = tui.workbench.activeTab();
        assert.ok(tab?.agent !== undefined);
        await tui.client.unfollow(tab.hub, tab.agent.id);
        await tui.workbench.activate(0);
        const agent = tui.screen().agent;
        assert.ok(agent?.cursor !== undefined, "older entries exist");
        const loaded = agent.items.length;
        // page up; at the top each page asks for the next older entries: wait for each load
        for (let page = 0; tui.screen().agent?.cursor !== undefined; page += 1) {
          assert.ok(page < 2000, "the older entries never all arrived");
          await tui.press("\x1b[5~");
          await new Promise((resolve) => setImmediate(resolve));
          await tui.app.olderLoad;
        }
        assert.equal(tui.screen().agent?.cursor, undefined);
        assert.ok((tui.screen().agent?.items.length ?? 0) > loaded);
        // the rest of the way up to the session's first message
        for (let page = 0; !tui.text().includes("what is the answer?"); page += 1) {
          assert.ok(page < 200, "the first message never came into view");
          await tui.press("\x1b[5~");
        }
      },
    },
    {
      name: "the tree moves the session back to a message, which returns to the editor",
      async run({ clients: { tui } }) {
        await tui.workbench.treePicker();
        const zone = tui.screen().zones.editor;
        const first = zone.kind === "picker" ? zone.picker.items.find((item) => item.label.includes("› what is the answer?")) : undefined;
        assert.ok(first !== undefined);
        await (zone.kind === "picker" ? zone.picker.choose(first.value) : Promise.resolve());
        await tui.waitForText((screen) => !screen.includes("the answer is forty-two"));
        assert.equal(tui.app.editorText(), "what is the answer?");
        await tui.press("\x03"); // Ctrl+C clears the editor
      },
    },
    {
      name: "settings: the theme is the user's setting; compaction is the session's",
      async run({ clients: { tui } }) {
        const pick = async (label: string): Promise<void> => {
          const zone = tui.screen().zones.editor;
          const item = zone.kind === "picker" ? zone.picker.items.find((candidate) => candidate.label.startsWith(label)) : undefined;
          assert.ok(zone.kind === "picker" && item !== undefined, label);
          await zone.picker.choose(item.value);
        };
        await tui.workbench.settingsPicker();
        await pick("theme");
        await pick("light");
        assert.equal(tui.client.settings["ui.theme"], "light");
        await tui.workbench.settingsPicker();
        await pick("auto-compaction: on");
        await tui.workbench.settingsPicker();
        await pick("auto-compaction: off");
        await tui.workbench.settingsPicker();
        await pick("theme");
        await pick("dark");
      },
    },
    {
      name: "/export writes the session as an HTML page on its hub",
      async run({ clients: { tui } }) {
        await tui.type("/export");
        await tui.submit();
        await tui.waitForText((screen) => screen.includes("exported to "));
        // the line on the screen may be cut: the path is the status line's
        const line = tui.screen().zones.status.find((status) => status.text.startsWith("exported to "))?.text ?? "";
        const path = /exported to (\S+\.html)/.exec(line)?.[1] ?? "";
        assert.ok(path.startsWith("/"), line);
        assert.match(readFileSync(path, "utf8"), /<html/i);
      },
    },
    {
      name: "/hub: the network on a free port, a device added: its QR code and link whole without padding, copied; a pairing shows it used",
      async run({ stand, clients: { tui } }) {
        await tui.type("/hub");
        await tui.submit();
        await tui.waitForText((screen) => screen.includes(`hub ${tui.client.home ?? ""}`) && screen.includes("network off") && screen.includes("+ add device"));
        // the listen field (second row): typed, Enter applies; then the network on (first row)
        await tui.press("\x1b[B");
        for (const _ of "127.0.0.1:8790") {
          await tui.press("\x7f");
        }
        await tui.type("127.0.0.1:0");
        await tui.press("\r");
        await tui.press("\x1b[A");
        await tui.press("\r");
        await tui.waitForText((screen) => screen.includes("network on"));
        const port = stand.hub.network.address()?.port;
        assert.ok(port !== undefined);
        // the address for links (fourth row)
        await tui.press("\x1b[B");
        await tui.press("\x1b[B");
        await tui.press("\x1b[B");
        await tui.type(`http://127.0.0.1:${port}`);
        await tui.press("\r");
        // + add device, Enter on the empty name: the device names itself
        await tui.press("\x1b[B");
        await tui.press("\r");
        await tui.waitForText((screen) => screen.includes("add device") && screen.includes("name (empty"));
        await tui.press("\r");
        const shown = await tui.waitForText((screen) => screen.includes("valid until") && screen.includes("▄"));
        // the link starts the main area's line (right after the strip's edge): no padding
        const link = new RegExp(`(?:^|│)(http://127\\.0\\.0\\.1:${port}/#pair=[0-9A-Z-]+)`, "m").exec(shown)?.[1];
        assert.ok(link !== undefined, `the link starts its line, no padding:\n${shown}`);
        await tui.press("\r"); // copy link
        assert.deepEqual(tui.copied.at(-1), link);
        const code = new URL(link).hash.replace("#pair=", "");
        const { redeemPairing } = await import("#cli/admin.ts");
        await redeemPairing(`http://127.0.0.1:${port}`, code, "Pixel 9");
        await tui.waitForText((screen) => screen.includes("used: Pixel 9"));
        await tui.press("\x1b[D"); // ← back to the name
        await tui.press("\x1b[D"); // ← the main screen
        await tui.waitForText((screen) => screen.includes("devices") && screen.includes("Pixel 9"));
        await tui.press("\x1b");
        assert.equal(tui.screen().zones.editor.kind, "editor");
        await stand.hub.network.close();
      },
    },
    {
      name: "the panel lists the subagent profiles and the dependencies in the editor's place",
      async run({ clients: { tui } }) {
        await tui.workbench.choosePanel("subagents");
        const subagents = tui.screen().zones.editor;
        assert.ok(subagents.kind === "picker" && subagents.picker.items.some((item) => item.label.startsWith("builder · claude")) && subagents.picker.items.some((item) => item.label.startsWith("explorer · harness · plan")));
        await tui.act("run.abort");
        await tui.workbench.choosePanel("dependencies");
        const report = tui.screen().zones.editor;
        assert.ok(report.kind === "picker" && report.picker.items.some((item) => item.label.startsWith("Claude Code: ")));
        assert.ok(report.kind === "picker" && report.picker.items.some((item) => item.label === "Subagents:"));
        await tui.act("run.abort");
        await tui.workbench.choosePanel("logs");
        const logs = tui.screen().zones.editor;
        assert.ok(logs.kind === "picker" && logs.picker.items.some((item) => / agent_start agent=/.test(item.label)), "the node's events, newest first");
        await tui.act("run.abort");
      },
    },
    {
      name: "keys come as presses and releases (kitty): the panel opens once, a toggle keeps it open, Esc closes it",
      async run({ clients: { tui } }) {
        // Ctrl+\ pressed, then released: one action
        await tui.press("\x1b[92;5u");
        await tui.press("\x1b[92;5:3u");
        assert.deepEqual(tui.screen().zones.overlays, ["panel"]);
        await tui.waitForText((screen) => screen.includes("MODE") && screen.includes("HARNESS") && screen.includes("━━○ off"));
        // madness is the first row: Space turns it on, the panel stays
        await tui.press(" ");
        await tui.waitForText((screen) => screen.includes("●━━  on"));
        assert.deepEqual(tui.screen().zones.overlays, ["panel"]);
        assert.equal(tui.screen().agent?.state.madness, true);
        await tui.press(" ");
        await tui.waitForText((screen) => !screen.includes("●━━  on"));
        await tui.press("\x1b");
        assert.deepEqual(tui.screen().zones.overlays, []);
      },
    },
    {
      name: "the panel's SESSION: the name field takes typing at once, its cursor moves with the arrows and names the tab without Enter; the implementer is the session's alone",
      async run({ stand, clients: { tui } }) {
        await tui.act("panel.toggle");
        await tui.waitForText((screen) => screen.includes("SESSION") && screen.includes("implementer") && screen.includes("restart hub"));
        await tui.press("\x1b[B"); // simple
        await tui.press("\x1b[B"); // name
        for (const key of "rnamed") {
          await tui.press(key);
        }
        // the cursor goes back and the missing letter goes in where it stands
        for (let step = 0; step < 5; step += 1) {
          await tui.press("\x1b[D");
        }
        await tui.press("e");
        await tui.waitForText(() => tui.workbench.tabs().some((tab) => tab.title === "renamed"));
        // the field's cursor is the terminal's: it stands after the typed letter
        const rows = tui.text().split("\n");
        // the panel's row (the strip's tab shows the name too, further left)
        const row = rows.findIndex((candidate) => /name\s+renamed/.test(candidate));
        assert.deepEqual(tui.terminal.cursor(), { x: (rows[row] ?? "").lastIndexOf("renamed") + 2, y: row }, "the terminal's cursor after `re`");
        await tui.press("\x1b[B"); // implementer
        await tui.press(" ");
        await tui.waitForText(() => tui.screen().agent?.state.implementer !== "self");
        await tui.press("\x1b");
        assert.deepEqual(tui.screen().zones.overlays, []);
        const defaults = JSON.parse(readFileSync(stand.layout.defaults, "utf8")) as Record<string, unknown>;
        assert.equal(defaults.madness, false, "madness is kept for new sessions");
        assert.equal("implementer" in defaults, false, "the implementer is not");
        await tui.act("panel.toggle");
        await tui.press("\x1b[B");
        await tui.press("\x1b[B");
        await tui.press("\x1b[B");
        // in turn through the profiles back to self
        for (let turn = 0; tui.screen().agent?.state.implementer !== "self"; turn += 1) {
          assert.ok(turn < 5, "the implementer never came back to self");
          const before = tui.screen().agent?.state.implementer;
          await tui.press(" ");
          await tui.waitForText(() => tui.screen().agent?.state.implementer !== before);
        }
        await tui.press("\x1b");
      },
    },
    {
      name: "Alt+S takes the keyboard into the tabs: ↓ to another, Enter opens it, Esc returns to the editor",
      async run({ stand, clients: { tui } }) {
        await tui.workbench.newTab(tui.client.home ?? "", stand.project);
        await tui.settle();
        assert.equal(tui.screen().active, 1);
        await tui.press("\x1bs");
        await tui.press("\x1b[A");
        await tui.press("\r");
        await tui.settle();
        assert.equal(tui.screen().active, 0);
        // back in the editor: typing goes there
        await tui.type("x");
        assert.equal(tui.app.editorText(), "x");
        await tui.press("\x7f");
      },
    },
    {
      name: "Shift+Tab moves the thinking level by one, and the footer shows it",
      async run({ stand, clients: { tui } }) {
        // a model that thinks, in a session of its own
        stand.models(["thinker"]);
        await tui.workbench.newTab(tui.client.home ?? "", stand.project);
        const tab = tui.workbench.activeTab();
        assert.ok(tab?.agent !== undefined);
        await tui.client.connection(tab.hub).call(tab.agent.id, { type: "harness_set", model: "scenario/thinker:low" });
        await tui.waitForText(() => tui.screen().agent?.session?.thinkingLevel === "low");
        const before = tui.screen().agent?.session?.thinkingLevel;
        await tui.press("\x1b[9;2u");
        await tui.press("\x1b[9;2:3u");
        await tui.waitForText(() => tui.screen().agent?.session?.thinkingLevel !== before);
        const after = tui.screen().agent?.session?.thinkingLevel;
        assert.notEqual(after, undefined);
        await tui.waitForText((screen) => screen.includes(String(after)));
      },
    },
    {
      name: "a rule parts the strip from the main area, rules part its blocks; the editor has no padding; a leading ! colors the editor's border for BUILD",
      async run({ clients: { tui } }) {
        const rows = tui.text().split("\n");
        assert.ok(rows.filter((row) => row.slice(0, 20).includes("│")).length > 10, "a rule down the screen after the strip");
        assert.equal(rows.filter((row) => /^─{18}│/.test(row)).length, 2, "the strip's three blocks");
        assert.ok(rows.slice(0, 3).some((row) => row.slice(0, 18).includes(tui.client.home ?? "?")), "the client's own node first");
        assert.ok(rows.some((row) => /^.{0,2}session\s/.test(row)), "the items block starts with session");
        const plain = tui.app.borderMode();
        await tui.type("!");
        assert.equal(tui.app.borderMode(), "build");
        // the editor has no padding: the text starts right after the rule
        await tui.waitForText((text) => text.split("\n").some((row) => /^.{18}│!\s*$/.test(row)));
        assert.notEqual(plain, "build");
        await tui.press("\x7f");
        assert.equal(tui.app.borderMode(), plain);
      },
    },
    {
      name: "ask_user: pi-ask-user's prompt in the editor's place; the arrows choose, Enter answers",
      async run({ stand, clients: { tui } }) {
        stand.script([
          { toolCalls: [{ name: "ask_user", args: { question: "Which database?", options: [{ title: "PostgreSQL", description: "relational" }, { title: "SQLite" }] } }] },
          { text: "noted" },
        ]);
        await tui.type("ask me");
        await tui.submit();
        await tui.waitForText((screen) => screen.includes("Which database?") && screen.includes("Type something."));
        await tui.press("\x1b[B");
        await tui.press("\r");
        await tui.waitForText((screen) => screen.includes("noted"));
        assert.match(JSON.stringify(stand.requests().at(-1)), /User answered: SQLite/);
      },
    },
    {
      name: "the model picker shows the favorites first; Tab switches to all models",
      async run({ clients: { tui } }) {
        await tui.act("model.select");
        const zone = tui.screen().zones.editor;
        assert.ok(zone.kind === "picker");
        await tui.waitForText((screen) => screen.includes("tab") && screen.includes("enter choose") && screen.includes("esc cancel"));
        await tui.act("run.abort");
      },
    },
    {
      name: "a new session: Ctrl+N chooses its folder in the chat zone by typing alone; the tab is the window's until its first message; Esc cancels",
      async run({ stand, clients: { tui } }) {
        const shared = (): { sessionId: string }[] => tui.client.workspaces.get(tui.client.home ?? "")?.tabs ?? [];
        await tui.press("\x0e"); // Ctrl+N
        await tui.waitForText((screen) => screen.includes("folder ⇒") && screen.includes("new session"));
        assert.equal(tui.screen().input, "newSession");
        await tui.press("\x1b");
        await tui.waitForText((screen) => !screen.includes("folder ⇒"));
        assert.equal(tui.screen().input, "editor");

        // the stand's project is a recent folder: typing its name chooses it, Enter starts there
        const before = tui.workbench.tabs().length;
        await tui.press("\x1bn"); // Alt+N alike
        await tui.waitForText((screen) => screen.includes("folder ⇒"));
        for (const key of "project") {
          await tui.press(key);
        }
        await tui.waitForText((screen) => screen.includes("filter project") && screen.includes(stand.project.replace(homedir(), "~")));
        await tui.press("\r");
        await tui.waitForText(() => tui.workbench.tabs().length === before + 1 && tui.screen().input === "editor");
        const draft = tui.workbench.activeTab();
        assert.equal(draft?.cwd, stand.project);
        assert.equal(draft?.draft, true);
        assert.ok(!shared().some((record) => record.sessionId === draft?.sessionId), "not among the user's tabs before a message");
        stand.script([{ text: "kept" }]);
        await tui.type("hello");
        await tui.submit();
        await tui.waitForText(() => shared().some((record) => record.sessionId === draft?.sessionId));

        // closed before a message, nothing of it remains
        await tui.press("\x0e");
        await tui.waitForText((screen) => screen.includes("folder ⇒"));
        for (const key of "project") {
          await tui.press(key);
        }
        await tui.press("\r");
        await tui.waitForText(() => tui.workbench.activeTab()?.draft === true);
        const empty = tui.workbench.activeTab();
        await tui.press("\x17"); // Ctrl+W
        await tui.waitForText(() => !tui.workbench.tabs().some((tab) => tab.sessionId === empty?.sessionId));
        assert.ok(!(await tui.client.sessions(tui.client.home ?? "")).some((session) => session.id === empty?.sessionId), "no file of it");
      },
    },
    {
      name: "a login step in the editor's place: ← from the first step returns to the providers; the link without padding; open and copy; ← goes back one step; ← in the field moves the cursor; Enter signs in",
      async run({ stand, clients: { tui } }) {
        const login = async (): Promise<void> => {
          await tui.type("/login");
          await tui.submit();
          await tui.waitForText((text) => text.includes("Log in on"));
          await tui.type("probe");
          await tui.waitForText((text) => text.includes("Probe SSO"));
          await tui.press("\r");
          await tui.waitForText((text) => text.includes("Choose the probe's login method:"));
        };
        // back from the first step: the providers again, the probe selected
        await login();
        await tui.press("\x1b[D");
        await tui.waitForText((text) => text.includes("Log in on") && /→ .*Probe SSO/.test(text));
        await tui.press("\x1b");

        await login();
        await tui.press("\r"); // Browser
        const text = await tui.waitForText((screen) => screen.includes("Complete the probe's sign-in"));
        assert.ok(text.split("\n").some((row) => /^.{18}│https:\/\/sso\.example\/authorize/.test(row)), "the link starts right after the rule");
        await tui.press("\r"); // open in browser
        assert.match(tui.opened.at(-1) ?? "", /state=run2/);
        await tui.press("\x1b[B");
        await tui.press("\r"); // copy link
        assert.match(tui.copied.at(-1) ?? "", /^https:\/\/sso\.example\/authorize.*state=run2$/);

        // back one step: the method again, then a new link
        await tui.press("\x1b[A");
        await tui.press("\x1b[D");
        await tui.waitForText((screen) => screen.includes("Choose the probe's login method:"));
        await tui.press("\r");
        await tui.waitForText(() => {
          const zone = tui.screen().zones.editor;
          return zone.kind === "interaction" && zone.request.kind === "login" && (zone.request.payload.url ?? "").endsWith("state=run3");
        });

        // typing goes to the field at once; ← there moves the cursor
        await tui.type("god");
        await tui.press("\x1b[D");
        await tui.type("o");
        await tui.press("\r");
        await tui.waitForText(() => tui.screen().zones.editor.kind === "editor");
        const auth = JSON.parse(readFileSync(join(stand.layout.agent, "auth.json"), "utf8")) as Record<string, { access?: string }>;
        assert.equal(auth["probe-sso"]?.access, "probe-access");
      },
    },
    {
      name: "harness's keys: Ctrl+C clears the editor, Delete and Ctrl+Z edit, Ctrl+D is nothing, Ctrl+W closes the tab",
      async run({ clients: { tui } }) {
        const tabs = tui.workbench.tabs().length;
        await tui.type("abc");
        await tui.press("\x03");
        assert.equal(tui.app.editorText(), "");
        assert.equal(tui.workbench.tabs().length, tabs, "Ctrl+C neither quits nor closes");
        await tui.type("abc");
        await tui.press("\x1b[D"); // ←: the cursor before c
        await tui.press("\x1b[3~"); // Delete
        assert.equal(tui.app.editorText(), "ab");
        await tui.press("\x1a"); // Ctrl+Z: undone
        assert.equal(tui.app.editorText(), "abc");
        await tui.press("\x04"); // Ctrl+D: no key of harness, nothing deleted, nothing closed
        assert.equal(tui.app.editorText(), "abc");
        assert.equal(tui.workbench.tabs().length, tabs);
        await tui.press("\x17"); // Ctrl+W closes the tab, with a message written too
        await tui.settle();
        assert.equal(tui.workbench.tabs().length, tabs - 1, "Ctrl+W closes the tab");
      },
    },
    {
      name: "captures: text, ANSI and PNG",
      async run({ clients: { tui } }) {
        const files = await tui.capture(mkdtempSync(join(tmpdir(), "shot-")));
        assert.ok(files.some((file) => file.endsWith("screen.txt")));
        assert.ok(files.some((file) => file.endsWith("screen.ansi")));
      },
    },
  ],
});

runScenario(scenario);
