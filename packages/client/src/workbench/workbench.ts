// The workbench every UI draws: the tabs of open sessions (left), the items of the active session
// (right: the session itself, its background tasks, its subagents), what the main area shows, and
// the one glyph each row carries. The tab set lives in the user's settings (`ui.tabs`), shared by
// all the user's UIs; which tab is active and which item is selected are this client's own.

import type { AgentInfo, AgentSummary } from "#protocol/node.ts";
import type { HarnessState, RunMode, SubagentInfo, TaskInfo } from "#protocol/state.ts";
import { agentKey, type ClientModel } from "../model/client-model.ts";

/** One row glyph, by priority: unavailable, waiting for the operator, failed (unseen), running, done (unseen), nothing. */
export type Glyph = "⊘" | "◆" | "✗" | "●" | "✓" | " ";

/** A tab as `ui.tabs` stores it. `seen`: the last activity the user has seen (ms), which clears ✓ and ✗. */
export type TabRecord = { node: string; sessionId: string; sessionFile?: string; cwd: string; seen?: number };

export type Tab = TabRecord & {
  agent: AgentInfo | undefined;
  glyph: Glyph;
  title: string;
  mode: RunMode;
  /** Why the tab cannot open now (its node is offline, its session is gone). */
  unavailable: string | undefined;
};

export type ItemKind = "session" | "task" | "subagent";

export type Item = { kind: ItemKind; id: string; label: string; detail: string; glyph: Glyph; depth: number };

export function glyphOf(summary: AgentSummary | undefined, seen: number | undefined, unavailable: string | undefined): Glyph {
  if (unavailable !== undefined) {
    return "⊘";
  } else if (summary === undefined) {
    return " ";
  } else if (summary.waiting > 0) {
    return "◆";
  } else if (summary.lastOutcome === "error" && (seen ?? 0) < summary.lastActivity) {
    return "✗";
  } else if (summary.status === "running") {
    return "●";
  } else if (summary.lastOutcome === "ok" && (seen ?? 0) < summary.lastActivity) {
    return "✓";
  } else {
    return " ";
  }
}

function taskGlyph(task: TaskInfo, seen: number | undefined): Glyph {
  if (task.endedAt === undefined) {
    return "●";
  } else if ((seen ?? 0) >= task.endedAt) {
    return " ";
  } else if (task.state === "failed") {
    return "✗";
  } else if (task.state === "exited") {
    return "✓";
  } else {
    return " "; // stopped on purpose
  }
}

function subagentGlyph(subagent: SubagentInfo): Glyph {
  switch (subagent.state) {
    case "running":
      return "●";
    case "waiting":
      return "◆";
    case "failed":
      return "✗";
    case "done":
      return "✓";
    case "stopped":
      return " ";
    default:
      throw new Error(`unknown subagent state: ${String(subagent.state satisfies never)}`);
  }
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`;
}

export function tabRecords(settings: Record<string, unknown>): TabRecord[] {
  const tabs = settings["ui.tabs"];
  return Array.isArray(tabs) ? (tabs.filter((tab) => typeof tab === "object" && tab !== null && typeof (tab as TabRecord).sessionId === "string") as TabRecord[]) : [];
}

export class Workbench {
  readonly client: ClientModel;
  active = 0;
  /** Selected item per tab (by session id); the session itself when absent. */
  private readonly selected = new Map<string, string>();
  /** Tasks seen per session: the last task end the user has looked at. */
  private readonly tasksSeen = new Map<string, number>();

  constructor(client: ClientModel) {
    this.client = client;
  }

  tabs(): Tab[] {
    return tabRecords(this.client.settings).map((record) => {
      const agent = [...this.client.agents.values()].find((candidate) => candidate.node === record.node && candidate.sessionId === record.sessionId);
      const unavailable = this.client.offline.has(record.node) ? `node ${record.node} is offline` : this.client.connections.has(record.node) ? undefined : `node ${record.node} is not connected`;
      return {
        ...record,
        agent,
        glyph: glyphOf(agent?.summary, record.seen, unavailable),
        title: agent?.summary.title !== undefined && agent.summary.title !== "" ? agent.summary.title : agent?.name ?? record.cwd.split("/").pop() ?? record.sessionId.slice(0, 8),
        mode: agent?.summary.mode ?? "plan",
        unavailable,
      };
    });
  }

  activeTab(): Tab | undefined {
    const tabs = this.tabs();
    return tabs[Math.min(this.active, tabs.length - 1)];
  }

  /** The items of a session: itself first, then its tasks and subagents on one level (subagents' own children indented). */
  items(tab: Tab, state: HarnessState | undefined): Item[] {
    const session: Item = { kind: "session", id: "session", label: tab.title, detail: tab.mode.toUpperCase(), glyph: tab.glyph === "⊘" ? "⊘" : tab.glyph, depth: 0 };
    const seen = this.tasksSeen.get(tab.sessionId);
    const now = Date.now();
    const tasks: Item[] = (state?.tasks ?? []).map((task) => ({
      kind: "task",
      id: task.id,
      label: task.command,
      detail: task.endedAt !== undefined ? (task.exitCode !== undefined ? `exit ${task.exitCode}` : task.state) : duration(now - task.startedAt),
      glyph: taskGlyph(task, seen),
      depth: 0,
    }));
    const subagents: Item[] = (state?.subagents ?? []).map((subagent) => ({
      kind: "subagent",
      id: subagent.session,
      label: `${subagent.profile} ${subagent.session.slice(0, 4)}`,
      detail: subagent.state,
      glyph: subagentGlyph(subagent),
      depth: subagent.parent !== undefined ? 1 : 0,
    }));
    return [session, ...tasks, ...subagents];
  }

  selectedItem(tab: Tab): string {
    return this.selected.get(tab.sessionId) ?? "session";
  }

  select(tab: Tab, itemId: string): void {
    this.selected.set(tab.sessionId, itemId);
    if (itemId !== "session") {
      this.tasksSeen.set(tab.sessionId, Date.now());
    } else {
      // the session itself
    }
    this.client.changed();
  }

  /** Activates a tab and marks what it shows as seen (shared through ui.tabs). */
  async activate(index: number): Promise<void> {
    const tabs = this.tabs();
    if (tabs.length === 0) {
      this.active = 0;
    } else {
      this.active = Math.max(0, Math.min(index, tabs.length - 1));
      const tab = tabs[this.active];
      if (tab?.agent !== undefined) {
        await this.client.follow(tab.node, tab.agent.id);
        await this.markSeen(tab);
      } else {
        // the tab's agent is not running: opening it starts one (openTab)
      }
    }
    this.client.changed();
  }

  async markSeen(tab: Tab): Promise<void> {
    const activity = tab.agent?.summary.lastActivity;
    if (activity !== undefined && (tab.seen ?? 0) < activity) {
      await this.writeTabs(tabRecords(this.client.settings).map((record) => (record.sessionId === tab.sessionId && record.node === tab.node ? { ...record, seen: activity } : record)));
    } else {
      // nothing new
    }
  }

  async writeTabs(records: TabRecord[]): Promise<void> {
    await this.client.setting("ui.tabs", records);
  }

  /** Starts an agent for a new session on the node and opens it as the last tab. */
  async newTab(node: string, cwd: string): Promise<Tab | undefined> {
    const { agent } = await this.client.connection(node).request("agent_start", { cwd });
    this.client.agents.set(agentKey(node, agent.id), agent);
    const records = [...tabRecords(this.client.settings), { node, sessionId: agent.sessionId, sessionFile: agent.sessionFile, cwd: agent.cwd }];
    await this.writeTabs(records);
    await this.activate(records.length - 1);
    return this.activeTab();
  }

  /** Opens a stored session: an agent for it (the node's, if one runs already), then a tab. */
  async openSession(node: string, session: { id: string; path: string; cwd: string }): Promise<void> {
    const records = tabRecords(this.client.settings);
    const index = records.findIndex((record) => record.node === node && record.sessionId === session.id);
    if (index !== -1) {
      await this.ensureAgent(this.tabs()[index]);
      await this.activate(index);
    } else {
      const { agent } = await this.client.connection(node).request("agent_start", { cwd: session.cwd, sessionFile: session.path });
      this.client.agents.set(agentKey(node, agent.id), agent);
      await this.writeTabs([...records, { node, sessionId: agent.sessionId, sessionFile: agent.sessionFile, cwd: agent.cwd }]);
      await this.activate(records.length);
    }
  }

  /** A tab whose agent is not running gets one, on its session file. */
  async ensureAgent(tab: Tab | undefined): Promise<void> {
    if (tab === undefined || tab.agent !== undefined || tab.unavailable !== undefined) {
      return;
    } else {
      const { agent } = await this.client.connection(tab.node).request("agent_start", { cwd: tab.cwd, sessionFile: tab.sessionFile });
      this.client.agents.set(agentKey(tab.node, agent.id), agent);
    }
  }

  /** Closes a tab (the agent keeps running on its node). */
  async closeTab(index: number): Promise<void> {
    const records = tabRecords(this.client.settings);
    records.splice(index, 1);
    await this.writeTabs(records);
    await this.activate(Math.min(this.active, records.length - 1));
  }

  async moveTab(from: number, to: number): Promise<void> {
    const records = tabRecords(this.client.settings);
    const [moved] = records.splice(from, 1);
    if (moved !== undefined) {
      records.splice(to, 0, moved);
      await this.writeTabs(records);
      this.active = to;
    } else {
      // no such tab
    }
  }
}
