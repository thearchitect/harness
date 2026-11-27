// The move of a harness home from the flat layout of earlier versions to its layout
// (protocol/layout.ts): pi's files to agent/, the hub's to hub/, the clients' to client/, what lives
// with processes to run/. It runs before anything opens the home, under a lock, once a backup of the
// whole home is written next to it (~/.harness.backup-<date>.tgz). Each step moves one thing or
// converts one file and removes its source last, so a migration stopped halfway goes on at the next
// start. An older hub still running (its socket answers) stops it: the two would serve the same
// sessions.

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { layoutOf, type Layout } from "#protocol/layout.ts";
import type { WorkspaceTab } from "#protocol/hub.ts";

/** Names at the top of a home that are the new layout's. */
const LAYOUT = new Set(["agent", "hub", "client", "run", "log", ".gitignore", ".migrate.lock"]);

/** Names of the flat layout that were harness's own (everything else at the top was pi's). */
const HARNESS_OWN = new Set(["ui-settings.json", "harness.json", "workspace.json", "remotes.json", "sessions", "sockets", "locks", "nodes", "users", "attachments", "uploads", "claude", "ui-state"]);

/** The name earlier clients gave this machine's hub in tabs and window state; now it is `local`. */
const OLD_HOME_NAMES = new Set(["default", "local"]);
const HOME_HUB = "local";

export type Migration = { moved: string[]; notes: string[]; backup?: string };

/** Whether a home has anything of the flat layout left. */
export function needsMigration(home: string): boolean {
  return existsSync(home) && readdirSync(home).some((name) => !LAYOUT.has(name));
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined; // absent or unreadable: nothing to carry over
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.migrate.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** One migration at a time: the lock holds its process's pid; a dead holder's lock is taken over. */
function withMigrationLock<T>(home: string, work: () => T): T {
  const lock = join(home, ".migrate.lock");
  for (let waited = 0; ; waited += 100) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (error) {
      const owner = Number.parseInt(readFileSync(lock, "utf8") || "0", 10);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      } else if (owner > 0 && !alive(owner)) {
        rmSync(lock, { force: true });
      } else if (waited > 60_000) {
        throw new Error(`another harness (pid ${owner}) has been moving ${home} for a minute: wait for it, or remove ${lock} if it is gone`);
      } else {
        sleep(100); // another process moves the home now
      }
    }
  }
  try {
    return work();
  } finally {
    rmSync(lock, { force: true });
  }
}

/** Moves `from` to `to` unless `to` is there already (a step done before). */
function move(from: string, to: string, migration: Migration): void {
  if (!existsSync(from)) {
    return; // nothing there, or moved already
  } else if (existsSync(to)) {
    migration.notes.push(`${to} exists: ${from} was left where it is`);
  } else {
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    renameSync(from, to);
    migration.moved.push(`${basename(from)} → ${to.slice(dirname(dirname(to)).length + 1)}`);
  }
}

type OldTab = { node?: string; hub?: string; sessionId?: string; sessionFile?: string; cwd?: string; seen?: number };

/** The flat home's tabs (`ui.tabs` of ui-settings.json) of this machine's hub, as its workspace keeps them. */
function oldTabs(settings: Record<string, unknown>): WorkspaceTab[] {
  const tabs = Array.isArray(settings["ui.tabs"]) ? (settings["ui.tabs"] as OldTab[]) : [];
  return tabs.flatMap((tab) =>
    OLD_HOME_NAMES.has(tab.hub ?? tab.node ?? "") && typeof tab.sessionId === "string" && typeof tab.sessionFile === "string" && typeof tab.cwd === "string"
      ? [{ sessionId: tab.sessionId, sessionFile: tab.sessionFile, cwd: tab.cwd, ...(typeof tab.seen === "number" ? { seen: tab.seen } : {}) }]
      : [],
  );
}

/** A session file of the flat layout, at its place in hub/sessions. */
function movedSessionFile(home: string, layout: Layout, file: string): string {
  const old = join(home, "sessions");
  return file.startsWith(`${old}/`) ? `${layout.sessions}${file.slice(old.length)}` : file;
}

function migrateHub(home: string, layout: Layout, migration: Migration): void {
  const settingsPath = join(home, "ui-settings.json");
  const settings = (readJson(settingsPath) as Record<string, unknown> | undefined) ?? {};
  const windowFile = readJson(join(home, "ui-state", "tui.json")) as { tabs?: Record<string, { draft?: string }> } | undefined;

  // tabs and the drafts the window kept: the hub's workspace
  if (existsSync(settingsPath) && !existsSync(layout.workspace)) {
    const drafts = new Map(Object.entries(windowFile?.tabs ?? {}).flatMap(([key, view]) => (typeof view.draft === "string" && view.draft !== "" ? [[key.split("/").slice(1).join("/"), view.draft] as const] : [])));
    const tabs = oldTabs(settings).map((tab) => ({ ...tab, sessionFile: movedSessionFile(home, layout, tab.sessionFile), ...(drafts.has(tab.sessionId) ? { draft: { text: drafts.get(tab.sessionId) ?? "", at: Date.now() } } : {}) }));
    const kept = readJson(join(home, "workspace.json")) as { tabs?: WorkspaceTab[] } | undefined;
    writeJson(layout.workspace, { revision: 1, tabs: kept?.tabs ?? tabs });
    rmSync(join(home, "workspace.json"), { force: true });
    migration.moved.push(`ui.tabs → hub/workspace.json (${tabs.length} tabs)`);
  } else {
    move(join(home, "workspace.json"), layout.workspace, migration);
  }

  // the user's UI settings, without the tabs; a hand-written hub configuration becomes its network access
  if (existsSync(settingsPath) && !existsSync(layout.hubSettings)) {
    const { ["ui.tabs"]: _tabs, ...rest } = settings;
    const config = readJson(join(home, "nodes", "default.json")) as { hub?: { listen?: string; url?: string }; server?: boolean } | undefined;
    const network = config?.hub?.listen !== undefined ? { "hub.network": { enabled: true, listen: config.hub.listen, proxy: false, ...(config.hub.url !== undefined ? { url: config.hub.url } : {}) } } : {};
    writeJson(layout.hubSettings, { ...rest, ...network });
    if (config?.server === true) {
      writeJson(layout.hubConfig, { server: true });
    } else {
      // an ordinary machine
    }
    rmSync(settingsPath, { force: true });
    migration.moved.push("ui-settings.json → hub/settings.json");
  } else {
    // moved before, or none
  }
  rmSync(join(home, "nodes"), { recursive: true, force: true });

  move(join(home, "harness.json"), layout.defaults, migration);
  move(join(home, "sessions"), layout.sessions, migration);
  move(join(home, "attachments"), layout.attachments, migration);
  move(join(home, "uploads"), join(layout.hub, "uploads"), migration);
  move(join(home, "claude"), layout.claude, migration);

  // the multi-user hub of earlier versions: its users and its nodes are gone
  for (const file of ["users.json", "nodes.json"]) {
    if (existsSync(join(layout.hub, file))) {
      rmSync(join(layout.hub, file), { force: true });
      migration.notes.push(`hub/${file} removed: a hub is one user's, and no nodes stand behind it`);
    } else {
      // none
    }
  }
  if (existsSync(join(home, "users"))) {
    rmSync(join(home, "users"), { recursive: true, force: true });
    migration.notes.push("users/ removed: a hub is one user's; other users run hubs of their own");
  } else {
    // none
  }
}

function migrateClient(home: string, layout: Layout, migration: Migration): void {
  move(join(home, "remotes.json"), layout.remotes, migration);

  // the window's state: its views without the drafts (they are the hub's now), this machine's hub named `local`
  const old = join(home, "ui-state", "tui.json");
  const state = readJson(old) as { tabs?: Record<string, Record<string, unknown>>; active?: { node?: string; hub?: string; sessionId?: string }; node?: string; hub?: string } | undefined;
  if (state !== undefined && !existsSync(layout.window)) {
    const rename = (hub: string | undefined): string | undefined => (hub !== undefined && OLD_HOME_NAMES.has(hub) ? HOME_HUB : hub);
    const tabs = Object.fromEntries(
      Object.entries(state.tabs ?? {}).map(([key, view]) => {
        const [hub, ...session] = key.split("/");
        const { draft: _draft, ...rest } = view;
        return [`${rename(hub) ?? hub}/${session.join("/")}`, rest];
      }),
    );
    const activeHub = rename(state.active?.hub ?? state.active?.node);
    const hub = rename(state.hub ?? state.node);
    writeJson(layout.window, {
      version: 2,
      tabs,
      ...(activeHub !== undefined && state.active?.sessionId !== undefined ? { active: { hub: activeHub, sessionId: state.active.sessionId } } : {}),
      ...(hub !== undefined ? { hub } : {}),
    });
    migration.moved.push("ui-state/tui.json → client/window.json");
  } else {
    // moved before, or none
  }
  rmSync(join(home, "ui-state"), { recursive: true, force: true });
}

/**
 * Moves a home of the flat layout to the new one (a backup first); nothing to do for a home in the
 * new layout. Throws when an older hub runs on it, or when the backup cannot be written.
 */
export function migrateHome(home: string, olderHubRuns: boolean): Migration {
  if (!needsMigration(home)) {
    return { moved: [], notes: [] };
  } else {
    return withMigrationLock(home, () => {
      const migration: Migration = { moved: [], notes: [] };
      const layout = layoutOf(home);
      const oldSocket = join(home, "sockets", "default.sock");
      if (!needsMigration(home)) {
        return migration; // another process moved it meanwhile
      } else if (olderHubRuns) {
        throw new Error(`an older harness hub still runs on ${home} (${oldSocket}): close its windows or stop its service, then start harness again`);
      } else {
        const backup = `${home.replace(/\/+$/, "")}.backup-${new Date().toISOString().slice(0, 10)}.tgz`;
        if (!existsSync(backup)) {
          // sockets are left out of the archive (tar warns of them and goes on)
          const tar = spawnSync("tar", ["-czf", backup, "--exclude=*.sock", "-C", dirname(home), basename(home)], { encoding: "utf8" });
          if (tar.status !== 0) {
            rmSync(backup, { force: true });
            throw new Error(`the backup of ${home} before moving it could not be written (${(tar.stderr || tar.error?.message || `tar exited ${String(tar.status)}`).trim()}): nothing was moved`);
          } else {
            migration.backup = backup;
          }
        } else {
          migration.backup = backup; // written by the run that was stopped halfway
        }

        for (const name of ["agent", "hub", "client", "run", "log"]) {
          mkdirSync(join(home, name), { recursive: true, mode: 0o700 });
        }
        // the processes' files of the flat layout: no process of it runs any more
        rmSync(join(home, "sockets"), { recursive: true, force: true });
        rmSync(join(home, "locks"), { recursive: true, force: true });

        migrateHub(home, layout, migration);
        migrateClient(home, layout, migration);

        // everything else at the top was pi's
        for (const name of readdirSync(home)) {
          if (!LAYOUT.has(name) && !HARNESS_OWN.has(name)) {
            move(join(home, name), join(layout.agent, name), migration);
          } else {
            // the layout's own, or harness's moved above
          }
        }
        return migration;
      }
    });
  }
}
