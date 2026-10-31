/**
 * The facade's view of the files on disk: which files the workspace holds
 * and their stamps (mtime in nanoseconds, size). Comparing two snapshots
 * tells the servers exactly what changed since the last synchronization,
 * independent of file watchers and their delays.
 */

import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Directories of harness session workspaces: never part of a project. */
const AGENT_WORKSPACE_DIR = ".agent-workspace-tmp";
/** Outside git, these directories are never walked. */
const UNTRACKED_SKIP = new Set(["node_modules", "target"]);
const STAT_CONCURRENCY = 256;

export type FileStamp = { mtimeNs: bigint; size: number };
/** Absolute path → stamp. */
export type Snapshot = ReadonlyMap<string, FileStamp>;
export type SnapshotDiff = { created: string[]; changed: string[]; deleted: string[] };

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { maxBuffer: 256 << 20, encoding: "utf8" });
  return stdout;
}

/** The repository root that owns `dir`: the superproject when `dir` is inside a submodule; undefined outside git. */
export async function repositoryRoot(dir: string): Promise<string | undefined> {
  try {
    const superproject = (await git(dir, ["rev-parse", "--show-superproject-working-tree"])).trim();
    if (superproject !== "") {
      return await repositoryRoot(superproject);
    } else {
      return (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
    }
  } catch {
    return undefined;
  }
}

/**
 * Every file of the workspace, absolute: tracked and untracked-not-ignored
 * files of the repository and of its initialized submodules; outside git, a
 * walk that skips dot-directories, node_modules and target.
 */
export async function listFiles(root: string, inGit: boolean): Promise<string[]> {
  const files = inGit ? await gitFiles(root) : await walk(root);
  return files.filter((file) => !file.split(sep).includes(AGENT_WORKSPACE_DIR));
}

async function gitFiles(dir: string): Promise<string[]> {
  const entries = (await git(dir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]))
    .split("\0")
    .filter((entry) => entry !== "");
  const gitlinks = new Set(
    (await git(dir, ["ls-files", "-z", "--stage"]))
      .split("\0")
      .filter((line) => line.startsWith("160000 "))
      .map((line) => line.slice(line.indexOf("\t") + 1)),
  );
  const nested = await Promise.all(
    [...new Set(entries)].map(async (entry): Promise<string[]> => {
      const path = join(dir, entry);
      if (entry.endsWith("/")) {
        // an untracked nested repository: not part of this workspace
        return [];
      } else if (gitlinks.has(entry)) {
        try {
          return await gitFiles(path);
        } catch {
          // an uninitialized submodule has no files
          return [];
        }
      } else {
        return [path];
      }
    }),
  );
  return nested.flat();
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || UNTRACKED_SKIP.has(entry.name)) {
          return [];
        } else {
          return await walk(path);
        }
      } else if (entry.isFile()) {
        return [path];
      } else {
        // sockets, fifos and symlinks are not source files
        return [];
      }
    }),
  );
  return nested.flat();
}

/** Stamps of the given files; a listed file that no longer exists (deleted, not yet staged) is left out. */
export async function stampFiles(files: readonly string[]): Promise<Snapshot> {
  const stamps = new Map<string, FileStamp>();
  for (let offset = 0; offset < files.length; offset += STAT_CONCURRENCY) {
    await Promise.all(
      files.slice(offset, offset + STAT_CONCURRENCY).map(async (file) => {
        try {
          const info = await stat(file, { bigint: true });
          if (info.isFile()) {
            stamps.set(file, { mtimeNs: info.mtimeNs, size: Number(info.size) });
          } else {
            // a directory listed by git (an uninitialized submodule)
          }
        } catch {
          // deleted in the working tree
        }
      }),
    );
  }
  return stamps;
}

export function diffSnapshots(previous: Snapshot, next: Snapshot): SnapshotDiff {
  const diff: SnapshotDiff = { created: [], changed: [], deleted: [] };
  for (const [file, stamp] of next) {
    const before = previous.get(file);
    if (before === undefined) {
      diff.created.push(file);
    } else if (before.mtimeNs !== stamp.mtimeNs || before.size !== stamp.size) {
      diff.changed.push(file);
    } else {
      // unchanged
    }
  }
  for (const file of previous.keys()) {
    if (!next.has(file)) {
      diff.deleted.push(file);
    } else {
      // still present
    }
  }
  return diff;
}

export function isEmptyDiff(diff: SnapshotDiff): boolean {
  return diff.created.length === 0 && diff.changed.length === 0 && diff.deleted.length === 0;
}
