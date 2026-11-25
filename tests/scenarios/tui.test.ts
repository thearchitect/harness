// The TUI against a node: a message goes out from the editor and the answer shows in the
// transcript; the search finds it; lists (the model) take the editor's place; the harness panel
// lies over the right strip; a narrow screen hides the strips and brings them back as overlays.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineScenario, runScenario } from "#testkit/scenario/scenario.ts";

export const scenario = defineScenario({
  name: "tui basics",
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
        for (let index = 0; index < 220; index += 1) {
          await tui.workbench.operatorBash(`echo line-${index}`, true);
        }
        // open it again: the snapshot holds the latest 200 entries
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
        await tui.waitForText((screen) => screen.includes("what is the answer?"));
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
