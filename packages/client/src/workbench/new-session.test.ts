// Choosing a new session's folder by keys alone, on a fake node: the recent folders under
// `folder ⇒`, typing filters, → and ← move between folders, `/` opens the best match, Enter starts
// the session, Esc cancels.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { HubOps, SessionListItem } from "#protocol/hub.ts";
import { age, NewSession, type NewSessionKey } from "./new-session.ts";

const TREE: Record<string, string[]> = {
  "/": ["home", "tmp"],
  "/home": ["u"],
  "/home/u": [".config", "harness", "notes", "projects"],
  "/home/u/.config": [],
  "/home/u/harness": ["packages"],
  "/home/u/harness/packages": [],
  "/home/u/notes": [],
  "/home/u/projects": ["crea", "site"],
  "/home/u/projects/crea": [],
  "/home/u/projects/site": [],
  "/tmp": [],
};

function choice(): { choice: NewSession; created: string[]; cancelled: () => boolean } {
  const created: string[] = [];
  let cancelled = false;
  const list = async (path: string, hidden: boolean): Promise<HubOps["dirs_list"]["result"]> => {
    const full = path === "~" ? "/home/u" : path;
    const names = TREE[full];
    if (names === undefined) {
      throw new Error(`${full}: no such directory`);
    } else {
      const join = (name: string): string => (full === "/" ? `/${name}` : `${full}/${name}`);
      return {
        path: full,
        parent: full === "/" ? undefined : full.replace(/\/[^/]*$/, "") || "/",
        home: "/home/u",
        dirs: names.filter((name) => hidden || !name.startsWith(".")).map((name) => ({ name, path: join(name), hasChildren: (TREE[join(name)] ?? []).length > 0 })),
      };
    }
  };
  const sessions: SessionListItem[] = [
    { id: "a", path: "/s/a", cwd: "/home/u/harness", created: 3_000, modified: 9_000, messageCount: 2 },
    { id: "b", path: "/s/b", cwd: "/home/u/projects/crea", created: 5_000, modified: 6_000, messageCount: 2 },
    { id: "c", path: "/s/c", cwd: "/home/u/harness", created: 1_000, modified: 2_000, messageCount: 2 },
  ];
  const made = new NewSession("laptop", {
    list,
    sessions: async () => sessions,
    create: async (path) => void created.push(path),
    cancel: () => (cancelled = true),
    changed: () => undefined,
    now: () => 3_600_000 + 5_000,
    failed: (message) => assert.fail(message),
  });
  return { choice: made, created, cancelled: () => cancelled };
}

async function keys(made: NewSession, ...pressed: (NewSessionKey | string)[]): Promise<void> {
  for (const key of pressed) {
    await made.key(typeof key === "string" && key.length === 1 ? { char: key } : (key as NewSessionKey));
  }
}

const labels = (made: NewSession): string[] =>
  made.rows().map((row) => (row.kind === "browse" ? "folder ⇒" : row.kind === "here" ? "· this folder" : `${row.label}${row.hasChildren ? " ›" : ""}`));

test("recent folders, newest session first, under folder ⇒; typing filters at once; Enter starts there", async () => {
  const { choice: made, created } = choice();
  await made.start();
  assert.deepEqual(labels(made), ["folder ⇒", "~/projects/crea", "~/harness ›"]);
  const first = made.rows()[1];
  assert.equal(first?.kind === "dir" ? first.age : undefined, age(3_600_000));
  await keys(made, "h", "a", "r");
  assert.deepEqual(labels(made), ["folder ⇒", "~/harness ›"]);
  assert.equal(made.selected, 1, "the best match is chosen");
  await keys(made, "enter");
  assert.deepEqual(created, ["/home/u/harness"]);
});

test("folder ⇒ browses the home; → opens a folder, ← goes back to it; Enter on · this folder starts in the folder browsed", async () => {
  const { choice: made, created } = choice();
  await made.start();
  await keys(made, "home", "right");
  assert.equal(made.path, "/home/u");
  assert.deepEqual(labels(made), ["· this folder", "harness ›", "notes", "projects ›"], "hidden folders only when the filter starts with a dot");
  await keys(made, "down", "down", "right");
  assert.equal(made.path, "/home/u/projects");
  await keys(made, "left");
  assert.equal(made.path, "/home/u");
  assert.equal(made.rows()[made.selected]?.kind === "dir" ? (made.rows()[made.selected] as { label: string }).label : undefined, "projects", "back on the folder it came from");
  await keys(made, "left", "left");
  assert.equal(made.path, "/");
  await keys(made, "home", "enter");
  assert.deepEqual(created, ["/"]);
});

test("/ opens the best match: har/pa walks down by typing; a dot shows hidden folders; Backspace on no filter goes up", async () => {
  const { choice: made, created } = choice();
  await made.start();
  await keys(made, "~");
  assert.equal(made.path, "/home/u");
  await keys(made, "h", "a", "r", "/");
  assert.equal(made.path, "/home/u/harness");
  await keys(made, "p", "a");
  assert.deepEqual(labels(made), ["· this folder", "packages"]);
  await keys(made, "enter");
  assert.deepEqual(created, ["/home/u/harness/packages"]);

  await keys(made, "backspace", "backspace", "backspace");
  assert.equal(made.path, "/home/u");
  await keys(made, ".", "c");
  assert.deepEqual(labels(made), ["· this folder", ".config"]);
});

test("Esc cancels; ← in the recent list does nothing", async () => {
  const { choice: made, cancelled } = choice();
  await made.start();
  await keys(made, "left");
  assert.equal(made.mode, "recent");
  await keys(made, "escape");
  assert.equal(cancelled(), true);
});
