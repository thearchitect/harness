// The state of a window: per tab what the operator left there (the message being written, where
// the transcript was scrolled, expanded tool output, the item shown), the active tab, the node
// chosen in the strip, and the drafts of sessions without a message yet. It belongs to the device:
// each UI keeps it in its own store (the TUI a file under a lock, the web localStorage, the phones a
// file) and nothing of it goes to the node; the tab set itself is the user's (ui.tabs).

/** Where a tab's transcript is: following its end, or a transcript entry's line at the top. */
export type ScrollAnchor = "follow" | { key: string; offset: number };

export type TabView = {
  /** The message being written. */
  draft: string;
  scroll: ScrollAnchor;
  /** Tool output expanded (Ctrl+E). */
  expanded: boolean;
  /** The item the main area shows: the session itself, a task, a subagent. */
  selected: string;
  /** The session's terminal shown over the main area (Ctrl+I). */
  terminal?: boolean;
};

export type WindowState = {
  version: 1;
  /** By `node/sessionId`. */
  tabs: Record<string, TabView>;
  active?: { node: string; sessionId: string };
  node?: string;
  /** Sessions without a message yet, with what was being written: a new session in the folder takes it after a restart. */
  drafts: { node: string; cwd: string; draft: string }[];
};

/** Where a UI keeps its window's state. */
export type ViewStateStore = {
  load(): Promise<WindowState | undefined>;
  save(state: WindowState): Promise<void>;
};

export const DEFAULT_VIEW: TabView = { draft: "", scroll: "follow", expanded: false, selected: "session" };

/** The state as read: a stored value of another shape counts as none. */
export function windowState(value: unknown): WindowState | undefined {
  const state = value as Partial<WindowState> | null | undefined;
  if (typeof state !== "object" || state === null || state.version !== 1 || typeof state.tabs !== "object" || state.tabs === null || !Array.isArray(state.drafts)) {
    return undefined;
  } else {
    return state as WindowState;
  }
}

/**
 * Two windows' states in one store: the tabs merged by key (each window's own views win), the
 * active tab, the node and the drafts of the window that saved last.
 */
export function mergeWindowStates(stored: WindowState | undefined, mine: WindowState): WindowState {
  return { ...mine, tabs: { ...(stored?.tabs ?? {}), ...mine.tabs } };
}
