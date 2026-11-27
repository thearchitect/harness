// Where the TUI keeps its window's state (client/workbench/view-state.ts): ~/.harness/client/window.json,
// written under its lock and merged by tab, so two windows keep each other's tabs; the active tab and
// the hub are the window's that saved last.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { layoutOf } from "#protocol/layout.ts";
import { mergeWindowStates, windowState, type ViewStateStore, type WindowState } from "#client/workbench/view-state.ts";
import { withFileLock } from "#extension/core/file-lock.ts";

function read(path: string): WindowState | undefined {
  try {
    return windowState(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined; // none yet, or unreadable: a first start
  }
}

export function tuiViewStore(home: string): ViewStateStore {
  const path = layoutOf(home).window;
  return {
    load: async () => read(path),
    save: async (state) => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      withFileLock(`${path}.lock`, () => {
        const temp = `${path}.${process.pid}.tmp`;
        writeFileSync(temp, `${JSON.stringify(mergeWindowStates(read(path), state), null, 2)}\n`, { mode: 0o600 });
        renameSync(temp, path);
      });
    },
  };
}
