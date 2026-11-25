/**
 * harness - the defaults of new sessions: the last chosen variant, madness and model reference,
 * kept in ~/.harness/harness.json. A session records its own values in session entries (state/);
 * this file only seeds new ones. The implementer is a session's alone: new sessions start with
 * `self`, and a key left in the file by an earlier harness is not read and goes at the next write.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Variant } from "#protocol/state.ts";
import { withFileLock } from "./file-lock.ts";

/** `model`: a model reference (plan 6.2) new sessions resolve and select; pi's own default when absent. */
export type Defaults = { variant: Variant; madness: boolean; model?: string };

/** What a new session starts with when nothing has been chosen yet. */
export const BUILTIN_DEFAULTS: Defaults = { variant: "advanced", madness: false };

export const DEFAULTS_FILE = "harness.json";

/**
 * The defaults in the file: built-in ones when it does not exist yet, and
 * built-in ones with the problem when it cannot be read or holds wrong values.
 */
export function loadDefaults(path: string): { defaults: Defaults; problem?: string } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { defaults: BUILTIN_DEFAULTS };
    } else {
      return { defaults: BUILTIN_DEFAULTS, problem: `${path}: ${(error as Error).message}` };
    }
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { defaults: BUILTIN_DEFAULTS, problem: `${path}: ${(error as Error).message}` };
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { defaults: BUILTIN_DEFAULTS, problem: `${path}: not a JSON object` };
  } else {
    const {
      variant = BUILTIN_DEFAULTS.variant,
      madness = BUILTIN_DEFAULTS.madness,
      model,
    } = data as Record<string, unknown>;
    if (variant !== "advanced" && variant !== "simple") {
      return { defaults: BUILTIN_DEFAULTS, problem: `${path}: variant must be "advanced" or "simple"` };
    } else if (typeof madness !== "boolean") {
      return { defaults: BUILTIN_DEFAULTS, problem: `${path}: madness must be true or false` };
    } else if (model !== undefined && (typeof model !== "string" || !model.includes("/"))) {
      return { defaults: BUILTIN_DEFAULTS, problem: `${path}: model must be a model reference like "anthropic/opus:medium"` };
    } else {
      return { defaults: { variant, madness, ...(model !== undefined ? { model } : {}) } };
    }
  }
}

/**
 * Changes one default and keeps the other as the file holds it now (another
 * session may have changed it). The file is replaced atomically: a reader never
 * sees it half-written. Throws when it cannot be written.
 */
export function saveDefault<K extends keyof Defaults>(path: string, key: K, value: Defaults[K]): void {
  // every agent of the user writes this file: the read and the write are one step under its lock
  withFileLock(`${path}.lock`, () => {
    const next: Defaults = { ...loadDefaults(path).defaults, [key]: value };
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    renameSync(temp, path);
  });
}
