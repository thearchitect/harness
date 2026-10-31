/**
 * TypeScript and JavaScript: the native TypeScript 7 language server
 * (`tsc --lsp`) of the bundle, whatever TypeScript the project itself uses.
 *
 * The server loads projects lazily, for open files only. The driver keeps the
 * whole repository loaded through the server's API session
 * (`custom/initializeAPISession`, `typescript/unstable/async`):
 * `updateSnapshot` holds open every project the editor would ever use - each
 * tsconfig.json/jsconfig.json and everything reachable from them through
 * `references` - and every source file outside all of them, so cross-project
 * references, rename and file moves see every package.
 *
 * Reinstalled dependencies (a changed lockfile or node_modules marker) need a
 * fresh server: the client never reports node_modules changes, so the running
 * one could keep resolving against the old packages.
 */

import { stat } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseJsonc } from "../jsonc.ts";
import type { DriverEnv, LanguageDriver, LanguageProfile, ServerLink, SyncOutcome, WorkspaceSummary } from "../profile.ts";
import type { SnapshotDiff } from "../snapshot.ts";

const LANGUAGE_IDS: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact",
};
/**
 * The server's js/ts settings. A rename renames everywhere: with aliases (the
 * editor default) a re-export would become `export { newName as oldName }`
 * and keep the old name alive for its importers.
 */
const JS_TS_SETTINGS = { preferences: { useAliasesForRenames: false } };
const ROOT_CONFIG_NAMES = new Set(["tsconfig.json", "jsconfig.json"]);
const CONFIG_PATTERN = /^(?:tsconfig|jsconfig)[^/]*\.json$/;
const LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]);
/** Files package managers rewrite inside node_modules on every install. */
const INSTALL_MARKERS = [".package-lock.json", ".modules.yaml", ".yarn-state.yml"];

type ApiModule = typeof import("typescript/unstable/async");
type Api = Awaited<ReturnType<ApiModule["API"]["fromLSPConnection"]>>;

type Model = {
  /** Every config the server holds open, absolute. */
  configs: string[];
  /** Source files outside every config, absolute. */
  looseFiles: string[];
  /** References to configs that do not exist (nothing to load). */
  missingReferences: string[];
  /** Fingerprint of installed dependencies. */
  installs: string;
};

function isSource(file: string): boolean {
  return extname(file) in LANGUAGE_IDS;
}

function isConfig(file: string): boolean {
  return CONFIG_PATTERN.test(basename(file));
}

export const typescriptProfile: LanguageProfile = {
  id: "ts",
  name: "TypeScript/JavaScript",
  extensions: Object.keys(LANGUAGE_IDS),
  moves: "lsp",
  languageId(file) {
    return LANGUAGE_IDS[extname(file)] ?? "typescript";
  },
  significant(file) {
    const name = basename(file);
    return isSource(file) || isConfig(file) || name === "package.json" || LOCKFILES.has(name);
  },
  createDriver(env) {
    return new TypeScriptDriver(env);
  },
};

class TypeScriptDriver implements LanguageDriver {
  private readonly env: DriverEnv;
  private api: Api | undefined;
  private model: Model | undefined;

  constructor(env: DriverEnv) {
    this.env = env;
  }

  async prepare(): Promise<void> {
    // the model needs the API session, which needs the running server
  }

  launch() {
    return { command: this.env.toolchain.tsgo, args: ["--lsp", "--stdio"], env: process.env, cwd: this.env.root };
  }

  initializationOptions(): unknown {
    return {};
  }

  capabilities(): Record<string, unknown> {
    return {};
  }

  configuration(section: string | undefined): unknown {
    if (section === "js/ts") {
      return JS_TS_SETTINGS;
    } else {
      // typescript, javascript, editor: the server's defaults
      return null;
    }
  }

  async initialized(server: ServerLink): Promise<void> {
    const { pipe } = await server.request<{ pipe: string }>("custom/initializeAPISession", {});
    const require = createRequire(join(this.env.toolchain.typescriptPackage, "package.json"));
    const module = (await import(pathToFileURL(require.resolve("typescript/unstable/async")).href)) as ApiModule;
    this.api = await module.API.fromLSPConnection({ pipe });
  }

  async sync(server: ServerLink, files: readonly string[], diff: SnapshotDiff, first: boolean): Promise<SyncOutcome> {
    const api = this.api;
    if (api === undefined) {
      throw new Error("the TypeScript API session is not attached");
    } else {
      const installs = await installFingerprint(files);
      const previous = this.model;
      if (previous !== undefined && previous.installs !== installs) {
        return "restart";
      } else if (previous !== undefined && !first && !this.touchesModel(previous, diff)) {
        return "current";
      } else {
        const next = await this.discover(api, files, installs);
        const snapshot = await api.updateSnapshot({
          openProjects: missing(next.configs, previous?.configs),
          closeProjects: missing(previous?.configs ?? [], next.configs),
          openFiles: missing(next.looseFiles, previous?.looseFiles),
          closeFiles: missing(previous?.looseFiles ?? [], next.looseFiles),
        });
        await snapshot.dispose();
        if (previous === undefined) {
          // TypeScript 7.0.2 asks for the settings at initialization, and again
          // takes a configuration change sent before the projects are loaded,
          // without applying either to renames (verified: they keep the alias);
          // a change after the first snapshot applies.
          server.notify("workspace/didChangeConfiguration", { settings: { "js/ts": JS_TS_SETTINGS } });
        } else {
          // configured with the first snapshot of this server
        }
        this.model = next;
        return "current";
      }
    }
  }

  async ready(): Promise<void> {
    // updateSnapshot returns once the projects are loaded
  }

  notification(): void {
    // nothing to track
  }

  summary(): WorkspaceSummary {
    const model = this.model;
    if (model === undefined) {
      return { lines: ["TypeScript/JavaScript: not synchronized yet"], facts: {} };
    } else {
      const rel = (file: string): string => relative(this.env.root, file);
      return {
        lines: [
          `TypeScript/JavaScript (TypeScript 7): ${model.configs.length} tsconfig/jsconfig projects, ${model.looseFiles.length} files outside every project (analyzed with default options)`,
          ...model.configs.map((config) => `  project ${rel(config)}`),
          ...model.missingReferences.map((config) => `  missing referenced project ${rel(config)} (skipped)`),
        ],
        facts: {
          projects: model.configs.map(rel),
          filesOutsideProjects: model.looseFiles.map(rel),
          missingReferences: model.missingReferences.map(rel),
        },
      };
    }
  }

  async dispose(): Promise<void> {
    const api = this.api;
    this.api = undefined;
    if (api !== undefined) {
      await api.close().catch(() => {
        // the server is gone with its pipe
      });
    } else {
      // never attached
    }
  }

  /** Whether a change can alter the model: files appeared or vanished, or a config changed. */
  private touchesModel(model: Model, diff: SnapshotDiff): boolean {
    const configs = new Set(model.configs);
    return (
      diff.created.length > 0 ||
      diff.deleted.length > 0 ||
      diff.changed.some((file) => configs.has(file) || isConfig(file))
    );
  }

  private async discover(api: Api, files: readonly string[], installs: string): Promise<Model> {
    const configs: string[] = [];
    const missingReferences: string[] = [];
    {
      const seen = new Set<string>();
      const queue = files.filter((file) => ROOT_CONFIG_NAMES.has(basename(file)));
      while (queue.length > 0) {
        const config = queue.shift()!;
        if (seen.has(config)) {
          continue;
        } else if (!(await exists(config))) {
          missingReferences.push(config);
          seen.add(config);
        } else {
          seen.add(config);
          configs.push(config);
          for (const reference of await projectReferences(config)) {
            queue.push(reference);
          }
        }
      }
    }
    const covered = new Set<string>();
    for (const config of configs) {
      const parsed = await api.parseConfigFile(config);
      for (const file of parsed.fileNames) {
        covered.add(resolve(file));
      }
    }
    return {
      configs: configs.sort(),
      looseFiles: files.filter((file) => isSource(file) && !covered.has(file)).sort(),
      missingReferences: missingReferences.sort(),
      installs,
    };
  }
}

/** The configs a config references, absolute: a directory reference means its tsconfig.json. */
async function projectReferences(config: string): Promise<string[]> {
  let parsed: unknown;
  try {
    parsed = parseJsonc(await readFile(config, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${config}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const references = (parsed as { references?: unknown }).references;
  if (!Array.isArray(references)) {
    return [];
  } else {
    const targets: string[] = [];
    for (const reference of references) {
      const path = (reference as { path?: unknown }).path;
      if (typeof path === "string") {
        const target = resolve(dirname(config), path);
        targets.push(target.endsWith(".json") ? target : join(target, "tsconfig.json"));
      } else {
        throw new Error(`${config}: a reference without a "path"`);
      }
    }
    return targets;
  }
}

/** Stamps of lockfiles and of the files package managers rewrite in node_modules on install. */
async function installFingerprint(files: readonly string[]): Promise<string> {
  const lockfiles = files.filter((file) => LOCKFILES.has(basename(file))).sort();
  const candidates = [
    ...lockfiles,
    ...[...new Set(lockfiles.map(dirname))].flatMap((dir) => INSTALL_MARKERS.map((marker) => join(dir, "node_modules", marker))),
  ];
  const stamps = await Promise.all(
    candidates.map(async (file) => {
      try {
        const info = await stat(file, { bigint: true });
        return `${file}:${info.mtimeNs}:${info.size}`;
      } catch {
        return `${file}:absent`;
      }
    }),
  );
  return stamps.join("\n");
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** Items of `wanted` absent from `present`. */
function missing(wanted: readonly string[], present: readonly string[] | undefined): string[] {
  const have = new Set(present ?? []);
  return wanted.filter((item) => !have.has(item));
}
