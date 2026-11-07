/**
 * One topic bound to a pi session: its process, its runs, dialogs and card.
 *
 * - A message starts a run (plan by default; build when the card says so for
 *   this one message, or with a leading "!"); during a run it steers.
 * - Reactions on the user's message: 👀 accepted, ✍ steered into the run,
 *   👌 finished, 💔 failed or interrupted.
 * - The pinned card shows directory, model, thinking level, the next
 *   message's mode and the status, and carries the session controls.
 * - After planning, the final message offers 🔨 Build / 💬 Build with note.
 *
 * The process starts on demand (`pi --session-id`, the session is resumed
 * from disk) and is reaped by the pool when idle.
 */

import type { RpcExtensionUIRequest, RpcExtensionUIResponse, RpcResponse } from "@earendil-works/pi-coding-agent";
import { homeOf } from "./accounts.ts";
import { renderSessionCard, type SessionStatus, type SessionView } from "./card.ts";
import type { Clock, Timer } from "./clock.ts";
import type { Config, UserConfig } from "./config.ts";
import { Dialogs } from "./dialogs.ts";
import { Outbox, type Keyboard } from "./outbox.ts";
import type { PoolProcess, SessionPool } from "./pool.ts";
import { bannerLine, escapeHtml, FINISHED_ENTRY_TYPE, type FinishedDetails } from "./render.ts";
import type { RpcEvent, RpcHandlers, RpcRequest, RpcSpec } from "./rpc.ts";
import type { StateStore, TopicState } from "./state.ts";
import { RunView } from "./stream.ts";
import type { Tg } from "./tg.ts";

export type PiProcess = PoolProcess & {
  request(command: RpcRequest): Promise<RpcResponse>;
  respondUi(response: RpcExtensionUIResponse): void;
  stderrTail(): string[];
};

/** What every session shares: the gateway's services. */
export type SessionDeps = {
  config: Config;
  store: StateStore;
  pool: SessionPool<PiProcess>;
  tg: Tg;
  clock: Clock;
  log(line: string): void;
  spawn(spec: RpcSpec, handlers: RpcHandlers): PiProcess;
  /** The pi command for a topic (accounts.ts piSpec). */
  spec(user: UserConfig, topic: TopicState): RpcSpec;
  newDraftId(): number;
};

export type UserInput = { text: string; images?: { data: string; mimeType: string }[]; messageId?: number };

export const BUILD_PLAN_PROMPT = "Implement the agreed plan.";
const CARD_REFRESH_MS = 10_000;

type Run = { view: RunView; title: "Planning" | "Building"; messages: number[]; banner?: FinishedDetails };

export class TopicSession {
  readonly outbox: Outbox;
  private readonly deps: SessionDeps;
  private readonly user: UserConfig;
  private readonly threadId: number;
  private readonly dialogs: Dialogs;
  private proc: PiProcess | undefined;
  private starting: Promise<PiProcess | { problem: string }> | undefined;
  private run: Run | undefined;
  private status: SessionStatus = { kind: "stopped" };
  private view: SessionView = { kind: "main" };
  private model: string | undefined;
  private thinking: string | undefined;
  private cardTimer: Timer | undefined;
  /** The next text is the note of "Build with note". */
  private awaitingBuildNote = false;
  private stopping = false;

  constructor(deps: SessionDeps, user: UserConfig, threadId: number) {
    this.deps = deps;
    this.user = user;
    this.threadId = threadId;
    this.outbox = new Outbox(deps.tg, user.telegramId, threadId, (line) => this.log(line), () => void this.threadGone());
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

  get topic(): TopicState {
    const topic = this.deps.store.topic(this.user.telegramId, this.threadId);
    if (topic === undefined) throw new Error(`topic ${this.threadId} is not bound`);
    return topic;
  }

  private get key(): string {
    return `${this.user.telegramId}:${this.threadId}`;
  }

  /** Nothing in this topic waits for the gateway or the user. */
  get quiescent(): boolean {
    return this.run === undefined && !this.dialogs.isOpen && !this.awaitingBuildNote;
  }

  get isRunning(): boolean {
    return this.run !== undefined;
  }

  /** Posts and pins the session card (topic just bound). */
  async createCard(): Promise<void> {
    const card = renderSessionCard(this.cardState(), this.deps.clock.now());
    const messageId = await this.outbox.send({ html: card.html }, { role: "pinned", keyboard: card.keyboard });
    if (messageId !== undefined) {
      this.deps.store.updateTopic(this.user.telegramId, this.threadId, (t) => (t.cardMessageId = messageId));
      await this.outbox.pin(messageId);
    } else {
      // could not post: logged by the outbox
    }
  }

  /** A text (with optional photos) from the user in this topic. */
  async userInput(input: UserInput): Promise<void> {
    await this.outbox.userPosted();
    if (this.topic.closed) {
      await this.outbox.send({ html: "This session is closed — start a new topic." }, { silent: false });
    } else if (await this.dialogs.text(input.text)) {
      // the text answered the open dialog
    } else if (this.awaitingBuildNote) {
      this.awaitingBuildNote = false;
      await this.outbox.closeSticky({ html: `💬 Build with note: ${escapeHtml(input.text)}` });
      await this.submit({ ...input, text: `!${input.text}` });
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
  async submit(input: UserInput): Promise<void> {
    const proc = await this.ensureProcess();
    if ("problem" in proc) {
      await this.outbox.send({ html: `❌ ${escapeHtml(proc.problem)}` }, { silent: false });
      if (input.messageId !== undefined) await this.outbox.react(input.messageId, "💔");
      return;
    }
    const images = input.images?.map((image) => ({ type: "image" as const, ...image }));
    const react = (emoji: "👀" | "✍" | "👌" | "💔"): void => {
      if (input.messageId !== undefined) void this.outbox.react(input.messageId, emoji);
    };
    if (this.run !== undefined) {
      const run = this.run;
      if (input.messageId !== undefined) run.messages.push(input.messageId);
      react("✍");
      void this.request(proc, { type: "prompt", message: input.text, images, streamingBehavior: "steer" }).then((response) => {
        if (response?.success !== true) react("💔");
      });
    } else if (input.text.startsWith("/")) {
      // a command of pi or an extension: no run of its own
      void this.request(proc, { type: "prompt", message: input.text, images }).then((response) => {
        react(response?.success === true ? "👌" : "💔");
        this.refreshCard();
      });
    } else {
      const build = input.text.startsWith("!") || this.topic.nextMode === "build";
      const message = build && !input.text.startsWith("!") ? `!${input.text}` : input.text;
      if (this.topic.nextMode === "build") {
        this.deps.store.updateTopic(this.user.telegramId, this.threadId, (t) => (t.nextMode = "plan"));
      } else {
        // the card's mode applies to the next message only
      }
      // The run exists from now on, so messages that follow steer it.
      const title = build ? "Building" : "Planning";
      const run: Run = { view: new RunView(this.outbox, this.deps.clock, title, this.deps.newDraftId()), title, messages: input.messageId !== undefined ? [input.messageId] : [] };
      this.run = run;
      this.deps.pool.setBusy(this.key, true);
      this.setStatus({ kind: "running", since: this.deps.clock.now() });
      react("👀");
      void this.request(proc, { type: "prompt", message, images }).then((response) => {
        const disposition = response?.success === true ? (response as { data?: { disposition?: string } }).data?.disposition : undefined;
        if (disposition === "started" || this.run !== run) {
          // the run goes on (or has already settled)
        } else {
          // not started (rejected, or consumed by an input handler): no run
          this.run = undefined;
          run.view.dispose();
          this.deps.pool.setBusy(this.key, false);
          this.setStatus({ kind: "idle" });
          react(disposition === "handled" ? "👌" : "💔");
        }
      });
    }
  }

  /** /stop, the card's ⏹, the draft's native stop. */
  async stop(): Promise<void> {
    await this.dialogs.cancel();
    if (this.proc !== undefined && this.run !== undefined) {
      await this.request(this.proc, { type: "abort" });
    } else {
      // nothing runs
    }
  }

  /** Card button `c:<action>[:<arg>]`; resolves with the toast text. */
  async card(action: string, arg: string | undefined): Promise<string> {
    switch (action) {
      case "mode":
        this.deps.store.updateTopic(this.user.telegramId, this.threadId, (t) => (t.nextMode = arg === "build" ? "build" : "plan"));
        this.refreshCard();
        return arg === "build" ? "Next message: Build" : "Next message: Plan";
      case "models": {
        const proc = await this.ensureProcess();
        if ("problem" in proc) return proc.problem;
        const page = Number(arg ?? 0);
        const models = this.view.kind === "models" ? this.view.models : await this.availableModels(proc);
        this.view = { kind: "models", page, models };
        this.refreshCard();
        return models.length > 0 ? "Choose a model" : "No models available";
      }
      case "model": {
        const chosen = this.view.kind === "models" ? this.view.models[Number(arg)] : undefined;
        const proc = this.proc;
        this.view = { kind: "main" };
        if (chosen === undefined || proc === undefined) {
          this.refreshCard();
          return "The list is outdated";
        } else {
          const response = await this.request(proc, { type: "set_model", provider: chosen.provider, modelId: chosen.id });
          if (response?.success) this.model = `${chosen.provider}/${chosen.id}`;
          this.refreshCard();
          return response?.success ? `Model: ${chosen.id}` : "Could not switch the model";
        }
      }
      case "thinking": {
        const proc = await this.ensureProcess();
        if ("problem" in proc) return proc.problem;
        const response = await this.request(proc, { type: "get_available_thinking_levels" });
        const levels = response?.success ? ((response as { data?: { levels?: string[] } }).data?.levels ?? []) : [];
        this.view = { kind: "thinking", levels };
        this.refreshCard();
        return "Choose the thinking level";
      }
      case "level": {
        const level = this.view.kind === "thinking" ? this.view.levels[Number(arg)] : undefined;
        const proc = this.proc;
        this.view = { kind: "main" };
        if (level === undefined || proc === undefined) {
          this.refreshCard();
          return "The list is outdated";
        } else {
          const response = await this.request(proc, { type: "set_thinking_level", level: level as never });
          if (response?.success) this.thinking = level;
          this.refreshCard();
          return response?.success ? `Thinking: ${level}` : "Could not set the level";
        }
      }
      case "compact": {
        if (this.run !== undefined) return "Wait until the run finishes";
        const proc = await this.ensureProcess();
        if ("problem" in proc) return proc.problem;
        this.setStatus({ kind: "compacting" });
        this.deps.pool.setBusy(this.key, true);
        void this.request(proc, { type: "compact" }).then((response) => {
          this.deps.pool.setBusy(this.key, false);
          this.setStatus({ kind: "idle" });
          void this.outbox.send({ html: response?.success ? "🗜 Context compacted." : "❌ Compaction failed." }, { silent: response?.success === true });
        });
        return "Compacting…";
      }
      case "stop":
        await this.stop();
        return "Stopping…";
      case "close":
        this.view = { kind: "confirmClose" };
        this.refreshCard();
        return "Close this session?";
      case "closeyes":
        await this.close();
        return "Closed";
      case "back":
        this.view = { kind: "main" };
        this.refreshCard();
        return "OK";
      default:
        return "Unknown action";
    }
  }

  /** Buttons under the final message of a planning run. */
  async runButton(action: string): Promise<string> {
    if (this.run !== undefined) {
      return "A run is in progress";
    } else if (action === "build") {
      await this.outbox.dropTransient();
      await this.submit({ text: `!${BUILD_PLAN_PROMPT}` });
      return "Building";
    } else if (action === "buildnote") {
      this.awaitingBuildNote = true;
      await this.outbox.send({ html: "💬 What should the build take into account?" }, { role: "sticky", forceReply: "Note for the build…", silent: false });
      return "Write the note";
    } else {
      return "Unknown action";
    }
  }

  /** A dialog button `d:<seq>:<action>`. */
  dialogButton(seq: number, action: string): Promise<string> {
    return this.dialogs.press(seq, action);
  }

  /** ✓ Close: the process stops, the topic is marked closed and renamed. */
  async close(): Promise<void> {
    await this.stop();
    await this.stopProcess();
    const topic = this.deps.store.updateTopic(this.user.telegramId, this.threadId, (t) => (t.closed = true));
    this.view = { kind: "main" };
    this.setStatus({ kind: "closed" });
    await this.deps.tg
      .editForumTopic(this.user.telegramId, this.threadId, { name: `✓ ${topic.title}`.slice(0, 128) })
      .catch((error: unknown) => this.log(`rename on close: ${String(error)}`));
  }

  /** The gateway shuts down: a running run is interrupted with a notice. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.run !== undefined) {
      await this.outbox.send({ html: "⚠️ Server restarting — run interrupted; send a message to continue." }, { silent: false });
      await this.stop();
    } else {
      // idle: nothing to tell the user
    }
    this.cardTimer?.cancel();
  }

  /* ------------------------------------------------------------------------ */

  private async threadGone(): Promise<void> {
    this.log("topic deleted by the user: closing the session");
    this.run?.view.dispose();
    this.run = undefined;
    this.dialogs.reset();
    if (this.proc !== undefined) await this.request(this.proc, { type: "abort" });
    await this.stopProcess();
    if (this.deps.store.topic(this.user.telegramId, this.threadId) !== undefined) {
      this.deps.store.updateTopic(this.user.telegramId, this.threadId, (t) => (t.closed = true));
    } else {
      // never bound
    }
    this.cardTimer?.cancel();
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
    const proc = this.deps.spawn(this.deps.spec(this.user, this.topic), {
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
      // already detached by stopProcess (close, topic gone)
    }
    const run = this.run;
    this.run = undefined;
    run?.view.dispose();
    this.dialogs.reset();
    this.awaitingBuildNote = false;
    if (unexpected) {
      const tail = proc.stderrTail().slice(-10).join("\n");
      void this.outbox.send({ html: `❌ pi exited unexpectedly.${tail ? `\n<pre>${escapeHtml(tail)}</pre>` : ""}\nSend a message to start it again.` }, { silent: false });
      for (const messageId of run?.messages ?? []) void this.outbox.react(messageId, "💔");
    } else {
      // stopped by the pool or the user
    }
    if (!this.topic.closed) this.setStatus({ kind: "stopped" });
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
      void this.outbox.send({ html: `⚠️ extension error (${escapeHtml(event.event)}): ${escapeHtml(event.error)}` });
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
    const banner = run.banner !== undefined ? bannerLine({ ...run.banner, interrupted }) : interrupted ? "⏹ interrupted" : undefined;
    const keyboard: Keyboard | undefined = run.title === "Planning" && !interrupted
      ? [[{ text: "🔨 Build", callback_data: "r:build" }, { text: "💬 Build with note", callback_data: "r:buildnote" }]]
      : undefined;
    await run.view.finish(banner, keyboard);
    for (const messageId of run.messages) await this.outbox.react(messageId, interrupted ? "💔" : "👌");
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
        await this.outbox.send({ html: `❌ ${escapeHtml(command.type)}: ${escapeHtml((response as { error?: string }).error ?? "failed")}` }, { silent: false });
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
    const topic = this.topic;
    return {
      dir: displayDir(topic.cwd, this.deps.config, this.user),
      model: this.model,
      thinking: this.thinking,
      nextMode: topic.nextMode,
      status: topic.closed ? { kind: "closed" } : this.status,
      view: this.view,
    };
  }

  private refreshCard(): void {
    const topic = this.deps.store.topic(this.user.telegramId, this.threadId);
    if (topic?.cardMessageId === undefined) {
      return; // no card yet (topic being bound) or the topic is gone
    }
    const card = renderSessionCard(this.cardState(), this.deps.clock.now());
    void this.outbox.edit(topic.cardMessageId, { html: card.html }, card.keyboard);
  }

  private log(line: string): void {
    this.deps.log(`${this.user.name}/${this.threadId}: ${line}`);
  }
}

/** `~` or `~/sub/dir` for a directory inside the user's home. */
export function displayDir(cwd: string, config: Config, user: UserConfig): string {
  const home = homeOf(config, user);
  return cwd === home ? "~" : cwd.startsWith(`${home}/`) ? `~/${cwd.slice(home.length + 1)}` : cwd;
}
