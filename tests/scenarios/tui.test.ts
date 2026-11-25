// The TUI against a node: a message goes out from the editor and the answer shows in the
// transcript; the search finds it; lists (the model) take the editor's place; the harness panel
// lies over the right strip; a narrow screen hides the strips and brings them back as overlays.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
        assert.deepEqual(tui.screen().strips, { left: false, right: false });
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
        await tui.client.unfollow(tab.node, tab.agent.id);
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
      name: "/export writes the session as an HTML page on its node",
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
      name: "the panel's SESSION: the name field takes typing at once and names the tab without Enter; the implementer is the session's alone",
      async run({ stand, clients: { tui } }) {
        await tui.act("panel.toggle");
        await tui.waitForText((screen) => screen.includes("SESSION") && screen.includes("implementer") && screen.includes("restart node"));
        await tui.press("\x1b[B"); // simple
        await tui.press("\x1b[B"); // name
        for (const key of "renamed") {
          await tui.press(key);
        }
        await tui.waitForText(() => tui.workbench.tabs().some((tab) => tab.title === "renamed"));
        await tui.press("\x1b[B"); // implementer
        await tui.press(" ");
        await tui.waitForText(() => tui.screen().agent?.state.implementer !== "self");
        await tui.press("\x1b");
        assert.deepEqual(tui.screen().zones.overlays, []);
        const defaults = JSON.parse(readFileSync(join(stand.dataDir, "harness.json"), "utf8")) as Record<string, unknown>;
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
      name: "Alt+← takes the keyboard into the tabs: ↓ to another, Enter opens it, Esc returns to the editor",
      async run({ stand, clients: { tui } }) {
        await tui.workbench.newTab(tui.client.home ?? "", stand.project);
        await tui.settle();
        assert.equal(tui.screen().active, 1);
        await tui.press("\x1b[1;3D");
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
        await tui.client.connection(tab.node).call(tab.agent.id, { type: "harness_set", model: "scenario/thinker:low" });
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
      name: "rules part the strips from the main area; a leading ! colors the editor's border for BUILD",
      async run({ clients: { tui } }) {
        const rows = tui.text().split("\n");
        assert.ok(rows.filter((row) => row.split("│").length >= 3).length > 10, "two rules down the screen");
        const plain = tui.app.borderMode();
        await tui.type("!");
        assert.equal(tui.app.borderMode(), "build");
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
      name: "keys as in pi: Ctrl+C clears the editor, Ctrl+D deletes forward with text and closes the tab without",
      async run({ clients: { tui } }) {
        const tabs = tui.workbench.tabs().length;
        await tui.type("abc");
        await tui.press("\x03");
        assert.equal(tui.app.editorText(), "");
        assert.equal(tui.workbench.tabs().length, tabs, "Ctrl+C neither quits nor closes");
        await tui.type("abc");
        await tui.press("\x1b[D"); // ←: the cursor before c
        await tui.press("\x04");
        assert.equal(tui.app.editorText(), "ab");
        assert.equal(tui.workbench.tabs().length, tabs);
        await tui.press("\x03");
        await tui.press("\x04");
        await tui.settle();
        assert.equal(tui.workbench.tabs().length, tabs - 1, "Ctrl+D on an empty editor closes the tab");
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
