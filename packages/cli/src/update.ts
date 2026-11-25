/**
 * harness - updates of the bundle, from the TUI (the harness panel's update row).
 *
 * - checkUpdates: what the master branch has over the installed revision -
 *   one GitHub API request (compare), made in the background at startup: the
 *   number of new commits, when the latest landed, and the pin changes of the
 *   CI's "Update bundle pins" commits (nix/update.sh writes one
 *   "<component> <old> -> <new>" line per change into their body: the format
 *   is a contract between the two);
 * - detectInstall: how the bundle is installed - in the user's Nix profile
 *   (install.sh), which `nix profile upgrade` updates, or by a system
 *   configuration (NixOS / home-manager), which only its owner can update;
 * - updateLines / updateHint: the Update section of the dependencies report and the
 *   panel row's hint;
 * - execUpdate: replaces the exiting TUI with a shell that upgrades the
 *   profile and starts harness again (it reopens the user's tabs; nodes run
 *   as services keep their agents, one inside the TUI stopped with it).
 */

import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";

const REPOSITORY_API = "https://api.github.com/repos/thearchitect/harness";
const CHECK_TIMEOUT_MS = 10_000;
const PIN_COMMIT_SUBJECT = "Update bundle pins";
const PIN_LINE = /^(\S+) (\S+) -> (\S+)$/;
const NIX = ["--extra-experimental-features", "nix-command flakes"];

/** A pinned component that changed between the installed revision and master. */
export type PinChange = { component: string; from: string; to: string };

export type UpdateState =
  | { kind: "checking" }
  | { kind: "dev" }
  | { kind: "current" }
  | { kind: "available"; count: number; latest: Date; changes: PinChange[] }
  | { kind: "failed"; reason: string };

export type Install = { kind: "profile"; element: string } | { kind: "system" };

type Commit = { commit: { message: string; committer: { date: string } } };

/**
 * What master has over the installed revision. A revision that is not a
 * commit SHA (a dev or dirty build) is not checked.
 */
export async function checkUpdates(revision: string, fetchImpl: typeof fetch): Promise<UpdateState> {
  if (!/^[0-9a-f]{7,40}$/.test(revision)) {
    return { kind: "dev" };
  } else {
    try {
      const compare = (await getJson(fetchImpl, `compare/${revision}...master`)) as {
        ahead_by?: unknown;
        commits?: unknown;
      };
      if (typeof compare.ahead_by !== "number" || !Array.isArray(compare.commits)) {
        throw new Error("unexpected compare response");
      } else if (compare.ahead_by === 0) {
        return { kind: "current" };
      } else {
        const commits = compare.commits as Commit[];
        // GitHub lists at most 250 commits: past that, the latest is asked for separately.
        const head = commits.length >= compare.ahead_by ? commits.at(-1) : ((await getJson(fetchImpl, "commits/master")) as Commit);
        const latest = new Date(head?.commit.committer.date ?? Number.NaN);
        if (Number.isNaN(latest.getTime())) {
          throw new Error("unexpected commit response");
        } else {
          return {
            kind: "available",
            count: compare.ahead_by,
            latest,
            changes: pinChanges(commits.map((entry) => entry.commit.message)),
          };
        }
      }
    } catch (error) {
      return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
  }
}

async function getJson(fetchImpl: typeof fetch, endpoint: string): Promise<unknown> {
  const response = await fetchImpl(`${REPOSITORY_API}/${endpoint}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "harness" },
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  if (response.ok) {
    return response.json();
  } else if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
    throw new Error("GitHub rate limit");
  } else if (response.status === 404) {
    throw new Error("revision not found on GitHub");
  } else {
    throw new Error(`HTTP ${response.status}`);
  }
}

/**
 * The pin changes of "Update bundle pins" commits, oldest first: each
 * component from its first old version to its last new one; a component back
 * at its old version did not change.
 */
export function pinChanges(messages: readonly string[]): PinChange[] {
  const changes = new Map<string, PinChange>();
  for (const message of messages) {
    const [subject = "", ...body] = message.split("\n");
    if (subject.trim() === PIN_COMMIT_SUBJECT) {
      for (const line of body) {
        const match = PIN_LINE.exec(line.trim());
        if (match === null) {
          // not a pin line (blank, or prose)
        } else {
          const [, component = "", from = "", to = ""] = match;
          const known = changes.get(component);
          changes.set(component, { component, from: known?.from ?? from, to });
        }
      }
    } else {
      // only CI's pin commits list changes
    }
  }
  return [...changes.values()]
    .filter((change) => change.from !== change.to)
    .sort((a, b) => a.component.localeCompare(b.component));
}

/**
 * The element of `nix profile list --json` that holds this bundle (its
 * manifest resolves to the running one), or undefined: the bundle is not in
 * this profile.
 */
export async function profileElement(listJson: string, manifestPath: string): Promise<string | undefined> {
  const running = await realpath(manifestPath);
  const list = JSON.parse(listJson) as { elements?: Record<string, { storePaths?: string[] }> };
  for (const [name, element] of Object.entries(list.elements ?? {})) {
    for (const storePath of element.storePaths ?? []) {
      const manifest = await realpath(`${storePath}/share/harness/manifest.json`).catch(() => undefined);
      if (manifest === running) {
        return name;
      } else {
        // another package, or another harness bundle
      }
    }
  }
  return undefined;
}

/** How the bundle is installed: nix missing or the bundle outside the user's profile means a system configuration. */
export async function detectInstall(manifestPath: string): Promise<Install> {
  const listJson = await new Promise<string | undefined>((resolve) => {
    execFile("nix", [...NIX, "profile", "list", "--json"], { timeout: 10_000 }, (error, stdout) => {
      resolve(error ? undefined : stdout);
    });
  });
  const element = listJson === undefined ? undefined : await profileElement(listJson, manifestPath);
  return element === undefined ? { kind: "system" } : { kind: "profile", element };
}

/** "15m ago", "2h ago", "3d ago". */
export function formatAge(date: Date, now: number): string {
  const minutes = Math.max(0, Math.floor((now - date.getTime()) / 60_000));
  if (minutes < 60) {
    return `${minutes}m ago`;
  } else if (minutes < 24 * 60) {
    return `${Math.floor(minutes / 60)}h ago`;
  } else {
    return `${Math.floor(minutes / (24 * 60))}d ago`;
  }
}

/** The panel row's hint. */
export function updateHint(state: UpdateState, now: number): string {
  switch (state.kind) {
    case "checking":
      return "checking…";
    case "dev":
      return "dev build";
    case "current":
      return "up to date";
    case "available":
      return `${state.count} new · ${formatAge(state.latest, now)}`;
    case "failed":
      return "check failed";
    default:
      throw new Error(`unknown update state: ${JSON.stringify(state satisfies never)}`);
  }
}

/** The Update section of the dependencies report. */
export function updateLines(state: UpdateState, install: Install, now: number): string[] {
  switch (state.kind) {
    case "checking":
      return ["Update: checking…"];
    case "dev":
      return ["Update: dev build, not checked"];
    case "current":
      return ["Update: up to date"];
    case "failed":
      return [`Update: check failed (${state.reason})`];
    case "available": {
      const width = Math.max(0, ...state.changes.map((change) => change.component.length));
      return [
        `Update: ${state.count} new commit${state.count === 1 ? "" : "s"} on master, latest ${formatAge(state.latest, now)}`,
        ...state.changes.map((change) => `  ${change.component.padEnd(width)}  ${change.from} → ${change.to}`),
        `  how: ${updateHow(install)}`,
      ];
    }
    default:
      throw new Error(`unknown update state: ${JSON.stringify(state satisfies never)}`);
  }
}

function updateHow(install: Install): string {
  switch (install.kind) {
    case "profile":
      return "Ctrl+\\ → update";
    case "system":
      return "installed by your NixOS / home-manager config: update its harness flake input and rebuild";
    default:
      throw new Error(`unknown install: ${JSON.stringify(install satisfies never)}`);
  }
}

/**
 * Upgrades the profile element and runs the new bundle's host setup where it
 * has one (`harness-setup`, macOS), then starts harness again; a failed
 * upgrade resumes the current version.
 */
const UPDATE_SCRIPT = `
echo "Updating harness…"
if nix ${NIX.map((arg) => `"${arg}"`).join(" ")} profile upgrade "$1"; then
  echo "harness updated"
  if command -v harness-setup >/dev/null 2>&1; then
    harness-setup || echo "warning: harness-setup failed; rerun it by hand"
  else
    : # no host integration on this platform
  fi
else
  echo "harness update failed; press Enter to resume the current version"
  read -r _ </dev/tty
fi
exec harness
`;

/** Replaces this process with the update script; called after the TUI stopped and the embedded node closed. */
export function execUpdate(element: string): void {
  if (process.execve === undefined) {
    throw new Error("this Node has no process.execve");
  } else {
    process.execve("/bin/sh", ["sh", "-c", UPDATE_SCRIPT, "sh", element], process.env);
  }
}

/** Whether execUpdate can replace this process (Node with process.execve, not Windows). */
export function canExecUpdate(): boolean {
  return typeof process.execve === "function";
}
