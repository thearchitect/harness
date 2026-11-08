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
import type { Config, UserConfig } from "./config.ts";
import type { Agent, PiProcess, UserInput } from "./core/agent.ts";
import { Agents } from "./core/agents.ts";
import type { Clock, Timer } from "./core/clock.ts";
import { dirChoices, displayDir, resolveDir } from "./core/dirs.ts";
import type { SessionPool } from "./core/pool.ts";
import type { RpcHandlers, RpcSpec } from "./core/rpc.ts";
import type { StateStore, WorkspaceState } from "./core/state.ts";
import type { Helper } from "./helper.ts";
import { Account } from "./telegram/account.ts";
import { closePanel } from "./telegram/card.ts";
import { HISTORY_TURNS, historyPages } from "./telegram/history.ts";
import { type AppSection, appLink } from "./telegram/links.ts";
import { Outbox } from "./telegram/outbox.ts";
import { escapeHtml, link } from "./telegram/render.ts";
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
  log(line: string): void;
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

  constructor(deps: WorkbenchDeps) {
    this.deps = deps;
    for (const user of deps.config.users) this.users.set(user.telegramId, user);
    this.agents = new Agents({
      clock: deps.clock,
      pool: deps.pool,
      spawn: deps.spawn,
      log: deps.log,
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
    await this.deps.tg.leaveChat(chatId).catch((error: unknown) => this.deps.log(`leaveChat ${chatId}: ${String(error)}`));
  }

  /** Answers a button press with a toast. */
  async answer(queryId: string, text: string): Promise<void> {
    await this.deps.tg.answerCallbackQuery(queryId, { text: text.slice(0, 200) }).catch((error: unknown) => this.deps.log(`answerCallbackQuery: ${String(error)}`));
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
        this.deps.log(`workspace ${workspace.chatId} dropped: its owner ${workspace.owner} is not configured`);
      }
    }
  }

  outbox(chatId: number): Outbox {
    const existing = this.outboxes.get(chatId);
    if (existing !== undefined) {
      return existing;
    } else {
      const outbox = new Outbox(this.deps.tg, chatId, (line) => this.deps.log(`chat ${chatId}: ${line}`), () => {
        if (this.deps.store.workspace(chatId)?.kind === "group") void this.removeWorkspace(chatId);
      });
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
        { config: this.deps.config, clock: this.deps.clock, helper: this.deps.helper, log: this.deps.log, restartUser: (id) => this.deps.pool.restartUser(id) },
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

  async setModel(user: UserConfig, agentId: string, provider: string, modelId: string): Promise<Result> {
    const agent = this.agents.get(agentId);
    if (agent === undefined || agent.userId !== user.telegramId) return { ok: false, problem: "this agent is gone" };
    const set = await agent.setModel(provider, modelId);
    return "problem" in set ? { ok: false, problem: set.problem } : { ok: true };
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
        dirs: dirChoices(this.deps.config, this.deps.store, user, this.deps.log).map((dir) => displayDir(this.deps.config, user, dir)),
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

  /** Nothing runs and nobody is in the middle of a login or of typing a secret. */
  isQuiescent(): boolean {
    return this.deps.pool.isQuiescent() && [...this.accounts.values()].every((a) => a.quiescent);
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
    if (!history.ok) this.deps.log(`${user.name}: history of ${agent.sessionId}: ${history.problem}`);
    return { ok: true };
  }

  private viewOf(agent: Agent): AgentView {
    const existing = this.views.get(agent.sessionId);
    if (existing !== undefined) {
      return existing;
    } else {
      const holder = this.agents.holder(agent);
      const surface: Surface = holder !== undefined ? { kind: "workspace", outbox: this.outbox(holder.chatId) } : this.background(agent);
      const view = new AgentView({ clock: this.deps.clock, dir: (a) => this.dir(a), link: (chatId) => this.link(chatId) }, agent, surface);
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
