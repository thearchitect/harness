// The UI settings of a user, kept by the node the user's clients come through: themes, fonts, the
// open tabs (ui.tabs), task defaults. Stored in ~/.harness/ui-settings.json, apart from pi's
// settings.json, which agents write themselves. Changes reach every client of the user.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Settings = Record<string, unknown>;

export class SettingsStore {
  private readonly path: string;
  private readonly listeners = new Set<(settings: Settings) => void>();

  constructor(dataDir: string) {
    this.path = join(dataDir, "ui-settings.json");
  }

  read(): Settings {
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Settings) : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      } else {
        throw new Error(`${this.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Sets one key (dotted keys are flat: "ui.tabs"), replacing the file atomically. */
  set(key: string, value: unknown): Settings {
    const next = { ...this.read(), [key]: value };
    if (value === undefined) {
      delete next[key];
    } else {
      // set above
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(temp, this.path);
    for (const listener of this.listeners) {
      listener(next);
    }
    return next;
  }

  onChange(listener: (settings: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
