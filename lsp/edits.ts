/**
 * Workspace edits from a language server, applied all or nothing.
 *
 *   plan    WorkspaceEdit → the final content of every touched path, replayed
 *           in order on a virtual file system (text edits, create, rename,
 *           delete), plus per-file diffs for review;
 *   commit  under the file mutation locks of every path: verify that no file
 *           changed since the server computed the edit, write each file
 *           atomically (temp file + rename), and restore the originals if any
 *           step fails.
 */

import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { uriToPath } from "./session.ts";
import type { Snapshot } from "./snapshot.ts";
import { assertNever, type Position, type TextEdit, type WorkspaceEdit } from "./protocol.ts";

/** One path's transition: `before`/`after` undefined mean absent. */
export type PathChange = { path: string; before: string | undefined; after: string | undefined; mode: number | undefined };

export type ChangeSet = {
  changes: PathChange[];
  /** Moves for display: final path ← original path. */
  moves: { from: string; to: string }[];
  /** Stamps of the original files as read while planning; commit refuses if any differs. */
  stamps: Map<string, string>;
};

/** Serializes the commit with other writers of the same paths (pi's file mutation queue). */
export type LockPaths = <T>(paths: readonly string[], fn: () => Promise<T>) => Promise<T>;

type Entry = { content: string | undefined; origin: string | undefined };

export class EditError extends Error {}

export async function planEdit(edit: WorkspaceEdit, basis: Snapshot): Promise<ChangeSet> {
  const originals = new Map<string, { content: string | undefined; mode: number | undefined }>();
  const stamps = new Map<string, string>();
  const files = new Map<string, Entry>();

  const original = async (path: string): Promise<{ content: string | undefined; mode: number | undefined }> => {
    const known = originals.get(path);
    if (known !== undefined) {
      return known;
    } else {
      let loaded: { content: string | undefined; mode: number | undefined };
      try {
        const info = await stat(path, { bigint: true });
        const stamp = `${info.mtimeNs}:${info.size}`;
        const seen = basis.get(path);
        if (seen !== undefined && `${seen.mtimeNs}:${seen.size}` !== stamp) {
          throw new EditError(`${path} changed after the language server computed the edit; repeat the operation`);
        } else {
          stamps.set(path, stamp);
          loaded = { content: await readFile(path, "utf8"), mode: Number(info.mode) & 0o7777 };
        }
      } catch (error) {
        if (error instanceof EditError) {
          throw error;
        } else if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          stamps.set(path, "absent");
          loaded = { content: undefined, mode: undefined };
        } else {
          throw error;
        }
      }
      originals.set(path, loaded);
      return loaded;
    }
  };
  const current = async (path: string): Promise<Entry> => {
    const entry = files.get(path);
    if (entry !== undefined) {
      return entry;
    } else {
      const loaded = await original(path);
      const fresh: Entry = { content: loaded.content, origin: loaded.content === undefined ? undefined : path };
      files.set(path, fresh);
      return fresh;
    }
  };
  const editText = async (uri: string, edits: TextEdit[]): Promise<void> => {
    const path = uriToPath(uri);
    const entry = await current(path);
    if (entry.content === undefined) {
      throw new EditError(`the edit changes ${path}, which does not exist`);
    } else {
      files.set(path, { ...entry, content: applyTextEdits(path, entry.content, edits) });
    }
  };

  if (edit.documentChanges !== undefined) {
    for (const change of edit.documentChanges) {
      if (!("kind" in change)) {
        await editText(change.textDocument.uri, change.edits);
      } else {
        switch (change.kind) {
          case "create": {
            const path = uriToPath(change.uri);
            const entry = await current(path);
            if (entry.content !== undefined && change.options?.overwrite !== true) {
              if (change.options?.ignoreIfExists === true) {
                // keep the existing file
              } else {
                throw new EditError(`the edit creates ${path}, which already exists`);
              }
            } else {
              files.set(path, { content: "", origin: entry.origin });
            }
            break;
          }
          case "rename": {
            const from = uriToPath(change.oldUri);
            const to = uriToPath(change.newUri);
            const source = await current(from);
            const target = await current(to);
            if (source.content === undefined) {
              throw new EditError(`the edit moves ${from}, which does not exist`);
            } else if (target.content !== undefined && change.options?.overwrite !== true) {
              if (change.options?.ignoreIfExists === true) {
                // keep both as they are
              } else {
                throw new EditError(`the edit moves ${from} onto ${to}, which already exists`);
              }
            } else {
              files.set(to, { content: source.content, origin: source.origin });
              files.set(from, { content: undefined, origin: undefined });
            }
            break;
          }
          case "delete": {
            const path = uriToPath(change.uri);
            const entry = await current(path);
            if (entry.content === undefined && change.options?.ignoreIfNotExists !== true) {
              throw new EditError(`the edit deletes ${path}, which does not exist`);
            } else {
              files.set(path, { content: undefined, origin: undefined });
            }
            break;
          }
          default:
            return assertNever(change);
        }
      }
    }
  } else if (edit.changes !== undefined) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      await editText(uri, edits);
    }
  } else {
    // an empty edit
  }

  const changes: PathChange[] = [];
  const moves: { from: string; to: string }[] = [];
  for (const [path, entry] of files) {
    const before = (await original(path)).content;
    const mode = entry.origin !== undefined ? (await original(entry.origin)).mode : undefined;
    if (before !== entry.content) {
      changes.push({ path, before, after: entry.content, mode });
    } else {
      // unchanged
    }
    if (entry.origin !== undefined && entry.origin !== path && entry.content !== undefined) {
      moves.push({ from: entry.origin, to: path });
    } else {
      // stays where it was
    }
  }
  changes.sort((a, b) => a.path.localeCompare(b.path));
  return { changes, moves, stamps };
}

/**
 * An exact text replacement with the semantics of the `edit` tool: `oldText`
 * must occur exactly once in the file.
 */
export async function planReplacement(path: string, oldText: string, newText: string): Promise<ChangeSet> {
  if (oldText === "") {
    throw new EditError("oldText is empty");
  } else {
    const info = await stat(path, { bigint: true });
    const before = await readFile(path, "utf8");
    const first = before.indexOf(oldText);
    if (first < 0) {
      throw new EditError(`oldText does not occur in ${path}`);
    } else if (before.indexOf(oldText, first + 1) >= 0) {
      throw new EditError(`oldText occurs more than once in ${path}; include more context to make it unique`);
    } else {
      const after = before.slice(0, first) + newText + before.slice(first + oldText.length);
      return {
        changes: before === after ? [] : [{ path, before, after, mode: Number(info.mode) & 0o7777 }],
        moves: [],
        stamps: new Map([[path, `${info.mtimeNs}:${info.size}`]]),
      };
    }
  }
}

/** Adds plain file moves (no content change) to a change set, refusing to overwrite. */
export async function addMoves(set: ChangeSet, moves: readonly { from: string; to: string }[]): Promise<ChangeSet> {
  const byPath = new Map(set.changes.map((change) => [change.path, change]));
  for (const move of moves) {
    const sourceChange = byPath.get(move.from);
    let content: string;
    let mode: number | undefined;
    if (sourceChange !== undefined) {
      if (sourceChange.after === undefined) {
        throw new EditError(`${move.from} is deleted by the same edit`);
      } else {
        content = sourceChange.after;
        mode = sourceChange.mode;
      }
    } else {
      const info = await stat(move.from, { bigint: true });
      set.stamps.set(move.from, `${info.mtimeNs}:${info.size}`);
      content = await readFile(move.from, "utf8");
      mode = Number(info.mode) & 0o7777;
    }
    if (byPath.has(move.to) || (await pathExists(move.to))) {
      throw new EditError(`${move.to} already exists`);
    } else {
      set.stamps.set(move.to, "absent");
      byPath.set(move.to, { path: move.to, before: undefined, after: content, mode });
      byPath.set(move.from, {
        path: move.from,
        before: sourceChange !== undefined ? sourceChange.before : content,
        after: undefined,
        mode: undefined,
      });
      set.moves.push(move);
    }
  }
  const changes = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { changes, moves: set.moves, stamps: set.stamps };
}

export async function commitChanges(set: ChangeSet, lock: LockPaths): Promise<void> {
  const paths = [...new Set([...set.changes.map((change) => change.path), ...set.stamps.keys()])].sort();
  await lock(paths, async () => {
    for (const [path, stamp] of set.stamps) {
      if ((await stampOf(path)) !== stamp) {
        throw new EditError(`${path} changed while the edit was under review; nothing was written, repeat the operation`);
      } else {
        // as planned
      }
    }
    const done: PathChange[] = [];
    try {
      for (const change of set.changes) {
        await writePath(change.path, change.after, change.mode);
        done.push(change);
      }
    } catch (error) {
      for (const change of done.reverse()) {
        await writePath(change.path, change.before, change.mode).catch(() => {
          // best effort: the error below names the failure
        });
      }
      throw new EditError(`writing the edit failed and the touched files were restored: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

async function writePath(path: string, content: string | undefined, mode: number | undefined): Promise<void> {
  if (content === undefined) {
    await rm(path, { force: true });
  } else {
    await mkdir(dirname(path), { recursive: true });
    const temp = join(dirname(path), `.${basename(path)}.harness-${process.pid}-${Date.now()}`);
    await writeFile(temp, content, "utf8");
    if (mode !== undefined) {
      await chmod(temp, mode);
    } else {
      // a new file: default permissions
    }
    await rename(temp, path);
  }
}

async function stampOf(path: string): Promise<string> {
  try {
    const info = await stat(path, { bigint: true });
    return `${info.mtimeNs}:${info.size}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "absent";
    } else {
      throw error;
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  return (await stampOf(path)) !== "absent";
}

/** Applies LSP text edits (UTF-16 positions, non-overlapping) to `text`. */
export function applyTextEdits(path: string, text: string, edits: readonly TextEdit[]): string {
  const lineStarts = computeLineStarts(text);
  const offset = (position: Position): number => {
    if (position.line >= lineStarts.length) {
      return text.length;
    } else {
      const start = lineStarts[position.line];
      const end = position.line + 1 < lineStarts.length ? lineStarts[position.line + 1] : text.length;
      return Math.min(start + position.character, end);
    }
  };
  const resolved = edits
    .map((edit) => ({ start: offset(edit.range.start), end: offset(edit.range.end), text: edit.newText }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < resolved.length; index++) {
    if (resolved[index].start < resolved[index - 1].end) {
      throw new EditError(`overlapping edits in ${path}`);
    } else {
      // ordered and disjoint
    }
  }
  let result = "";
  let cursor = 0;
  for (const edit of resolved) {
    result += text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return result + text.slice(cursor);
}

/** Offsets where each line starts; LSP line breaks are \n, \r\n and \r. */
function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\r") {
      if (text[index + 1] === "\n") {
        index += 1;
      } else {
        // a lone \r ends the line
      }
      starts.push(index + 1);
    } else if (char === "\n") {
      starts.push(index + 1);
    } else {
      // inside a line
    }
  }
  return starts;
}

/* ----------------------------------------------------------------------------
 * Review: unified diffs of a change set
 * ------------------------------------------------------------------------- */

const CONTEXT_LINES = 1;

/** A unified diff of one path change (Myers line diff, one line of context). */
export function unifiedDiff(change: PathChange, label: string): string {
  if (change.before === undefined) {
    return `+++ ${label} (new file, ${lineCount(change.after ?? "")} lines)`;
  } else if (change.after === undefined) {
    return `--- ${label} (removed)`;
  } else {
    const ops = diffLines(change.before.split("\n"), change.after.split("\n"));
    // hunks: runs of changed lines whose unchanged gaps fit in the context of both sides
    const hunks: { start: number; end: number }[] = [];
    ops.forEach((op, index) => {
      const last = hunks.at(-1);
      if (op.kind === "same") {
        // context, attached below
      } else if (last !== undefined && index - last.end <= CONTEXT_LINES * 2) {
        last.end = index + 1;
      } else {
        hunks.push({ start: index, end: index + 1 });
      }
    });
    const out: string[] = [`--- ${label}`];
    for (const hunk of hunks) {
      const start = Math.max(0, hunk.start - CONTEXT_LINES);
      const stop = Math.min(ops.length, hunk.end + CONTEXT_LINES);
      const slice = ops.slice(start, stop);
      const aCount = slice.filter((op) => op.kind !== "add").length;
      const bCount = slice.filter((op) => op.kind !== "del").length;
      out.push(`@@ -${ops[start].aLine + 1},${aCount} +${ops[start].bLine + 1},${bCount} @@`);
      for (const op of slice) {
        out.push(`${DIFF_MARKS[op.kind]}${op.text}`);
      }
    }
    return out.join("\n");
  }
}

function lineCount(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}

type DiffOp = { kind: "same" | "del" | "add"; text: string; aLine: number; bLine: number };
const DIFF_MARKS: Record<DiffOp["kind"], string> = { same: " ", del: "-", add: "+" };

/** Myers O(ND) diff of two line arrays. */
function diffLines(a: readonly string[], b: readonly string[]): DiffOp[] {
  const max = a.length + b.length;
  const v = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0))) {
        x = v.get(k + 1) ?? 0;
      } else {
        x = (v.get(k - 1) ?? 0) + 1;
      }
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v.set(k, x);
      if (x >= a.length && y >= b.length) {
        trace.push(new Map(v));
        break outer;
      } else {
        // keep searching
      }
    }
  }
  const ops: DiffOp[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 2; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && (vd.get(k - 1) ?? 0) < (vd.get(k + 1) ?? 0))) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = vd.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      ops.push({ kind: "same", text: a[x], aLine: x, bLine: y });
    }
    if (d > 0) {
      if (x === prevX) {
        y -= 1;
        ops.push({ kind: "add", text: b[y], aLine: x, bLine: y });
      } else {
        x -= 1;
        ops.push({ kind: "del", text: a[x], aLine: x, bLine: y });
      }
    } else {
      // d = 0: only the common prefix remains, consumed above
    }
  }
  return ops.reverse();
}
