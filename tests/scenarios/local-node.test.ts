// The local node held by a client window (local.ts), with real processes: the first window holds
// it and the next connects; when the holder goes, exactly one of the others holds a new node and the
// rest connect to it; a service is waited for, never replaced; node_restart starts the node again in
// its holder; another version's node is refused with the reason.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { listenUnix, socketPath } from "#node/endpoints/unix.ts";
import { quitQuestion, versionProblem } from "#node/local.ts";
import { HarnessNode } from "#node/node.ts";

const WINDOW = fileURLToPath(new URL("../../packages/testkit/src/fakes/window.ts", import.meta.url));

type Welcome = { pid?: number; host?: string; holding?: boolean; harness?: string; error?: string };

class Window {
  readonly process: ChildProcess;
  readonly welcomes: Welcome[] = [];
  readonly errors: string[] = [];
  private readonly waiters: (() => void)[] = [];

  constructor(home: string, version = "test") {
    this.process = spawn(process.execPath, [WINDOW, home, version], { stdio: ["pipe", "pipe", "inherit"] });
    createInterface({ input: this.process.stdout! }).on("line", (line) => {
      const reported = JSON.parse(line) as Welcome;
      if (reported.pid !== undefined) {
        this.welcomes.push(reported);
      } else {
        // an error of a connection attempt: the window tries again
        this.errors.push(reported.error ?? line);
      }
      for (const waiter of this.waiters.splice(0)) {
        waiter();
      }
    });
  }

  /** The welcome after `count` earlier ones. */
  async welcome(count: number): Promise<Welcome> {
    const deadline = Date.now() + 20_000;
    while (this.welcomes.length <= count) {
      assert.ok(Date.now() < deadline, `window ${this.process.pid}: no welcome after ${count}`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 500);
      });
    }
    return this.welcomes[count] ?? {};
  }

  send(command: string): void {
    this.process.stdin!.write(`${command}\n`);
  }

  exited(): Promise<void> {
    return new Promise((resolve) => (this.process.exitCode !== null || this.process.signalCode !== null ? resolve() : this.process.once("exit", () => resolve())));
  }
}

const windows: Window[] = [];
function open(home: string, version?: string): Window {
  const window = new Window(home, version);
  windows.push(window);
  return window;
}
after(() => {
  for (const window of windows) {
    window.process.kill("SIGKILL");
  }
});

function home(): string {
  // short: the socket's path is limited
  return mkdtempSync(join(tmpdir(), "ln-"));
}

test("the first window holds the node, the next connects; when the holder quits, the other holds a new one", async () => {
  const dir = home();
  const a = open(dir);
  const first = await a.welcome(0);
  assert.equal(first.holding, true);
  assert.equal(first.host, "client");
  assert.equal(first.pid, a.process.pid);
  const b = open(dir);
  const second = await b.welcome(0);
  assert.equal(second.holding, false);
  assert.equal(second.pid, a.process.pid);

  a.send("quit");
  await a.exited();
  const moved = await b.welcome(1);
  assert.equal(moved.holding, true, JSON.stringify(b.welcomes));
  assert.equal(moved.pid, b.process.pid);
});

test("three windows lose a crashed holder together: exactly one holds a new node, the other connects to it", async () => {
  const dir = home();
  const a = open(dir);
  await a.welcome(0);
  const b = open(dir);
  const c = open(dir);
  await b.welcome(0);
  await c.welcome(0);
  a.process.kill("SIGKILL"); // its lock stays behind with a PID that is gone
  const [nb, nc] = await Promise.all([b.welcome(1), c.welcome(1)]);
  assert.equal([nb, nc].filter((welcome) => welcome.holding === true).length, 1, JSON.stringify([nb, nc]));
  assert.equal(nb.pid, nc.pid);
});

test("node_restart starts the node again in its holder; its clients come back", async () => {
  const dir = home();
  const a = open(dir);
  await a.welcome(0);
  const b = open(dir);
  await b.welcome(0);
  b.send("restart");
  const [ra, rb] = await Promise.all([a.welcome(1), b.welcome(1)]);
  assert.equal(ra.holding, true);
  assert.equal(rb.pid, a.process.pid);
});

test("a service is waited for, never replaced: its clients come back to it", async () => {
  const dir = home();
  const start = async (): Promise<{ node: HarnessNode; close(): Promise<void> }> => {
    const node = new HarnessNode({ name: "default", dataDir: dir, harnessVersion: "test" });
    const server = await listenUnix(node, socketPath(dir, "default"));
    return {
      node,
      close: async () => {
        server.close();
        await node.close();
      },
    };
  };
  const service = await start();
  const a = open(dir);
  const first = await a.welcome(0);
  assert.deepEqual([first.host, first.holding], ["service", false]);
  await service.close();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(a.welcomes.length, 1, "no node held while the service is down");
  const again = await start();
  const back = await a.welcome(1);
  assert.deepEqual([back.host, back.holding], ["service", false]);
  await again.close();
});

test("quitting the holder asks first while agents work or other windows use the node", () => {
  assert.equal(quitQuestion(undefined), undefined, "a client of another holder or a service quits at once");
  assert.equal(quitQuestion({ running: 0, otherClients: 0 }), undefined);
  assert.equal(quitQuestion({ running: 2, otherClients: 1 }), "Quitting stops 2 running agents (1 other windows use this node)");
  assert.match(quitQuestion({ running: 0, otherClients: 1 }) ?? "", /1 other windows/);
});

test("another version's node is refused with what to do", () => {
  assert.equal(versionProblem("2", { node: "default", harness: "2", host: "client", pid: 7 }), undefined);
  assert.equal(
    versionProblem("2", { node: "default", harness: "1", host: "client", pid: 7 }),
    "harness 2: node default runs harness 1 (held by window PID 7); close it or restart the service",
  );
  assert.match(versionProblem("2", { node: "default", harness: "1", host: "service", pid: 7 }) ?? "", /\(a service\)/);
});
