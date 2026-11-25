// Background tasks of a session: processes the model (or a subagent engine) starts and controls.
// Each runs in its own process group with the session's environment and secrets; its output goes
// to `<session workspace>/tasks/<id>.log` (the model reads it with `read`) and through a bounded
// in-memory tail for waits and patterns. The supervisor lives as long as the agent process (a
// reload keeps it); events drive notifications to the model and the HarnessState of clients.

import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import type { NotifyPolicy, TaskInfo, TaskState } from "#protocol/state.ts";

export type Spawner = (command: string, options: { cwd: string; env: Record<string, string | undefined> }) => ChildProcess;

export type Clock = { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The shell pi's bash tool uses (bash, else sh): commands are written for it, whatever $SHELL is. */
const shellSpawner: Spawner = (command, options) => {
  const shell = getShellConfig();
  return nodeSpawn(shell.shell, [...shell.args, command], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
};

/** Grace between SIGTERM and SIGKILL of a stopped task's group. */
export const STOP_GRACE_MS = 5000;
/** The in-memory output kept per task for waits and the operator's view (the log keeps everything). */
const TAIL_BYTES = 256 * 1024;

export type TaskEvent =
  | { kind: "exit"; task: TaskInfo }
  | { kind: "pattern"; task: TaskInfo; pattern: string; line: string };

export type WaitCondition = { exit: boolean; pattern?: RegExp; timeoutMs: number };

export type WaitOutcome =
  | { kind: "exit"; task: TaskInfo }
  | { kind: "pattern"; task: TaskInfo; line: string }
  | { kind: "timeout"; task: TaskInfo }
  | { kind: "aborted"; task: TaskInfo };

type Watcher = { pattern: RegExp; once: boolean };

type Task = {
  info: TaskInfo;
  process: ChildProcess;
  log: WriteStream;
  logPath: string;
  tail: string;
  /** Characters dropped from the front of `tail`. */
  tailStart: number;
  partialLine: string;
  watchers: Watcher[];
  listeners: Set<() => void>;
  killTimer?: unknown;
};

export type StartOptions = {
  command: string;
  cwd: string;
  name?: string;
  notify: NotifyPolicy;
  env: Record<string, string | undefined>;
  logPath: string;
  /** Patterns that raise a `pattern` event (notification) once each. */
  watch?: RegExp[];
};

export type SupervisorDeps = { publish(tasks: TaskInfo[]): void; spawner?: Spawner; clock?: Clock };

export class Supervisor {
  private readonly tasks = new Map<string, Task>();
  private readonly listeners = new Set<(event: TaskEvent) => void>();
  private readonly publish: (tasks: TaskInfo[]) => void;
  private readonly spawner: Spawner;
  private readonly clock: Clock;
  private counter = 0;

  constructor(deps: SupervisorDeps) {
    this.publish = deps.publish;
    this.spawner = deps.spawner ?? shellSpawner;
    this.clock = deps.clock ?? systemClock;
  }

  onEvent(listener: (event: TaskEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): TaskInfo[] {
    return [...this.tasks.values()].map((task) => task.info);
  }

  get(id: string): TaskInfo | undefined {
    return this.tasks.get(id)?.info;
  }

  logPath(id: string): string | undefined {
    return this.tasks.get(id)?.logPath;
  }

  start(options: StartOptions): TaskInfo {
    this.counter += 1;
    const id = `t${this.counter}`;
    mkdirSync(dirname(options.logPath), { recursive: true });
    const log = createWriteStream(options.logPath, { flags: "a" });
    const child = this.spawner(options.command, { cwd: options.cwd, env: options.env });
    const task: Task = {
      info: {
        id,
        source: "own",
        command: options.name !== undefined && options.name !== "" ? `${options.name}: ${options.command}` : options.command,
        cwd: options.cwd,
        state: "running",
        startedAt: this.clock.now(),
        outputBytes: 0,
        notify: options.notify,
      },
      process: child,
      log,
      logPath: options.logPath,
      tail: "",
      tailStart: 0,
      partialLine: "",
      watchers: (options.watch ?? []).map((pattern) => ({ pattern, once: true })),
      listeners: new Set(),
    };
    this.tasks.set(id, task);

    const onData = (chunk: Buffer): void => this.receive(task, chunk);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (error) => {
      this.receive(task, Buffer.from(`\n[harness] the task could not run: ${error.message}\n`));
      this.finish(task, "failed", undefined);
    });
    child.on("close", (code, signal) => {
      const state: TaskState = task.info.state === "stopped" ? "stopped" : code === 0 ? "exited" : "failed";
      this.finish(task, state, code ?? (signal !== null ? 128 : undefined));
    });
    this.changed();
    return task.info;
  }

  private receive(task: Task, chunk: Buffer): void {
    const text = chunk.toString("utf8");
    task.log.write(chunk);
    task.info = { ...task.info, outputBytes: task.info.outputBytes + chunk.length };
    task.tail += text;
    if (task.tail.length > TAIL_BYTES) {
      const drop = task.tail.length - TAIL_BYTES;
      task.tail = task.tail.slice(drop);
      task.tailStart += drop;
    } else {
      // the tail still fits
    }

    const lines = (task.partialLine + text).split("\n");
    task.partialLine = lines.pop() ?? "";
    for (const line of lines) {
      for (const watcher of [...task.watchers]) {
        if (watcher.pattern.test(line)) {
          if (watcher.once) {
            task.watchers = task.watchers.filter((candidate) => candidate !== watcher);
          } else {
            // a standing watch
          }
          this.emit({ kind: "pattern", task: task.info, pattern: watcher.pattern.source, line });
        } else {
          // no match on this line
        }
      }
    }
    for (const listener of task.listeners) {
      listener();
    }
  }

  private finish(task: Task, state: TaskState, exitCode: number | undefined): void {
    if (task.info.endedAt !== undefined) {
      return; // "error" and "close" can both arrive
    } else {
      if (task.killTimer !== undefined) {
        this.clock.clearTimeout(task.killTimer);
      } else {
        // the task ended by itself
      }
      task.log.end();
      task.info = { ...task.info, state, exitCode, endedAt: this.clock.now() };
      for (const listener of task.listeners) {
        listener();
      }
      this.emit({ kind: "exit", task: task.info });
      this.changed();
    }
  }

  private emit(event: TaskEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private changed(): void {
    this.publish(this.list());
  }

  /** The output kept in memory: from a character offset (of the whole stream), or the last lines, optionally filtered. */
  output(id: string, query: { offset?: number; tailLines?: number; grep?: RegExp }): { text: string; offset: number; next: number; dropped: boolean } {
    const task = this.require(id);
    const next = task.tailStart + task.tail.length;
    if (query.offset !== undefined) {
      const from = Math.max(query.offset, task.tailStart);
      const text = task.tail.slice(from - task.tailStart);
      return { text: filterLines(text, query.grep), offset: from, next, dropped: query.offset < task.tailStart };
    } else {
      const lines = task.tail.split("\n");
      const selected = query.grep !== undefined ? lines.filter((line) => query.grep?.test(line)) : lines;
      const shown = query.tailLines !== undefined ? selected.slice(-query.tailLines) : selected;
      return { text: shown.join("\n"), offset: task.tailStart, next, dropped: task.tailStart > 0 };
    }
  }

  /** Waits for the first of: exit, a line matching the pattern, the timeout, the signal. */
  wait(id: string, condition: WaitCondition, signal?: AbortSignal): Promise<WaitOutcome> {
    const task = this.require(id);
    if (task.info.endedAt !== undefined && condition.exit) {
      return Promise.resolve({ kind: "exit", task: task.info });
    } else {
      const existing = condition.pattern !== undefined ? task.tail.split("\n").find((line) => condition.pattern?.test(line)) : undefined;
      if (existing !== undefined) {
        return Promise.resolve({ kind: "pattern", task: task.info, line: existing });
      } else {
        return new Promise((resolve) => {
          let checked = task.tail.length + task.tailStart;
          const done = (outcome: WaitOutcome): void => {
            task.listeners.delete(listener);
            this.clock.clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            resolve(outcome);
          };
          const listener = (): void => {
            if (condition.pattern !== undefined) {
              const fresh = task.tail.slice(Math.max(0, checked - task.tailStart));
              checked = task.tailStart + task.tail.length;
              const line = fresh.split("\n").find((candidate) => condition.pattern?.test(candidate));
              if (line !== undefined) {
                done({ kind: "pattern", task: task.info, line });
                return;
              } else {
                // no match yet
              }
            } else {
              // waiting for exit only
            }
            if (task.info.endedAt !== undefined) {
              done({ kind: "exit", task: task.info });
            } else {
              // still running
            }
          };
          const onAbort = (): void => done({ kind: "aborted", task: task.info });
          const timer = this.clock.setTimeout(() => done({ kind: "timeout", task: task.info }), condition.timeoutMs);
          task.listeners.add(listener);
          signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
    }
  }

  input(id: string, text: string): void {
    const task = this.require(id);
    if (task.info.endedAt !== undefined || task.process.stdin === null || task.process.stdin.destroyed) {
      throw new Error(`task ${id} has ended: it takes no input`);
    } else {
      task.process.stdin.write(text);
    }
  }

  /** Stops the task's process group: the signal, then SIGKILL after the grace period. */
  stop(id: string, signal: NodeJS.Signals = "SIGTERM"): TaskInfo {
    const task = this.require(id);
    if (task.info.endedAt !== undefined) {
      return task.info;
    } else {
      task.info = { ...task.info, state: "stopped" };
      killGroup(task.process, signal);
      task.killTimer = this.clock.setTimeout(() => killGroup(task.process, "SIGKILL"), STOP_GRACE_MS);
      this.changed();
      return task.info;
    }
  }

  async stopAll(_reason: string): Promise<void> {
    const running = [...this.tasks.values()].filter((task) => task.info.endedAt === undefined);
    await Promise.all(
      running.map(
        (task) =>
          new Promise<void>((resolve) => {
            task.listeners.add(() => {
              if (task.info.endedAt !== undefined) {
                resolve();
              } else {
                // output while stopping
              }
            });
            this.stop(task.info.id);
          }),
      ),
    );
  }

  hasLiveTasks(): boolean {
    return [...this.tasks.values()].some((task) => task.info.endedAt === undefined);
  }

  private require(id: string): Task {
    const task = this.tasks.get(id);
    if (task === undefined) {
      throw new Error(`no task ${id}: task_status lists the tasks of this session`);
    } else {
      return task;
    }
  }
}

function filterLines(text: string, grep: RegExp | undefined): string {
  return grep === undefined ? text : text.split("\n").filter((line) => grep.test(line)).join("\n");
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // the group is already gone
  }
}
