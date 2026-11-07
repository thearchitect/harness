/**
 * The agent of one place (a topic or All): its pi process, its runs, dialogs
 * and pinned status line. It exists from /agent to /close (or until the user
 * deletes the topic).
 *
 * - A message starts a run, in plan; a message starting with "!" builds (the
 *   harness contract: the "!" goes to pi as is). During a run a message
 *   steers it.
 * - /stop (or the draft's native stop) aborts; /model, /thinking, /compact
 *   and /close act on the agent; their choices are panels at the bottom.
 * - The pinned line shows directory, model, thinking level and state.
 *
 * The process starts on demand (`pi --session-id`, the session is resumed
 * from disk) and is reaped by the pool when idle.
 */

import type { RpcExtensionUIRequest, RpcExtensionUIResponse, RpcResponse } from "@earendil-works/pi-coding-agent";
import { homeOf } from "./accounts.ts";
import { closePanel, modelsPanel, renderSessionCard, thinkingPanel, type SessionStatus } from "./card.ts";
import type { Clock, Timer } from "./clock.ts";
import type { Config, UserConfig } from "./config.ts";
import { Dialogs } from "./dialogs.ts";
import type { Outbox } from "./outbox.ts";
import type { PoolProcess, SessionPool } from "./pool.ts";
import { bannerLine, escapeHtml, FINISHED_ENTRY_TYPE, type FinishedDetails } from "./render.ts";
import type { RpcEvent, RpcHandlers, RpcRequest, RpcSpec } from "./rpc.ts";
import type { AgentState, Place, StateStore } from "./state.ts";
import { RunView } from "./stream.ts";

export type PiProcess = PoolProcess & {
  request(command: RpcRequest): Promise<RpcResponse>;
  respondUi(response: RpcExtensionUIResponse): void;
  stderrTail(): string[];
};

/** What every agent shares: the gateway's services. */
export type SessionDeps = {
  config: Config;
  store: StateStore;
  pool: SessionPool<PiProcess>;
  clock: Clock;
  log(line: string): void;
  spawn(spec: RpcSpec, handlers: RpcHandlers): PiProcess;
  /** The pi command for an agent (accounts.ts piSpec). */
  spec(user: UserConfig, agent: AgentState): RpcSpec;
  newDraftId(): number;
};

export type UserInput = { text: string; images?: { data: string; mimeType: string }[] };

const CARD_REFRESH_MS = 10_000;

type Run = { view: RunView; banner?: FinishedDetails };

export class Agent {
  readonly outbox: Outbox;
  private readonly deps: SessionDeps;
  private readonly user: UserConfig;
  private readonly place: Place;
  private readonly dialogs: Dialogs;
  private proc: PiProcess | undefined;
  private starting: Promise<PiProcess | { problem: string }> | undefined;
  private run: Run | undefined;
  private status: SessionStatus = { kind: "stopped" };
  /** The lists the open panel shows (its buttons carry indexes). */
  private models: { provider: string; id: string }[] = [];
  private levels: string[] = [];
  private model: string | undefined;
  private thinking: string | undefined;
  private cardTimer: Timer | undefined;
  /** Closed or the gateway stops: exits are expected. */
  private stopping = false;

  /** `outbox`: the place's (the gateway owns one per place). */
  constructor(deps: SessionDeps, user: UserConfig, place: Place, outbox: Outbox) {
    this.deps = deps;
    this.user = user;
    this.place = place;
    this.outbox = outbox;
    this.dialogs = new Dialogs({
      outbox: this.outbox,
      clock: deps.clock,
      respond: (response) => this.proc?.respondUi(response),
      opened: async () => {
        this.setStatus({ kind: "waiting" });
        await this.run?.view.pause();
      },
      closed: () => {
        if (this.run !== undefined) {
          this.setStatus({ kind: "running", since: this.deps.clock.now() });
          this.run.view.resume();
        } else {
          this.setStatus(this.proc !== undefined ? { kind: "idle" } : { kind: "stopped" });
        }
      },
    });
  }

  private get state(): AgentState {
    const agent = this.deps.store.agent(this.user.telegramId, this.place);
    if (agent === undefined) throw new Error(`no agent in place ${this.place ?? "All"}`);
    return agent;
  }

  private get key(): string {
    return `${this.user.telegramId}:${this.place ?? "all"}`;
  }

  get dir(): string {
    return displayDir(this.state.cwd, this.deps.config, this.user);
  }

  /** Nothing waits for the gateway or the user. */
  get quiescent(): boolean {
    return this.run === undefined && !this.dialogs.isOpen;
  }

  get isRunning(): boolean {
    return this.run !== undefined;
  }

  /** Posts and pins the status line (agent just started), and starts pi. */
  async open(): Promise<void> {
    const messageId = await this.outbox.send({ html: renderSessionCard(this.cardState(), this.deps.clock.now()) }, { role: "pinned" });
    if (messageId !== undefined) {
      this.deps.store.updateAgent(this.user.telegramId, this.place, (a) => (a.cardMessageId = messageId));
      await this.outbox.pin(messageId);
    } else {
      // could not post: logged by the outbox
    }
    const proc = await this.ensureProcess();
    if ("problem" in proc) await this.fail(proc.problem);
  }

  /** A message from the user in this place. */
  async userInput(input: UserInput): Promise<void> {
    await this.outbox.userPosted();
    if (await this.dialogs.text(input.text)) {
      // the text answered the open dialog
    } else {
      await this.submit(input);
    }
  }

  /**
   * Sends a prompt: a new run, or a steer into the running one. Resolves once
   * the prompt is sent, not when pi answers it: an extension command may open
   * a dialog before pi responds, and its answer is a later update of this
   * user.
   */
  private async submit(input: UserInput): Promise<void> {
    const proc = await this.ensureProcess();
    if ("problem" in proc) {
      await this.fail(proc.problem);
      return;
    }
    const images = input.images?.map((image) => ({ type: "image" as const, ...image }));
    if (this.run !== undefined) {
      void this.request(proc, { type: "prompt", message: input.text, images, streamingBehavior: "steer" });
    } else if (input.text.startsWith("/")) {
      // a command of an extension (pi's own commands do not exist over RPC): no run of its own
      void this.request(proc, { type: "prompt", message: input.text, images }).then(() => this.refreshCard());
    } else {
      // The run exists from now on, so messages that follow steer it.
      const run: Run = { view: new RunView(this.outbox, this.deps.clock, input.text.startsWith("!") ? "Building" : "Planning", this.deps.newDraftId()) };
      this.run = run;
      this.deps.pool.setBusy(this.key, true);
      this.setStatus({ kind: "running", since: this.deps.clock.now() });
      void this.request(proc, { type: "prompt", message: input.text, images }).then((response) => {
        const disposition = response?.success === true ? (response as { data?: { disposition?: string } }).data?.disposition : undefined;
        if (disposition === "started" || this.run !== run) {
          // the run goes on (or has already settled)
        } else {
          // not started (rejected, or consumed by an input handler): no run
          this.run = undefined;
          run.view.dispose();
          this.deps.pool.setBusy(this.key, false);
          this.setStatus({ kind: "idle" });
        }
      });
    }
  }

  /** /stop and the draft's native stop. */
  async stop(): Promise<void> {
    await this.dialogs.cancel();
    if (this.proc !== undefined && this.run !== undefined) {
      await this.request(this.proc, { type: "abort" });
    } else {
      // nothing runs
    }
  }

  /** /model, /thinking, /compact, /close and the buttons of their panels (`s:<action>[:<arg>]`); resolves with the toast text. */
  async panelAction(action: string, arg: string | undefined): Promise<string> {
    switch (action) {
      case "models": {
        const proc = await this.ensureProcess();
        if ("problem" in proc) return this.failPanel(proc.problem);
        const page = Number(arg ?? 0);
        if (page === 0) this.models = await this.availableModels(proc);
        await this.outbox.showPanel(modelsPanel(this.models, page, this.model));
        return "Model";
      }
      case "model": {
        const chosen = this.models[Number(arg)];
        const proc = this.proc;
        if (chosen === undefined || proc === undefined) {
          return this.failPanel("The list is outdated, run /model again.");
        } else {
          const response = await this.request(proc, { type: "set_model", provider: chosen.provider, modelId: chosen.id });
          if (response?.success) this.model = `${chosen.provider}/${chosen.id}`;
          this.refreshCard();
          await this.outbox.closePanel(response?.success ? `Model: ${escapeHtml(chosen.provider)}/${escapeHtml(chosen.id)}` : "Could not switch the model.");
          return response?.success ? chosen.id : "Failed";
        }
      }
      case "thinking": {
        const proc = await this.ensureProcess();
        if ("problem" in proc) return this.failPanel(proc.problem);
        const response = await this.request(proc, { type: "get_available_thinking_levels" });
        this.levels = response?.success ? ((response as { data?: { levels?: string[] } }).data?.levels ?? []) : [];
        await this.outbox.showPanel(thinkingPanel(this.levels, this.thinking));
        return "Thinking level";
      }
      case "level": {
        const level = this.levels[Number(arg)];
        const proc = this.proc;
        if (level === undefined || proc === undefined) {
          return this.failPanel("The list is outdated, run /thinking again.");
        } else {
          const response = await this.request(proc, { type: "set_thinking_level", level: level as never });
          if (response?.success) this.thinking = level;
          this.refreshCard();
          await this.outbox.closePanel(response?.success ? `Thinking: ${escapeHtml(level)}` : "Could not set the level.");
          return response?.success ? level : "Failed";
        }
      }
      case "compact": {
        if (this.run !== undefined) return this.failPanel("Wait until the run finishes.");
        const proc = await this.ensureProcess();
        if ("problem" in proc) return this.failPanel(proc.problem);
        this.setStatus({ kind: "compacting" });
        this.deps.pool.setBusy(this.key, true);
        void this.request(proc, { type: "compact" }).then((response) => {
          this.deps.pool.setBusy(this.key, false);
          this.setStatus({ kind: "idle" });
          void this.outbox.send({ html: response?.success ? "Context compacted." : "Compaction failed." }, { silent: response?.success === true });
        });
        return "Compacting";
      }
      case "close":
        await this.outbox.showPanel(closePanel(this.dir));
        return "Close the agent?";
      case "closeyes":
        await this.outbox.closePanel(`Agent in ${escapeHtml(this.dir)} closed.`);
        await this.close();
        return "Closed";
      case "dismiss":
        await this.outbox.closePanel(undefined);
        return "OK";
      default:
        return "Unknown action";
    }
  }

  /** A dialog button `d:<seq>:<action>`. */
  dialogButton(seq: number, action: string): Promise<string> {
    return this.dialogs.press(seq, action);
  }

  /** Stops the agent for good: the process stops, the place has no agent any more. */
  async close(): Promise<void> {
    this.stopping = true;
    await this.stop();
    this.run?.view.dispose();
    this.run = undefined;
    this.dialogs.reset();
    await this.stopProcess();
    this.cardTimer?.cancel();
    const cardId = this.deps.store.agent(this.user.telegramId, this.place)?.cardMessageId;
    if (cardId !== undefined) {
      await this.outbox.edit(cardId, { html: renderSessionCard({ ...this.cardState(), status: { kind: "closed" } }, this.deps.clock.now()) });
      await this.outbox.unpin(cardId);
    } else {
      // no status line was posted
    }
    this.deps.store.removeAgent(this.user.telegramId, this.place);
  }

  /** The user deleted the topic: the agent goes, nothing is posted. */
  async placeGone(): Promise<void> {
    this.stopping = true;
    this.run?.view.dispose();
    this.run = undefined;
    this.dialogs.reset();
    this.cardTimer?.cancel();
    await this.stopProcess();
    this.deps.store.removeAgent(this.user.telegramId, this.place);
  }

  /** The gateway shuts down: a running run is interrupted with a notice. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.run !== undefined) {
      await this.outbox.send({ html: "Server restarting: the run is interrupted. Send a message to continue." }, { silent: false });
      await this.stop();
    } else {
      // idle: nothing to tell the user
    }
    this.cardTimer?.cancel();
  }

  /* ------------------------------------------------------------------------ */

  private async fail(problem: string): Promise<void> {
    await this.outbox.send({ html: `Error: ${escapeHtml(problem)}` }, { silent: false });
  }

  private async failPanel(problem: string): Promise<string> {
    await this.outbox.closePanel(escapeHtml(problem));
    return "Failed";
  }

  private async stopProcess(): Promise<void> {
    if (this.proc !== undefined) {
      this.proc = undefined; // onExit sees no current process: an expected exit
      await this.deps.pool.stop(this.key);
    } else {
      // no process
    }
  }

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
    const room = this.deps.pool.makeRoom(this.user.telegramId);
    if (!room.ok) return { problem: room.reason };
    const proc = this.deps.spawn(this.deps.spec(this.user, this.state), {
      onEvent: (event) => this.onEvent(event),
      onUiRequest: (request) => void this.onUiRequest(request),
      onLog: (line) => this.log(`pi: ${line}`),
    });
    this.proc = proc;
    // Registered before the pool's own exit handler: at exit, a process still
    // in the pool was not stopped by anyone - an unexpected exit.
    void proc.exited.then(() => this.onExit(proc));
    this.deps.pool.add(this.key, this.user.telegramId, proc);
    let state: RpcResponse | undefined;
    try {
      state = await proc.request({ type: "get_state" });
    } catch (error) {
      return { problem: `pi did not start: ${(error as Error).message}\n${proc.stderrTail().slice(-10).join("\n")}` };
    }
    if (state.success) {
      const data = (state as { data?: { model?: { provider: string; id: string }; thinkingLevel?: string } }).data;
      this.model = data?.model !== undefined ? `${data.model.provider}/${data.model.id}` : undefined;
      this.thinking = data?.thinkingLevel;
    } else {
      this.log(`get_state failed: ${(state as { error?: string }).error ?? "?"}`);
    }
    this.setStatus({ kind: "idle" });
    return proc;
  }

  private onExit(proc: PiProcess): void {
    const unexpected = !this.stopping && this.deps.pool.get(this.key) === proc;
    if (this.proc === proc) {
      this.proc = undefined;
    } else {
      // already detached by stopProcess (close, place gone)
    }
    const run = this.run;
    this.run = undefined;
    run?.view.dispose();
    this.dialogs.reset();
    if (unexpected) {
      const tail = proc.stderrTail().slice(-10).join("\n");
      void this.outbox.send({ html: `pi exited unexpectedly.${tail ? `\n<pre>${escapeHtml(tail)}</pre>` : ""}\nSend a message to start it again.` }, { silent: false });
    } else {
      // stopped by the pool or the user
    }
    if (!this.stopping) this.setStatus({ kind: "stopped" });
  }

  private onEvent(event: RpcEvent): void {
    if (event.type === "entry_appended") {
      const entry = event.entry as { type?: string; customType?: string; data?: FinishedDetails };
      if (entry.type === "custom" && entry.customType === FINISHED_ENTRY_TYPE && entry.data !== undefined && this.run !== undefined) {
        this.run.banner = entry.data;
      } else {
        // other entries are not shown
      }
    } else if (event.type === "thinking_level_changed") {
      this.thinking = event.level;
      this.refreshCard();
    } else if (event.type === "agent_settled") {
      void this.settle(event.aborted);
    } else if (event.type === "extension_error") {
      void this.outbox.send({ html: `Extension error (${escapeHtml(event.event)}): ${escapeHtml(event.error)}` }, { silent: false });
    } else {
      this.run?.view.onEvent(event);
    }
  }

  private async onUiRequest(request: RpcExtensionUIRequest): Promise<void> {
    await this.dialogs.handle(request);
  }

  private async settle(aborted: boolean): Promise<void> {
    const run = this.run;
    if (run === undefined) {
      return; // a run of an extension command, or already settled
    }
    this.run = undefined;
    const interrupted = aborted || run.banner?.interrupted === true;
    const banner = run.banner !== undefined ? bannerLine({ ...run.banner, interrupted }) : interrupted ? "interrupted" : undefined;
    await run.view.finish(banner);
    this.deps.pool.setBusy(this.key, false);
    this.setStatus(this.proc !== undefined ? { kind: "idle" } : { kind: "stopped" });
  }

  private async availableModels(proc: PiProcess): Promise<{ provider: string; id: string }[]> {
    const response = await this.request(proc, { type: "get_available_models" });
    const models = response?.success ? ((response as { data?: { models?: { provider: string; id: string }[] } }).data?.models ?? []) : [];
    return models.map((m) => ({ provider: m.provider, id: m.id }));
  }

  private async request(proc: PiProcess, command: RpcRequest): Promise<RpcResponse | undefined> {
    try {
      const response = await proc.request(command);
      if (!response.success) {
        await this.fail(`${command.type}: ${(response as { error?: string }).error ?? "failed"}`);
      } else {
        // accepted
      }
      return response;
    } catch (error) {
      this.log(`${command.type}: ${(error as Error).message}`);
      return undefined;
    }
  }

  private setStatus(status: SessionStatus): void {
    this.status = status;
    this.cardTimer?.cancel();
    this.cardTimer = status.kind === "running" ? this.deps.clock.after(CARD_REFRESH_MS, () => this.setStatus(this.status)) : undefined;
    this.refreshCard();
  }

  private cardState(): Parameters<typeof renderSessionCard>[0] {
    return { dir: this.dir, model: this.model, thinking: this.thinking, status: this.status };
  }

  private refreshCard(): void {
    const cardId = this.deps.store.agent(this.user.telegramId, this.place)?.cardMessageId;
    if (cardId === undefined || this.stopping) {
      return; // no status line yet, or the agent is going away
    } else {
      void this.outbox.edit(cardId, { html: renderSessionCard(this.cardState(), this.deps.clock.now()) });
    }
  }

  private log(line: string): void {
    this.deps.log(`${this.user.name}/${this.place ?? "all"}: ${line}`);
  }
}

/** `~` or `~/sub/dir` for a directory inside the user's home. */
export function displayDir(cwd: string, config: Config, user: UserConfig): string {
  const home = homeOf(config, user);
  return cwd === home ? "~" : cwd.startsWith(`${home}/`) ? `~/${cwd.slice(home.length + 1)}` : cwd;
}
