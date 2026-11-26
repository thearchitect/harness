// A session's terminal on a client: the node's screen and then its stream give the rows the shell
// drew, with their colors; the cursor stands where the shell's does (the TUI's marker before its
// cell); scrolling the history is the client's own and typing comes back to the bottom.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { NodeApi } from "./client-model.ts";
import { TerminalModel } from "./terminal-model.ts";

function flushed(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

test("the screen and the stream, the cursor, the client's own history", async () => {
  const requests: { op: string; args: unknown }[] = [];
  const api = {
    request: async (op: string, args: unknown) => {
      requests.push({ op, args });
      return op === "terminal_open" ? { screen: "\x1b[31mred\x1b[0m line\r\n$ " } : {};
    },
  } as unknown as NodeApi;
  const model = new TerminalModel("n", "s", "/w", () => api, () => undefined);
  await model.open(20, 4);
  await flushed();
  assert.equal(model.state, "open");
  assert.deepEqual(requests[0], { op: "terminal_open", args: { session: "s", cwd: "/w", cols: 20, rows: 4 } });

  model.output("echo hi\r\nhi\r\n$ ");
  await flushed();
  const plain = (lines: string[]): string[] => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
  const view = model.view("|");
  assert.deepEqual(plain(view.lines), ["red line", "$ echo hi", "hi", "$ |"]);
  assert.match(view.lines[0] ?? "", /\x1b\[0;38;5;1mred/);
  assert.deepEqual(view.cursor, { x: 2, y: 3 });

  // the history: up a line shows the one above, typing comes back down
  model.output("a\r\nb\r\nc\r\n");
  await flushed();
  assert.equal(model.scroll(2), true);
  assert.equal(plain(model.view().lines)[0], "$ echo hi");
  assert.equal(model.view().cursor, undefined);
  model.input("x");
  assert.equal(model.view().cursor !== undefined, true);
  assert.deepEqual(requests.at(-1), { op: "terminal_input", args: { session: "s", data: "x" } });

  model.resize(30, 5);
  assert.deepEqual(requests.at(-1), { op: "terminal_resize", args: { session: "s", cols: 30, rows: 5 } });
  model.exited(0);
  assert.equal(model.state, "exited");
  model.dispose();
});
