// The model's tools for background tasks, and the notifications that tell it about them. Tasks
// follow bash's rules: no gate (a command is a command), sequential execution, the session's
// secrets in the environment. `notify` decides what a task's exit (or a watched line) does:
// `wake` starts a run (or joins the running one as a follow-up), `queue` waits for the next run,
// `none` only updates the task's state.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import type { NotifyPolicy, TaskInfo } from "#protocol/state.ts";
import { scratchWorkspaceRoot } from "../core/authorize.ts";
import { interruptedError, type Interrupts } from "../core/interrupts.ts";
import { sessionSecrets } from "../tools/secrets.ts";
import type { Supervisor, TaskEvent, WaitOutcome } from "./supervisor.ts";

export const TASK_MESSAGE_TYPE = "harness-task";

const NOTIFY = Type.Union([Type.Literal("wake"), Type.Literal("queue"), Type.Literal("none")], {
  description: "What the task's exit (or a watched line) does: wake starts or joins a run, queue waits for your next run, none only updates its state",
});

const DEFAULT_WAIT_S = 600;

/** The default `notify` from settings.json `harness.tasks.notify`, else `wake`. */
function defaultNotify(agentDir: string): NotifyPolicy {
  try {
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as { harness?: { tasks?: { notify?: unknown } } };
    const value = settings.harness?.tasks?.notify;
    return value === "queue" || value === "none" || value === "wake" ? value : "wake";
  } catch {
    return "wake"; // no settings file, or not readable: the built-in default
  }
}

function describeTask(task: TaskInfo): string {
  const state = task.endedAt !== undefined ? `${task.state}${task.exitCode !== undefined ? ` (exit ${task.exitCode})` : ""}` : "running";
  const took = ((task.endedAt ?? Date.now()) - task.startedAt) / 1000;
  return `${task.id} ${state} ${took.toFixed(1)}s, ${task.outputBytes} bytes of output — ${task.command}`;
}

function describeOutcome(outcome: WaitOutcome): string {
  switch (outcome.kind) {
    case "exit":
      return `Task ended: ${describeTask(outcome.task)}`;
    case "pattern":
      return `Matched in ${outcome.task.id}: ${outcome.line}`;
    case "timeout":
      return `Still running after the wait: ${describeTask(outcome.task)}`;
    case "aborted":
      return `Wait interrupted: ${describeTask(outcome.task)}`;
    default:
      throw new Error(`unknown wait outcome: ${JSON.stringify(outcome satisfies never)}`);
  }
}

function regex(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (error) {
    throw new Error(`not a regular expression: ${pattern} (${error instanceof Error ? error.message : String(error)})`);
  }
}

/** `agentDir`: pi's agent directory, whose settings.json may name the default `notify`. */
export function registerTaskTools(pi: ExtensionAPI, supervisor: Supervisor, interrupts: Interrupts, agentDir: string): void {
  // Notifications: an exit or a watched line reaches the model by the task's policy.
  const unsubscribe = supervisor.onEvent((event: TaskEvent) => {
    const notify = event.task.notify;
    const content =
      event.kind === "exit"
        ? `Background task ended: ${describeTask(event.task)}. Output: task_output id=${event.task.id}.`
        : `Background task ${event.task.id} printed a watched line: ${event.line}`;
    switch (notify) {
      case "wake":
        pi.sendMessage({ customType: TASK_MESSAGE_TYPE, content, display: true, details: { task: event.task } }, { triggerTurn: true, deliverAs: "followUp" });
        break;
      case "queue":
        pi.sendMessage({ customType: TASK_MESSAGE_TYPE, content, display: true, details: { task: event.task } }, { deliverAs: "nextTurn" });
        break;
      case "none":
        break; // the state is published; nobody is told
      default:
        throw new Error(`unknown notify policy: ${String(notify satisfies never)}`);
    }
  });
  pi.on("session_shutdown", (event) => {
    unsubscribe();
    if (event.reason !== "reload") {
      void supervisor.stopAll(`the session ended (${event.reason})`);
    } else {
      // a reload keeps the tasks: the next extension instance subscribes again
    }
  });

  pi.registerTool({
    name: "task_start",
    label: "Start task",
    description:
      "Start a shell command as a background task: it runs in its own process group with the session's environment and secrets, its output goes to a log file you can read. Returns the task id at once (or after an optional wait).",
    promptSnippet: "Run a long command in the background (servers, watchers, long builds) and get notified",
    promptGuidelines: [
      "Use task_start for commands that run long or never end (dev servers, watchers, long builds and test suites); use bash for commands you wait for anyway.",
      "A task's notify decides what its end does: wake starts or joins a run, queue waits for your next run, none says nothing. Stop the tasks you no longer need with task_stop.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "The shell command" }),
      cwd: Type.Optional(Type.String({ description: "Working directory, relative to the session cwd" })),
      name: Type.Optional(Type.String({ description: "A short name shown to the operator" })),
      notify: Type.Optional(NOTIFY),
      watch: Type.Optional(Type.Array(Type.String(), { description: "Regular expressions: a matching output line notifies once each" })),
      wait_for: Type.Optional(
        Type.Object({
          exit: Type.Optional(Type.Boolean()),
          pattern: Type.Optional(Type.String()),
          timeout_s: Type.Optional(Type.Number()),
        }, { description: "Wait before returning: for exit, a matching line, or the timeout (whichever comes first)" }),
      ),
    }),
    executionMode: "sequential",
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const workspace = await scratchWorkspaceRoot(ctx);
      const sessionId = ctx.sessionManager.getSessionId();
      const task = supervisor.start({
        command: params.command,
        cwd: resolve(ctx.cwd, params.cwd ?? "."),
        name: params.name,
        notify: params.notify ?? defaultNotify(agentDir),
        env: { ...process.env, ...sessionSecrets.env(sessionId) },
        logPath: join(workspace, "tasks", `${Date.now()}-${toolCallId.slice(-8)}.log`),
        watch: (params.watch ?? []).map(regex),
      });
      const logPath = supervisor.logPath(task.id) ?? "";
      if (params.wait_for !== undefined) {
        const interrupt = interrupts.register(toolCallId);
        try {
          const outcome = await supervisor.wait(
            task.id,
            {
              exit: params.wait_for.exit ?? true,
              pattern: params.wait_for.pattern !== undefined ? regex(params.wait_for.pattern) : undefined,
              timeoutMs: (params.wait_for.timeout_s ?? DEFAULT_WAIT_S) * 1000,
            },
            signal !== undefined ? AbortSignal.any([signal, interrupt.signal]) : interrupt.signal,
          );
          return {
            content: [{ type: "text", text: `Started ${task.id}, log ${logPath}. ${describeOutcome(outcome)}` }],
            details: { task: outcome.task, logPath },
          };
        } catch (error) {
          throw interruptedError(error, interrupt.reason());
        } finally {
          interrupts.release(toolCallId);
        }
      } else {
        return { content: [{ type: "text", text: `Started ${task.id}, log ${logPath}.` }], details: { task, logPath } };
      }
    },
  });

  pi.registerTool({
    name: "task_status",
    label: "Task status",
    description: "The background tasks of this session (or one of them): state, exit code, duration, output size.",
    promptSnippet: "List background tasks and their state",
    parameters: Type.Object({ id: Type.Optional(Type.String()) }),
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const tasks = params.id !== undefined ? [supervisor.get(params.id)].filter((task): task is TaskInfo => task !== undefined) : supervisor.list();
      if (params.id !== undefined && tasks.length === 0) {
        throw new Error(`no task ${params.id}`);
      } else {
        const text = tasks.length > 0 ? tasks.map(describeTask).join("\n") : "No background tasks in this session.";
        return { content: [{ type: "text", text }], details: { tasks } };
      }
    },
  });

  pi.registerTool({
    name: "task_output",
    label: "Task output",
    description:
      "A background task's recent output: from a character offset (the `next` of the previous call continues), the last lines, or the lines matching a pattern. The whole output is in the task's log file.",
    promptSnippet: "Read a background task's output",
    parameters: Type.Object({
      id: Type.String(),
      offset: Type.Optional(Type.Number()),
      tail_lines: Type.Optional(Type.Number()),
      grep: Type.Optional(Type.String()),
    }),
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const output = supervisor.output(params.id, {
        offset: params.offset,
        tailLines: params.offset === undefined ? (params.tail_lines ?? 50) : undefined,
        grep: params.grep !== undefined ? regex(params.grep) : undefined,
      });
      const note = output.dropped ? `(earlier output is only in the log: ${supervisor.logPath(params.id)})\n` : "";
      return {
        content: [{ type: "text", text: `${note}${output.text}\n[next offset: ${output.next}]` }],
        details: { id: params.id, next: output.next },
      };
    },
  });

  pi.registerTool({
    name: "task_wait",
    label: "Wait for task",
    description: "Wait for a background task: for its exit, a matching output line, or the timeout — whichever comes first. \"/-\" from the operator interrupts the wait.",
    promptSnippet: "Wait for a background task to exit or print a line",
    parameters: Type.Object({
      id: Type.String(),
      exit: Type.Optional(Type.Boolean({ description: "Return when the task exits (default true)" })),
      pattern: Type.Optional(Type.String({ description: "Return on the first output line matching this regular expression" })),
      timeout_s: Type.Number({ description: "The longest wait, in seconds" }),
    }),
    executionMode: "sequential",
    async execute(toolCallId, params, signal) {
      const interrupt = interrupts.register(toolCallId);
      try {
        const outcome = await supervisor.wait(
          params.id,
          { exit: params.exit ?? true, pattern: params.pattern !== undefined ? regex(params.pattern) : undefined, timeoutMs: params.timeout_s * 1000 },
          signal !== undefined ? AbortSignal.any([signal, interrupt.signal]) : interrupt.signal,
        );
        const reason = outcome.kind === "aborted" ? interrupt.reason() : undefined;
        const text = reason !== undefined ? `${describeOutcome(outcome)}. Aborted by user. User-provided abort reason: ${reason}` : describeOutcome(outcome);
        return { content: [{ type: "text", text }], details: { task: outcome.task, outcome: outcome.kind } };
      } finally {
        interrupts.release(toolCallId);
      }
    },
  });

  pi.registerTool({
    name: "task_input",
    label: "Task input",
    description: "Write text to a background task's stdin (add \\n for a line).",
    promptSnippet: "Send input to a background task",
    parameters: Type.Object({ id: Type.String(), text: Type.String() }),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      supervisor.input(params.id, params.text);
      return { content: [{ type: "text", text: `Wrote ${params.text.length} characters to ${params.id}.` }], details: { id: params.id } };
    },
  });

  pi.registerTool({
    name: "task_stop",
    label: "Stop task",
    description: "Stop a background task: the signal (default SIGTERM) to its process group, SIGKILL after 5 s.",
    promptSnippet: "Stop a background task",
    parameters: Type.Object({
      id: Type.String(),
      signal: Type.Optional(Type.Union([Type.Literal("SIGTERM"), Type.Literal("SIGINT"), Type.Literal("SIGKILL"), Type.Literal("SIGHUP")])),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const task = supervisor.stop(params.id, params.signal);
      return { content: [{ type: "text", text: `Stopping ${describeTask(task)}` }], details: { task } };
    },
  });
}
