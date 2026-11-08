/**
 * The operations on workspaces, agents and sessions, shared by the Telegram
 * router and the Mini App, and the views that show the agents in the chats.
 *
 * Every operation of a user runs in that user's queue (`serial`): a Telegram
 * update and a Mini App action never race for the same agent. Nothing in the
 * queue waits for the user: dialogs and login prompts are answered by later
 * updates, and every wait inside has a deadline (pi requests, helpers).
 *
 * Workspaces: the user's private chat with the bot (title "Direct") and every
 * group a configured user added the bot to; each holds at most one agent and
 * belongs to one user, whose messages alone count there.
 */

import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { Config, UserConfig } from "./config.ts";
import type { Agent, PiProcess, UserInput } from "./core/agent.ts";
import { Agents } from "./core/agents.ts";
import type { Clock, Timer } from "./core/clock.ts";
import { dirChoices, displayDir, resolveDir, resolvePath } from "./core/dirs.ts";
import type { SessionPool } from "./core/pool.ts";
import type { RpcHandlers, RpcSpec } from "./core/rpc.ts";
import type { StateStore, WorkspaceState } from "./core/state.ts";
import { diffAs, type Entry, listDirAs, mkdirAs, type Outcome, readFileAs, zipDirAs } from "./files.ts";
import type { Favorite, Helper, ModelRef, ModelSettings } from "./helper.ts";
import type { Fields, Telemetry } from "./telemetry.ts";
import { Account } from "./telegram/account.ts";
import { closePanel } from "./telegram/card.ts";
import { HISTORY_TURNS, historyPages } from "./telegram/history.ts";
import { type AppSection, appLink } from "./telegram/links.ts";
import { Outbox } from "./telegram/outbox.ts";
import { escapeHtml, formatDuration, link } from "./telegram/render.ts";
import type { Tg } from "./telegram/tg.ts";
import { AgentView, type Surface } from "./telegram/view.ts";

export type WorkbenchDeps = {
  config: Config;
  store: StateStore;
  pool: SessionPool<PiProcess>;
  tg: Tg;
  clock: Clock;
  helper: Helper;
  botUsername: string;
  t: Telemetry;
  /** A snapshot of the machine's resources (telemetry). */
  resources(): Fields;
  spawn(spec: RpcSpec, handlers: RpcHandlers): PiProcess;
  spec(user: UserConfig, sessionId: string, cwd: string): RpcSpec;
};

export type Result = { ok: true } | { ok: false; problem: string };

export type AgentInfo = {
  id: string;
  dir: string;
  title: string;
  model?: string;
  thinking?: string;
  status: Agent["status"];
  workspace?: { id: number; title: string };
};

export type AppState = {
  workspace: { id: number; title: string; kind: WorkspaceState["kind"]; agent?: AgentInfo };
  agents: AgentInfo[];
  workspaces: { id: number; title: string; kind: WorkspaceState["kind"]; agentId?: string }[];
  dirs: string[];
};

export const NO_AGENT = "No agent here.";
const DIRECT_TITLE = "Direct";
/** How long the gateway waits for the chats to take its last messages when it stops. */
const FLUSH_LIMIT_MS = 8_000;

export class Workbench {
  readonly agents: Agents;
  private readonly deps: WorkbenchDeps;
  private readonly users = new Map<number, UserConfig>();
  private readonly views = new Map<string, AgentView>();
  private readonly outboxes = new Map<number, Outbox>();
  private readonly accounts = new Map<number, Account>();
  private readonly chains = new Map<number, Promise<unknown>>();
  private busyWork = 0;

  constructor(deps: WorkbenchDeps) {
    this.deps = deps;
    for (const user of deps.config.users) this.users.set(user.telegramId, user);
    this.agents = new Agents({
      clock: deps.clock,
      pool: deps.pool,
      spawn: deps.spawn,
      t: deps.t,
      context: (agent) => ({ user: this.userOf(agent.userId).name, dir: this.dir(agent) }),
      resources: deps.resources,
      store: deps.store,
      spec: (userId, sessionId, cwd) => deps.spec(this.userOf(userId), sessionId, cwd),
      gone: (agent) => {
        this.views.get(agent.sessionId)?.detach();
        this.views.delete(agent.sessionId);
      },
    });
  }

  get config(): Config {
    return this.deps.config;
  }

  user(telegramId: number): UserConfig | undefined {
    return this.users.get(telegramId);
  }

  workspace(chatId: number): WorkspaceState | undefined {
    return this.deps.store.workspace(chatId);
  }

  /** Leaves a group the bot does not serve. */
  async leave(chatId: number): Promise<void> {
    this.deps.t.info("workspace.leave", { chat: chatId });
    await this.deps.tg.leaveChat(chatId).catch((error: unknown) => this.deps.t.warn("tg.call", { chat: chatId, method: "leaveChat", message: String(error) }));
  }

  /** Answers a button press with a toast. */
  async answer(queryId: string, text: string): Promise<void> {
    await this.deps.tg
      .answerCallbackQuery(queryId, { text: text.slice(0, 200) })
      .catch((error: unknown) => this.deps.t.warn("tg.call", { method: "answerCallbackQuery", message: String(error) }));
  }

  /** Runs `step` in the user's queue, after their earlier operations. */
  serial<T>(userId: number, step: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(userId) ?? Promise.resolve();
    const next = previous.then(step, step);
    this.chains.set(userId, next.catch(() => undefined));
    return next;
  }

  /** Workspaces of users no longer configured are dropped; the bot leaves their groups. */
  async prune(): Promise<void> {
    for (const workspace of this.deps.store.workspaces()) {
      if (this.users.has(workspace.owner)) {
        // a configured user's
      } else {
        this.deps.store.removeWorkspace(workspace.chatId);
        if (workspace.kind === "group") {
          await this.leave(workspace.chatId);
        } else {
          // a private chat: nothing to leave
        }
        this.deps.t.info("workspace.drop", { chat: workspace.chatId, owner: workspace.owner, message: "its owner is not configured" });
      }
    }
  }

  outbox(chatId: number): Outbox {
    const existing = this.outboxes.get(chatId);
    if (existing !== undefined) {
      return existing;
    } else {
      const outbox = new Outbox(this.deps.tg, chatId, this.deps.t, () => {
        if (this.deps.store.workspace(chatId)?.kind === "group") void this.removeWorkspace(chatId);
      });
      outbox.onPinDenied = () => void outbox.send({ html: "Give me the right to pin messages." });
      this.outboxes.set(chatId, outbox);
      return outbox;
    }
  }

  account(user: UserConfig): Account {
    const existing = this.accounts.get(user.telegramId);
    if (existing !== undefined) {
      return existing;
    } else {
      const account = new Account(
        { config: this.deps.config, clock: this.deps.clock, helper: this.deps.helper, t: this.deps.t, restartUser: (id) => this.deps.pool.restartUser(id) },
        user,
      );
      this.accounts.set(user.telegramId, account);
      return account;
    }
  }

  link(chatId: number, section?: AppSection): string {
    return appLink(this.deps.botUsername, chatId, section);
  }

  /* Workspaces --------------------------------------------------------------- */

  /** The user's private chat as a workspace (created on first contact). */
  ensurePrivate(user: UserConfig): WorkspaceState {
    const existing = this.deps.store.workspace(user.telegramId);
    if (existing !== undefined) {
      return existing;
    } else {
      const workspace: WorkspaceState = { chatId: user.telegramId, kind: "private", owner: user.telegramId, title: DIRECT_TITLE };
      this.deps.store.addWorkspace(workspace);
      return workspace;
    }
  }

  /**
   * A configured user added the bot to a group (`announce`: it says "No agent
   * here."), or wrote in a group the bot was in before its workspace was known
   * (adopted silently): it becomes their workspace.
   */
  async addGroup(chatId: number, title: string, owner: UserConfig, admin: boolean | undefined, announce: boolean): Promise<void> {
    if (this.deps.store.workspace(chatId) === undefined) {
      this.deps.store.addWorkspace({ chatId, kind: "group", owner: owner.telegramId, title });
      if (announce) await this.noAgent(chatId);
    } else {
      // known already
    }
    if (admin === false) await this.adminHint(chatId);
  }

  async adminHint(chatId: number): Promise<void> {
    await this.outbox(chatId).send({ html: "Make me an admin: I need it to see your messages." });
  }

  /** The bot left the group (or can no longer write there): the workspace goes, its agent to the background. */
  async removeWorkspace(chatId: number): Promise<void> {
    const agent = this.agents.forget(chatId);
    this.outboxes.delete(chatId);
    if (agent !== undefined && this.agents.get(agent.sessionId) === agent) {
      await this.viewOf(agent).moveTo(this.background(agent));
    } else {
      // no agent, or it stopped with the workspace
    }
  }

  /** A group became a supergroup: the workspace moves to the new id. */
  async migrate(oldId: number, newId: number): Promise<void> {
    const workspace = this.deps.store.workspace(oldId);
    if (workspace === undefined || this.deps.store.workspace(newId) !== undefined) {
      return; // not ours, or moved already
    }
    this.deps.store.removeWorkspace(oldId);
    this.deps.store.addWorkspace({ ...workspace, chatId: newId });
    this.outboxes.delete(oldId);
    const agent = this.agents.attached(newId);
    if (agent !== undefined) await this.viewOf(agent).moveTo({ kind: "workspace", outbox: this.outbox(newId) });
  }

  retitle(chatId: number, title: string): void {
    const workspace = this.deps.store.workspace(chatId);
    if (workspace !== undefined && workspace.kind === "group" && workspace.title !== title) {
      this.deps.store.updateWorkspace(chatId, (w) => (w.title = title));
    } else {
      // unknown, private, or unchanged
    }
  }

  async noAgent(chatId: number): Promise<void> {
    await this.outbox(chatId).send({ markdown: link(NO_AGENT, this.link(chatId)) });
  }

  /* Operations (inside the user's queue) ----------------------------------- */

  /** `/new <path>` and the Mini App: a new agent in the workspace; the one there goes to the background. */
  async newAgent(user: UserConfig, chatId: number, path: string): Promise<Result> {
    const owned = this.ownedWorkspace(user, chatId);
    const chosen = resolveDir(this.deps.config, user, path);
    if (!owned.ok) {
      return owned;
    } else if ("problem" in chosen) {
      return { ok: false, problem: chosen.problem };
    } else {
      this.deps.store.rememberDir(user.telegramId, chosen.dir);
      const agent = this.agents.obtain(user.telegramId, randomUUID(), chosen.dir, "");
      this.deps.t.info("agent.new", { user: user.name, dir: this.dir(agent), agent: agent.sessionId.slice(0, 8), chat: chatId });
      return this.place(user, chatId, agent);
    }
  }

  /** The Mini App: continue a session in the workspace. */
  async resume(user: UserConfig, chatId: number, sessionId: string): Promise<Result> {
    const owned = this.ownedWorkspace(user, chatId);
    if (!owned.ok) return owned;
    const running = this.agents.get(sessionId);
    if (running !== undefined) {
      return running.userId === user.telegramId ? this.place(user, chatId, running) : { ok: false, problem: "not your session" };
    }
    const sessions = await this.deps.helper.sessions(user);
    if (!sessions.ok) return sessions;
    const session = sessions.data.find((s) => s.id === sessionId);
    return session === undefined ? { ok: false, problem: "no such session" } : this.place(user, chatId, this.agents.obtain(user.telegramId, session.id, session.cwd, session.title));
  }

  /** "Attach here", the Mini App's Here and Move: the agent goes to the workspace. */
  async attach(user: UserConfig, chatId: number, agentId: string): Promise<Result> {
    const owned = this.ownedWorkspace(user, chatId);
    const agent = this.agents.get(agentId);
    if (!owned.ok) {
      return owned;
    } else if (agent === undefined || agent.userId !== user.telegramId) {
      return { ok: false, problem: "this agent is gone" };
    } else {
      return this.place(user, chatId, agent);
    }
  }

  /** `/detach`: the workspace's agent goes to the background. */
  async detach(user: UserConfig, chatId: number): Promise<Result> {
    const owned = this.ownedWorkspace(user, chatId);
    if (!owned.ok) return owned;
    const attached = this.agents.attached(chatId);
    if (attached === undefined) return { ok: false, problem: NO_AGENT };
    const dir = this.dir(attached);
    this.deps.t.info("agent.detach", { user: user.name, dir, agent: attached.sessionId.slice(0, 8), chat: chatId });
    const agent = this.agents.detach(chatId);
    if (agent !== undefined && this.agents.get(agent.sessionId) === agent) {
      await this.viewOf(agent).moveTo(this.background(agent), "moved to background");
    } else {
      // its process was not running: it ceased to exist, its session is in the history
    }
    await this.outbox(chatId).send({ markdown: link(`Agent in ${dir} moved to the background.`, this.link(chatId)) });
    return { ok: true };
  }

  /** `/close` (confirmed) and the Mini App: the agent ends; its session stays in the history. */
  async close(user: UserConfig, agentId: string): Promise<Result> {
    const agent = this.agents.get(agentId);
    if (agent === undefined || agent.userId !== user.telegramId) {
      return { ok: false, problem: "this agent is gone" };
    } else {
      const holder = this.agents.holder(agent);
      this.deps.t.info("agent.close", { user: user.name, dir: this.dir(agent), agent: agent.sessionId.slice(0, 8) });
      await this.agents.close(agent);
      if (holder !== undefined) await this.outbox(holder.chatId).send({ markdown: link(`Agent in ${this.dir(agent)} closed.`, this.link(holder.chatId)) });
      return { ok: true };
    }
  }

  /** `/close`: the confirmation panel. */
  async askClose(user: UserConfig, chatId: number): Promise<Result> {
    const agent = this.agents.attached(chatId);
    if (agent === undefined || !this.ownedWorkspace(user, chatId).ok) {
      return { ok: false, problem: NO_AGENT };
    } else {
      await this.outbox(chatId).showPanel(closePanel(this.dir(agent)));
      return { ok: true };
    }
  }

  /** `/stop`, Stop, the Mini App: the open dialog is cancelled and the run aborted. */
  async stopAgent(user: UserConfig, agentId: string): Promise<Result> {
    const agent = this.agents.get(agentId);
    if (agent === undefined || agent.userId !== user.telegramId) {
      return { ok: false, problem: "this agent is gone" };
    } else {
      await this.viewOf(agent).stop();
      return { ok: true };
    }
  }

  /**
   * Switches the agent's model, then its thinking level to the effort the
   * user set for that model in Models (a running pi does not re-read its
   * settings).
   */
  async setModel(user: UserConfig, agentId: string, provider: string, modelId: string): Promise<Result> {
    const agent = this.agents.get(agentId);
    if (agent === undefined || agent.userId !== user.telegramId) return { ok: false, problem: "this agent is gone" };
    const set = await agent.setModel(provider, modelId);
    if ("problem" in set) {
      return { ok: false, problem: set.problem };
    } else {
      const settings = await this.deps.helper.models(user);
      const effort = settings.ok ? settings.data.favorites.find((f) => f.provider === provider && f.id === modelId)?.effort : undefined;
      if (effort !== undefined) {
        const level = await agent.setThinking(effort);
        return "problem" in level ? { ok: false, problem: level.problem } : { ok: true };
      } else {
        return { ok: true }; // no effort set for this model: pi keeps its level
      }
    }
  }

  /** Speech to text of a voice note saved in the user's home. */
  transcribe(user: UserConfig, path: string, onDelta: (text: string) => void): Promise<Outcome<string>> {
    return this.deps.helper.transcribe(user, path, onDelta);
  }

  /** The Mini App's Models: the user's favorites, their effort and the default model. */
  models(user: UserConfig): Promise<Outcome<ModelSettings>> {
    return this.deps.helper.models(user);
  }

  async saveModels(user: UserConfig, favorites: Favorite[], defaultModel: ModelRef | null): Promise<Result> {
    const saved = await this.deps.helper.saveModels(user, favorites, defaultModel);
    this.deps.t.info("models.save", { user: user.name, favorites: favorites.length, ok: saved.ok });
    return saved.ok ? { ok: true } : { ok: false, problem: saved.problem };
  }

  /* Files (the Mini App's Files, /diff) -------------------------------------- */

  async listFiles(user: UserConfig, path: string): Promise<Outcome<{ path: string; entries: Entry[]; truncated: boolean }>> {
    const dir = resolveDir(this.deps.config, user, path);
    if ("problem" in dir) {
      return { ok: false, problem: dir.problem };
    } else {
      const listed = await listDirAs(this.deps.config, user, dir.dir);
      return listed.ok ? { ok: true, data: { path: displayDir(this.deps.config, user, dir.dir), ...listed.data } } : listed;
    }
  }

  async makeFolder(user: UserConfig, path: string, name: string): Promise<Result> {
    const dir = resolveDir(this.deps.config, user, path);
    if ("problem" in dir) {
      return { ok: false, problem: dir.problem };
    } else {
      const made = await mkdirAs(this.deps.config, user, dir.dir, name);
      this.deps.t.info("files.mkdir", { user: user.name, ok: made.ok, ...(made.ok ? {} : { message: made.problem }) });
      return made.ok ? { ok: true } : made;
    }
  }

  /** Download: a file as is, a directory as a zip; a document in the workspace, silently. */
  async download(user: UserConfig, chatId: number, path: string): Promise<Result> {
    const owned = this.ownedWorkspace(user, chatId);
    const target = resolvePath(this.deps.config, user, path);
    if (!owned.ok) {
      return owned;
    } else if ("problem" in target) {
      return { ok: false, problem: target.problem };
    } else {
      const file = target.kind === "dir"
        ? await zipDirAs(this.deps.config, user, target.path)
        : await readFileAs(this.deps.config, user, target.path).then((r): Outcome<{ name: string; data: Buffer }> => (r.ok ? { ok: true, data: { name: basename(target.path), data: r.data } } : r));
      this.deps.t.info("files.download", { user: user.name, kind: target.kind, ok: file.ok, ...(file.ok ? { size: file.data.data.length } : { message: file.problem }) });
      if (!file.ok) {
        return file;
      } else {
        const id = await this.outbox(chatId).sendDocument(file.data, escapeHtml(displayDir(this.deps.config, user, target.path)));
        return id !== undefined ? { ok: true } : { ok: false, problem: "Telegram did not take the file" };
      }
    }
  }

  /** `/diff`: the changes in the directory of the workspace's agent, as a .diff document; never reaches the model. */
  async diff(user: UserConfig, chatId: number): Promise<Result> {
    const agent = this.ownedWorkspace(user, chatId).ok ? this.agents.attached(chatId) : undefined;
    if (agent === undefined) {
      return { ok: false, problem: NO_AGENT };
    } else {
      const dir = this.dir(agent);
      const diff = await diffAs(this.deps.config, user, agent.cwd);
      this.deps.t.info("files.diff", { user: user.name, dir, ok: diff.ok, ...(diff.ok ? { files: diff.data.files } : "problem" in diff ? { message: diff.problem } : { notRepo: true }) });
      if (diff.ok && diff.data.patch.length === 0) {
        await this.outbox(chatId).send({ html: `No changes in ${escapeHtml(dir)}.` });
        return { ok: true };
      } else if (diff.ok) {
        const name = `${basename(agent.cwd) || "home"}.diff`;
        const caption = `${escapeHtml(dir)} · ${diff.data.files} file${diff.data.files === 1 ? "" : "s"}`;
        await this.outbox(chatId).sendDocument({ name, data: diff.data.patch }, caption);
        return { ok: true };
      } else if ("notRepo" in diff) {
        await this.outbox(chatId).send({ html: `${escapeHtml(dir)} is not a git repository.` });
        return { ok: true };
      } else {
        return { ok: false, problem: `diff: ${diff.problem}` };
      }
    }
  }

  /** `/status` and `/start`: the workspace's agent and the user's other agents. */
  async status(user: UserConfig, chatId: number): Promise<void> {
    const here = this.ownedWorkspace(user, chatId).ok ? this.agents.attached(chatId) : undefined;
    const lines: string[] = [];
    if (here === undefined) {
      lines.push(link(NO_AGENT, this.link(chatId)));
    } else {
      lines.push(link(`${this.dir(here)} · ${here.title || "new session"}`, this.link(chatId)));
      const stats = await here.stats();
      const started = here.runStartedAt;
      const state = here.status === "running" && started !== undefined ? `running ${formatDuration(this.deps.clock.now() - started)}` : here.status;
      lines.push(
        here.running
          ? [
              here.currentModel?.split("/").pop(),
              here.currentThinking,
              state,
              stats?.contextPercent !== undefined ? `context ${Math.round(stats.contextPercent)}%` : undefined,
              stats?.costUsd !== undefined ? `$${stats.costUsd.toFixed(2)}` : undefined,
            ]
              .filter((part) => part !== undefined)
              .join(" · ")
          : "stopped",
      );
    }
    const others = this.agents.ofUser(user.telegramId).filter((agent) => agent !== here);
    if (others.length > 0) {
      const described = others.map((agent) => `${this.dir(agent)} (${agent.status}, ${this.agents.holder(agent)?.title ?? "background"})`);
      lines.push(`${others.length} more agent${others.length === 1 ? "" : "s"}: ${described.join(", ")}`);
    } else {
      // no other agents
    }
    await this.outbox(chatId).send({ markdown: lines.join("\n") });
  }

  async setThinking(user: UserConfig, agentId: string, level: string): Promise<Result> {
    const agent = this.agents.get(agentId);
    if (agent === undefined || agent.userId !== user.telegramId) return { ok: false, problem: "this agent is gone" };
    const set = await agent.setThinking(level);
    return "problem" in set ? { ok: false, problem: set.problem } : { ok: true };
  }

  /** A message in a workspace: it answers the agent's open dialog, or goes to the agent. */
  async prompt(user: UserConfig, chatId: number, input: UserInput): Promise<void> {
    const agent = this.ownedWorkspace(user, chatId).ok ? this.agents.attached(chatId) : undefined;
    if (agent === undefined) {
      await this.noAgent(chatId);
    } else if (await this.viewOf(agent).answer(input.text)) {
      // the text answered the open dialog
    } else {
      await agent.prompt(input);
    }
  }

  /** A dialog button of an agent. */
  async pressDialog(user: UserConfig, agentId: string, seq: number, action: string): Promise<string> {
    const agent = this.agents.get(agentId);
    return agent === undefined || agent.userId !== user.telegramId ? "This question is closed." : this.viewOf(agent).pressDialog(seq, action);
  }

  /* Queries (the Mini App) ---------------------------------------------------- */

  state(user: UserConfig, chatId: number): AppState | undefined {
    const workspace = this.deps.store.workspace(chatId);
    if (workspace === undefined || workspace.owner !== user.telegramId) {
      return undefined;
    } else {
      const here = this.agents.attached(chatId);
      return {
        workspace: { id: workspace.chatId, title: workspace.title, kind: workspace.kind, agent: here !== undefined ? this.info(here) : undefined },
        agents: this.agents.ofUser(user.telegramId).map((agent) => this.info(agent)),
        workspaces: this.deps.store.owned(user.telegramId).map((w) => ({ id: w.chatId, title: w.title, kind: w.kind, agentId: w.agent?.sessionId })),
        dirs: dirChoices(this.deps.config, this.deps.store, user, (message) => this.deps.t.warn("dirs.list", { user: user.name, message })).map((dir) =>
          displayDir(this.deps.config, user, dir),
        ),
      };
    }
  }

  ownsWorkspace(user: UserConfig, chatId: number): boolean {
    return this.ownedWorkspace(user, chatId).ok;
  }

  dir(agent: Agent): string {
    return displayDir(this.deps.config, this.userOf(agent.userId), agent.cwd);
  }

  displayDir(user: UserConfig, cwd: string): string {
    return displayDir(this.deps.config, user, cwd);
  }

  /* Life cycle ------------------------------------------------------------------ */

  /** Nothing runs, nothing is being transcribed, nobody is in the middle of a login or of typing a secret. */
  isQuiescent(): boolean {
    return this.deps.pool.isQuiescent() && this.busyWork === 0 && [...this.accounts.values()].every((a) => a.quiescent);
  }

  /** Resolves when the agents' files have been delivered and every chat has taken what was sent to it. */
  async drain(): Promise<void> {
    await Promise.all([...this.views.values()].map((view) => view.delivered()));
    await Promise.all([...this.outboxes.values()].map((outbox) => outbox.flush()));
  }

  /** Work that keeps the machine awake (a transcription) while `work` runs. */
  async keepAwake<T>(work: () => Promise<T>): Promise<T> {
    this.busyWork += 1;
    try {
      return await work();
    } finally {
      this.busyWork -= 1;
    }
  }

  /** The gateway stops: runs and dialogs are told, processes and helpers end, the chats get the last messages. */
  async shutdown(): Promise<void> {
    await Promise.all([...this.views.values()].map((view) => view.interrupt()));
    await Promise.all([...this.accounts.values()].map((account) => account.shutdown()));
    await this.agents.stopAll();
    this.deps.helper.killAll();
    let timer: Timer | undefined;
    await Promise.race([
      Promise.all([...this.outboxes.values()].map((outbox) => outbox.flush())),
      new Promise<void>((resolve) => (timer = this.deps.clock.after(FLUSH_LIMIT_MS, resolve))),
    ]);
    timer?.cancel();
  }

  /* ------------------------------------------------------------------------ */

  /** Attaches the agent: the displaced one goes to the background, the vacated workspace is told, the target gets header and history. */
  private async place(user: UserConfig, chatId: number, agent: Agent): Promise<Result> {
    const workspace = this.deps.store.workspace(chatId);
    if (workspace === undefined) return { ok: false, problem: "no such workspace" };
    const view = this.viewOf(agent);
    const { displaced, vacated } = this.agents.attach(chatId, agent);
    if (displaced !== undefined && this.agents.get(displaced.sessionId) === displaced) {
      await this.viewOf(displaced).moveTo(this.background(displaced), "moved to background");
    } else {
      // nothing displaced, or it stopped with the move
    }
    if (vacated !== undefined) {
      await this.outbox(vacated).send({ markdown: link(`Agent in ${this.dir(agent)} moved to ${workspace.title}.`, this.link(vacated)) });
    } else {
      // it came from the background
    }
    const problem = await agent.start();
    const history = await this.deps.helper.history(user, agent.cwd, agent.sessionId, HISTORY_TURNS);
    if (history.ok && agent.title === "") agent.title = history.data.title;
    const model = agent.currentModel?.split("/").pop();
    const header = link([this.dir(agent), agent.title || "new session", ...(model !== undefined ? [model] : [])].join(" · "), this.link(chatId));
    for (const page of historyPages(header, history.ok ? history.data.turns : [])) await this.outbox(chatId).send({ markdown: page });
    await view.moveTo({ kind: "workspace", outbox: this.outbox(chatId) }, `moved to ${workspace.title}`);
    if (problem !== undefined) await this.outbox(chatId).send({ html: `Error: ${escapeHtml(problem)}` }, { silent: false });
    if (!history.ok) this.deps.t.warn("helper.history", { user: user.name, agent: agent.sessionId.slice(0, 8), message: history.problem });
    this.deps.t.info("agent.attach", { user: user.name, dir: this.dir(agent), agent: agent.sessionId.slice(0, 8), chat: chatId });
    return { ok: true };
  }

  private viewOf(agent: Agent): AgentView {
    const existing = this.views.get(agent.sessionId);
    if (existing !== undefined) {
      return existing;
    } else {
      const holder = this.agents.holder(agent);
      const surface: Surface = holder !== undefined ? { kind: "workspace", outbox: this.outbox(holder.chatId) } : this.background(agent);
      const view = new AgentView(
        {
          clock: this.deps.clock,
          dir: (a) => this.dir(a),
          link: (chatId) => this.link(chatId),
          readFile: (a, path) => readFileAs(this.deps.config, this.userOf(a.userId), path),
          t: this.deps.t,
        },
        agent,
        surface,
      );
      this.views.set(agent.sessionId, view);
      return view;
    }
  }

  private background(agent: Agent): Surface {
    return { kind: "background", outbox: this.outbox(agent.userId) };
  }

  private info(agent: Agent): AgentInfo {
    const holder = this.agents.holder(agent);
    return {
      id: agent.sessionId,
      dir: this.dir(agent),
      title: agent.title || "new session",
      model: agent.currentModel,
      thinking: agent.currentThinking,
      status: agent.status,
      workspace: holder !== undefined ? { id: holder.chatId, title: holder.title } : undefined,
    };
  }

  private ownedWorkspace(user: UserConfig, chatId: number): Result {
    const workspace = this.deps.store.workspace(chatId);
    return workspace !== undefined && workspace.owner === user.telegramId ? { ok: true } : { ok: false, problem: "not your workspace" };
  }

  private userOf(telegramId: number): UserConfig {
    const user = this.users.get(telegramId);
    if (user === undefined) throw new Error(`user ${telegramId} is not configured`);
    return user;
  }
}
