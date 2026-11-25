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
