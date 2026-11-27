// The state of a window: per tab what depends on its screen (where the transcript was scrolled,
// expanded tool output, the item shown, the terminal shown), the active tab and the hub chosen in
// the strip. It belongs to the client: each UI keeps it in its own store (the TUI a file under a
// lock, the web localStorage, the phones a file). The tabs and their drafts are the hub's
// (its workspace).

/** Where a tab's transcript is: following its end, or a transcript entry's line at the top. */
export type ScrollAnchor = "follow" | { key: string; offset: number };

export type TabView = {
  scroll: ScrollAnchor;
  /** Tool output expanded (Ctrl+E). */
  expanded: boolean;
  /** The item the main area shows: the session itself, a task, a subagent. */
  selected: string;
  /** The session's terminal shown over the main area (Ctrl+I). */
  terminal?: boolean;
};

export type WindowState = {
  version: 2;
  /** By `hub/sessionId`. */
  tabs: Record<string, TabView>;
  active?: { hub: string; sessionId: string };
  hub?: string;
};

/** Where a UI keeps its window's state. */
export type ViewStateStore = {
  load(): Promise<WindowState | undefined>;
  save(state: WindowState): Promise<void>;
};

export const DEFAULT_VIEW: TabView = { scroll: "follow", expanded: false, selected: "session" };

/** The state as read: a stored value of another shape counts as none. */
export function windowState(value: unknown): WindowState | undefined {
  const state = value as Partial<WindowState> | null | undefined;
  if (typeof state !== "object" || state === null || state.version !== 2 || typeof state.tabs !== "object" || state.tabs === null) {
    return undefined;
  } else {
    return state as WindowState;
  }
}

/**
 * Two windows' states in one store: the tabs merged by key (each window's own views win), the
 * active tab and the hub of the window that saved last.
 */
export function mergeWindowStates(stored: WindowState | undefined, mine: WindowState): WindowState {
  return { ...mine, tabs: { ...(stored?.tabs ?? {}), ...mine.tabs } };
}
