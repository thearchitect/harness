import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { TaskInfo } from "#protocol/state.ts";
import type { Clock } from "#protocol/clock.ts";
import { Supervisor, type TaskEvent } from "./supervisor.ts";

const dir = mkdtempSync(join(tmpdir(), "supervisor-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A clock whose timers fire only when the test says so. */
function manualClock(): Clock & { fire(): void } {
  const timers = new Set<() => void>();
  return {
    now: () => Date.now(),
    setTimeout: (fn) => {
      timers.add(fn);
      return fn;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as () => void);
    },
    fire: () => {
      for (const fn of [...timers]) {
        timers.delete(fn);
        fn();
      }
    },
  };
}

function setup(clock?: Clock) {
  const published: TaskInfo[][] = [];
  const events: TaskEvent[] = [];
  const supervisor = new Supervisor({ publish: (tasks) => published.push(tasks), clock });
  supervisor.onEvent((event) => events.push(event));
  let n = 0;
  const start = (command: string, watch?: RegExp[]) =>
    supervisor.start({ command, cwd: dir, notify: "wake", env: process.env, logPath: join(dir, `log-${++n}.log`), watch });
  return { supervisor, published, events, start };
}

describe("the supervisor", () => {
  test("a task runs to its exit; its output is in the log and the tail; the exit is an event and published state", async () => {
    const { supervisor, events, published, start } = setup();
    const task = start("echo one; echo two >&2; exit 3");
    const outcome = await supervisor.wait(task.id, { exit: true, timeoutMs: 10_000 });
    assert.equal(outcome.kind, "exit");
    assert.equal(outcome.task.state, "failed");
    assert.equal(outcome.task.exitCode, 3);
    assert.match(supervisor.output(task.id, { tailLines: 10 }).text, /one\ntwo/);
    await new Promise((resolve) => setTimeout(resolve, 50)); // the log stream flushes on end
    assert.match(readFileSync(supervisor.logPath(task.id) ?? "", "utf8"), /one\ntwo/);
    assert.deepEqual(events.map((event) => event.kind), ["exit"]);
    assert.equal(published.at(-1)?.[0]?.state, "failed");
  });

  test("a watched line is an event once; a wait returns on a matching line before the exit", async () => {
    const { supervisor, events, start } = setup();
    const task = start("echo starting; echo ready on 8080; echo ready again; sleep 30", [/ready/]);
    const outcome = await supervisor.wait(task.id, { exit: true, pattern: /ready on (\d+)/, timeoutMs: 10_000 });
    assert.equal(outcome.kind, "pattern");
    assert.equal(outcome.kind === "pattern" && outcome.line, "ready on 8080");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(events.filter((event) => event.kind === "pattern").length, 1);
    supervisor.stop(task.id);
    const stopped = await supervisor.wait(task.id, { exit: true, timeoutMs: 10_000 });
    assert.equal(stopped.task.state, "stopped");
  });

  test("stop ends the whole process group, children included", async () => {
    const { supervisor, start } = setup();
    const task = start("sleep 30 & echo $!; wait");
    const started = await supervisor.wait(task.id, { exit: false, pattern: /^\d+$/, timeoutMs: 10_000 });
    assert.equal(started.kind, "pattern");
    const child = Number(started.kind === "pattern" ? started.line : "");
    assert.ok(child > 1);
    supervisor.stop(task.id);
    await supervisor.wait(task.id, { exit: true, timeoutMs: 10_000 });
    // the orphaned child is reaped by init a moment after the group signal
    const alive = (): boolean => {
      try {
        process.kill(child, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let attempt = 0; attempt < 50 && alive(); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(alive(), false);
  });

  test("input goes to the task's stdin; an ended task refuses input", async () => {
    const { supervisor, start } = setup();
    const task = start("read line; echo got:$line");
    supervisor.input(task.id, "hello\n");
    const outcome = await supervisor.wait(task.id, { exit: true, timeoutMs: 10_000 });
    assert.equal(outcome.task.state, "exited");
    assert.match(supervisor.output(task.id, {}).text, /got:hello/);
    assert.throws(() => supervisor.input(task.id, "late\n"), /has ended/);
  });

  test("a wait ends at the timeout (on the clock) and on its signal", async () => {
    const clock = manualClock();
    const { supervisor, start } = setup(clock);
    const task = start("sleep 30");
    const waiting = supervisor.wait(task.id, { exit: true, timeoutMs: 1000 });
    clock.fire();
    assert.equal((await waiting).kind, "timeout");
    const controller = new AbortController();
    const interrupted = supervisor.wait(task.id, { exit: true, timeoutMs: 1000 }, controller.signal);
    controller.abort();
    assert.equal((await interrupted).kind, "aborted");
    supervisor.stop(task.id, "SIGKILL");
    await supervisor.wait(task.id, { exit: true, timeoutMs: 1000 });
  });

  test("an unknown task id is an error that says where to look", () => {
    const { supervisor } = setup();
    assert.throws(() => supervisor.output("t99", {}), /no task t99/);
  });
});
