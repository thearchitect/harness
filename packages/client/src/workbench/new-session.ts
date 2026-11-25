// Choosing where a new session starts, in the chat zone: the folders of recent sessions (newest
// first) under `folder ⇒`, which browses the node's directories. No field and no focus: typing
// filters (pi-tui's fuzzy matching), ↑/↓ choose, → opens a folder (its directories replace the list),
// ← goes up, `/` opens the best match, Enter starts the session in the chosen folder, Esc cancels.
// Listings come from the node (dirs_list) and are fetched ahead for the chosen row and the parent,
// so → and ← answer at once, also for nodes behind a hub. The same model in every UI.

import type { DirItem, NodeOps, SessionListItem } from "#protocol/node.ts";
import { fuzzyFilter } from "../fuzzy.ts";

export type NewSessionRow =
  /** `folder ⇒`: browse from the node user's home. */
  | { kind: "browse" }
  /** `· this folder`: start in the folder being browsed. */
  | { kind: "here"; path: string }
  | { kind: "dir"; path: string; label: string; age?: string; hasChildren: boolean };

export type NewSessionKey =
  | { char: string }
  | "backspace"
  | "up"
  | "down"
  | "pageUp"
  | "pageDown"
  | "home"
  | "end"
  | "right"
  | "left"
  | "enter"
  | "escape";

type Listing = NodeOps["dirs_list"]["result"];

export type NewSessionDeps = {
  list(path: string, hidden: boolean): Promise<Listing>;
  sessions(): Promise<SessionListItem[]>;
  create(path: string): Promise<void>;
  cancel(): void;
  changed(): void;
  now(): number;
  failed(message: string): void;
};

/** Rows a page key moves. */
const PAGE = 10;

/** "2h", "1d", "3w": how long ago a session started. */
export function age(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) {
    return `${minutes}m`;
  } else if (minutes < 60 * 24) {
    return `${Math.floor(minutes / 60)}h`;
  } else if (minutes < 60 * 24 * 14) {
    return `${Math.floor(minutes / (60 * 24))}d`;
  } else {
    return `${Math.floor(minutes / (60 * 24 * 7))}w`;
  }
}

export class NewSession {
  readonly node: string;
  mode: "recent" | "browse" = "recent";
  /** The folder being browsed. */
  path: string | undefined;
  filter = "";
  selected = 0;
  /** The node user's home (from the node's first listing). */
  home: string | undefined;
  private recent: { path: string; created: number }[] = [];
  private readonly listings = new Map<string, Listing>();
  private readonly deps: NewSessionDeps;

  constructor(node: string, deps: NewSessionDeps) {
    this.node = node;
    this.deps = deps;
  }

  /** Loads the recent folders and the home; fetches the recent folders' listings for their `›`. */
  async start(): Promise<void> {
    // the home names the folders under it `~/…`; the recent folders do not wait for it
    void this.listing("~", false).then((home) => {
      this.home = home?.home ?? home?.path;
      this.deps.changed();
    });
    const sessions = await this.deps.sessions().catch(() => []);
    const seen = new Set<string>();
    this.recent = [...sessions]
      .sort((a, b) => b.created - a.created)
      .filter((session) => session.cwd !== "" && !seen.has(session.cwd) && (seen.add(session.cwd), true))
      .map((session) => ({ path: session.cwd, created: session.created }))
      .slice(0, 50);
    if (this.mode === "recent" && this.filter !== "") {
      // typed before the list came: the best match is chosen
      this.selected = this.rows().length > 1 ? 1 : 0;
    } else {
      // the selection stands
    }
    this.deps.changed();
    await Promise.all(this.recent.map((entry) => this.listing(entry.path, false)));
    this.deps.changed();
  }

  /** The listing of a folder: cached for this choice, fetched once. */
  private async listing(path: string, hidden: boolean): Promise<Listing | undefined> {
    const key = `${hidden ? "h" : "v"}${path}`;
    const known = this.listings.get(key);
    if (known !== undefined) {
      return known;
    } else {
      try {
        const listing = await this.deps.list(path, hidden);
        this.listings.set(key, listing);
        this.listings.set(`${hidden ? "h" : "v"}${listing.path}`, listing);
        return listing;
      } catch (error) {
        this.deps.failed(error instanceof Error ? error.message : String(error));
        return undefined;
      }
    }
  }

  private known(path: string): Listing | undefined {
    return this.listings.get(`${this.filter.startsWith(".") ? "h" : "v"}${path}`) ?? this.listings.get(`v${path}`);
  }

  /** A path as the list shows it: under the home as `~/…`. */
  label(path: string): string {
    const home = this.home;
    return home !== undefined && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
  }

  title(): string {
    return this.mode === "recent" || this.path === undefined ? `New session on ${this.node}` : `New session on ${this.node} · ${this.label(this.path)}`;
  }

  rows(): NewSessionRow[] {
    if (this.mode === "recent") {
      const dirs = this.recent.map((entry): NewSessionRow & { kind: "dir" } => ({
        kind: "dir",
        path: entry.path,
        label: this.label(entry.path),
        age: age(this.deps.now() - entry.created),
        hasChildren: (this.known(entry.path)?.dirs.length ?? 0) > 0,
      }));
      return [{ kind: "browse" }, ...fuzzyFilter(dirs, this.filter, (row) => row.label)];
    } else {
      const path = this.path ?? "/";
      const listing = this.known(path);
      const hidden = this.filter.startsWith(".");
      const dirs = (listing?.dirs ?? [])
        .filter((dir) => hidden || !dir.name.startsWith("."))
        .map((dir: DirItem): NewSessionRow & { kind: "dir" } => ({ kind: "dir", path: dir.path, label: dir.name, hasChildren: dir.hasChildren }));
      return [{ kind: "here", path }, ...fuzzyFilter(dirs, this.filter, (row) => row.label)];
    }
  }

  /** Whether the browsed folder's listing is still on its way. */
  loading(): boolean {
    return this.mode === "browse" && this.path !== undefined && this.known(this.path) === undefined;
  }

  private select(index: number): void {
    const count = this.rows().length;
    this.selected = Math.max(0, Math.min(count - 1, index));
    void this.prefetch();
    this.deps.changed();
  }

  /** The chosen row's folder and the parent: → and ← answer without waiting. */
  private async prefetch(): Promise<void> {
    const row = this.rows()[this.selected];
    const hidden = this.filter.startsWith(".");
    await Promise.all([
      row?.kind === "dir" ? this.listing(row.path, hidden) : Promise.resolve(undefined),
      this.mode === "browse" && this.path !== undefined && this.path !== "/" ? this.listing(this.path.replace(/\/[^/]*$/, "") || "/", hidden) : Promise.resolve(undefined),
    ]);
    this.deps.changed();
  }

  /** Browses a folder: its directories replace the list, the filter clears. */
  async browse(path: string): Promise<void> {
    this.mode = "browse";
    this.filter = "";
    this.selected = 0;
    const listing = await this.listing(path, false);
    this.path = listing?.path ?? path;
    this.select(this.rows().length > 1 ? 1 : 0);
  }

  async up(): Promise<void> {
    if (this.mode === "recent" || this.path === undefined || this.path === "/") {
      return; // nothing above
    } else {
      const from = this.path;
      await this.browse(from.replace(/\/[^/]*$/, "") || "/");
      const back = this.rows().findIndex((row) => row.kind === "dir" && row.path === from);
      this.select(back >= 0 ? back : 0);
    }
  }

  /** → on a row: `folder ⇒` browses the home, a folder opens. */
  async open(index: number): Promise<void> {
    const row = this.rows()[index];
    if (row === undefined || row.kind === "here") {
      return; // the folder itself is open already
    } else if (row.kind === "browse") {
      await this.browse(this.home ?? "~");
    } else {
      await this.browse(row.path);
    }
  }

  /** Enter on a row: start the session there (`folder ⇒` browses instead). */
  async choose(index: number): Promise<void> {
    const row = this.rows()[index];
    if (row === undefined) {
      return; // nothing to choose
    } else if (row.kind === "browse") {
      await this.open(index);
    } else {
      await this.deps.create(row.path);
    }
  }

  async key(key: NewSessionKey): Promise<void> {
    const rows = this.rows();
    if (typeof key === "object") {
      if (this.mode === "recent" && this.filter === "" && (key.char === "~" || key.char === "/")) {
        await this.browse(key.char === "~" ? (this.home ?? "~") : "/");
      } else if (key.char === "/") {
        // the best match opens: "har/cr/" walks down by typing
        const best = rows.find((row) => row.kind === "dir");
        if (best !== undefined && this.filter !== "") {
          await this.browse((best as { path: string }).path);
        } else {
          // no folder to open
        }
      } else {
        this.filter += key.char;
        if (this.mode === "browse" && this.path !== undefined && this.filter === ".") {
          // a leading dot asks for the hidden folders too
          await this.listing(this.path, true);
        } else {
          // the listing at hand filters
        }
        this.select(this.rows().length > 1 ? 1 : 0);
      }
    } else {
      switch (key) {
        case "backspace":
          if (this.filter !== "") {
            this.filter = [...this.filter].slice(0, -1).join("");
            this.select(this.filter === "" ? 0 : 1);
          } else {
            await this.up();
          }
          break;
        case "up":
          this.select(this.selected - 1);
          break;
        case "down":
          this.select(this.selected + 1);
          break;
        case "pageUp":
          this.select(this.selected - PAGE);
          break;
        case "pageDown":
          this.select(this.selected + PAGE);
          break;
        case "home":
          this.select(0);
          break;
        case "end":
          this.select(rows.length - 1);
          break;
        case "right":
          await this.open(this.selected);
          break;
        case "left":
          await this.up();
          break;
        case "enter":
          await this.choose(this.selected);
          break;
        case "escape":
          this.deps.cancel();
          break;
        default:
          throw new Error(`unknown key: ${String(key satisfies never)}`);
      }
    }
  }
}
