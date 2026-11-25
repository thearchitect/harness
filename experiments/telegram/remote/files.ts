/**
 * File work the gateway does for a user, always as that user (their uid,
 * their permissions), with deadlines and size caps:
 *
 * - reading a file the agent sends (send_file) or the user downloads;
 * - zipping a directory for download;
 * - listing a directory and creating one (the Mini App's Files);
 * - the diff of an agent's directory (/diff);
 * - saving files of incoming messages to ~/tmp/<chat>-<message>/.
 */

import { basename, dirname, join } from "node:path";
import { execAsUser, homeOf } from "./accounts.ts";
import type { Config, UserConfig } from "./config.ts";

/** What a bot may send (Bot API sendDocument). */
export const SEND_LIMIT = 50 * 1024 * 1024;
/** What a bot may download (Bot API getFile). */
export const DOWNLOAD_LIMIT = 20 * 1024 * 1024;

const READ_TIMEOUT_MS = 30_000;
const ZIP_TIMEOUT_MS = 120_000;
const DIFF_TIMEOUT_MS = 30_000;
const LIST_LIMIT = 500;

export type Outcome<T> = { ok: true; data: T } | { ok: false; problem: string };

function failed(result: { code: number | null; stderr: string; problem?: string }, what: string): string {
  return result.problem ?? (result.stderr.trim().split("\n").slice(-3).join("\n") || `${what} exited with ${result.code}`);
}

/** A file's content, read as the user; at most SEND_LIMIT bytes. */
export async function readFileAs(config: Config, user: UserConfig, path: string): Promise<Outcome<Buffer>> {
  const result = await execAsUser(config, user, "cat", ["--", path], { timeoutMs: READ_TIMEOUT_MS, maxBytes: SEND_LIMIT });
  return result.code === 0 && result.problem === undefined ? { ok: true, data: result.stdout } : { ok: false, problem: failed(result, "cat") };
}

/** A directory as a zip (`<name>.zip`, the directory itself at its root), built as the user; at most SEND_LIMIT bytes. */
export async function zipDirAs(config: Config, user: UserConfig, dir: string): Promise<Outcome<{ name: string; data: Buffer }>> {
  const name = basename(dir) || "home";
  const result = await execAsUser(config, user, "zip", ["-q", "-r", "-y", "-", basename(dir)], {
    cwd: dirname(dir),
    timeoutMs: ZIP_TIMEOUT_MS,
    maxBytes: SEND_LIMIT,
  });
  if (result.problem !== undefined && result.problem.startsWith("larger")) {
    return { ok: false, problem: `${name}.zip is larger than Telegram's 50 MB limit for bots` };
  } else if (result.code === 0 && result.problem === undefined) {
    return { ok: true, data: { name: `${name}.zip`, data: result.stdout } };
  } else {
    return { ok: false, problem: failed(result, "zip") };
  }
}

export type Entry = { name: string; kind: "dir" | "file" | "other"; size: number; hidden: boolean };

/** The entries of a directory, as the user sees them: directories first, then by name. */
export async function listDirAs(config: Config, user: UserConfig, dir: string): Promise<Outcome<{ entries: Entry[]; truncated: boolean }>> {
  const result = await execAsUser(config, user, "find", [dir, "-mindepth", "1", "-maxdepth", "1", "-printf", "%y\\t%s\\t%f\\0"], {
    timeoutMs: READ_TIMEOUT_MS,
    maxBytes: 4 * 1024 * 1024,
  });
  if (result.code !== 0 || result.problem !== undefined) {
    return { ok: false, problem: failed(result, "find") };
  } else {
    const entries = result.stdout
      .toString("utf8")
      .split("\0")
      .filter((record) => record !== "")
      .map((record): Entry => {
        const [type = "", size = "0", ...name] = record.split("\t");
        const fileName = name.join("\t");
        return { name: fileName, kind: type === "d" ? "dir" : type === "f" ? "file" : "other", size: Number(size), hidden: fileName.startsWith(".") };
      })
      .sort((a, b) => (a.kind === "dir") === (b.kind === "dir") ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1);
    return { ok: true, data: { entries: entries.slice(0, LIST_LIMIT), truncated: entries.length > LIST_LIMIT } };
  }
}

const FOLDER_NAME = /^[^/\0]{1,255}$/;

/** Creates `<parent>/<name>` as the user. */
export async function mkdirAs(config: Config, user: UserConfig, parent: string, name: string): Promise<Outcome<string>> {
  if (!FOLDER_NAME.test(name) || name === "." || name === "..") {
    return { ok: false, problem: "a folder name has no / and is not . or .." };
  } else {
    const path = join(parent, name);
    const result = await execAsUser(config, user, "mkdir", ["--", path], { timeoutMs: READ_TIMEOUT_MS, maxBytes: 64 * 1024 });
    return result.code === 0 ? { ok: true, data: path } : { ok: false, problem: failed(result, "mkdir") };
  }
}

/**
 * The changes in `dir` (a git working tree or a directory inside one) against
 * HEAD, untracked files included, as one patch; "" when nothing changed.
 */
export async function diffAs(config: Config, user: UserConfig, dir: string): Promise<Outcome<{ patch: Buffer; files: number }> | { ok: false; notRepo: true }> {
  const script = [
    "set -e",
    'git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 3',
    'if git rev-parse --verify -q HEAD >/dev/null; then git diff HEAD --binary -- .; else git diff --cached --binary -- .; git diff --binary -- .; fi',
    'git ls-files --others --exclude-standard -z -- . | while IFS= read -r -d "" f; do git diff --no-index --binary -- /dev/null "$f" || [ $? -eq 1 ]; done',
  ].join("\n");
  const result = await execAsUser(config, user, "bash", ["-c", script], { cwd: dir, timeoutMs: DIFF_TIMEOUT_MS, maxBytes: SEND_LIMIT });
  if (result.code === 3) {
    return { ok: false, notRepo: true };
  } else if (result.code !== 0 || result.problem !== undefined) {
    return { ok: false, problem: failed(result, "git diff") };
  } else {
    const files = (result.stdout.toString("utf8").match(/^diff --git /gm) ?? []).length;
    return { ok: true, data: { patch: result.stdout, files } };
  }
}

/** Saves a file of a message to ~/tmp/<folder>/<name> as the user; resolves with its absolute path. */
export async function saveIncomingAs(config: Config, user: UserConfig, folder: string, name: string, data: Buffer): Promise<Outcome<string>> {
  const safeName = name.replace(/[/\\\0]/g, "_").replace(/^\.+/, "_") || "file";
  const dir = join(homeOf(config, user), "tmp", folder);
  const result = await execAsUser(config, user, "sh", ["-c", 'umask 077; mkdir -p "$1" && cat > "$1/$2"', "sh", dir, safeName], {
    timeoutMs: READ_TIMEOUT_MS,
    maxBytes: 64 * 1024,
    input: data,
  });
  return result.code === 0 ? { ok: true, data: join(dir, safeName) } : { ok: false, problem: failed(result, "save") };
}

/** Human size: 1.2 MB, 240 KB, 12 B. */
export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  } else if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  } else {
    return `${bytes} B`;
  }
}
