// The workspace: a session joins with a draft or when it differs otherwise, leaves when wiped back to
// a new one without a message on disk; tabs are arranged on the revision they were read at; a tab's
// session can be replaced, its draft going along. Attachments: kept by content, removed once old
// and named by no draft and no transcript.

import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Attachments } from "./attachments.ts";
import { Workspace } from "./workspace.ts";

test("a session joins the workspace with a draft or a difference, and leaves wiped back to a new one", () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const workspace = new Workspace(dir);
  const events: number[] = [];
  workspace.onChange((data) => events.push(data.revision));
  const tab = { sessionId: "s1", sessionFile: join(dir, "s1.jsonl"), cwd: "/p" };

  assert.deepEqual(workspace.setDraft(tab, "", false, 1).tabs, [], "a new session stays its window's");
  const joined = workspace.setDraft(tab, "hello", false, 2);
  assert.deepEqual(joined.tabs, [{ ...tab, draft: { text: "hello", at: 2 } }]);
  assert.deepEqual(workspace.setDraft(tab, "", false, 3).tabs, [], "wiped back: it leaves");
  assert.deepEqual(workspace.setDraft(tab, "", true, 4).tabs, [tab], "a message or a name keeps it");
  writeFileSync(tab.sessionFile, "{}\n");
  assert.deepEqual(workspace.setDraft(tab, "", false, 5).tabs, [tab], "a session on disk stays");
  assert.deepEqual(events, [1, 2, 3]);
});

test("tabs are arranged on the revision they were read at; drafts stay; a replaced session keeps its draft", () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const workspace = new Workspace(dir);
  workspace.setDraft({ sessionId: "a", sessionFile: "/x/a", cwd: "/p" }, "draft a", false, 1);
  const read = workspace.setDraft({ sessionId: "b", sessionFile: "/x/b", cwd: "/p" }, "draft b", false, 2);
  const swapped = workspace.setTabs([...read.tabs].reverse().map(({ draft: _draft, ...tab }) => ({ ...tab, seen: 9 })), read.revision);
  assert.deepEqual(
    swapped.tabs.map((tab) => [tab.sessionId, tab.draft?.text, tab.seen]),
    [
      ["b", "draft b", 9],
      ["a", "draft a", 9],
    ],
  );
  assert.throws(() => workspace.setTabs([], read.revision), /changed meanwhile/);
  const replaced = workspace.replaceSession("a", { sessionId: "a2", sessionFile: "/x/a2" });
  assert.deepEqual(replaced.tabs[1], { sessionId: "a2", sessionFile: "/x/a2", cwd: "/p", seen: 9, draft: { text: "draft a", at: 1 } });
});

test("attachments: kept by content; the old ones nothing names go", async () => {
  const dir = mkdtempSync(join(tmpdir(), "att-"));
  const attachments = new Attachments(dir);
  const a = await attachments.put("s1", "photo.png", Buffer.from("A"));
  assert.equal(await attachments.put("s1", "again.png", Buffer.from("A")), a, "the same content, one file");
  assert.match(a, /attachments\/s1\/[0-9a-f]{64}\.png$/);
  const b = await attachments.put("s1", "b.txt", Buffer.from("B"));
  const c = await attachments.put("s2", "c.txt", Buffer.from("C"));
  await attachments.put("s2", "d.txt", Buffer.from("D")); // young: kept
  const old = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
  for (const path of [a, b, c]) {
    utimesSync(path, old, old);
  }
  const removed = await attachments.sweep(7, Date.now(), [`look at @${a}`], async (session) => (session === "s2" ? `{"text":"@${c}"}` : undefined));
  assert.deepEqual(removed, [b], "named by a draft (a), by its transcript (c), young (d): kept");
});
