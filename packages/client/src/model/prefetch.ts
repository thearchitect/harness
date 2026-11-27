// Loading ahead in the background (plan polish-3 D), the same for the TUI and the app: every session
// the operator may open is in memory, whole, before it is opened. In order: the active tab; the
// window's other tabs, most recently used first; then the stored sessions of the hubs' lists, most
// recently changed first. A running agent is followed (live) and its older entries loaded to the
// beginning; a session without one is read from its file (session_read) and read again when the file
// changed (checked when the lists are read, at most once a minute). `ui.prefetch`: `all` (default),
// `tabs` (the window's tabs only), `off`.

import { storedKey, type ClientModel } from "./client-model.ts";

export type PrefetchMode = "all" | "tabs" | "off";

/** A session to load: the hub, its running agent (if any), its file. */
export type PrefetchTarget = { hub: string; agent: string | undefined; file: string | undefined };

/** How often stored sessions are checked for changes. */
export const PREFETCH_RECHECK_MS = 60_000;

export function prefetchMode(settings: Record<string, unknown>): PrefetchMode {
  const value = settings["ui.prefetch"];
  return value === "tabs" || value === "off" ? value : "all";
}

export class Prefetch {
  private readonly client: ClientModel;
  /** The window's tabs as targets, the active one first, then by use. */
  private readonly tabs: () => PrefetchTarget[];
  private readonly now: () => number;
  private running = false;
  private again = false;
  private listedAt = 0;
  private stopped = false;

  constructor(client: ClientModel, tabs: () => PrefetchTarget[], now: () => number) {
    this.client = client;
    this.tabs = tabs;
    this.now = now;
  }

  /** Something changed (a tab, a connection, the active tab): a pass runs, or another after the current one. */
  kick(): void {
    if (this.stopped || prefetchMode(this.client.settings) === "off") {
      return;
    } else if (this.running) {
      this.again = true;
    } else {
      this.running = true;
      void this.pass()
        .catch(() => undefined) // a node gone meanwhile: the next pass tries again
        .finally(() => {
          this.running = false;
          if (this.again) {
            this.again = false;
            this.kick();
          } else {
            // done until something changes
          }
        });
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private async pass(): Promise<void> {
    for (const target of this.tabs()) {
      await this.load(target);
    }
    const now = this.now();
    if (prefetchMode(this.client.settings) === "all" && now - this.listedAt >= PREFETCH_RECHECK_MS) {
      this.listedAt = now;
      for (const target of await this.listed()) {
        if (this.stopped) {
          return;
        } else {
          await this.load(target);
        }
      }
    } else {
      // the window's tabs only, or the lists were read a moment ago
    }
  }

  /** The stored sessions of every connected hub, most recently changed first. */
  private async listed(): Promise<PrefetchTarget[]> {
    const lists = await Promise.all(
      [...this.client.connections.keys()]
        .filter((hub) => !this.client.offline.has(hub))
        .map(async (hub) => (await this.client.sessions(hub).catch(() => [])).map((session) => ({ hub, session }))),
    );
    return lists
      .flat()
      .sort((a, b) => b.session.modified - a.session.modified)
      .map(({ hub, session }) => ({ hub, agent: session.agent, file: session.path }));
  }

  private async load(target: PrefetchTarget): Promise<void> {
    if (this.stopped || !this.client.connections.has(target.hub) || this.client.offline.has(target.hub)) {
      return; // gone, or not reachable now
    } else if (target.agent !== undefined) {
      await this.client.follow(target.hub, target.agent);
      await this.client.loadAll(target.hub, target.agent);
    } else if (target.file !== undefined) {
      const known = this.client.stored.get(storedKey(target.hub, target.file));
      if (known === undefined || this.now() - known.checked >= PREFETCH_RECHECK_MS) {
        await this.client.readStored(target.hub, target.file, this.now());
      } else {
        // read a moment ago
      }
    } else {
      // a draft without a file yet: nothing stored
    }
  }
}
