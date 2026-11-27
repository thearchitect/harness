// The workbench every UI draws: the tabs of open sessions (left), the items of the active session
// (right: the session itself, its background tasks, its subagents), what the main area shows, and
// the one glyph each row carries. The tab set lives in the user's settings (`ui.tabs`), shared by
// all the user's UIs; which tab is active and which item is selected are this client's own.

import { systemClock, type Clock } from "#protocol/clock.ts";
import type { BridgedComponent, ComponentMouse, LoginProvider, SubagentProfileView } from "#protocol/hap.ts";
import { familyRefs } from "#protocol/model-ref.ts";
import { modeOfText } from "#protocol/modes.ts";
import type { InteractionRequest } from "#protocol/interactions.ts";
import type { AgentInfo, AgentSummary } from "#protocol/hub.ts";
import type { HarnessState, RunMode, SubagentInfo, TaskInfo, Variant } from "#protocol/state.ts";
import type { ActionId } from "../keymap.ts";
import type { AgentModel, TranscriptItem } from "../model/agent-model.ts";
import { agentKey, type ClientModel } from "../model/client-model.ts";
import type { TerminalModel } from "../model/terminal-model.ts";
import { Prefetch, PREFETCH_RECHECK_MS, prefetchMode, type PrefetchTarget } from "../model/prefetch.ts";
import { NewSession } from "./new-session.ts";
import { DEFAULT_VIEW, type TabView, type ViewStateStore, type WindowState } from "./view-state.ts";

/** A window's state is kept at most this often. */
export const VIEW_SAVE_MS = 500;

/** Screen widths (columns; the app converts them to `ch`) below which a strip hides behind an overlay. */
export const LEFT_STRIP_MIN = 72;
/** How long a notice stays in the status line. */
export const NOTICE_MS = 15_000;
/** How often an open task view refreshes its output. */
export const TASK_OUTPUT_MS = 700;

export type PickerItem = { value: string; label: string; description?: string };

/**
 * A choice from a list, drawn in the editor's place. `custom`: the typed text is a choice of its
 * own when no item matches (a directory, a name). `scopes`: lists to switch between with Tab (the
 * model's favorites and all models); `items` are the shown scope's.
 */
export type Picker = {
  id: string;
  title: string;
  items: PickerItem[];
  choose(value: string): Promise<void>;
  custom?: string;
  scopes?: { title: string; items: PickerItem[] }[];
  scope?: number;
  /** The item selected when the list opens (the one the operator came back from). */
  initial?: string;
};

/** A key and what it does, for a list's hint line: drawn as pi draws key hints (`tab favorites/all`). */
export type KeyHint = { key: string; does: string };

/** The hint line of a picker: every key it takes, each with what it does. */
/** The keys of choosing a new session's folder, in the editor's place. */
export const NEW_SESSION_HINTS: KeyHint[] = [
  { key: "↑↓", does: "select" },
  { key: "→", does: "open" },
  { key: "←", does: "up" },
  { key: "type", does: "filter" },
  { key: "enter", does: "create here" },
  { key: "esc", does: "cancel" },
];

export function pickerHints(picker: Picker): KeyHint[] {
  return [
    { key: "↑↓", does: "select" },
    ...(picker.scopes !== undefined && picker.scopes.length > 1 ? [{ key: "tab", does: picker.scopes.map((scope) => scope.title.toLowerCase()).join("/") }] : []),
    { key: "type", does: picker.custom !== undefined ? `filter or ${picker.custom}` : "filter" },
    { key: "enter", does: "choose" },
    { key: "esc", does: "cancel" },
  ];
}

/** What lies over the screen: the harness panel (on the right) and the left strip when the screen is too narrow for it. */
export type OverlayKind = "panel" | "tabs";

/**
 * A row of the strip's top block: a hub this client reaches (its own first, named `inprocess` in
 * the window that holds it), one glyph for all its sessions: ⊘ offline, ◆ one waits for the
 * operator, ● something works.
 */
export type HubRow = { name: string; label: string; glyph: "⊘" | "◆" | "●" | "" };

export type StatusLine = { level: "info" | "warning" | "error" | "working"; text: string };

/** The line above a subagent's transcript: its profile, state, engine, model, cost. */
export function subagentHeading(main: Extract<MainZone, { kind: "subagent" }>): string {
  const subagent = main.subagent;
  const model = main.agent?.claudeInfo?.model ?? subagent?.model;
  const cost = main.agent?.claudeInfo?.costUsd ?? subagent?.costUsd ?? 0;
  return [
    `${subagent?.profile ?? "subagent"} ${main.id.slice(0, 8)}`,
    subagent?.state ?? "gone",
    subagent?.engine ?? "",
    ...(model !== undefined ? [model] : []),
    ...(cost > 0 ? [`$${cost.toFixed(2)}`] : []),
    "the editor steers it while it runs",
  ]
    .filter((part) => part !== "")
    .join(" · ");
}

/** A subagent: its row in the session's state and its transcript (a `harness` subagent's agent, a `claude` one's stream). */
export type MainZone =
  | { kind: "transcript" }
  /** Choosing where a new session starts (Ctrl+T, + new). */
  | { kind: "newSession"; choice: NewSession }
  | { kind: "task"; taskId: string; task: TaskInfo | undefined; output: string }
  | {
      kind: "subagent";
      id: string;
      subagent: SubagentInfo | undefined;
      agent: AgentModel | undefined;
      /** A call to show in its transcript, expanded: the Task of a subagent of Claude's whose row was chosen. */
      focus?: string;
    };

export type EditorZone =
  | { kind: "editor"; mode: RunMode }
  /** `from`: the subagent that asks (an interaction of a subagent of this session). */
  | { kind: "interaction"; request: InteractionRequest; from?: string }
  | { kind: "picker"; picker: Picker }
  /** The keys of what the main zone shows in place of the editor (choosing a folder). */
  | { kind: "hint"; hints: KeyHint[] }
  /** An extension's component drawn in the agent (terminal clients only; others say they cannot show it). */
  | { kind: "component"; component: BridgedComponent };

/** The zones of the main area (top to bottom) and what lies over the screen — the same in every UI. */
export type Zones = {
  main: MainZone;
  aboveEditor: { queue: { kind: "steer" | "next"; text: string }[]; widgets: string[]; search: Search | undefined };
  editor: EditorZone;
  status: StatusLine[];
  footer: { hub: string; agent: AgentModel | undefined };
  overlays: OverlayKind[];
  /** An extension's overlay component drawn in the agent, over the screen. */
  componentOverlay: BridgedComponent | undefined;
};

/** Where typed text goes now. */
export type InputTarget = "editor" | "dialog" | "picker" | "component" | "search" | "task" | "subagent" | "newSession";

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
  strips: { left: boolean };
  /** The strip's three blocks: the hubs, the chosen hub's sessions, the active session's items. */
  hubs: HubRow[];
  hub: string | undefined;
  /** The chosen hub's tabs (each with its index among all tabs); `active` indexes these. */
  tabs: Tab[];
  active: number;
  /** A new session being placed on this node: its row in the sessions block. */
  newSession: string | undefined;
  tab: Tab | undefined;
  agent: AgentModel | undefined;
  items: Item[];
  selected: string;
  zones: Zones;
  input: InputTarget;
  toolsExpanded: boolean;
  /** What the active tab left: its draft, where it was scrolled (a UI restores them when the tab comes back). */
  view: TabView | undefined;
  /** Text for the editor: a UI puts it in once per `key` (the agent's setEditorText, a branch's message). */
  prefill: { key: string; text: string } | undefined;
  /** A link the active session asks the operator's browser to open: a UI opens it once per `key`. */
  openUrl: { key: string; url: string } | undefined;
  /** The active session's terminal, shown over the main area (Ctrl+I): the UI opens it at its size. */
  terminal: TerminalModel | undefined;
};

export type PanelId = "madness" | "simple" | "name" | "implementer" | "subagents" | "dependencies" | "logs" | "restart" | "update";

/**
 * A row of the harness panel (Ctrl+\): a toggle (on/off, its tone when on) keeps the panel open; an
 * action (with a hint on the right) closes it, so what it shows is not under the panel; a text field
 * takes typing as soon as it is selected and applies it as it is typed (editSessionName).
 */
export type PanelItem =
  | { kind: "toggle"; id: PanelId; label: string; tone: "success" | "error"; on: boolean }
  | { kind: "value"; id: PanelId; label: string; value: string }
  | { kind: "text"; id: PanelId; label: string; value: string; placeholder: string }
  | { kind: "action"; id: PanelId; label: string; hint: string };

/** A typed session name goes to the session this long after the last key (pi writes an entry per change). */
export const NAME_APPLY_MS = 400;

export type PanelSection = { title: string; items: PanelItem[] };

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
export type TabRecord = { hub: string; sessionId: string; sessionFile?: string; cwd: string; seen?: number };

export type Tab = TabRecord & {
  agent: AgentInfo | undefined;
  glyph: Glyph;
  title: string;
  mode: RunMode;
  /** Why the tab cannot open now (its hub is offline, its session is gone). */
  unavailable: string | undefined;
  /** Its index among all tabs (what activate, goto and closeTab take). */
  index: number;
  /** A session without a message yet: this window's alone until its first message. */
  draft: boolean;
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

/** A hub event (telemetry JSONL) as one line: time, event, its fields. */
function logLine(line: string): string {
  try {
    const { at, event, ...rest } = JSON.parse(line) as { at?: string; event?: string; [key: string]: unknown };
    const fields = Object.entries(rest).map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
    return [at?.slice(11, 19) ?? "", event ?? "?", ...fields].join(" ");
  } catch {
    return line;
  }
}

/** The commands every UI runs itself (Workbench.clientCommand). */
export const CLIENT_COMMANDS: { name: string; description: string }[] = [
  { name: "new", description: "New session (Ctrl+T)" },
  { name: "open", description: "Open a session (Ctrl+O)" },
  { name: "model", description: "Choose the model (Ctrl+L)" },
  { name: "login", description: "Log in to a provider on this session's node" },
  { name: "logout", description: "Remove a provider's login on this session's node" },
  { name: "tree", description: "Move to another point of the session's tree" },
  { name: "settings", description: "Theme, compaction, message queues" },
  { name: "bash", description: "Run a command yourself; the model sees it and its output" },
  { name: "bash-quiet", description: "Run a command yourself, kept out of the model's context" },
  { name: "export", description: "The session as an HTML page (optionally: where to write it)" },
  { name: "quit", description: "Quit (a node this window holds stops with it)" },
];

/** A node of pi's session tree (get_tree), as far as the tree list reads it. */
type TreeNode = {
  entry: { id: string; type: string; message?: { role?: string; content?: unknown }; summary?: string };
  children: TreeNode[];
  label?: string;
};

/** A tree entry's line: user messages, answers, summaries; other entries are not listed. */
function treeLine(node: TreeNode): string | undefined {
  const entry = node.entry;
  const firstLine = (text: string): string => text.split("\n").find((line) => line.trim() !== "")?.slice(0, 100) ?? "";
  const textOf = (content: unknown): string =>
    typeof content === "string" ? content : Array.isArray(content) ? (content as { type?: string; text?: string }[]).filter((block) => block.type === "text").map((block) => block.text ?? "").join(" ") : "";
  if (entry.type === "message" && entry.message?.role === "user") {
    return `› ${firstLine(textOf(entry.message.content))}`;
  } else if (entry.type === "message" && entry.message?.role === "assistant") {
    const text = firstLine(textOf(entry.message.content));
    return text !== "" ? `  ${text}` : undefined;
  } else if (entry.type === "branch_summary" || entry.type === "compaction") {
    return `≡ ${firstLine(entry.summary ?? entry.type)}`;
  } else {
    return undefined;
  }
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`;
}

export function tabRecords(settings: Record<string, unknown>): TabRecord[] {
  const tabs = settings["ui.tabs"];
  return Array.isArray(tabs) ? (tabs.filter((tab) => typeof tab === "object" && tab !== null && typeof (tab as TabRecord).sessionId === "string" && typeof (tab as TabRecord).hub === "string") as TabRecord[]) : [];
}

/** What names a tab: its session on its hub. */
export type TabKey = { hub: string; sessionId: string };

/** Whether a record is a tab's: the same session on the same hub. */
function sameTab(record: TabKey, tab: TabKey): boolean {
  return record.hub === tab.hub && record.sessionId === tab.sessionId;
}

export type WorkbenchOptions = {
  /** Where new sessions start (the client's working directory). */
  cwd?: string;
  clock?: Clock;
  update?: UpdateHook;
  /** The themes this UI can draw (`ui.theme` names). */
  themes?: () => string[];
  /** Settings only this kind of UI has (the app's fonts and notifications): rows of /settings. */
  uiSettings?: () => UiSetting[];
  /** Brings a file of a hub to this device (the app downloads it); without it the path is shown. */
  offerFile?: (node: string, path: string) => void;
  /** Whether this window holds its home hub (the TUI's local hub in its process): its row reads `inprocess`. */
  holdsHome?: () => boolean;
  /** `+ add` of the hubs block: pairs this client with a hub (its address, a one-time code). */
  addHub?: (url: string, code: string) => Promise<void>;
  /** Where this window keeps its state between starts (view-state.ts); none: nothing is kept. */
  viewStore?: ViewStateStore;
  /** Loads sessions ahead in the background (prefetch.ts); on by default, `ui.prefetch` tunes it. */
  prefetch?: boolean;
};

/** A row of /settings a UI adds: choosing it runs `choose` (which may open its own list). */
export type UiSetting = { value: string; label: string; description?: string; choose(): void | Promise<void> };

export class Workbench {
  readonly client: ClientModel;
  /** The active tab, by identity: other clients' changes of the tab set keep it. */
  private activeKey: TabKey | undefined;
  /** The node the strip shows the sessions of (where new sessions start, what HARNESS acts on). */
  private chosenHub: string | undefined;
  /** The last active tab of each hub (choosing a hub opens it again). */
  private readonly lastActive = new Map<string, string>();
  /**
   * Tabs of sessions without a message yet: this window's alone (pi writes no file for them); the
   * first message puts them in the shared tab set (ui.tabs).
   */
  private drafts: TabRecord[] = [];
  /** Choosing where a new session starts. */
  private newSessionChoice: NewSession | undefined;
  private readonly holdsHome: () => boolean;
  private readonly addHub: WorkbenchOptions["addHub"];
  picker: Picker | undefined;
  overlays: OverlayKind[] = [];
  private searchState: { query: string; index: number } | undefined;
  /** The client's own directory (the TUI's); undefined: new sessions ask for one (the app). */
  private readonly cwd: string | undefined;
  private readonly clock: Clock;
  private readonly update: UpdateHook | undefined;
  private readonly themes: () => string[];
  private readonly uiSettings: () => UiSetting[];
  private readonly offerFile: ((node: string, path: string) => void) | undefined;
  private prefill: Screen["prefill"];
  private prefillCounter = 0;
  private readonly agentPrefillSeen = new WeakMap<AgentModel, number>();
  /** What each tab left (by `node/sessionId`): this window's own, kept by its store. */
  private readonly views = new Map<string, TabView>();
  private readonly viewStore: ViewStateStore | undefined;
  private viewSave: unknown;
  /** Tasks seen per session: the last task end the user has looked at. */
  private readonly tasksSeen = new Map<string, number>();
  private notice: { level: "info" | "warning" | "error"; message: string; at: number } | undefined;
  private readonly taskOutputs = new Map<string, string>();
  private taskTimer: unknown;
  private taskShown: string | undefined;

  constructor(client: ClientModel, options: WorkbenchOptions = {}) {
    this.client = client;
    this.cwd = options.cwd;
    this.clock = options.clock ?? systemClock;
    this.update = options.update;
    this.themes = options.themes ?? (() => []);
    this.uiSettings = options.uiSettings ?? (() => []);
    this.offerFile = options.offerFile;
    this.holdsHome = options.holdsHome ?? (() => false);
    this.addHub = options.addHub;
    this.viewStore = options.viewStore;
    if (options.prefetch !== false) {
      const prefetch = new Prefetch(client, () => this.prefetchTargets(), () => this.clock.now());
      this.prefetch = prefetch;
      // a pass when the window's sessions change, and at most once a minute for the lists' changes
      client.onChange(() => {
        const now = this.clock.now();
        const targets = this.prefetchTargets();
        const signature = JSON.stringify([prefetchMode(client.settings), targets]);
        if (signature !== this.prefetchSignature || now - this.prefetchAt >= PREFETCH_RECHECK_MS) {
          this.prefetchSignature = signature;
          this.prefetchAt = now;
          prefetch.kick();
        } else {
          // nothing new to load
        }
      });
    } else {
      this.prefetch = undefined;
    }
  }

  private readonly prefetch: Prefetch | undefined;
  private prefetchSignature = "";
  private prefetchAt = 0;
  /** When each tab was last active (the order tabs are loaded ahead in). */
  private readonly usedAt = new Map<string, number>();

  /** The window's tabs to load ahead: the active one, then by their last use. */
  private prefetchTargets(): PrefetchTarget[] {
    const active = this.activeTab();
    const used = (tab: Tab): number => (active !== undefined && sameTab(tab, active) ? Infinity : (this.usedAt.get(`${tab.hub}/${tab.sessionId}`) ?? 0));
    return this.tabs()
      .filter((tab) => tab.unavailable === undefined)
      .sort((a, b) => used(b) - used(a))
      .map((tab) => ({ hub: tab.hub, agent: tab.agent?.id, file: tab.sessionFile ?? tab.agent?.sessionFile }));
  }

  /** Stops loading ahead (the window closes). */
  stopPrefetch(): void {
    this.prefetch?.stop();
  }

  /* ----- what each tab left (view-state.ts) ----- */

  /** What a tab left: its draft, its scroll, its expanded output, its item. */
  view(tab: TabKey): TabView {
    return this.views.get(`${tab.hub}/${tab.sessionId}`) ?? DEFAULT_VIEW;
  }

  /**
   * Changes what a tab left. Drafts and scrolling change as the operator types and scrolls: kept
   * quietly; what the screen shows (the item, expanded output) redraws.
   */
  updateView(tab: TabKey, change: Partial<TabView>): void {
    this.views.set(`${tab.hub}/${tab.sessionId}`, { ...this.view(tab), ...change });
    this.scheduleViewSave();
    if (change.selected !== undefined || change.expanded !== undefined) {
      this.client.changed();
    } else {
      // the UI has it already
    }
  }

  /** The window's state to keep: the views of the tabs there are, the active tab, the hub, the drafts with text. */
  windowState(): WindowState {
    const tabs = this.tabs();
    const active = this.activeTab();
    const hub = this.chosenHub;
    return {
      version: 1,
      tabs: Object.fromEntries(tabs.filter((tab) => !tab.draft).flatMap((tab) => (this.views.has(`${tab.hub}/${tab.sessionId}`) ? [[`${tab.hub}/${tab.sessionId}`, this.view(tab)]] : []))),
      ...(active !== undefined && !active.draft ? { active: { hub: active.hub, sessionId: active.sessionId } } : {}),
      ...(hub !== undefined ? { hub } : {}),
      drafts: tabs.filter((tab) => tab.draft && this.view(tab).draft !== "").map((tab) => ({ hub: tab.hub, cwd: tab.cwd, draft: this.view(tab).draft })),
    };
  }

  /** At most one save per VIEW_SAVE_MS. */
  private scheduleViewSave(): void {
    if (this.viewStore === undefined || this.viewSave !== undefined) {
      return; // nowhere to keep it, or a save is coming
    } else {
      this.viewSave = this.clock.setTimeout(() => {
        this.viewSave = undefined;
        void this.saveViews();
      }, VIEW_SAVE_MS);
    }
  }

  /** Keeps the window's state now (on quitting). */
  async saveViews(): Promise<void> {
    if (this.viewSave !== undefined) {
      this.clock.clearTimeout(this.viewSave);
      this.viewSave = undefined;
    } else {
      // no save pending
    }
    await this.viewStore?.save(this.windowState()).catch((error: unknown) => this.notify("warning", `the window's state was not kept: ${error instanceof Error ? error.message : String(error)}`));
  }

  /**
   * The window as it was: the tabs' views, the active tab and the hub; each draft of a session
   * without a message becomes a new session in its folder with the draft. Call once the hubs are
   * connected, before the UI starts.
   */
  async restoreViews(): Promise<void> {
    const state = await this.viewStore?.load().catch(() => undefined);
    if (state === undefined) {
      return; // a first start, or nothing kept
    } else {
      for (const [key, view] of Object.entries(state.tabs)) {
        this.views.set(key, { ...DEFAULT_VIEW, ...view });
      }
      const tabs = this.tabs();
      const active = state.active;
      const index = active !== undefined ? tabs.findIndex((tab) => sameTab(tab, active)) : -1;
      if (index >= 0) {
        this.activeKey = active;
        this.chosenHub = active?.hub;
      } else {
        // the tab is gone: the first one opens
      }
      if (state.hub !== undefined && (this.client.connections.has(state.hub) || this.client.offline.has(state.hub))) {
        this.chosenHub = state.hub;
      } else {
        // the hub is gone: the active tab's or the home hub
      }
      for (const draft of state.drafts) {
        if (this.client.connections.has(draft.hub)) {
          const tab = await this.newTab(draft.hub, draft.cwd).catch(() => undefined);
          if (tab !== undefined) {
            this.updateView(tab, { draft: draft.draft });
          } else {
            // the folder is gone
          }
        } else {
          // its hub is not here: the draft goes
        }
      }
      this.client.changed();
    }
  }

  /** The index of the active tab among all tabs (0 without tabs). */
  get active(): number {
    const key = this.activeKey;
    return Math.max(0, key !== undefined ? this.tabs().findIndex((tab) => sameTab(tab, key)) : 0);
  }

  /**
   * The hub the strip shows: chosen, else the active tab's, else the home hub when it is connected,
   * else the first hub reached.
   */
  hub(): string | undefined {
    const home = this.client.home;
    return this.chosenHub ?? this.activeTab()?.hub ?? (home !== undefined && this.client.connections.has(home) ? home : [...this.client.connections.keys()][0]);
  }

  /** The chosen hub's tabs, each with its index among all. */
  hubTabs(): Tab[] {
    const node = this.hub();
    return this.tabs().filter((tab) => tab.hub === node);
  }

  /** The hubs block: this client's own hub first, then the others it reaches; one glyph each. */
  hubs(): HubRow[] {
    const home = this.client.home;
    const names = [...new Set([...(home !== undefined ? [home] : []), ...this.client.connections.keys(), ...this.client.offline.keys()])];
    return names.map((name) => {
      const agents = [...this.client.agents.values()].filter((agent) => agent.hub === name);
      const glyph = this.client.offline.has(name) || !this.client.connections.has(name)
        ? "⊘"
        : agents.some((agent) => agent.summary.waiting > 0 || agent.summary.status === "waiting")
          ? "◆"
          : agents.some((agent) => agent.summary.status === "running")
            ? "●"
            : "";
      return { name, label: name === home && this.holdsHome() ? "inprocess" : name, glyph };
    });
  }

  /** Chooses a hub in the strip: its last active tab opens again, or choosing a folder for a new session there. */
  async chooseHub(hub: string): Promise<void> {
    if (!this.client.connections.has(hub)) {
      this.notify("warning", `hub ${hub} is offline`);
    } else {
      this.chosenHub = hub;
      const tabs = this.tabs();
      const last = this.lastActive.get(hub);
      const index = tabs.findIndex((tab) => tab.hub === hub && (last === undefined || tab.sessionId === last));
      const fallback = tabs.findIndex((tab) => tab.hub === hub);
      if (index >= 0 || fallback >= 0) {
        await this.goto(index >= 0 ? index : fallback);
      } else {
        this.openNewSession(hub);
      }
    }
  }

  /** `+ add` in the hubs block: another hub's address, then the one-time code made there (harness hub device add). */
  pairHub(): void {
    const addHub = this.addHub;
    if (addHub === undefined) {
      this.notify("warning", "this client adds hubs elsewhere (its pairing screen)");
    } else {
      this.openPicker({
        id: "add-hub",
        title: "Add a hub: its address (wss://…)",
        items: [],
        custom: "the hub's address",
        choose: (url) =>
          this.openPicker({
            id: "add-hub-code",
            title: `Pairing code for ${url} (harness hub device add on the hub)`,
            items: [],
            custom: "the one-time code",
            choose: (code) => addHub(url, code),
          }),
      });
    }
  }

  /** Choosing where a new session starts on a hub, in the chat zone (new-session.ts). */
  openNewSession(node: string): void {
    const choice = new NewSession(node, {
      list: (path, hidden) => this.client.connection(node).request("dirs_list", { path, hidden }),
      sessions: () => this.client.sessions(node),
      create: async (path) => {
        this.newSessionChoice = undefined;
        await this.newTab(node, path);
      },
      cancel: () => {
        this.newSessionChoice = undefined;
        this.client.changed();
      },
      changed: () => this.client.changed(),
      now: () => this.clock.now(),
      failed: (message) => this.notify("error", message),
    });
    this.chosenHub = node;
    this.newSessionChoice = choice;
    this.client.changed();
    void choice.start();
  }

  /* ----- the screen ----- */

  /** Everything a UI draws, for a screen `width` columns wide and the editor's current text. */
  /**
   * The mode the editor shows for `text`: the run's while the active session runs, else what the
   * text asks for (a leading `!` asks for BUILD). UIs call it as the text changes.
   */
  editorMode(text: string): RunMode {
    const tab = this.activeTab();
    const agent = tab?.agent !== undefined ? this.client.full.get(agentKey(tab.hub, tab.agent.id)) : undefined;
    return agent?.running === true ? agent.state.mode : modeOfText(text, agent?.state.variant ?? "advanced").mode;
  }

  screen(width: number, editor: { mode: RunMode }): Screen {
    const tab = this.activeTab();
    // a tab whose agent is not up yet shows what was read from its file
    const agent = tab?.agent !== undefined ? this.client.full.get(agentKey(tab.hub, tab.agent.id)) : tab !== undefined ? this.client.storedModel(tab.hub, tab.sessionFile) : undefined;
    if (tab?.agent !== undefined && agent === undefined && tab.unavailable === undefined) {
      // the active tab's agent became known (another client opened it, the hub reported it): follow it
      void this.client.follow(tab.hub, tab.agent.id).catch((error: unknown) => this.notify("error", error instanceof Error ? error.message : String(error)));
    } else {
      // followed already, or nothing to follow
    }
    const items = tab !== undefined ? this.items(tab, agent?.state) : [];
    const selected = tab !== undefined ? this.selectedItem(tab) : "session";
    const choice = this.newSessionChoice;
    const main: MainZone = choice !== undefined ? { kind: "newSession", choice } : this.mainZone(selected, agent, tab);
    this.followTask(main.kind === "task" ? main.taskId : undefined);
    const asking = tab?.agent !== undefined ? this.asking(tab.hub, tab.agent.id, agent) : undefined;
    const request = asking?.request;
    const inline = agent?.components.filter((component) => !component.overlay).at(-1);
    const componentOverlay = agent?.components.filter((component) => component.overlay).at(-1);
    const editorZone: EditorZone =
      this.picker !== undefined
        ? { kind: "picker", picker: this.picker }
        : choice !== undefined
          ? { kind: "hint", hints: NEW_SESSION_HINTS }
          : request !== undefined
          ? { kind: "interaction", request, ...(asking?.from !== undefined ? { from: asking.from } : {}) }
          : inline !== undefined
            ? { kind: "component", component: inline }
            : { kind: "editor", mode: agent?.running === true ? agent.state.mode : editor.mode };
    const queue = agent?.session?.queue;
    const nodeTabs = this.hubTabs();
    return {
      strips: { left: width >= LEFT_STRIP_MIN },
      hubs: this.hubs(),
      hub: this.hub(),
      tabs: nodeTabs,
      active: choice !== undefined ? -1 : nodeTabs.findIndex((candidate) => tab !== undefined && sameTab(candidate, tab)),
      newSession: choice?.hub,
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
        status: this.statusLines(this.tabs(), tab, agent),
        footer: { hub: tab?.hub ?? "", agent },
        overlays: this.overlays.filter((overlay) => (overlay === "tabs" ? width < LEFT_STRIP_MIN : true)),
        componentOverlay,
      },
      input:
        editorZone.kind === "picker"
          ? "picker"
          : editorZone.kind === "hint"
            ? "newSession"
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
      toolsExpanded: tab !== undefined ? this.view(tab).expanded : false,
      view: tab !== undefined ? this.view(tab) : undefined,
      prefill: this.prefillOf(agent),
      openUrl: agent?.openUrl !== undefined ? { key: `${agent.agentId}:${agent.openUrl.seq}`, url: agent.openUrl.url } : undefined,
      terminal: this.shownTerminal(tab),
    };
  }

  private terminalShown: TerminalModel | undefined;

  /** The active tab's terminal when it is shown; the one shown before (another tab's, a hidden one) stops coming here. */
  private shownTerminal(tab: Tab | undefined): TerminalModel | undefined {
    const shown = tab !== undefined && tab.unavailable === undefined && this.view(tab).terminal === true ? this.client.terminal(tab.hub, tab.sessionId, tab.cwd) : undefined;
    if (shown !== this.terminalShown) {
      this.terminalShown?.detach();
      this.terminalShown = shown;
    } else {
      // the same
    }
    return shown;
  }

  /** The latest text for the editor: the workbench's own, or a newer one of the agent. */
  private prefillOf(agent: AgentModel | undefined): Screen["prefill"] {
    if (agent !== undefined && agent.editorText !== undefined && agent.editorTextSeq !== this.agentPrefillSeen.get(agent)) {
      this.agentPrefillSeen.set(agent, agent.editorTextSeq);
      this.setEditorText(agent.editorText);
    } else {
      // nothing new from the agent
    }
    return this.prefill;
  }

  /**
   * A command of the client itself (`/new`, `/model`, `/bash …`): run here, in every UI the same;
   * false when the text is not one (it goes to the agent, whose own commands it may be). `quit` is
   * the UI's own.
   */
  async clientCommand(text: string, quit: () => void): Promise<boolean> {
    const [command = ""] = text.trim().split(/\s+/);
    const rest = text.trim().slice(command.length).trim();
    switch (command) {
      case "/new":
        await this.act("tabs.new");
        return true;
      case "/open":
      case "/resume":
        await this.act("tabs.open");
        return true;
      case "/quit":
      case "/exit":
        quit();
        return true;
      case "/model":
        await this.act("model.select");
        return true;
      case "/login":
        await this.loginPicker();
        return true;
      case "/logout":
        if (rest === "") {
          this.notify("warning", "/logout <provider>");
        } else {
          await this.logout(rest);
        }
        return true;
      case "/tree":
        await this.treePicker();
        return true;
      case "/settings":
        await this.settingsPicker();
        return true;
      case "/export":
        await this.exportSession(rest === "" ? undefined : rest);
        return true;
      case "/bash":
      case "/bash-quiet":
        // the operator's own command on the session's machine; "-quiet" keeps it out of the model's context
        if (rest === "") {
          this.notify("warning", `${command} <command>`);
        } else {
          await this.operatorBash(rest, command === "/bash-quiet");
        }
        return true;
      default:
        return false;
    }
  }

  /** The session as an HTML page (pi's export), written on its hub; the app downloads it. */
  private async exportSession(outputPath: string | undefined): Promise<void> {
    const tab = this.activeTab();
    if (tab?.agent === undefined) {
      this.notify("warning", "no session to export");
    } else {
      try {
        const { path } = await this.client.connection(tab.hub).call<{ path: string }>(tab.agent.id, { type: "export_html", ...(outputPath !== undefined ? { outputPath } : {}) });
        if (this.offerFile !== undefined) {
          this.offerFile(tab.hub, path);
        } else {
          this.notify("info", `exported to ${path}${tab.hub !== this.client.home ? ` on ${tab.hub}` : ""}`);
        }
      } catch (error) {
        this.notify("error", `export: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Completions of `/commands`: the client's own and the active session's (its extensions', skills', prompts'). */
  async commands(): Promise<{ name: string; description?: string }[]> {
    const tab = this.activeTab();
    const own = CLIENT_COMMANDS;
    if (tab?.agent === undefined) {
      return own;
    } else {
      const { commands } = await this.client.connection(tab.hub).call<{ commands: { name: string; description?: string }[] }>(tab.agent.id, { type: "get_commands" });
      return [...own, ...commands];
    }
  }

  /** Puts text into the editor of every UI drawing this workbench. */
  setEditorText(text: string): void {
    this.prefillCounter += 1;
    this.prefill = { key: String(this.prefillCounter), text };
    this.client.changed();
  }

  /**
   * Settings as a list in the editor's place: the theme (the user's UI settings, shared by their
   * clients) and the session's queue and compaction behavior (pi's, on the session's hub).
   */
  async settingsPicker(): Promise<void> {
    const tab = this.activeTab();
    const api = tab !== undefined ? this.client.connections.get(tab.hub) : undefined;
    const agentId = tab?.agent?.id;
    const state =
      api !== undefined && agentId !== undefined
        ? await api.call<{ steeringMode: string; followUpMode: string; autoCompactionEnabled: boolean }>(agentId, { type: "get_state" })
        : undefined;
    const theme = typeof this.client.settings["ui.theme"] === "string" ? String(this.client.settings["ui.theme"]) : "(pi's)";
    const toggle = (mode: string): string => (mode === "all" ? "one-at-a-time" : "all");
    const own = this.uiSettings();
    const items: PickerItem[] = [
      { value: "theme", label: `theme: ${theme}`, description: "every client of yours" },
      ...own.map((setting) => ({ value: `ui:${setting.value}`, label: setting.label, ...(setting.description !== undefined ? { description: setting.description } : {}) })),
      ...(state !== undefined
        ? [
            { value: "compaction", label: `auto-compaction: ${state.autoCompactionEnabled ? "on" : "off"}`, description: "this session" },
            { value: "steering", label: `steering messages: ${state.steeringMode}`, description: "delivered while the model works" },
            { value: "followUp", label: `follow-up messages: ${state.followUpMode}`, description: "delivered when the run ends" },
          ]
        : []),
    ];
    this.openPicker({
      id: "settings",
      title: "Settings",
      items,
      choose: async (value) => {
        if (value === "theme") {
          this.openPicker({
            id: "theme",
            title: "Theme",
            items: this.themes().map((name) => ({ value: name, label: name })),
            choose: (name) => this.client.setting("ui.theme", name),
          });
        } else if (value.startsWith("ui:")) {
          await own.find((setting) => `ui:${setting.value}` === value)?.choose();
        } else if (api === undefined || agentId === undefined || state === undefined) {
          this.notify("warning", "no session");
        } else if (value === "compaction") {
          await api.call(agentId, { type: "set_auto_compaction", enabled: !state.autoCompactionEnabled });
        } else if (value === "steering") {
          await api.call(agentId, { type: "set_steering_mode", mode: toggle(state.steeringMode) });
        } else {
          await api.call(agentId, { type: "set_follow_up_mode", mode: toggle(state.followUpMode) });
        }
      },
    });
  }

  /**
   * The session's tree (pi's /tree) as a list in the editor's place: choosing an entry moves the
   * session there; a user message comes back to the editor to edit and send again.
   */
  async treePicker(): Promise<void> {
    const tab = this.activeTab();
    if (tab?.agent === undefined) {
      this.notify("warning", "no session here");
    } else {
      const api = this.client.connection(tab.hub);
      const agentId = tab.agent.id;
      const { tree, leafId } = await api.call<{ tree: TreeNode[]; leafId: string | null }>(agentId, { type: "get_tree" });
      const rows: PickerItem[] = [];
      const walk = (nodes: TreeNode[], depth: number): void => {
        for (const node of nodes) {
          const line = treeLine(node);
          if (line !== undefined) {
            rows.push({ value: node.entry.id, label: `${"  ".repeat(Math.min(depth, 12))}${node.entry.id === leafId ? "● " : ""}${line}`, description: node.label });
          } else {
            // not a point one moves to
          }
          walk(node.children, node.children.length > 1 ? depth + 1 : depth);
        }
      };
      walk(tree, 0);
      this.openPicker({
        id: "tree",
        title: "Session tree",
        items: rows,
        choose: async (entryId) => {
          const result = await api.call<{ editorText?: string; cancelled: boolean }>(agentId, { type: "harness_navigate", entryId });
          if (result.editorText !== undefined) {
            this.setEditorText(result.editorText);
          } else {
            // moved to an answer: nothing to edit
          }
        },
      });
    }
  }

  private mainZone(selected: string, agent: AgentModel | undefined, tab: Tab | undefined): MainZone {
    if (selected === "session" || agent === undefined || tab === undefined) {
      return { kind: "transcript" };
    } else {
      const task = agent.state.tasks.find((candidate) => candidate.id === selected);
      const subagent = agent.state.subagents.find((candidate) => candidate.session === selected);
      const childId = subagent?.agentId ?? (selected.startsWith("agent:") ? selected.slice("agent:".length) : undefined);
      if (subagent !== undefined || childId !== undefined) {
        const child = childId !== undefined ? this.client.agents.get(agentKey(tab.hub, childId)) : undefined;
        if (child !== undefined && !this.client.full.has(agentKey(tab.hub, child.id))) {
          void this.client.follow(tab.hub, child.id).catch(() => undefined);
        } else {
          // followed already, or its agent is gone
        }
        const transcript =
          child !== undefined
            ? this.client.full.get(agentKey(tab.hub, child.id))
            : subagent?.engine === "claude" && tab.agent !== undefined
              ? this.client.claudeTranscript(tab.hub, tab.agent.id, subagent.session)
              : undefined;
        return { kind: "subagent", id: selected, subagent, agent: transcript };
      } else if (task?.toolUseId !== undefined && task.owner !== undefined && tab.agent !== undefined) {
        // a subagent of Claude's: its Task call in Claude's transcript
        const owner = agent.state.subagents.find((candidate) => candidate.session === task.owner);
        return { kind: "subagent", id: task.owner, subagent: owner, agent: this.client.claudeTranscript(tab.hub, tab.agent.id, task.owner), focus: task.toolUseId };
      } else {
        return { kind: "task", taskId: selected, task, output: this.taskOutputs.get(selected) ?? "" };
      }
    }
  }

  /** The agents of a session's subagents on its hub, subagents of subagents included. */
  private descendants(node: string, agentId: string): AgentInfo[] {
    const children = [...this.client.agents.values()].filter((candidate) => candidate.hub === node && candidate.parent === agentId);
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
    } else if (tab !== undefined && tab.agent === undefined && !tab.draft) {
      lines.push({ level: "info", text: "starting…" }); // shown from its file meanwhile
    } else {
      // available, its agent up
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
        const output = await this.client.connection(tab.hub).call<{ text: string }>(tab.agent.id, { type: "harness_task_output", taskId, offset: 0, limit: 256 * 1024 });
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

  /** Tab in a picker with scopes: the next scope's list. */
  nextPickerScope(): void {
    const picker = this.picker;
    if (picker?.scopes !== undefined && picker.scopes.length > 1) {
      const scope = ((picker.scope ?? 0) + 1) % picker.scopes.length;
      this.picker = { ...picker, scope, items: picker.scopes[scope]?.items ?? [] };
      this.client.changed();
    } else {
      // one list only
    }
  }

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

  /** A question in the editor's place: `yes` runs `act`, Cancel (or Esc) leaves things as they are. */
  confirm(title: string, yes: string, act: () => Promise<void> | void): void {
    this.openPicker({
      id: "confirm",
      title,
      items: [
        { value: "yes", label: yes },
        { value: "cancel", label: "Cancel" },
      ],
      choose: (value) => (value === "yes" ? act() : undefined),
    });
  }

  closePicker(): void {
    this.picker = undefined;
    this.client.changed();
  }

  closeOverlay(kind: OverlayKind): void {
    if (this.overlays.includes(kind)) {
      this.overlays = this.overlays.filter((overlay) => overlay !== kind);
      this.overlayClosed(kind);
      this.client.changed();
    } else {
      // not open
    }
  }

  /** The panel closes with a name being typed: it applies now. */
  private overlayClosed(kind: OverlayKind): void {
    if (kind === "panel") {
      void this.commitSessionName();
    } else {
      // nothing pending in the strips
    }
  }

  toggleOverlay(kind: OverlayKind): void {
    if (this.overlays.includes(kind)) {
      this.overlayClosed(kind);
    } else {
      // opening
    }
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

  /**
   * The harness panel: MODE (the active session's switches, kept for new sessions too), SESSION (its
   * name, its implementer) and HARNESS (the bundle, the hub). The same sections, rows and order in
   * every UI. Without a session only HARNESS.
   */
  panel(): PanelSection[] {
    const tab = this.activeTab();
    const model = tab?.agent !== undefined ? this.client.full.get(agentKey(tab.hub, tab.agent.id)) : undefined;
    const state = model?.state;
    const name = this.nameDraft?.text ?? model?.session?.sessionName ?? "";
    const mode: PanelSection[] =
      state !== undefined
        ? [
            {
              title: "mode",
              items: [
                { kind: "toggle", id: "madness", label: "madness", tone: "error", on: state.madness },
                { kind: "toggle", id: "simple", label: "simple", tone: "success", on: state.variant === "simple" },
              ],
            },
            {
              title: "session",
              items: [
                { kind: "text", id: "name", label: "name", value: name, placeholder: tab?.title ?? "" },
                { kind: "value", id: "implementer", label: "implementer", value: state.implementer },
              ],
            },
          ]
        : [];
    const harness: PanelSection = {
      title: "harness",
      items: [
        ...(this.update !== undefined ? [{ kind: "action" as const, id: "update" as const, label: "update", hint: this.update.hint() }] : []),
        // the report and the profiles are the session's agent's
        ...(state !== undefined
          ? [
              { kind: "action" as const, id: "dependencies" as const, label: "dependencies", hint: "versions" },
              { kind: "action" as const, id: "subagents" as const, label: "subagents", hint: "profiles" },
            ]
          : []),
        { kind: "action", id: "logs", label: "logs", hint: "hub events" },
        { kind: "action", id: "restart", label: "restart hub", hint: this.panelHub() ?? "" },
      ],
    };
    return [...mode, harness];
  }

  /** The hub the HARNESS rows act on: the active session's, else the home one. */
  private panelHub(): string | undefined {
    return this.activeTab()?.hub ?? this.client.home;
  }

  /** The session name being typed in the panel, and where it goes. */
  private nameDraft: { node: string; agent: string; text: string; timer: unknown } | undefined;

  /** The panel's name field changed: the session gets the name NAME_APPLY_MS after the last change. */
  editSessionName(text: string): void {
    const tab = this.activeTab();
    if (tab?.agent === undefined) {
      return;
    } else {
      if (this.nameDraft !== undefined) {
        this.clock.clearTimeout(this.nameDraft.timer);
      } else {
        // the first change of this edit
      }
      const draft = { node: tab.hub, agent: tab.agent.id, text, timer: undefined as unknown };
      draft.timer = this.clock.setTimeout(() => void this.applySessionName(draft), NAME_APPLY_MS);
      this.nameDraft = draft;
      this.client.changed();
    }
  }

  /** The name field is left (another row, the panel closed): the typed name applies now. */
  async commitSessionName(): Promise<void> {
    const draft = this.nameDraft;
    if (draft !== undefined) {
      this.clock.clearTimeout(draft.timer);
      this.nameDraft = undefined;
      await this.applySessionName(draft);
      this.client.changed();
    } else {
      // nothing typed
    }
  }

  private async applySessionName(draft: { node: string; agent: string; text: string }): Promise<void> {
    const name = draft.text.trim();
    if (name === "") {
      // pi keeps a name: an emptied field leaves it as it was
    } else {
      await this.client
        .connection(draft.node)
        .call(draft.agent, { type: "set_session_name", name })
        .catch((error: unknown) => this.notify("error", `session name: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  /**
   * Applies a panel row. True when the panel stays open (a toggle or a value: the change shows in
   * it), false when it closes first (an action: what it shows is not under the panel).
   */
  async applyPanel(id: PanelId): Promise<boolean> {
    const item = this.panel()
      .flatMap((section) => section.items)
      .find((candidate) => candidate.id === id);
    if (item === undefined) {
      this.notify("warning", `${id}: not here now`);
      return true;
    } else if (item.kind === "action") {
      await this.commitSessionName();
      this.closeOverlay("panel");
      await this.choosePanel(id);
      return false;
    } else if (item.kind === "text") {
      return true; // a field takes typing, not applying
    } else {
      await this.choosePanel(id);
      return true;
    }
  }

  /** A read-only list in the editor's place (a report, the profiles). */
  private showList(id: string, title: string, lines: { label: string; description?: string }[]): void {
    this.openPicker({ id, title, items: lines.map((line, index) => ({ value: String(index), ...line })), choose: () => undefined });
  }

  async choosePanel(value: PanelId): Promise<void> {
    const tab = this.activeTab();
    const agent = tab?.agent !== undefined ? this.client.full.get(agentKey(tab.hub, tab.agent.id)) : undefined;
    if (value === "update") {
      if (this.update?.canRun() === true) {
        await this.update.run();
      } else {
        this.notify("info", `update: ${this.update?.hint() ?? "not available here"}`);
      }
    } else if (value === "restart") {
      const hub = this.panelHub();
      if (hub === undefined) {
        this.notify("warning", "no hub");
      } else {
        const agents = [...this.client.agents.values()].filter((agent) => agent.hub === hub).length;
        this.confirm(`Restart hub ${hub}? Stops ${agents} agents and their background tasks`, "Restart", async () => {
          await this.client.connection(hub).request("hub_restart", {});
        });
      }
    } else if (value === "logs") {
      try {
        const { lines } = await this.client.homeRequest("logs_tail", { lines: 300 });
        this.showList("logs", `Log of ${this.client.home ?? "the hub"}`, [...lines].reverse().map((line) => ({ label: logLine(line) })));
      } catch (error) {
        this.notify("error", error instanceof Error ? error.message : String(error));
      }
    } else if (tab?.agent === undefined || agent === undefined) {
      this.notify("warning", "no session");
    } else if (value === "dependencies") {
      const { text } = await this.client.connection(tab.hub).call<{ text: string }>(tab.agent.id, { type: "harness_report" });
      this.showList("dependencies", `Dependencies (hub ${tab.hub})`, [...text.split("\n"), ...(this.update?.lines() ?? [])].map((label) => ({ label })));
    } else if (value === "subagents") {
      const { profiles, problems } = await this.client.connection(tab.hub).call<{ profiles: SubagentProfileView[]; problems: string[] }>(tab.agent.id, { type: "harness_subagents" });
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
      switch (value) {
        case "madness":
          await this.client.connection(tab.hub).call(tab.agent.id, { type: "harness_set", madness: !state.madness });
          break;
        case "simple":
          await this.client.connection(tab.hub).call(tab.agent.id, { type: "harness_set", variant });
          break;
        case "implementer": {
          // in turn: self, then the profiles this session may call
          const { profiles } = await this.client.connection(tab.hub).call<{ profiles: SubagentProfileView[] }>(tab.agent.id, { type: "harness_subagents" });
          const choices = ["self", ...profiles.map((profile) => profile.name)];
          const next = choices[(choices.indexOf(state.implementer) + 1) % choices.length] ?? "self";
          await this.client.connection(tab.hub).call(tab.agent.id, { type: "harness_set", implementer: next });
          break;
        }
        case "name":
          break; // a field: typing applies it (editSessionName)
        default:
          throw new Error(`panel row ${value} has no change`);
      }
    }
  }

  /* ----- actions (keymap.ts): every UI acts through these ----- */

  async act(action: ActionId): Promise<void> {
    const tab = this.activeTab();
    const api = tab !== undefined ? this.client.connections.get(tab.hub) : undefined;
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
        // Alt+N: the Nth session of the chosen hub
        const target = this.hubTabs()[Number(action.slice("tabs.goto.".length)) - 1];
        if (target !== undefined) {
          await this.goto(target.index);
        } else {
          // no such tab
        }
      } else {
        const named = action as Exclude<ActionId, `tabs.goto.${number}`>;
        switch (named) {
          case "tabs.next":
          case "tabs.prev": {
            const tabs = this.hubTabs();
            const at = tabs.findIndex((candidate) => tab !== undefined && sameTab(candidate, tab));
            const target = tabs[tabs.length === 0 ? 0 : (Math.max(0, at) + (action === "tabs.next" ? 1 : tabs.length - 1)) % tabs.length];
            if (target !== undefined) {
              await this.goto(target.index);
            } else {
              // no tabs on this hub
            }
            break;
          }
          case "tabs.new": {
            const hub = this.hub();
            if (hub === undefined || !this.client.connections.has(hub)) {
              this.notify("warning", "no hub to start a session on: none of yours is online");
            } else {
              this.openNewSession(hub);
            }
            break;
          }
          case "tabs.close":
            await this.closeTab(this.active);
            break;
          case "tabs.open":
            await this.openSessionPicker();
            break;
          case "items.next":
          case "items.prev":
            if (tab !== undefined) {
              const items = this.items(tab, this.client.full.get(agentKey(tab.hub, agentId ?? ""))?.state);
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
          case "terminal.toggle":
            if (tab !== undefined) {
              this.updateView(tab, { terminal: this.view(tab).terminal !== true });
              this.client.changed();
            } else {
              // no session: no directory for a terminal
            }
            break;
          case "strip.tabs":
            this.toggleOverlay("tabs");
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
            if (tab !== undefined) {
              this.updateView(tab, { expanded: !this.view(tab).expanded });
            } else {
              // no session
            }
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

  /** A tab shows at once (from what was loaded ahead); its agent starts meanwhile, and its transcript carries on. */
  private async goto(index: number): Promise<void> {
    const tab = this.tabs()[index];
    await this.activate(index);
    await this.ensureAgent(tab);
    this.client.changed();
  }

  /**
   * Logs in to a provider on the active session's hub (where its agents read auth.json): a list of
   * providers, then the login's steps as interactions in the editor's place.
   */
  async loginPicker(initial?: string): Promise<void> {
    const tab = this.activeTab();
    if (tab?.agent === undefined) {
      this.notify("warning", "no session: logins are stored on a session's hub");
    } else {
      const node = tab.hub;
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
        ...(initial !== undefined ? { initial } : {}),
        choose: (value) => {
          const [provider, authType] = value.split("\u0000") as [string, "oauth" | "api_key"];
          // the login runs on the hub; its steps arrive as `login` interactions
          void api
            .call<{ back?: true }>(agentId, { type: "harness_login", provider, authType })
            .then((result) => (result.back === true ? this.loginPicker(value) : this.notify("info", `logged in to ${provider} on ${node}`)))
            .catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              this.notify(message === "Login cancelled" ? "info" : "error", `login to ${provider}: ${message}`);
            });
        },
      });
    }
  }

  /** Stops a background task of the active session (an own one, or a Claude Code session's). */
  async stopTask(taskId: string): Promise<void> {
    const tab = this.activeTab();
    if (tab?.agent === undefined) {
      this.notify("warning", "no session here");
    } else {
      try {
        await this.client.connection(tab.hub).call(tab.agent.id, { type: "harness_task_stop", taskId });
      } catch (error) {
        this.notify("error", error instanceof Error ? error.message : String(error));
      }
    }
  }

  /** The operator's own command in the session (pi's user bash): its run shows in the transcript. */
  async operatorBash(command: string, excludeFromContext: boolean): Promise<void> {
    const tab = this.activeTab();
    if (tab?.agent === undefined) {
      this.notify("warning", "no session here: Ctrl+T starts one, Ctrl+O opens one");
    } else {
      try {
        await this.client.connection(tab.hub).call(tab.agent.id, { type: "bash", command, excludeFromContext });
      } catch (error) {
        this.notify("error", error instanceof Error ? error.message : String(error));
      }
    }
  }

  async logout(provider: string): Promise<void> {
    const tab = this.activeTab();
    if (tab?.agent === undefined) {
      this.notify("warning", "no session: logins are stored on a session's hub");
    } else {
      await this.client.connection(tab.hub).call(tab.agent.id, { type: "harness_logout", provider });
      this.notify("info", `logged out of ${provider} on ${tab.hub}`);
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
      const api = this.client.connection(tab.hub);
      const agentId = tab.agent.id;
      type Listed = { provider: string; id: string; name?: string };
      const { models, favorites } = await api.call<{ models: Listed[]; favorites?: { provider: string; id: string }[] }>(agentId, { type: "get_available_models" });
      const item = (model: Listed): PickerItem => ({ value: `${model.provider}/${model.id}`, label: `${model.provider}/${model.id}`, ...(model.name !== undefined ? { description: model.name } : {}) });
      // references first: they follow the newest model of their family (plan 6.2)
      const refs = familyRefs(models).map(({ ref, model }) => ({ value: `ref:${ref}`, label: `${ref} → ${model.id}`, description: "the newest of the family, now and later" }));
      const all = [...refs, ...models.map(item)];
      // the favorites (pi's enabledModels) first, when there are any
      const favorite = (favorites ?? []).map((wanted) => models.find((model) => model.provider === wanted.provider && model.id === wanted.id) ?? wanted).map(item);
      const scopes = favorite.length > 0 ? [{ title: "Favorites", items: favorite }, { title: "All", items: all }] : [{ title: "All", items: all }];
      this.openPicker({
        id: "model",
        title: "Model",
        items: scopes[0]?.items ?? [],
        scopes,
        scope: 0,
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

  async componentResize(componentId: string, width: number, rows?: number): Promise<void> {
    await this.componentCall({ type: "harness_component_resize", componentId, width, ...(rows !== undefined ? { rows } : {}) });
  }

  /** The pointer at a cell of a bridged component. */
  async componentMouse(componentId: string, event: ComponentMouse): Promise<void> {
    await this.componentCall({ type: "harness_component_mouse", componentId, event });
  }

  private async componentCall(record: { type: string; [key: string]: unknown }): Promise<void> {
    const tab = this.activeTab();
    if (tab?.agent !== undefined) {
      await this.client
        .connection(tab.hub)
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
      const owner = [tab.agent, ...this.descendants(tab.hub, tab.agent.id)].find((candidate) =>
        this.client.full.get(agentKey(tab.hub, candidate.id))?.interactions.some((request) => request.id === interactionId),
      );
      try {
        await this.client.connection(tab.hub).call((owner ?? tab.agent).id, { type: "harness_interaction_response", interactionId, answer: value });
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
      const agent = this.client.full.get(agentKey(tab.hub, tab.agent.id));
      const subagent = agent?.state.subagents.find((candidate) => candidate.session === selected);
      const task = agent?.state.tasks.find((candidate) => candidate.id === selected);
      const nested = selected.startsWith("agent:") ? this.client.agents.get(agentKey(tab.hub, selected.slice("agent:".length))) : undefined;
      const api = this.client.connection(tab.hub);
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
          if (tab.draft) {
            await this.keepDraft(tab);
          } else {
            // a kept session already
          }
        }
      } catch (error) {
        this.notify("error", error instanceof Error ? error.message : String(error));
      }
    }
  }

  tabs(): Tab[] {
    const shared = tabRecords(this.client.settings);
    const drafts = this.drafts.filter((draft) => !shared.some((record) => sameTab(record, draft)));
    return [...shared, ...drafts].map((record, index) => {
      const agent = [...this.client.agents.values()].find((candidate) => candidate.hub === record.hub && candidate.sessionId === record.sessionId);
      const unavailable = this.client.offline.has(record.hub) ? `hub ${record.hub} is offline` : this.client.connections.has(record.hub) ? undefined : `hub ${record.hub} is not connected`;
      // a subagent that waits for the operator makes its session wait too
      const childWaits = agent !== undefined && unavailable === undefined && this.descendants(record.hub, agent.id).some((child) => child.summary.waiting > 0);
      return {
        ...record,
        agent,
        glyph: childWaits ? "◆" : glyphOf(agent?.summary, record.seen, unavailable),
        title: agent?.summary.title !== undefined && agent.summary.title !== "" ? agent.summary.title : agent?.name ?? record.cwd.split("/").pop() ?? record.sessionId.slice(0, 8),
        mode: agent?.summary.mode ?? "plan",
        unavailable,
        index,
        draft: index >= shared.length,
      };
    });
  }

  activeTab(): Tab | undefined {
    const tabs = this.tabs();
    const key = this.activeKey;
    return (key !== undefined ? tabs.find((tab) => sameTab(tab, key)) : undefined) ?? tabs.find((tab) => tab.hub === this.chosenHub) ?? tabs[0];
  }

  /** The items of a session: itself first, then its tasks and subagents on one level (subagents' own children indented). */
  items(tab: Tab, state: HarnessState | undefined): Item[] {
    // the strip's sessions block above names it already: the row is just `session`, in its mode's color
    const session: Item = { kind: "session", id: "session", label: "session", detail: tab.mode.toUpperCase(), glyph: tab.glyph === "⊘" ? "⊘" : tab.glyph, depth: 0 };
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
      const child = subagent.agentId !== undefined ? this.client.agents.get(agentKey(tab.hub, subagent.agentId)) : undefined;
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
          ? this.descendants(tab.hub, child.id).map((grandchild) => ({
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
    return this.view(tab).selected;
  }

  select(tab: Tab, itemId: string): void {
    // a subagent of Claude's opens its Task call expanded
    const agent = tab.agent !== undefined ? this.client.full.get(agentKey(tab.hub, tab.agent.id)) : undefined;
    const claudeAgent = agent?.state.tasks.some((task) => task.id === itemId && task.toolUseId !== undefined) === true;
    this.updateView(tab, claudeAgent ? { selected: itemId, expanded: true } : { selected: itemId });
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
      this.activeKey = undefined;
    } else {
      const tab = tabs[Math.max(0, Math.min(index, tabs.length - 1))];
      if (tab !== undefined) {
        this.activeKey = { hub: tab.hub, sessionId: tab.sessionId };
        this.usedAt.set(`${tab.hub}/${tab.sessionId}`, this.clock.now());
        this.chosenHub = tab.hub;
        this.lastActive.set(tab.hub, tab.sessionId);
        this.newSessionChoice = undefined;
      } else {
        // tabs is not empty
      }
      if (tab?.agent !== undefined) {
        await this.client.follow(tab.hub, tab.agent.id);
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
      await this.updateTabs((records) => records.map((record) => (sameTab(record, tab) ? { ...record, seen: Math.max(record.seen ?? 0, activity) } : record)));
    } else {
      // nothing new
    }
  }

  /** Changes the tab set from its current value: another client's change at the same time is kept (ifRevision). */
  async updateTabs(change: (records: TabRecord[]) => TabRecord[]): Promise<void> {
    await this.client.updateSetting<unknown>("ui.tabs", (current) => change(tabRecords({ "ui.tabs": current })));
  }

  /** The index of a tab in the current set. */
  private tabIndex(tab: TabKey): number {
    return tabRecords(this.client.settings).findIndex((record) => sameTab(record, tab));
  }

  /** Starts an agent for a new session on the hub and opens it as the last tab. */
  /**
   * A new session on the hub, in `cwd`: an agent and a tab of this window alone (a draft), which
   * joins the shared tab set with its first message; closed before that, nothing of it remains.
   */
  async newTab(hub: string, cwd: string): Promise<Tab | undefined> {
    const { agent } = await this.client.connection(hub).request("agent_start", { cwd });
    this.client.agents.set(agentKey(hub, agent.id), agent);
    const record: TabRecord = { hub, sessionId: agent.sessionId, sessionFile: agent.sessionFile, cwd: agent.cwd };
    this.drafts = [...this.drafts, record];
    await this.activate(this.tabs().findIndex((tab) => sameTab(tab, record)));
    return this.activeTab();
  }

  /** A draft's first message is sent: it joins the shared tab set (every client of the user sees it). */
  private async keepDraft(tab: Tab): Promise<void> {
    const record: TabRecord = { hub: tab.hub, sessionId: tab.sessionId, sessionFile: tab.agent?.sessionFile ?? tab.sessionFile, cwd: tab.cwd };
    await this.updateTabs((records) => (records.some((candidate) => sameTab(candidate, record)) ? records : [...records, record]));
    this.drafts = this.drafts.filter((draft) => !sameTab(draft, record));
  }

  /** Opens a stored session: an agent for it (the hub's, if one runs already), then a tab. */
  async openSession(hub: string, session: { id: string; path: string; cwd: string }): Promise<void> {
    const records = tabRecords(this.client.settings);
    const index = records.findIndex((record) => record.hub === hub && record.sessionId === session.id);
    if (index !== -1) {
      await this.ensureAgent(this.tabs()[index]);
      await this.activate(index);
    } else {
      const { agent } = await this.client.connection(hub).request("agent_start", { cwd: session.cwd, sessionFile: session.path });
      this.client.agents.set(agentKey(hub, agent.id), agent);
      const record: TabRecord = { hub, sessionId: agent.sessionId, sessionFile: agent.sessionFile, cwd: agent.cwd };
      await this.updateTabs((current) => (current.some((candidate) => sameTab(candidate, record)) ? current : [...current, record]));
      await this.activate(this.tabIndex(record));
    }
  }

  /** A tab whose agent is not running gets one, on its session file. */
  async ensureAgent(tab: Tab | undefined): Promise<void> {
    if (tab === undefined || tab.agent !== undefined || tab.unavailable !== undefined) {
      return;
    } else {
      const { agent } = await this.client.connection(tab.hub).request("agent_start", { cwd: tab.cwd, sessionFile: tab.sessionFile });
      this.client.agents.set(agentKey(tab.hub, agent.id), agent);
    }
  }

  /** Closes a tab (the agent keeps running on its hub). */
  /** Closes a tab: its agent keeps running on its hub; a draft's agent stops (nothing of it remains). */
  async closeTab(index: number): Promise<void> {
    const closed = this.tabs()[index];
    if (closed === undefined) {
      return; // no such tab
    } else if (closed.draft) {
      this.drafts = this.drafts.filter((draft) => !sameTab(draft, closed));
      if (closed.agent !== undefined) {
        await this.client
          .connection(closed.hub)
          .request("agent_close", { agent: closed.agent.id })
          .catch(() => undefined);
      } else {
        // no agent to stop
      }
    } else {
      await this.updateTabs((records) => records.filter((record) => !sameTab(record, closed)));
    }
    const left = this.tabs().filter((tab) => tab.hub === closed.hub);
    const next = left[Math.min(left.length - 1, this.nodeTabIndexBefore(closed, left))];
    if (next !== undefined) {
      await this.activate(next.index);
    } else {
      this.activeKey = undefined;
      this.client.changed();
    }
  }

  /** Where a closed tab was among its hub's remaining tabs. */
  private nodeTabIndexBefore(closed: Tab, left: Tab[]): number {
    const before = this.tabs().filter((tab) => tab.hub === closed.hub && tab.index < closed.index).length;
    return Math.max(0, Math.min(before, left.length - 1));
  }

  async moveTab(from: number, to: number): Promise<void> {
    const moved = tabRecords(this.client.settings)[from];
    if (moved !== undefined) {
      await this.updateTabs((records) => {
        const rest = records.filter((record) => !sameTab(record, moved));
        return [...rest.slice(0, to), moved, ...rest.slice(to)];
      });
      this.client.changed();
    } else {
      // no such tab
    }
  }
}
