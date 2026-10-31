/**
 * What a language contributes to the facade.
 *
 * A LanguageProfile is static: which files belong to the language and how
 * its server moves files. For every server lifetime the session creates a
 * LanguageDriver: it discovers the language's workspace model (projects,
 * modules, crates), hands it to the server and decides when the server is
 * ready to answer workspace-wide questions.
 */

import type { LaunchSpec } from "./client.ts";
import type { SnapshotDiff } from "./snapshot.ts";

export type LanguageId = "ts" | "go" | "rust";

/** Paths of the bundled tools (manifest) the drivers launch or load. */
export type Toolchain = {
  tsgo: string;
  typescriptPackage: string;
  gopls: string;
  rustAnalyzer: string;
};

export type DriverEnv = {
  root: string;
  inGit: boolean;
  toolchain: Toolchain;
  /** A private directory of this server lifetime for generated files; removed on stop. */
  tempDir: string;
};

/** A running server as drivers see it. */
export type ServerLink = {
  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
  notify(method: string, params: unknown): void;
  readonly capabilities: Record<string, unknown>;
};

/** Coverage of the workspace: human lines for the model, and the same facts as data. */
export type WorkspaceSummary = {
  lines: string[];
  facts: Record<string, unknown>;
};

export type SyncOutcome = "current" | "restart";

export interface LanguageDriver {
  /** Discovers what the server needs before it starts (initialization options). */
  prepare(files: readonly string[]): Promise<void>;
  /** The command line; throws with an actionable message when a required toolchain is missing. */
  launch(): LaunchSpec;
  initializationOptions(): unknown;
  /** Client capabilities beyond the facade's common set (merged into `initialize`). */
  capabilities(): Record<string, unknown>;
  /** The answer to `workspace/configuration` for one requested section. */
  configuration(section: string | undefined): unknown;
  /** After `initialized`: attach side channels (the TypeScript API session). */
  initialized(server: ServerLink): Promise<void>;
  /**
   * Brings the server's workspace model up to date with the files on disk.
   * `diff` holds what changed since the previous sync (everything is new on
   * the first one). "restart" asks for a fresh server: a change the running
   * one cannot absorb, such as reinstalled dependencies.
   */
  sync(server: ServerLink, files: readonly string[], diff: SnapshotDiff, first: boolean): Promise<SyncOutcome>;
  /** Resolves when the server can answer workspace-wide requests; rejects with the reason it cannot. */
  ready(server: ServerLink, deadline: number): Promise<void>;
  notification(method: string, params: unknown): void;
  summary(): WorkspaceSummary;
  dispose(): Promise<void>;
}

export interface LanguageProfile {
  readonly id: LanguageId;
  readonly name: string;
  readonly extensions: readonly string[];
  languageId(file: string): string;
  /** Files whose changes the server must hear about. */
  significant(file: string): boolean;
  /**
   * How files of the language move: through the server's
   * `workspace/willRenameFiles`, or only within their directory (Go: a file
   * move across directories is a move of declarations between packages).
   */
  readonly moves: "lsp" | "same-directory";
  createDriver(env: DriverEnv): LanguageDriver;
}
