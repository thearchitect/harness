// The directories of the node's machine, for choosing where a new session starts (dirs_list): the
// directories in one directory by name, each saying whether it holds directories itself — read up
// to its first directory, so a big directory costs no more than a small one.

import { opendir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DirItem } from "#protocol/node.ts";

async function isDirectory(path: string, entry: { isDirectory(): boolean; isSymbolicLink(): boolean }): Promise<boolean> {
  if (entry.isDirectory()) {
    return true;
  } else if (entry.isSymbolicLink()) {
    return (await stat(path).catch(() => undefined))?.isDirectory() === true;
  } else {
    return false;
  }
}

/** Whether a directory holds a directory (an unreadable one does not). */
async function hasDirectory(path: string, hidden: boolean): Promise<boolean> {
  const dir = await opendir(path).catch(() => undefined);
  if (dir === undefined) {
    return false;
  } else {
    try {
      for await (const entry of dir) {
        if ((hidden || !entry.name.startsWith(".")) && (await isDirectory(join(path, entry.name), entry))) {
          return true;
        } else {
          // a file, or a hidden directory not asked for
        }
      }
      return false;
    } catch {
      return false;
    }
  }
}

export async function listDirs(path: string, hidden: boolean): Promise<{ path: string; parent: string | undefined; dirs: DirItem[] }> {
  const dir = await opendir(path);
  const names: string[] = [];
  for await (const entry of dir) {
    if ((hidden || !entry.name.startsWith(".")) && (await isDirectory(join(path, entry.name), entry))) {
      names.push(entry.name);
    } else {
      // a file, or hidden
    }
  }
  names.sort((a, b) => a.localeCompare(b));
  const dirs = await Promise.all(names.map(async (name) => ({ name, path: join(path, name), hasChildren: await hasDirectory(join(path, name), hidden) })));
  return { path, parent: path === "/" ? undefined : dirname(path), dirs };
}
