/**
 * The agents of all users and where each one is: attached to a workspace (the
 * attachment is durable, in state.json) or in the background.
 *
 * An agent exists while it is attached (its process may be stopped: it
 * starts on the next message) or while its process runs in the background.
 * A background agent whose process stops ceases to exist; its session stays
 * in the history. One agent per session, one agent per workspace, one
 * workspace per agent.
 */

import { Agent, type AgentDeps } from "./agent.ts";
import type { RpcSpec } from "./rpc.ts";
import type { StateStore, WorkspaceState } from "./state.ts";

export type AgentsDeps = Omit<AgentDeps, "exited"> & {
  store: StateStore;
  spec(userId: number, sessionId: string, cwd: string): RpcSpec;
  /** A background agent ceased to exist. */
  gone(agent: Agent): void;
};

export class Agents {
  private readonly deps: AgentsDeps;
  private readonly agents = new Map<string, Agent>();

  constructor(deps: AgentsDeps) {
    this.deps = deps;
  }

  get(sessionId: string): Agent | undefined {
    return this.agents.get(sessionId);
  }

  all(): Agent[] {
    return [...this.agents.values()];
  }

  ofUser(userId: number): Agent[] {
    return this.all().filter((a) => a.userId === userId);
  }

  /** The workspace holding the agent, or undefined when it is in the background. */
  holder(agent: Agent): WorkspaceState | undefined {
    return this.deps.store.holding(agent.sessionId);
  }

  /** The agent attached to a workspace (created for an attachment that survived a restart). */
  attached(chatId: number): Agent | undefined {
    const workspace = this.deps.store.workspace(chatId);
    const attachment = workspace?.agent;
    if (workspace === undefined || attachment === undefined) {
      return undefined;
    } else {
      return this.agents.get(attachment.sessionId) ?? this.create(workspace.owner, attachment.sessionId, attachment.cwd, "");
    }
  }

  /** The agent of a session, created (in the background, process stopped) when the session has none. */
  obtain(userId: number, sessionId: string, cwd: string, title: string): Agent {
    return this.agents.get(sessionId) ?? this.create(userId, sessionId, cwd, title);
  }

  /**
   * Attaches the agent to the workspace. Resolves who moved: the agent that
   * held the workspace before (now in the background) and the workspace the
   * agent held before (now empty).
   */
  attach(chatId: number, agent: Agent): { displaced?: Agent; vacated?: number } {
    const target = this.deps.store.workspace(chatId);
    if (target === undefined) {
      throw new Error(`no workspace ${chatId}`);
    } else if (target.agent?.sessionId === agent.sessionId) {
      return {}; // already there
    } else {
      const displaced = target.agent !== undefined ? this.attached(chatId) : undefined;
      const previous = this.holder(agent);
      if (previous !== undefined) this.deps.store.updateWorkspace(previous.chatId, (w) => delete w.agent);
      this.deps.store.updateWorkspace(chatId, (w) => (w.agent = { sessionId: agent.sessionId, cwd: agent.cwd }));
      if (displaced !== undefined) this.dropIfStopped(displaced);
      return { displaced, vacated: previous?.chatId };
    }
  }

  /** The workspace's agent goes to the background; resolves it (gone already when its process was not running). */
  detach(chatId: number): Agent | undefined {
    const agent = this.attached(chatId);
    if (agent === undefined) {
      return undefined;
    } else {
      this.deps.store.updateWorkspace(chatId, (w) => delete w.agent);
      this.dropIfStopped(agent);
      return agent;
    }
  }

  /** Ends the agent: no attachment, no process; its session stays on disk. */
  async close(agent: Agent): Promise<void> {
    const holder = this.holder(agent);
    if (holder !== undefined) this.deps.store.updateWorkspace(holder.chatId, (w) => delete w.agent);
    this.agents.delete(agent.sessionId);
    await agent.stop();
    this.deps.gone(agent);
  }

  /** The workspace is gone (the bot left the group): its agent goes to the background. */
  forget(chatId: number): Agent | undefined {
    const agent = this.attached(chatId);
    this.deps.store.removeWorkspace(chatId);
    if (agent !== undefined) this.dropIfStopped(agent);
    return agent;
  }

  /** Stops every process (the gateway stops); attachments stay. */
  async stopAll(): Promise<void> {
    await Promise.all(this.all().map((agent) => agent.stop()));
  }

  private create(userId: number, sessionId: string, cwd: string, title: string): Agent {
    const agent = new Agent({ ...this.deps, exited: (a) => this.dropIfStopped(a) }, userId, sessionId, cwd, title, () => this.deps.spec(userId, sessionId, cwd));
    this.agents.set(sessionId, agent);
    return agent;
  }

  /** A background agent without a process ceases to exist. */
  private dropIfStopped(agent: Agent): void {
    if (this.agents.get(agent.sessionId) !== agent) {
      return; // closed already
    } else if (this.holder(agent) === undefined && !agent.running) {
      this.agents.delete(agent.sessionId);
      this.deps.gone(agent);
    } else {
      // attached, or its process runs in the background
    }
  }
}
