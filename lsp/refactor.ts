/**
 * Refactorings: a list of operations applied one after another, each on the
 * state the previous ones left. The whole list is approved once (by the
 * caller); every operation is computed by the language servers on the files
 * as they are now and written atomically on its own.
 *
 * A failing operation stops the run: the operations before it stay applied,
 * and the caller gets the failed one and the rest to retry from. A plan file
 * is cut down to exactly those, so the model fixes its first entry and runs
 * the same file again.
 */

import { readFile, writeFile } from "node:fs/promises";
import { commitChanges, type ChangeSet, type LockPaths, type PathChange } from "./edits.ts";
import type { Facade, SymbolRef } from "./facade.ts";
import { generatedFiles } from "./generated.ts";

export type Operation =
  | { rename: SymbolRef & { newName: string } }
  | { move: { from: string; to: string } }
  | { codeAction: { file: string; title: string; startLine?: number; endLine?: number } }
  | { edit: { file: string; oldText: string; newText: string } };

export type OperationKind = "rename" | "move" | "codeAction" | "edit";

export type RefactorOutcome = {
  /** How many operations were applied, from the first. */
  applied: number;
  /** The net change of the applied operations. */
  net: ChangeSet;
  /** Symbols renamed in files that look generated: change their source and regenerate. */
  warnings: string[];
  failure: { index: number; reason: string } | undefined;
};

export function operationKind(operation: Operation): OperationKind {
  if ("rename" in operation) {
    return "rename";
  } else if ("move" in operation) {
    return "move";
  } else if ("codeAction" in operation) {
    return "codeAction";
  } else if ("edit" in operation) {
    return "edit";
  } else {
    throw new Error(`unknown operation: ${JSON.stringify(operation satisfies never)}`);
  }
}

/** One line per operation, for approval dialogs and errors. */
export function describeOperation(operation: Operation): string {
  if ("rename" in operation) {
    const { file, line, name, newName } = operation.rename;
    return `rename ${name} → ${newName} (${file}:${line})`;
  } else if ("move" in operation) {
    return `move ${operation.move.from} → ${operation.move.to}`;
  } else if ("codeAction" in operation) {
    const { file, title, startLine, endLine } = operation.codeAction;
    return `code action ${JSON.stringify(title)} (${file}${startLine !== undefined ? `:${startLine}${endLine !== undefined ? `-${endLine}` : ""}` : ""})`;
  } else if ("edit" in operation) {
    const firstLine = operation.edit.oldText.split("\n")[0];
    return `edit ${operation.edit.file}: ${JSON.stringify(firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine)}`;
  } else {
    throw new Error(`unknown operation: ${JSON.stringify(operation satisfies never)}`);
  }
}

/* ----------------------------------------------------------------------------
 * Plan files: a JSON array of operations
 * ------------------------------------------------------------------------- */

export async function readPlan(path: string): Promise<Operation[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read the plan ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`the plan ${path} must be a JSON array of operations`);
  } else {
    return parsed.map((entry, index) => parseOperation(entry, `${path}[${index}]`));
  }
}

/** The plan file reduced to `operations`, one per line. */
export async function writePlan(path: string, operations: readonly Operation[]): Promise<void> {
  await writeFile(path, `[\n${operations.map((operation) => `  ${JSON.stringify(operation)}`).join(",\n")}\n]\n`, "utf8");
}

export function parseOperation(entry: unknown, where: string): Operation {
  const fail = (message: string): never => {
    throw new Error(`${where}: ${message}`);
  };
  const record = (value: unknown, what: string): Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : fail(`${what} must be an object`);
  const text = (value: unknown, what: string): string => (typeof value === "string" ? value : fail(`${what} must be a string`));
  const line = (value: unknown, what: string): number =>
    typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : fail(`${what} must be a 1-based line number`);
  const optionalLine = (value: unknown, what: string): number | undefined => (value === undefined ? undefined : line(value, what));

  const operation = record(entry, "an operation");
  const keys = Object.keys(operation);
  if (keys.length !== 1) {
    return fail(`an operation has exactly one of rename, move, codeAction, edit; got ${keys.join(", ") || "none"}`);
  } else {
    const [kind] = keys;
    const body = record(operation[kind], kind);
    switch (kind) {
      case "rename":
        return {
          rename: {
            file: text(body.file, "rename.file"),
            line: line(body.line, "rename.line"),
            name: text(body.name, "rename.name"),
            ...(body.occurrence !== undefined ? { occurrence: line(body.occurrence, "rename.occurrence") } : {}),
            newName: text(body.newName, "rename.newName"),
          },
        };
      case "move":
        return { move: { from: text(body.from, "move.from"), to: text(body.to, "move.to") } };
      case "codeAction":
        return {
          codeAction: {
            file: text(body.file, "codeAction.file"),
            title: text(body.title, "codeAction.title"),
            ...(body.startLine !== undefined ? { startLine: line(body.startLine, "codeAction.startLine") } : {}),
            ...(body.endLine !== undefined ? { endLine: optionalLine(body.endLine, "codeAction.endLine") } : {}),
          },
        };
      case "edit":
        return { edit: { file: text(body.file, "edit.file"), oldText: text(body.oldText, "edit.oldText"), newText: text(body.newText, "edit.newText") } };
      default:
        return fail(`unknown operation ${JSON.stringify(kind)}; use rename, move, codeAction or edit`);
    }
  }
}

/* ----------------------------------------------------------------------------
 * Running
 * ------------------------------------------------------------------------- */

export type RunOptions = {
  lock: LockPaths;
  signal: AbortSignal | undefined;
  onProgress: (done: number, total: number, current: string) => void;
};

export async function runRefactor(facade: Facade, operations: readonly Operation[], options: RunOptions): Promise<RefactorOutcome> {
  const steps: ChangeSet[] = [];
  const warnings: string[] = [];
  const commit = async (set: ChangeSet): Promise<void> => {
    await commitChanges(set, options.lock);
    steps.push(set);
  };
  for (const [index, operation] of operations.entries()) {
    if (options.signal?.aborted) {
      return { applied: index, net: netChange(steps), warnings, failure: { index, reason: "interrupted by the user" } };
    } else {
      options.onProgress(index, operations.length, describeOperation(operation));
      try {
        await apply(facade, operation, commit, warnings);
      } catch (error) {
        return { applied: index, net: netChange(steps), warnings, failure: { index, reason: error instanceof Error ? error.message : String(error) } };
      }
    }
  }
  return { applied: operations.length, net: netChange(steps), warnings, failure: undefined };
}

async function apply(facade: Facade, operation: Operation, commit: (set: ChangeSet) => Promise<void>, warnings: string[]): Promise<void> {
  if ("rename" in operation) {
    const { newName, ...ref } = operation.rename;
    const { set, definitions } = await facade.rename(ref, newName);
    await commit(set);
    const generated = await generatedFiles(facade.workspace.root, facade.workspace.inGit, definitions);
    for (const [file, reason] of generated) {
      warnings.push(
        `${ref.name} → ${newName}: defined in ${facade.workspace.display(file)}, which looks generated (${reason}); make the same change in its source and regenerate after this refactoring`,
      );
    }
  } else if ("move" in operation) {
    await commit(await facade.moveFiles([operation.move]));
  } else if ("codeAction" in operation) {
    const { file, title, startLine, endLine } = operation.codeAction;
    const first = startLine ?? 1;
    // without lines the action applies to the whole file (the range is clamped to its end)
    const last = endLine ?? (startLine !== undefined ? startLine : Number.MAX_SAFE_INTEGER);
    await facade.applyCodeAction(file, first, last, title, async (set) => {
      await commit(set);
      return { applied: true };
    });
  } else if ("edit" in operation) {
    await commit(await facade.replaceText(operation.edit.file, operation.edit.oldText, operation.edit.newText));
  } else {
    throw new Error(`unknown operation: ${JSON.stringify(operation satisfies never)}`);
  }
}

/**
 * The net effect of consecutive change sets: each path from its state before
 * the first step to its state after the last; moves composed (a→b, b→c is a→c).
 */
export function netChange(steps: readonly ChangeSet[]): ChangeSet {
  const states = new Map<string, PathChange>();
  const origins = new Map<string, string>();
  for (const step of steps) {
    for (const change of step.changes) {
      const known = states.get(change.path);
      states.set(change.path, { path: change.path, before: known !== undefined ? known.before : change.before, after: change.after, mode: change.mode });
    }
    for (const move of step.moves) {
      const origin = origins.get(move.from) ?? move.from;
      origins.delete(move.from);
      origins.set(move.to, origin);
    }
  }
  return {
    changes: [...states.values()].filter((change) => change.before !== change.after).sort((a, b) => a.path.localeCompare(b.path)),
    moves: [...origins].filter(([to, from]) => to !== from).map(([to, from]) => ({ from, to })),
    stamps: new Map(),
  };
}
