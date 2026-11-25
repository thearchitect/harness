// Path classification for the change gate: canonical paths (symlinks resolved, missing tails
// kept), containment, and the session workspace.

import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** The directory under each project that holds the session workspaces. */
export const AGENT_WORKSPACE_DIR = ".agent-workspace-tmp";

/** The canonical form of a path that may not exist yet: its existing prefix resolved, the rest appended. */
export async function canonicalizeProspectivePath(path: string): Promise<string> {
  let cursor = resolve(path);
  const missingSegments: string[] = [];
  for (;;) {
    try {
      const existing = await realpath(cursor);
      return resolve(existing, ...missingSegments.reverse());
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      const parent = dirname(cursor);
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      } else if (parent === cursor) {
        throw error;
      } else {
        missingSegments.push(basename(cursor));
        cursor = parent;
      }
    }
  }
}

export function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!isAbsolute(pathFromRoot) && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`));
}

/** Whether a path (relative to cwd) lies inside a canonical root. */
export async function isInsideRoot(path: string, cwd: string, root: string): Promise<boolean> {
  return isInside(root, await canonicalizeProspectivePath(resolve(cwd, path)));
}

function formatSessionDate(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}--${pad(date.getHours())}-${pad(date.getMinutes())}`;
}

/** The session's disposable workspace: <cwd>/.agent-workspace-tmp/<creation date>--<session id>, canonical. */
export async function sessionWorkspaceRoot(cwd: string, header: { id: string; timestamp: string } | null): Promise<string> {
  if (header === null) {
    return canonicalizeProspectivePath(resolve(cwd, AGENT_WORKSPACE_DIR));
  } else {
    return canonicalizeProspectivePath(resolve(cwd, AGENT_WORKSPACE_DIR, `${formatSessionDate(new Date(header.timestamp))}--${header.id}`));
  }
}
