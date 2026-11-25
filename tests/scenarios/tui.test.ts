// The TUI against a node: a message goes out from the editor and the answer shows in the
// transcript; the search finds it; lists (the model) take the editor's place; the harness panel
// lies over the right strip; a narrow screen hides the strips and brings them back as overlays.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { NodeConnection } from "#client/connection.ts";
import { inProcessTransport } from "#node/endpoints/transports.ts";
import { TuiDriver } from "#testkit/drivers/tui.ts";
import { createStand, type Stand } from "#testkit/stand/stand.ts";

describe("tui", () => {
  let stand: Stand;
  let tui: TuiDriver;

  before(async () => {
    stand = await createStand();
    tui = await TuiDriver.start(() => NodeConnection.open(inProcessTransport(stand.node), "tui"), { cwd: stand.project });
  });

  after(async () => {
    tui.stop();
    await stand.down();
  });

  test("a message from the editor gets its answer in the transcript", async () => {
    stand.script([{ text: "the answer is forty-two" }]);
    await tui.type("what is the answer?");
    await tui.submit();
    const text = await tui.waitForText((screen) => screen.includes("the answer is forty-two"));
    assert.match(text, /what is the answer\?/);
    assert.equal(tui.screen().zones.editor.kind, "editor");
  });

  test("the search finds the answer and closes with Esc", async () => {
    await tui.act("transcript.search");
    await tui.type("forty");
    const search = tui.screen().zones.aboveEditor.search;
    assert.equal(search?.matches.length, 1);
    assert.equal(tui.screen().input, "search");
    await tui.act("run.abort");
    assert.equal(tui.screen().zones.aboveEditor.search, undefined);
  });

  test("choosing the model is a list in the editor's place", async () => {
    await tui.act("model.select");
    const zone = tui.screen().zones.editor;
    assert.equal(zone.kind, "picker");
    assert.ok(zone.kind === "picker" && zone.picker.items.some((item) => item.value === "scenario/scripted"));
    await tui.waitForText((screen) => screen.includes("scenario/scripted"));
    await tui.act("run.abort");
    assert.equal(tui.screen().zones.editor.kind, "editor");
  });

  test("the harness panel is an overlay; a narrow screen hides the strips, which come back as overlays", async () => {
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
  });

  test("captures: text, ANSI and (with the bundle's browser) PNG", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shot-"));
    const files = await tui.capture(dir);
    assert.ok(files.some((file) => file.endsWith("screen.txt")));
    assert.ok(files.some((file) => file.endsWith("screen.ansi")));
  });
});
