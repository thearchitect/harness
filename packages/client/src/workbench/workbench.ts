// The workbench every UI draws: the tabs of open sessions (left), the items of the active session
// (right: the session itself, its background tasks, its subagents), what the main area shows, and
// the one glyph each row carries. The tab set lives in the user's settings (`ui.tabs`), shared by
// all the user's UIs; which tab is active and which item is selected are this client's own.

import { systemClock, type Clock } from "#protocol/clock.ts";
import type { BridgedComponent, LoginProvider, SubagentProfileView } from "#protocol/hap.ts";
import { familyRefs } from "#protocol/model-ref.ts";
import type { InteractionRequest } from "#protocol/interactions.ts";
import type { AgentInfo, AgentSummary } from "#protocol/node.ts";
import type { HarnessState, RunMode, SubagentInfo, TaskInfo, Variant } from "#protocol/state.ts";
import type { ActionId } from "../keymap.ts";
import type { AgentModel, TranscriptItem } from "../model/agent-model.ts";
import { agentKey, type ClientModel } from "../model/client-model.ts";

/** Screen widths (columns; the app converts them to `ch`) below which a strip hides behind an overlay. */
export const LEFT_STRIP_MIN = 80;
export const RIGHT_STRIP_MIN = 110;
/** How long a notice stays in the status line. */
export const NOTICE_MS = 15_000;
/** How often an open task view refreshes its output. */
export const TASK_OUTPUT_MS = 700;

export type PickerItem = { value: string; label: string; description?: string };

/** A choice from a list, drawn in the editor's place. */
export type Picker = { id: string; title: string; items: PickerItem[]; choose(value: string): Promise<void> };

/** What lies over the screen: the harness panel (over the right strip) and hidden strips. */
export type OverlayKind = "panel" | "tabs" | "items";

export type StatusLine = { level: "info" | "warning" | "error" | "working"; text: string };

/** A subagent: its row in the session's state, and for a `harness` subagent its own agent's transcript. */
export type MainZone =
  | { kind: "transcript" }
  | { kind: "task"; taskId: string; task: TaskInfo | undefined; output: string }
  | { kind: "subagent"; id: string; subagent: SubagentInfo | undefined; agent: AgentModel | undefined };

export type EditorZone =
  | { kind: "editor"; mode: RunMode }
  /** `from`: the subagent that asks (an interaction of a subagent of this session). */
  | { kind: "interaction"; request: InteractionRequest; from?: string }
  | { kind: "picker"; picker: Picker }
  /** An extension's component drawn in the agent (terminal clients only; others say they cannot show it). */
  | { kind: "component"; component: BridgedComponent };

/** The zones of the main area (top to bottom) and what lies over the screen — the same in every UI. */
export type Zones = {
  main: MainZone;
  aboveEditor: { queue: { kind: "steer" | "next"; text: string }[]; widgets: string[]; search: Search | undefined };
  editor: EditorZone;
  status: StatusLine[];
  footer: { node: string; agent: AgentModel | undefined };
  overlays: OverlayKind[];
  /** An extension's overlay component drawn in the agent, over the screen. */
  componentOverlay: BridgedComponent | undefined;
};

/** Where typed text goes now. */
export type InputTarget = "editor" | "dialog" | "picker" | "component" | "search" | "task" | "subagent";

/** A search of the transcript: the query, the keys of the matching items (oldest first), the current one. */
export type Search = { query: string; matches: string[]; index: number };

/** The searchable text of a transcript item. */
export function itemText(item: TranscriptItem): string {
  switch (item.kind) {
    case "message": {
      const content = item.message.content;
      return typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((block: { type?: string; text?: string; thinking?: string; arguments?: unknown }) => block.text ?? block.thinking ?? (block.arguments !== undefined ? JSON.stringify(block.arguments) : "")).join("\n")
          : "";
    }
    case "custom":
      return JSON.stringify(item.data ?? "");
    case "compaction":
    case "branch":
      return item.summary;
    default:
      throw new Error(`unknown transcript item: ${JSON.stringify(item satisfies never)}`);
  }
}

export type Screen = {
  strips: { left: boolean; right: boolean };
  tabs: Tab[];
  active: number;
  tab: Tab | undefined;
  agent: AgentModel | undefined;
  items: Item[];
  selected: string;
  zones: Zones;
  input: InputTarget;
  toolsExpanded: boolean;
};

export type PanelRow = { value: "madness" | "simple" | "implementer" | "subagents" | "dependencies" | "update"; label: string; description: string };

/** The bundle's update, as the client's process knows it (the TUI's: cli/src/update.ts). */
export type UpdateHook = {
  /** The panel row's hint: "up to date", "3 new · 2h ago", … */
  hint(): string;
  /** The update section of the dependencies report. */
  lines(): string[];
  /** Whether the row upgrades (the bundle is in the user's Nix profile and has news). */
  canRun(): boolean;
  run(): Promise<void>;
};

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

export type WorkbenchOptions = {
  /** Where new sessions start (the client's working directory). */
  cwd?: string;
  clock?: Clock;
  update?: UpdateHook;
};

export class Workbench {
  readonly client: ClientModel;
  active = 0;
  picker: Picker | undefined;
  overlays: OverlayKind[] = [];
  toolsExpanded = false;
  private searchState: { query: string; index: number } | undefined;
  private readonly cwd: string;
  private readonly clock: Clock;
  private readonly update: UpdateHook | undefined;
  /** Selected item per tab (by session id); the session itself when absent. */
  private readonly selected = new Map<string, string>();
  /** Tasks seen per session: the last task end the user has looked at. */
  private readonly tasksSeen = new Map<string, number>();
  private notice: { level: "info" | "warning" | "error"; message: string; at: number } | undefined;
  private readonly taskOutputs = new Map<string, string>();
  private taskTimer: unknown;
  private taskShown: string | undefined;

  constructor(client: ClientModel, options: WorkbenchOptions = {}) {
    this.client = client;
    this.cwd = options.cwd ?? "/";
    this.clock = options.clock ?? systemClock;
    this.update = options.update;
  }

  /* ----- the screen ----- */

  /** Everything a UI draws, for a screen `width` columns wide and the editor's current text. */
  screen(width: number, editor: { mode: RunMode }): Screen {
    const tabs = this.tabs();
    const tab = tabs[Math.min(this.active, tabs.length - 1)];
    const agent = tab?.agent !== undefined ? this.client.full.get(agentKey(tab.node, tab.agent.id)) : undefined;
    const items = tab !== undefined ? this.items(tab, agent?.state) : [];
    const selected = tab !== undefined ? this.selectedItem(tab) : "session";
    const main = this.mainZone(selected, agent, tab);
    this.followTask(main.kind === "task" ? main.taskId : undefined);
    const asking = tab?.agent !== undefined ? this.asking(tab.node, tab.agent.id, agent) : undefined;
    const request = asking?.request;
    const inline = agent?.components.filter((component) => !component.overlay).at(-1);
    const componentOverlay = agent?.components.filter((component) => component.overlay).at(-1);
    const editorZone: EditorZone =
      this.picker !== undefined
        ? { kind: "picker", picker: this.picker }
        : request !== undefined
          ? { kind: "interaction", request, ...(asking?.from !== undefined ? { from: asking.from } : {}) }
          : inline !== undefined
            ? { kind: "component", component: inline }
            : { kind: "editor", mode: agent?.running === true ? agent.state.mode : editor.mode };
    const queue = agent?.session?.queue;
    return {
      strips: { left: width >= LEFT_STRIP_MIN, right: width >= RIGHT_STRIP_MIN },
      tabs,
      active: this.active,
      tab,
      agent,
      items,
      selected,
      zones: {
        main,
        aboveEditor: {
          queue: [...(queue?.steering ?? []).map((text) => ({ kind: "steer" as const, text })), ...(queue?.followUp ?? []).map((text) => ({ kind: "next" as const, text }))],
          widgets: Object.values(agent?.widgets ?? {}).flat(),
          search: this.search(agent),
        },
        editor: editorZone,
        status: this.statusLines(tabs, tab, agent),
        footer: { node: tab?.node ?? "", agent },
        overlays: this.overlays.filter((overlay) => (overlay === "tabs" ? width < LEFT_STRIP_MIN : overlay === "items" ? width < RIGHT_STRIP_MIN : true)),
        componentOverlay,
      },
      input:
        editorZone.kind === "picker"
          ? "picker"
          : componentOverlay !== undefined || editorZone.kind === "component"
            ? "component"
            : editorZone.kind === "interaction"
            ? "dialog"
            : this.searchState !== undefined
              ? "search"
              : main.kind === "task"
                ? "task"
                : main.kind === "subagent"
                  ? "subagent"
                  : "editor",
      toolsExpanded: this.toolsExpanded,
    };
  }

  private mainZone(selected: string, agent: AgentModel | undefined, tab: Tab | undefined): MainZone {
    if (selected === "session" || agent === undefined || tab === undefined) {
      return { kind: "transcript" };
    } else {
      const task = agent.state.tasks.find((candidate) => candidate.id === selected);
      const subagent = agent.state.subagents.find((candidate) => candidate.session === selected);
      const childId = subagent?.agentId ?? (selected.startsWith("agent:") ? selected.slice("agent:".length) : undefined);
      if (subagent !== undefined || childId !== undefined) {
        const child = childId !== undefined ? this.client.agents.get(agentKey(tab.node, childId)) : undefined;
        if (child !== undefined && !this.client.full.has(agentKey(tab.node, child.id))) {
          void this.client.follow(tab.node, child.id).catch(() => undefined);
        } else {
          // followed already, or its agent is gone
        }
        return { kind: "subagent", id: selected, subagent, agent: child !== undefined ? this.client.full.get(agentKey(tab.node, child.id)) : undefined };
      } else {
        return { kind: "task", taskId: selected, task, output: this.taskOutputs.get(selected) ?? "" };
      }
    }
  }

  /** The agents of a session's subagents on its node, subagents of subagents included. */
  private descendants(node: string, agentId: string): AgentInfo[] {
    const children = [...this.client.agents.values()].filter((candidate) => candidate.node === node && candidate.parent === agentId);
    return children.flatMap((child) => [child, ...this.descendants(node, child.id)]);
  }

  /**
   * The interaction the session waits on: its own first, then its subagents' (followed in full while
   * they ask, so their requests are known).
   */
  private asking(node: string, agentId: string, agent: AgentModel | undefined): { request: InteractionRequest; from?: string } | undefined {
    const own = agent?.interactions[0];
    if (own !== undefined) {
      return { request: own };
    } else {
      for (const child of this.descendants(node, agentId)) {
        const key = agentKey(node, child.id);
        if (child.summary.waiting > 0 && !this.client.full.has(key)) {
          void this.client.follow(node, child.id).catch(() => undefined);
        } else {
          // not asking, or followed already
        }
        const request = this.client.full.get(key)?.interactions[0];
        if (request !== undefined) {
          return { request, from: child.subagent?.profile ?? "subagent" };
        } else {
          // this one does not ask
        }
      }
      return undefined;
    }
  }

  private statusLines(tabs: Tab[], tab: Tab | undefined, agent: AgentModel | undefined): StatusLine[] {
    const now = this.clock.now();
    const lines: StatusLine[] = [];
    const notice = [this.notice, ...(agent?.notices.slice(-1) ?? [])].filter((candidate) => candidate !== undefined && now - candidate.at < NOTICE_MS).sort((a, b) => (b?.at ?? 0) - (a?.at ?? 0))[0];
    if (notice !== undefined) {
      lines.push({ level: notice.level, text: notice.message.split("\n")[0] ?? "" });
    } else {
      // no recent notice
    }
    const statuses = Object.values(agent?.status ?? {});
    if (statuses.length > 0) {
      lines.push({ level: "info", text: statuses.join(" · ") });
    } else {
      // no extension statuses
    }
    if (agent?.running === true) {
      lines.push({ level: "working", text: "working… (Esc to stop)" });
    } else {
      // idle
    }
    if (tab?.unavailable !== undefined) {
      lines.push({ level: "warning", text: `⊘ ${tab.unavailable}` });
    } else {
      // available
    }
    const waiting = tabs.filter((candidate, index) => index !== this.active && candidate.glyph === "◆").length;
    if (waiting > 0) {
      lines.push({ level: "warning", text: `◆ ${waiting} other session${waiting > 1 ? "s" : ""} waiting for you` });
    } else {
      // nobody else waits
    }
    return lines;
  }

  /** The output of the task shown in the main area, refreshed while it is shown. */
  private followTask(taskId: string | undefined): void {
    if (taskId === this.taskShown) {
      return;
    } else {
      this.taskShown = taskId;
      if (this.taskTimer !== undefined) {
        this.clock.clearTimeout(this.taskTimer);
        this.taskTimer = undefined;
      } else {
        // no task followed
      }
      if (taskId !== undefined) {
        void this.pollTask(taskId);
      } else {
        // the main area shows no task
      }
    }
  }

  private async pollTask(taskId: string): Promise<void> {
    const tab = this.activeTab();
    if (tab?.agent === undefined || this.taskShown !== taskId) {
      return;
    } else {
      try {
        const output = await this.client.connection(tab.node).call<{ text: string }>(tab.agent.id, { type: "harness_task_output", taskId, offset: 0, limit: 256 * 1024 });
        if (this.taskOutputs.get(taskId) !== output.text) {
          this.taskOutputs.set(taskId, output.text);
          this.client.changed();
        } else {
          // unchanged
        }
      } catch (error) {
        this.taskOutputs.set(taskId, error instanceof Error ? error.message : String(error));
      }
      if (this.taskShown === taskId) {
        this.taskTimer = this.clock.setTimeout(() => void this.pollTask(taskId), TASK_OUTPUT_MS);
      } else {
        // the view moved on
      }
    }
  }

  private search(agent: AgentModel | undefined): Search | undefined {
    if (this.searchState === undefined) {
      return undefined;
    } else {
      const query = this.searchState.query.toLowerCase();
      const matches = query === "" ? [] : (agent?.items ?? []).filter((item) => itemText(item).toLowerCase().includes(query)).map((item) => item.key);
      const index = matches.length === 0 ? 0 : ((this.searchState.index % matches.length) + matches.length) % matches.length;
      return { query: this.searchState.query, matches, index };
    }
  }

  /** Starts a search, or changes its query (the newest match first). */
  setSearch(query: string): void {
    this.searchState = { query, index: -1 };
    this.client.changed();
  }

  /** Moves to the next older (-1) or newer (+1) match. */
  stepSearch(direction: 1 | -1): void {
    if (this.searchState !== undefined) {
      this.searchState = { ...this.searchState, index: this.searchState.index + direction };
      this.client.changed();
    } else {
      // no search open
    }
  }

  endSearch(): void {
    this.searchState = undefined;
    this.client.changed();
  }

  notify(level: "info" | "warning" | "error", message: string): void {
    this.notice = { level, message, at: this.clock.now() };
    this.client.changed();
  }

  /* ----- pickers and overlays ----- */

  openPicker(picker: Omit<Picker, "choose"> & { choose(value: string): Promise<void> | void }): void {
    this.picker = {
      ...picker,
      choose: async (value) => {
        this.picker = undefined;
        try {
          await picker.choose(value);
        } catch (error) {
          this.notify("error", error instanceof Error ? error.message : String(error));
        }
        this.client.changed();
      },
    };
    this.client.changed();
  }

  closePicker(): void {
    this.picker = undefined;
    this.client.changed();
  }

  toggleOverlay(kind: OverlayKind): void {
    this.overlays = this.overlays.includes(kind) ? this.overlays.filter((overlay) => overlay !== kind) : [...this.overlays, kind];
    this.client.changed();
  }

  /** Esc: the search, the topmost overlay, then the picker, close first. */
  dismiss(): boolean {
    if (this.searchState !== undefined) {
      this.endSearch();
      return true;
    } else if (this.overlays.length > 0) {
      this.overlays = this.overlays.slice(0, -1);
      this.client.changed();
      return true;
    } else if (this.picker !== undefined) {
      this.closePicker();
      return true;
    } else {
      return false;
    }
  }

  panelRows(state: HarnessState): PanelRow[] {
    return [
      { value: "madness", label: `${state.madness ? "[x]" : "[ ]"} madness`, description: "write/edit without gates" },
      { value: "simple", label: `${state.variant === "simple" ? "[x]" : "[ ]"} simple`, description: "one mode instead of PLAN/BUILD" },
      { value: "implementer", label: `implementer: ${state.implementer}`, description: "self or a subagent profile (builder)" },
      { value: "subagents", label: "subagents", description: "the profiles this session may call" },
      { value: "dependencies", label: "dependencies", description: "the bundle, Claude Code, bundled versions" },
      ...(this.update !== undefined ? [{ value: "update" as const, label: `update · ${this.update.hint()}`, description: this.update.canRun() ? "upgrade and restart" : "nothing to do here" }] : []),
    ];
  }

  /** A read-only list in the editor's place (a report, the profiles). */
  private showList(id: string, title: string, lines: { label: string; description?: string }[]): void {
    this.openPicker({ id, title, items: lines.map((line, index) => ({ value: String(index), ...line })), choose: () => undefined });
  }

  async choosePanel(value: PanelRow["value"]): Promise<void> {
    const tab = this.activeTab();
    const agent = tab?.agent !== undefined ? this.client.full.get(agentKey(tab.node, tab.agent.id)) : undefined;
    if (value === "update") {
      if (this.update?.canRun() === true) {
        await this.update.run();
      } else {
        this.notify("info", `update: ${this.update?.hint() ?? "not available here"}`);
      }
    } else if (tab?.agent === undefined || agent === undefined) {
      this.notify("warning", "no session");
    } else if (value === "dependencies") {
      const { text } = await this.client.connection(tab.node).call<{ text: string }>(tab.agent.id, { type: "harness_report" });
      this.showList("dependencies", `Dependencies (node ${tab.node})`, [...text.split("\n"), ...(this.update?.lines() ?? [])].map((label) => ({ label })));
    } else if (value === "subagents") {
      const { profiles, problems } = await this.client.connection(tab.node).call<{ profiles: SubagentProfileView[]; problems: string[] }>(tab.agent.id, { type: "harness_subagents" });
      this.showList("subagents", "Subagents", [
        ...profiles.map((profile) => ({
          label: `${profile.name} · ${profile.engine} · ${profile.mode}${profile.model !== undefined ? ` · ${profile.model}${profile.resolved !== undefined ? ` → ${profile.resolved}` : ""}` : ""}`,
          description: `${profile.description} (${profile.source}: ${profile.dir})`,
        })),
        ...problems.map((problem) => ({ label: `✗ ${problem}` })),
      ]);
    } else {
      const state = agent.state;
      const variant: Variant = state.variant === "simple" ? "advanced" : "simple";
      const change =
        value === "madness" ? { madness: !state.madness } : value === "simple" ? { variant } : { implementer: state.implementer === "self" ? "builder" : "self" };
      await this.client.connection(tab.node).call(tab.agent.id, { type: "harness_set", ...change });
    }
  }

  /* ----- actions (keymap.ts): every UI acts through these ----- */

  async act(action: ActionId): Promise<void> {
    const tab = this.activeTab();
    const api = tab !== undefined ? this.client.connections.get(tab.node) : undefined;
    const agentId = tab?.agent?.id;
    const call = async (record: { type: string; [key: string]: unknown }): Promise<void> => {
      if (api !== undefined && agentId !== undefined) {
        await api.call(agentId, record);
      } else {
        this.notify("warning", "no session here: Ctrl+T starts one, Ctrl+O opens one");
      }
    };
    try {
      if (action.startsWith("tabs.goto.")) {
        await this.goto(Number(action.slice("tabs.goto.".length)) - 1);
      } else {
        const named = action as Exclude<ActionId, `tabs.goto.${number}`>;
        switch (named) {
          case "tabs.next":
          case "tabs.prev": {
            const count = this.tabs().length;
            await this.goto(count === 0 ? 0 : (this.active + (action === "tabs.next" ? 1 : count - 1)) % count);
            break;
          }
          case "tabs.new":
            await this.newTabOnNode();
            break;
          case "tabs.close":
            await this.closeTab(this.active);
            break;
          case "tabs.open":
            await this.openSessionPicker();
            break;
          case "items.next":
          case "items.prev":
            if (tab !== undefined) {
              const items = this.items(tab, this.client.full.get(agentKey(tab.node, agentId ?? ""))?.state);
              const index = items.findIndex((item) => item.id === this.selectedItem(tab));
              const next = items[Math.max(0, Math.min(items.length - 1, index + (action === "items.next" ? 1 : -1)))];
              this.select(tab, next?.id ?? "session");
            } else {
              // no session
            }
            break;
          case "panel.toggle":
            this.toggleOverlay("panel");
            break;
          case "strip.tabs":
            this.toggleOverlay("tabs");
            break;
          case "strip.items":
            this.toggleOverlay("items");
            break;
          case "model.select":
            await this.openModelPicker();
            break;
          case "model.cycle":
            await call({ type: "cycle_model" });
            break;
          case "thinking.cycle":
            await call({ type: "cycle_thinking_level" });
            break;
          case "tools.expand":
            this.toolsExpanded = !this.toolsExpanded;
            break;
          case "run.abort":
            if (!this.dismiss()) {
              await call({ type: "abort" });
            } else {
              // Esc closed an overlay or the picker
            }
            break;
          case "transcript.search":
            if (this.searchState === undefined) {
              this.setSearch("");
            } else {
              this.stepSearch(-1);
            }
            break;
          case "app.quit":
          case "editor.submit":
          case "editor.newline":
            break; // the UI's own: quitting, its editor
          default:
            throw new Error(`unknown action: ${String(named satisfies never)}`);
        }
      }
    } catch (error) {
      this.notify("error", error instanceof Error ? error.message : String(error));
    }
    this.client.changed();
  }

  /** A new session: on the home node in the client's directory; with several nodes, the user picks one. */
  private async newTabOnNode(): Promise<void> {
    const nodes = [...this.client.connections.keys()];
    const home = this.client.home ?? nodes[0];
    if (nodes.length <= 1 || home === undefined) {
      await this.newTab(home ?? "", this.cwd);
    } else {
      this.openPicker({
        id: "new-session",
        title: "New session on",
        items: nodes.map((node) => ({ value: node, label: node, description: node === home ? this.cwd : "~ (the node user's home)" })),
        choose: async (node) => {
          await this.newTab(node, node === home ? this.cwd : "~");
        },
      });
    }
  }

  private async goto(index: number): Promise<void> {
    await this.ensureAgent(this.tabs()[index]);
    await this.activate(index);
  }

  /**
   * Logs in to a provider on the active session's node (where its agents read auth.json): a list of
   * providers, then the login's steps as interactions in the editor's place.
   */
  async loginPicker(): Promise<void> {
    const tab = this.activeTab();
    if (tab?.agent === undefined) {
      this.notify("warning", "no session: logins are stored on a session's node");
    } else {
      const node = tab.node;
      const agentId = tab.agent.id;
      const api = this.client.connection(node);
      const { providers } = await api.call<{ providers: LoginProvider[] }>(agentId, { type: "harness_login_providers" });
      this.openPicker({
        id: "login",
        title: `Log in on ${node}`,
        items: providers.map((provider) => ({
          value: `${provider.id}\u0000${provider.authType}`,
          label: `${provider.configured ? "✓ " : ""}${provider.name}`,
          description: provider.authType === "oauth" ? (provider.subscription ? "subscription" : "account") : "API key",
        })),
        choose: (value) => {
          const [provider, authType] = value.split("\u0000") as [string, "oauth" | "api_key"];
          // the login runs on the node; its steps arrive as interactions
          void api
            .call(agentId, { type: "harness_login", provider, authType })
            .then(() => this.notify("info", `logged in to ${provider} on ${node}`))
            .catch((error: unknown) => this.notify("error", `login to ${provider}: ${error instanceof Error ? error.message : String(error)}`));
        },
      });
    }
  }

  async logout(provider: string): Promise<void> {
    const tab = this.activeTab();
    if (tab?.agent === undefined) {
      this.notify("warning", "no session: logins are stored on a session's node");
    } else {
      await this.client.connection(tab.node).call(tab.agent.id, { type: "harness_logout", provider });
      this.notify("info", `logged out of ${provider} on ${tab.node}`);
    }
  }

  async openSessionPicker(): Promise<void> {
    const nodes = [...this.client.connections.keys()];
    const lists = await Promise.all(nodes.map(async (node) => ({ node, sessions: await this.client.sessions(node).catch(() => []) })));
    const all = lists.flatMap(({ node, sessions }) => sessions.map((session) => ({ node, session }))).sort((a, b) => b.session.modified - a.session.modified);
    this.openPicker({
      id: "sessions",
      title: "Open a session",
      items: all.slice(0, 300).map(({ node, session }) => ({
        value: `${node}\u0000${session.id}`,
        label: `${node}/${session.name ?? session.firstMessage?.split("\n")[0]?.slice(0, 60) ?? session.id.slice(0, 8)}`,
        description: `${session.agent !== undefined ? "running · " : ""}${session.cwd} · ${new Date(session.modified).toLocaleString()}`,
      })),
      choose: async (value) => {
        const [node, id] = value.split("\u0000");
        const found = all.find((candidate) => candidate.node === node && candidate.session.id === id);
        if (found !== undefined) {
          await this.openSession(found.node, found.session);
        } else {
          // the list changed meanwhile
        }
      },
    });
  }

  async openModelPicker(): Promise<void> {
    const tab = this.activeTab();
    if (tab?.agent === undefined) {
      this.notify("warning", "no session");
    } else {
      const api = this.client.connection(tab.node);
      const agentId = tab.agent.id;
      const { models } = await api.call<{ models: { provider: string; id: string; name?: string }[] }>(agentId, { type: "get_available_models" });
      // references first: they follow the newest model of their family (plan 6.2)
      const refs = familyRefs(models).map(({ ref, model }) => ({ value: `ref:${ref}`, label: `${ref} → ${model.id}`, description: "the newest of the family, now and later" }));
      this.openPicker({
        id: "model",
        title: "Model",
        items: [...refs, ...models.map((model) => ({ value: `${model.provider}/${model.id}`, label: `${model.provider}/${model.id}`, description: model.name }))],
        choose: async (value) => {
          if (value.startsWith("ref:")) {
            await api.call(agentId, { type: "harness_set", model: value.slice("ref:".length) });
          } else {
            const slash = value.indexOf("/");
            await api.call(agentId, { type: "set_model", provider: value.slice(0, slash), modelId: value.slice(slash + 1) });
          }
        },
      });
    }
  }

  /** Keys for, and the width of, a bridged component of the active session. */
  async componentInput(componentId: string, data: string): Promise<void> {
    await this.componentCall({ type: "harness_component_input", componentId, data });
  }

  async componentResize(componentId: string, width: number): Promise<void> {
    await this.componentCall({ type: "harness_component_resize", componentId, width });
  }

  private async componentCall(record: { type: string; [key: string]: unknown }): Promise<void> {
    const tab = this.activeTab();
    if (tab?.agent !== undefined) {
      await this.client
        .connection(tab.node)
        .call(tab.agent.id, record)
        .catch((error: unknown) => this.notify("error", error instanceof Error ? error.message : String(error)));
    } else {
      // the session is gone with its component
    }
  }

  async answer(interactionId: string, value: unknown): Promise<void> {
    const tab = this.activeTab();
    if (tab?.agent !== undefined) {
      // the session's own interaction, or one of its subagents'
      const owner = [tab.agent, ...this.descendants(tab.node, tab.agent.id)].find((candidate) =>
        this.client.full.get(agentKey(tab.node, candidate.id))?.interactions.some((request) => request.id === interactionId),
      );
      try {
        await this.client.connection(tab.node).call((owner ?? tab.agent).id, { type: "harness_interaction_response", interactionId, answer: value });
      } catch (error) {
        this.notify("error", `answer not delivered: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      this.notify("error", "the session's agent is gone");
    }
  }

  /** Sends the editor's text to the active session in the mode it asks for. */
  async prompt(text: string, mode: RunMode): Promise<void> {
    const tab = this.activeTab();
    if (tab?.agent === undefined) {
      this.notify("warning", "no session here: Ctrl+T starts one, Ctrl+O opens one");
    } else {
      const selected = this.selectedItem(tab);
      const agent = this.client.full.get(agentKey(tab.node, tab.agent.id));
      const subagent = agent?.state.subagents.find((candidate) => candidate.session === selected);
      const task = agent?.state.tasks.find((candidate) => candidate.id === selected);
      const nested = selected.startsWith("agent:") ? this.client.agents.get(agentKey(tab.node, selected.slice("agent:".length))) : undefined;
      const api = this.client.connection(tab.node);
      try {
        if (subagent !== undefined) {
          // the operator's steering of a live subagent (C12), through the session that runs it
          await api.call(tab.agent.id, { type: "harness_subagent_send", session: subagent.session, text });
        } else if (nested?.parent !== undefined) {
          await api.call(nested.parent, { type: "harness_subagent_send", session: nested.sessionId, text });
        } else if (task !== undefined) {
          await api.call(tab.agent.id, { type: "harness_task_input", taskId: task.id, data: `${text}\n` });
        } else {
          await api.call(tab.agent.id, { type: "harness_prompt", text, mode });
        }
      } catch (error) {
        this.notify("error", error instanceof Error ? error.message : String(error));
      }
    }
  }

  tabs(): Tab[] {
    return tabRecords(this.client.settings).map((record) => {
      const agent = [...this.client.agents.values()].find((candidate) => candidate.node === record.node && candidate.sessionId === record.sessionId);
      const unavailable = this.client.offline.has(record.node) ? `node ${record.node} is offline` : this.client.connections.has(record.node) ? undefined : `node ${record.node} is not connected`;
      // a subagent that waits for the operator makes its session wait too
      const childWaits = agent !== undefined && unavailable === undefined && this.descendants(record.node, agent.id).some((child) => child.summary.waiting > 0);
      return {
        ...record,
        agent,
        glyph: childWaits ? "◆" : glyphOf(agent?.summary, record.seen, unavailable),
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
    const now = this.clock.now();
    const tasks: Item[] = (state?.tasks ?? []).map((task) => ({
      kind: "task",
      id: task.id,
      label: task.command,
      detail: task.endedAt !== undefined ? (task.exitCode !== undefined ? `exit ${task.exitCode}` : task.state) : duration(now - task.startedAt),
      glyph: taskGlyph(task, seen),
      depth: 0,
    }));
    // a harness subagent's own agent tells its state live, and its own subagents follow it indented
    const subagents: Item[] = (state?.subagents ?? []).flatMap((subagent) => {
      const child = subagent.agentId !== undefined ? this.client.agents.get(agentKey(tab.node, subagent.agentId)) : undefined;
      const live = child !== undefined && (subagent.state === "running" || subagent.state === "waiting");
      const row: Item = {
        kind: "subagent",
        id: subagent.session,
        label: `${subagent.profile} ${subagent.session.slice(0, 4)}`,
        detail: subagent.costUsd !== undefined && subagent.costUsd > 0 ? `${subagent.state} $${subagent.costUsd.toFixed(2)}` : subagent.state,
        glyph: live && child.summary.waiting > 0 ? "◆" : subagentGlyph(subagent),
        depth: 0,
      };
      const nested: Item[] =
        child !== undefined
          ? this.descendants(tab.node, child.id).map((grandchild) => ({
              kind: "subagent" as const,
              id: `agent:${grandchild.id}`,
              label: `${grandchild.subagent?.profile ?? "subagent"} ${grandchild.sessionId.slice(0, 4)}`,
              detail: grandchild.summary.status,
              glyph: glyphOf(grandchild.summary, undefined, undefined),
              depth: 1,
            }))
          : [];
      return [row, ...nested];
    });
    return [session, ...tasks, ...subagents];
  }

  selectedItem(tab: Tab): string {
    return this.selected.get(tab.sessionId) ?? "session";
  }

  select(tab: Tab, itemId: string): void {
    this.selected.set(tab.sessionId, itemId);
    if (itemId !== "session") {
      this.tasksSeen.set(tab.sessionId, this.clock.now());
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
