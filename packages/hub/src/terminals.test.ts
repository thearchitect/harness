// A session's terminal on its node: the shell runs in the session's directory, input and the size
// reach it, a second viewer gets the same screen, the shell's exit is told, and opening it again
// starts another.

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import xterm from "@xterm/headless";
import { Terminals } from "./terminals.ts";

type Event = { ev: string; session: string; data?: string; code?: number };

function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (condition()) {
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        reject(new Error("timed out"));
      } else {
        setTimeout(check, 20);
      }
    };
    check();
  });
}

/** What a screen (with the stream after it) shows, as text. */
async function screenText(screen: string, after: string, cols: number, rows: number): Promise<string> {
  const term = new xterm.Terminal({ cols, rows, allowProposedApi: true, scrollback: 1000 });
  await new Promise<void>((resolve) => term.write(screen + after, resolve));
  const buffer = term.buffer.active;
  return Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true) ?? "").join("\n");
}

test("a session's terminal: its directory, input, size, two viewers, exit and another start", async () => {
  process.env.SHELL = "/bin/sh"; // the user's shell is theirs; this test speaks sh
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "term-")));
  const events = new Map<object, Event[]>();
  const logged: string[] = [];
  const terminals = new Terminals(
    (viewer, event) => events.set(viewer, [...(events.get(viewer) ?? []), event as Event]),
    (event) => logged.push(event.event),
  );
  const first = {};
  const second = {};
  const output = (viewer: object): string => (events.get(viewer) ?? []).map((event) => event.data ?? "").join("");
  try {
    const opened = await terminals.open(first, "s1", dir, 60, 10);
    terminals.input("s1", "export PS1='$ '; pwd; stty size\r");
    await until(() => output(first).includes(`${dir}\r\n`) && output(first).includes("10 60"));

    terminals.resize("s1", 50, 8);
    terminals.input("s1", "stty size\r");
    await until(() => output(first).includes("8 50"));

    // a second viewer: the screen as it is, then the same stream
    const again = await terminals.open(second, "s1", dir, 50, 8);
    terminals.input("s1", "echo second-$((40+2))\r");
    await until(() => output(second).includes("second-42") && output(first).includes("second-42"));
    const one = await screenText(opened.screen, output(first), 50, 8);
    const two = await screenText(again.screen, output(second), 50, 8);
    assert.equal(two.split("\n").slice(-8).join("\n"), one.split("\n").slice(-8).join("\n"), "the same screen");

    // hidden from one: the shell runs on, the other still gets it
    terminals.detach(first, "s1");
    const before = output(first).length;
    terminals.input("s1", "echo after\r");
    await until(() => output(second).includes("after\r\n"));
    assert.equal(output(first).length, before);

    // the shell exits: told; opening it again starts another
    terminals.input("s1", "exit\r");
    await until(() => (events.get(second) ?? []).some((event) => event.ev === "terminal_exit"));
    await terminals.open(second, "s1", dir, 50, 8);
    terminals.input("s1", "echo reborn\r");
    await until(() => output(second).includes("reborn\r\n"));
    assert.deepEqual(logged, ["terminal_started", "terminal_exited", "terminal_started"]);
  } finally {
    terminals.closeAll();
  }
});
