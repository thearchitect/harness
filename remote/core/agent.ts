/**
 * An agent: one pi session the gateway serves, and its `pi --mode rpc`
 * process when it runs. No Telegram here: what happens is reported to the
 * agent's listener (the view of wherever the agent currently is).
 *
 * - A prompt starts a run (a leading "!" builds: harness's contract, the "!"
 *   goes to pi as is); during a run a prompt steers it; a "/command" goes to
 *   pi without a run of its own.
 * - The process starts on demand (`pi --session-id`, the session is resumed
 *   from disk) and is reaped by the pool when idle.
 * - Deadlines: the process must be ready (get_state) within START_TIMEOUT_MS,
 *   every RPC request answers within REQUEST_TIMEOUT_MS; otherwise pi is
 *   taken for hung and killed. A run without a single event for
 *   MODEL_SILENCE_MS while the model works (TOOL_SILENCE_MS while a tool
 *   runs) is aborted, and killed ABORT_GRACE_MS later if it does not settle.
 *   An open dialog suspends the watchdog: it waits for the user, and does not
 *   keep the machine awake (the pool sees the agent as idle).
 */

import type { RpcExtensionUIRequest, RpcExtensionUIResponse, RpcResponse } from "@earendil-works/pi-coding-agent";
import type { Clock, Timer } from "./clock.ts";
import type { PoolProcess, SessionPool } from "./pool.ts";
import type { RpcEvent, RpcHandlers, RpcRequest, RpcSpec } from "./rpc.ts";

export const START_TIMEOUT_MS = 60_000;
export const REQUEST_TIMEOUT_MS = 60_000;
export const MODEL_SILENCE_MS = 2 * 60_000;
export const TOOL_SILENCE_MS = 60 * 60_000;
export const ABORT_GRACE_MS = 60_000;

/** harness's "per-message-mode-finished" entry (index.ts ModeDetails). */
export type FinishedDetails = {
  mode: "plan" | "normal";
  model?: string;
  effort?: string;
  finishedAt?: number;
  durationMs?: number;
  costUsd?: number;
  interrupted?: boolean;
};

export const FINISHED_ENTRY_TYPE = "per-message-mode-finished";

export type PiProcess = PoolProcess & {
  request(command: RpcRequest): Promise<RpcResponse>;
  respondUi(response: RpcExtensionUIResponse): void;
  stderrTail(): string[];
};

export type AgentStatus = "stopped" | "idle" | "running" | "waiting";

export type Settled = { aborted: boolean; banner?: FinishedDetails; lastText: string };

/** What the agent reports; the current view implements it. */
export type AgentListener = {
  runStarted(build: boolean): void;
  event(event: RpcEvent): void;
  uiRequest(request: RpcExtensionUIRequest): void;
  settled(result: Settled): void;
  /** The process ended; `problem` is set when nobody asked it to (a crash, a hang). */
  exited(problem: string | undefined): void;
  /** Something failed that the user should see. */
  problem(message: string): void;
  /** Status, model or thinking level changed. */
  changed(): void;
};

export type AgentDeps = {
  clock: Clock;
  pool: SessionPool<PiProcess>;
  spawn(spec: RpcSpec, handlers: RpcHandlers): PiProcess;
  log(line: string): void;
  /** The process of an agent ended (after its listener heard of it): the registry decides whether the agent goes on. */
  exited(agent: Agent): void;
};

export type UserInput = { text: string; images?: { data: string; mimeType: string }[] };

type Run = { build: boolean; banner?: FinishedDetails; lastText: string; activeTools: number };

export class Agent {
  readonly sessionId: string;
  readonly userId: number;
  readonly cwd: string;
  title: string;
  listener: AgentListener | undefined;
  private readonly deps: AgentDeps;
  private readonly spec: () => RpcSpec;
  private proc: PiProcess | undefined;
  private starting: Promise<PiProcess | { problem: string }> | undefined;
  private run: Run | undefined;
  private readonly pendingUi = new Set<string>();
  private model: string | undefined;
  private thinking: string | undefined;
  private watchdog: Timer | undefined;
  /** Why the gateway killed the current process (a hang); undefined for an orderly stop. */
  private killed: string | undefined;

  constructor(deps: AgentDeps, userId: number, sessionId: string, cwd: string, title: string, spec: () => RpcSpec) {
    this.deps = deps;
    this.userId = userId;
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.title = title;
    this.spec = spec;
  }

  get status(): AgentStatus {
    if (this.proc === undefined) {
      return "stopped";
    } else if (this.run === undefined) {
      return "idle";
    } else if (this.pendingUi.size > 0) {
      return "waiting";
    } else {
      return "running";
    }
  }

  get running(): boolean {
    return this.proc !== undefined;
  }

  get inRun(): boolean {
    return this.run !== undefined;
  }

  get currentModel(): string | undefined {
    return this.model;
  }

  get currentThinking(): string | undefined {
    return this.thinking;
  }

  /** Sends a prompt; resolves once it is sent (an extension command may open a dialog before pi answers). */
  async prompt(input: UserInput): Promise<void> {
    const proc = await this.ensureProcess();
    if ("problem" in proc) {
      this.listener?.problem(proc.problem);
      return;
    }
    if (this.title === "" && !input.text.startsWith("/")) this.title = input.text.replace(/^!\s*/, "").replace(/\s+/g, " ").slice(0, 80);
    const images = input.images?.map((image) => ({ type: "image" as const, ...image }));
    if (this.run !== undefined) {
      void this.request(proc, { type: "prompt", message: input.text, images, streamingBehavior: "steer" });
    } else if (input.text.startsWith("/")) {
      void this.request(proc, { type: "prompt", message: input.text, images }).then(() => this.listener?.changed());
    } else {
      const run: Run = { build: input.text.startsWith("!"), lastText: "", activeTools: 0 };
      this.run = run; // from now on, messages steer it
      this.updateBusy();
      this.listener?.runStarted(run.build);
      this.listener?.changed();
      this.armWatchdog();
      void this.request(proc, { type: "prompt", message: input.text, images }).then((response) => {
        const disposition = response?.success === true ? (response as { data?: { disposition?: string } }).data?.disposition : undefined;
        if (disposition === "started" || this.run !== run) {
          // the run goes on (or has already settled)
        } else {
          // not started (rejected, or consumed by an input handler): no run
          this.endRun();
          this.listener?.settled({ aborted: disposition !== "handled", lastText: "" });
          this.listener?.changed();
        }
      });
    }
  }

  async abort(): Promise<void> {
    if (this.proc !== undefined && this.run !== undefined) {
      await this.request(this.proc, { type: "abort" });
    } else {
      // nothing runs
    }
  }

  respondUi(response: RpcExtensionUIResponse): void {
    this.pendingUi.delete(response.id);
    this.updateBusy();
    if (this.run !== undefined) this.armWatchdog();
    this.proc?.respondUi(response);
    this.listener?.changed();
  }

  async models(): Promise<{ provider: string; id: string }[] | { problem: string }> {
    const proc = await this.ensureProcess();
    if ("problem" in proc) return proc;
    const response = await this.request(proc, { type: "get_available_models" });
    return response?.success
      ? ((response as { data?: { models?: { provider: string; id: string }[] } }).data?.models ?? []).map((m) => ({ provider: m.provider, id: m.id }))
      : { problem: "could not list the models" };
  }

  async thinkingLevels(): Promise<string[] | { problem: string }> {
    const proc = await this.ensureProcess();
    if ("problem" in proc) return proc;
    const response = await this.request(proc, { type: "get_available_thinking_levels" });
    return response?.success ? ((response as { data?: { levels?: string[] } }).data?.levels ?? []) : { problem: "could not list the thinking levels" };
  }

  async setModel(provider: string, modelId: string): Promise<{ ok: true } | { problem: string }> {
    const proc = await this.ensureProcess();
    if ("problem" in proc) return proc;
    const response = await this.request(proc, { type: "set_model", provider, modelId });
    if (response?.success) {
      this.model = `${provider}/${modelId}`;
      this.listener?.changed();
      return { ok: true };
    } else {
      return { problem: "could not switch the model" };
    }
  }

  async setThinking(level: string): Promise<{ ok: true } | { problem: string }> {
    const proc = await this.ensureProcess();
    if ("problem" in proc) return proc;
    const response = await this.request(proc, { type: "set_thinking_level", level: level as never });
    if (response?.success) {
      this.thinking = level;
      this.listener?.changed();
      return { ok: true };
    } else {
      return { problem: "could not set the thinking level" };
    }
  }

  /** Starts the process now (to show model and thinking level); resolves with the problem, if any. */
  async start(): Promise<string | undefined> {
    const proc = await this.ensureProcess();
    return "problem" in proc ? proc.problem : undefined;
  }

  /** Stops the process (the session stays on disk). */
  async stop(): Promise<void> {
    this.cancelWatchdog();
    await this.deps.pool.stop(this.sessionId);
  }

  /* ------------------------------------------------------------------------ */

  private ensureProcess(): Promise<PiProcess | { problem: string }> {
    if (this.proc !== undefined) {
      return Promise.resolve(this.proc);
    } else if (this.starting !== undefined) {
      return this.starting;
    } else {
      this.starting = this.startProcess().finally(() => (this.starting = undefined));
      return this.starting;
    }
  }

  private async startProcess(): Promise<PiProcess | { problem: string }> {
    const room = this.deps.pool.makeRoom(this.userId);
    if (!room.ok) return { problem: room.reason };
    this.killed = undefined;
    const proc = this.deps.spawn(this.spec(), {
      onEvent: (event) => this.onEvent(event),
      onUiRequest: (request) => this.onUiRequest(request),
      onLog: (line) => this.deps.log(`${this.sessionId.slice(0, 8)}: pi: ${line}`),
    });
    this.proc = proc;
    // Registered before the pool's own exit handler: at exit, a process still
    // in the pool was not stopped by anyone (pool.stop removes it first).
    void proc.exited.then(() => this.onExit(proc));
    this.deps.pool.add(this.sessionId, this.userId, proc);
    const state = await this.timed(proc, proc.request({ type: "get_state" }), START_TIMEOUT_MS, "pi did not start");
    if (state === undefined) {
      return { problem: `pi did not start within ${START_TIMEOUT_MS / 1000} s\n${proc.stderrTail().slice(-10).join("\n")}` };
    } else if (state.success) {
      const data = (state as { data?: { model?: { provider: string; id: string }; thinkingLevel?: string } }).data;
      this.model = data?.model !== undefined ? `${data.model.provider}/${data.model.id}` : undefined;
      this.thinking = data?.thinkingLevel;
      this.listener?.changed();
      return proc;
    } else {
      return { problem: `pi did not start: ${(state as { error?: string }).error ?? "get_state failed"}` };
    }
  }

  /** A request answered within REQUEST_TIMEOUT_MS, or undefined (pi exited or hung: then it is killed). */
  private async request(proc: PiProcess, command: RpcRequest): Promise<RpcResponse | undefined> {
    const response = await this.timed(proc, proc.request(command), REQUEST_TIMEOUT_MS, `pi did not answer ${command.type}`);
    if (response !== undefined && !response.success) {
      this.listener?.problem(`${command.type}: ${(response as { error?: string }).error ?? "failed"}`);
    } else {
      // answered, or reported by timed()
    }
    return response;
  }

  private async timed(proc: PiProcess, pending: Promise<RpcResponse>, limitMs: number, what: string): Promise<RpcResponse | undefined> {
    let timer: Timer | undefined;
    const deadline = new Promise<"timeout">((resolve) => (timer = this.deps.clock.after(limitMs, () => resolve("timeout"))));
    try {
      const outcome = await Promise.race([pending, deadline]);
      if (outcome === "timeout") {
        this.kill(proc, `${what} within ${limitMs / 1000} s: killed`);
        return undefined;
      } else {
        return outcome;
      }
    } catch (error) {
      this.deps.log(`${this.sessionId.slice(0, 8)}: ${what}: ${(error as Error).message}`);
      return undefined;
    } finally {
      timer?.cancel();
    }
  }

  private kill(proc: PiProcess, reason: string): void {
    if (this.proc === proc && this.killed === undefined) {
      this.killed = reason;
      proc.kill("SIGKILL");
    } else {
      // already gone or already being killed
    }
  }

  private onEvent(event: RpcEvent): void {
    const run = this.run;
    if (run !== undefined) this.armWatchdog();
    switch (event.type) {
      case "entry_appended": {
        const entry = event.entry as { type?: string; customType?: string; data?: FinishedDetails };
        if (entry.type === "custom" && entry.customType === FINISHED_ENTRY_TYPE && entry.data !== undefined && run !== undefined) {
          run.banner = entry.data;
        } else {
          // other entries are not shown
        }
        return;
      }
      case "thinking_level_changed":
        this.thinking = event.level;
        this.listener?.changed();
        return;
      case "agent_settled":
        if (run !== undefined) {
          this.endRun();
          this.listener?.settled({ aborted: event.aborted, banner: run.banner, lastText: run.lastText });
          this.listener?.changed();
        } else {
          // a run of an extension command, or already settled
        }
        return;
      case "extension_error":
        this.listener?.problem(`extension error (${event.event}): ${event.error}`);
        return;
      case "tool_execution_start":
        if (run !== undefined) {
          run.activeTools += 1;
          this.armWatchdog();
        }
        this.listener?.event(event);
        return;
      case "tool_execution_end":
        if (run !== undefined) {
          run.activeTools = Math.max(0, run.activeTools - 1);
          this.armWatchdog();
        }
        this.listener?.event(event);
        return;
      case "message_end": {
        const message = event.message as { role?: string; content?: unknown };
        if (run !== undefined && message.role === "assistant") {
          const text = textOf(message.content).trim();
          if (text !== "") run.lastText = text;
        }
        this.listener?.event(event);
        return;
      }
      default:
        this.listener?.event(event);
        return;
    }
  }

  private onUiRequest(request: RpcExtensionUIRequest): void {
    switch (request.method) {
      case "select":
      case "confirm":
      case "input":
      case "editor":
        this.pendingUi.add(request.id);
        this.cancelWatchdog();
        this.updateBusy();
        this.listener?.changed();
        break;
      default:
        break; // notifications and TUI decorations wait for nothing
    }
    this.listener?.uiRequest(request);
  }

  private onExit(proc: PiProcess): void {
    if (this.proc !== proc) return; // an older process
    const unexpected = this.deps.pool.get(this.sessionId) === proc;
    const problem = this.killed ?? (unexpected ? `pi exited unexpectedly\n${proc.stderrTail().slice(-10).join("\n")}` : undefined);
    this.proc = undefined;
    this.endRun();
    this.pendingUi.clear();
    this.listener?.exited(problem);
    this.listener?.changed();
    this.deps.exited(this);
  }

  private endRun(): void {
    this.run = undefined;
    this.cancelWatchdog();
    this.updateBusy();
  }

  private updateBusy(): void {
    this.deps.pool.setBusy(this.sessionId, this.run !== undefined && this.pendingUi.size === 0);
  }

  /** (Re)starts the silence watchdog for the current phase of the run. */
  private armWatchdog(): void {
    this.cancelWatchdog();
    const run = this.run;
    if (run === undefined || this.pendingUi.size > 0) {
      return; // no run, or waiting for the user
    }
    const limit = run.activeTools > 0 ? TOOL_SILENCE_MS : MODEL_SILENCE_MS;
    this.watchdog = this.deps.clock.after(limit, () => {
      const proc = this.proc;
      if (proc === undefined || this.run !== run) return;
      this.listener?.problem(`No output for ${limit / 60_000} min: run aborted.`);
      void this.request(proc, { type: "abort" });
      this.watchdog = this.deps.clock.after(ABORT_GRACE_MS, () => {
        if (this.run === run) this.kill(proc, "the aborted run did not stop: pi killed");
      });
    });
  }

  private cancelWatchdog(): void {
    this.watchdog?.cancel();
    this.watchdog = undefined;
  }
}

/** The text parts of a message content. */
export function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  } else if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: "text"; text: string } => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text")
      .map((part) => part.text)
      .join("\n");
  } else {
    return "";
  }
}
