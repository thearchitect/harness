/**
 * Rust: rust-analyzer of the bundle, with the project's own cargo from PATH.
 *
 *   linkedProjects  the root manifest of every Cargo workspace in the tree
 *                   (`cargo locate-project --workspace` for each Cargo.toml):
 *                   rust-analyzer alone looks only one directory deep;
 *   features        all of them (`cargo.features = "all"`), so feature-gated
 *                   code is analyzed too.
 *
 * Readiness is rust-analyzer's own `experimental/serverStatus`: workspace-wide
 * requests wait for `quiescent`. Manifest changes are the driver's: it reloads
 * the workspace explicitly (or reconfigures it when the set of Cargo
 * workspaces changed) and waits for the reload it caused, instead of racing
 * the server's file watcher.
 */

import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename, relative } from "node:path";
import { promisify } from "node:util";
import type { DriverEnv, LanguageDriver, LanguageProfile, ServerLink, SyncOutcome, WorkspaceSummary } from "../profile.ts";
import type { SnapshotDiff } from "../snapshot.ts";

const execFileAsync = promisify(execFile);

const MANIFEST_FILES = new Set(["Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml"]);
/**
 * How long a triggered reload may take to show up as a non-quiescent status;
 * a reload that never shows up within it had nothing to do.
 */
const RELOAD_NOTICE_MS = 10_000;

type Status = { health: "ok" | "warning" | "error"; quiescent: boolean; message?: string };
type Model = { linkedProjects: string[]; manifests: string };

export const rustProfile: LanguageProfile = {
  id: "rust",
  name: "Rust",
  extensions: [".rs"],
  moves: "lsp",
  languageId() {
    return "rust";
  },
  significant(file) {
    // manifests are the driver's: it reloads the workspace itself
    return file.endsWith(".rs");
  },
  createDriver(env) {
    return new RustDriver(env);
  },
};

class RustDriver implements LanguageDriver {
  private readonly env: DriverEnv;
  private model: Model | undefined;
  private readonly workspaceCache = new Map<string, { stamp: string; root: string }>();
  private status: Status | undefined;
  /** Status notifications so far; the last non-quiescent one; the reload awaited (status count and time when triggered). */
  private statusSeq = 0;
  private nonQuiescentSeq: number | undefined;
  private reload: { seq: number; at: number } | undefined;
  private readonly statusWaiters = new Set<() => void>();

  constructor(env: DriverEnv) {
    this.env = env;
  }

  async prepare(files: readonly string[]): Promise<void> {
    try {
      await execFileAsync("cargo", ["--version"]);
    } catch (error) {
      throw new Error(`cargo is not available in PATH; rust-analyzer needs the project's Rust toolchain (${error instanceof Error ? error.message : String(error)})`);
    }
    this.model = await this.discover(files);
  }

  launch() {
    return { command: this.env.toolchain.rustAnalyzer, args: [], env: process.env, cwd: this.env.root };
  }

  initializationOptions(): unknown {
    return this.settings();
  }

  capabilities(): Record<string, unknown> {
    return { experimental: { serverStatusNotification: true } };
  }

  configuration(section: string | undefined): unknown {
    if (section === "rust-analyzer") {
      return this.settings();
    } else {
      return null;
    }
  }

  async initialized(): Promise<void> {
    // the initial workspace load counts as the first reload
    this.reload = { seq: this.statusSeq, at: Date.now() };
  }

  async sync(server: ServerLink, files: readonly string[], _diff: SnapshotDiff, first: boolean): Promise<SyncOutcome> {
    if (first) {
      return "current";
    } else {
      const previous = this.model;
      const manifests = await manifestFingerprint(files);
      if (previous !== undefined && previous.manifests === manifests) {
        return "current";
      } else {
        const next = await this.discover(files);
        this.model = next;
        this.reload = { seq: this.statusSeq, at: Date.now() };
        if (previous !== undefined && previous.linkedProjects.join("\n") === next.linkedProjects.join("\n")) {
          await server.request("rust-analyzer/reloadWorkspace", null);
        } else {
          server.notify("workspace/didChangeConfiguration", { settings: {} });
        }
        return "current";
      }
    }
  }

  async ready(_server: ServerLink, deadline: number): Promise<void> {
    for (;;) {
      const status = this.status;
      const reload = this.reload;
      const reloadDone =
        reload === undefined ||
        (this.nonQuiescentSeq !== undefined && this.nonQuiescentSeq > reload.seq) ||
        Date.now() - reload.at > RELOAD_NOTICE_MS;
      if (status !== undefined && status.quiescent && reloadDone) {
        this.reload = undefined;
        if (status.health === "error") {
          throw new Error(`rust-analyzer cannot load the workspace: ${status.message ?? "no details"}`);
        } else {
          return;
        }
      } else if (Date.now() >= deadline) {
        throw new Error(`rust-analyzer is still loading the workspace${status?.message !== undefined ? `: ${status.message}` : ""}; repeat the request later`);
      } else if (reload !== undefined && status?.quiescent === true) {
        // quiescent, but the reload has not shown up yet: wait for it, or for its notice window to pass
        await this.nextStatus(Math.min(deadline, reload.at + RELOAD_NOTICE_MS + 1));
      } else {
        await this.nextStatus(deadline);
      }
    }
  }

  notification(method: string, params: unknown): void {
    if (method === "experimental/serverStatus") {
      this.statusSeq += 1;
      this.status = params as Status;
      if (!this.status.quiescent) {
        this.nonQuiescentSeq = this.statusSeq;
      } else {
        // quiescent
      }
      for (const wake of this.statusWaiters) {
        wake();
      }
    } else {
      // progress and log messages
    }
  }

  summary(): WorkspaceSummary {
    const model = this.model;
    if (model === undefined) {
      return { lines: ["Rust: not synchronized yet"], facts: {} };
    } else {
      const rel = (file: string): string => relative(this.env.root, file);
      const health = this.status !== undefined && this.status.health !== "ok" ? `; ${this.status.health}: ${this.status.message ?? ""}` : "";
      return {
        lines: [
          `Rust: ${model.linkedProjects.length} Cargo workspaces, all features enabled${health}`,
          ...model.linkedProjects.map((manifest) => `  workspace ${rel(manifest)}`),
          "  not analyzed: cfg branches for other target platforms",
        ],
        facts: { cargoWorkspaces: model.linkedProjects.map(rel), status: this.status ?? null },
      };
    }
  }

  async dispose(): Promise<void> {
    for (const wake of this.statusWaiters) {
      wake();
    }
  }

  private settings(): Record<string, unknown> {
    return {
      linkedProjects: this.model?.linkedProjects ?? [],
      cargo: { features: "all" },
      files: { watcher: "client" },
      checkOnSave: false,
      cachePriming: { enable: true },
    };
  }

  /** Resolves on the next status notification, or at `until`. */
  private nextStatus(until: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(wake, Math.max(0, until - Date.now()));
      const waiters = this.statusWaiters;
      function wake(): void {
        clearTimeout(timer);
        waiters.delete(wake);
        resolve();
      }
      waiters.add(wake);
    });
  }

  private async discover(files: readonly string[]): Promise<Model> {
    const manifests = files.filter((file) => basename(file) === "Cargo.toml").sort();
    const roots = new Set<string>();
    for (const manifest of manifests) {
      roots.add(await this.workspaceRoot(manifest));
    }
    return { linkedProjects: [...roots].sort(), manifests: await manifestFingerprint(files) };
  }

  private async workspaceRoot(manifest: string): Promise<string> {
    const info = await stat(manifest, { bigint: true });
    const stamp = `${info.mtimeNs}:${info.size}`;
    const cached = this.workspaceCache.get(manifest);
    if (cached !== undefined && cached.stamp === stamp) {
      return cached.root;
    } else {
      let root: string;
      try {
        const { stdout } = await execFileAsync(
          "cargo",
          ["locate-project", "--workspace", "--message-format", "plain", "--manifest-path", manifest],
          { cwd: this.env.root },
        );
        root = stdout.trim();
      } catch (error) {
        throw new Error(`cannot locate the Cargo workspace of ${manifest}: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.workspaceCache.set(manifest, { stamp, root });
      return root;
    }
  }
}

async function manifestFingerprint(files: readonly string[]): Promise<string> {
  const manifests = files.filter((file) => MANIFEST_FILES.has(basename(file))).sort();
  const stamps = await Promise.all(
    manifests.map(async (file) => {
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
