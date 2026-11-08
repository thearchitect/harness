/**
 * Where an agent may work: its user's home or a directory inside it. A new
 * agent is offered ~, the recent directories that still exist and the
 * subdirectories of ~ (the Mini App); `/new <path>` resolves the path inside ~.
 */

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { homeOf } from "../accounts.ts";
import type { Config, UserConfig } from "../config.ts";
import type { StateStore } from "./state.ts";

const SUBDIRS_LIMIT = 15;

/** Absolute directories to offer: ~, recent ones, then the subdirectories of ~ (no hidden ones). */
export function dirChoices(config: Config, store: StateStore, user: UserConfig, onProblem: (message: string) => void): string[] {
  const home = homeOf(config, user);
  const recent = store.user(user.telegramId).recentDirs.filter((dir) => dir !== home && isInside(home, dir) && isDirectory(dir));
  let subdirs: string[] = [];
  try {
    subdirs = readdirSync(home, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => resolve(home, entry.name))
      .filter((dir) => !recent.includes(dir))
      .sort()
      .slice(0, SUBDIRS_LIMIT);
  } catch (error) {
    onProblem(`cannot list ${home}: ${(error as Error).message}`);
  }
  return [home, ...recent, ...subdirs];
}

/** A directory relative to ~ (`proj`, `~/proj`, `~`), resolved through symlinks; it must stay inside ~. */
export function resolveDir(config: Config, user: UserConfig, path: string): { dir: string } | { problem: string } {
  const resolved = resolvePath(config, user, path);
  if ("problem" in resolved) {
    return resolved;
  } else if (resolved.kind !== "dir") {
    return { problem: `${path} is not a directory.` };
  } else {
    return { dir: resolved.path };
  }
}

/** A file or directory relative to ~ (or absolute inside it), resolved through symlinks; it must stay inside ~. */
export function resolvePath(config: Config, user: UserConfig, path: string): { path: string; kind: "dir" | "file" } | { problem: string } {
  const home = homeOf(config, user);
  const candidate = resolve(home, path.trim().replace(/^~\/?/, ""));
  if (!existsSync(candidate)) {
    return { problem: `${path} does not exist.` };
  } else {
    const real = realpathSync(candidate);
    const stat = statSync(real);
    if (!isInside(home, real)) {
      return { problem: `${path} is outside your home.` };
    } else if (stat.isDirectory()) {
      return { path: real, kind: "dir" };
    } else if (stat.isFile()) {
      return { path: real, kind: "file" };
    } else {
      return { problem: `${path} is neither a file nor a directory.` };
    }
  }
}

/** `~` or `~/sub/dir` for a directory inside the user's home. */
export function displayDir(config: Config, user: UserConfig, cwd: string): string {
  const home = homeOf(config, user);
  return cwd === home ? "~" : cwd.startsWith(`${home}/`) ? `~/${cwd.slice(home.length + 1)}` : cwd;
}

function isInside(home: string, dir: string): boolean {
  return dir === home || dir.startsWith(`${home}/`);
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
