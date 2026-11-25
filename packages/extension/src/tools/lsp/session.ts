/**
 * One language server over its whole life: start, synchronization with the
 * files on disk, requests, crashes and stop.
 *
 *   idle ──run──► starting ──► running ──exit──► crashed ──run──► starting …
 *                    │fail                          │ 3 crashes in 2 min
 *                    ▼                              ▼
 *                 crashed                         failed  (until restart())
 *   any ──stop──► stopping ──► stopped                    (terminal)
 *
 * Every request runs after a synchronization that started after the request
 * arrived: the server hears about each file created, changed or deleted on
 * disk since the previous one, the driver updates the workspace model, and
 * the server confirms it is ready. Documents are open only while a request
 * needs them, so the server never holds stale editor content.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ErrorCodes, RpcError, ServerProcess, describeExit, type ConnectionHandlers } from "./client.ts";
import type { LanguageDriver, LanguageProfile, ServerLink, Toolchain, WorkspaceSummary } from "./profile.ts";
import { assertNever, type Diagnostic, type FileEvent, type WorkspaceEdit } from "./protocol.ts";
import { diffSnapshots, isEmptyDiff, listFiles, stampFiles, type Snapshot, type SnapshotDiff } from "./snapshot.ts";

export const TIMEOUTS = {
  initialize: 60_000,
  request: 60_000,
  /** Requests that compute workspace edits over the whole repository. */
  edit: 120_000,
  /** How long a synchronization may wait for the server to become ready (indexing). */
  ready: 300_000,
  /** How long to wait for pushed diagnostics of a freshly opened document. */
  diagnostics: 15_000,
} as const;

const CRASH_WINDOW_MS = 120_000;
const CRASH_LIMIT = 3;

/** Client capabilities common to every server. */
const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ["utf-16"] },
  window: { workDoneProgress: true },
  workspace: {
    applyEdit: true,
    configuration: true,
    workspaceFolders: true,
    didChangeConfiguration: { dynamicRegistration: true },
    didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
    workspaceEdit: { documentChanges: true, resourceOperations: ["create", "rename", "delete"], failureHandling: "abort" },
    fileOperations: { willRename: true, didRename: true },
    symbol: { resolveSupport: { properties: ["location.range"] } },
  },
  textDocument: {
    synchronization: { didSave: false, willSave: false },
    hover: { contentFormat: ["markdown", "plaintext"] },
    definition: { linkSupport: true },
    typeDefinition: { linkSupport: true },
    implementation: { linkSupport: true },
    references: {},
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    rename: { prepareSupport: true },
    codeAction: {
      codeActionLiteralSupport: {
        codeActionKind: {
          valueSet: ["", "quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source", "source.organizeImports", "source.fixAll"],
        },
      },
      resolveSupport: { properties: ["edit"] },
      dataSupport: true,
      isPreferredSupport: true,
      disabledSupport: true,
    },
    publishDiagnostics: { versionSupport: true },
    diagnostic: { dynamicRegistration: false },
    callHierarchy: {},
    typeHierarchy: {},
  },
};

type Running = {
  process: ServerProcess;
  link: ServerLink;
  driver: LanguageDriver;
  tempDir: string;
  /** Stamps of the significant files the server last heard about; undefined before the first sync. */
  snapshot: Snapshot | undefined;
};

type State =
  | { kind: "idle" }
  | { kind: "starting"; started: Promise<Running> }
  | { kind: "running"; running: Running }
  | { kind: "crashed"; reason: string }
  | { kind: "failed"; reason: string }
  | { kind: "stopping"; stopped: Promise<void> }
  | { kind: "stopped" };

type Synced = { running: Running; basis: Snapshot };

type OpenDocument = { count: number; version: number; opened: Promise<void>; publishSeq: number };
type PublishedDiagnostics = { seq: number; version: number | undefined; items: Diagnostic[] };

export type SessionStatus = {
  language: string;
  name: string;
  state: State["kind"];
  reason: string | undefined;
  summary: WorkspaceSummary | undefined;
};

/** What a request sees: the synchronized server and the snapshot it was synchronized to. */
export type RequestScope = {
  readonly link: ServerLink;
  /** Stamps of the files as the server saw them; edits are applied only if the files still match. */
  readonly basis: Snapshot;
  /** Runs `fn` with `file` open in the server (reference-counted across concurrent requests). */
  withDocument<T>(file: string, fn: (uri: string) => Promise<T>): Promise<T>;
  /** Diagnostics of an open document: pulled when the server supports it, otherwise the next push. */
  diagnostics(uri: string): Promise<{ items: Diagnostic[]; complete: boolean }>;
};

export type ApplyEditHandler = (edit: WorkspaceEdit) => Promise<{ applied: boolean; failureReason?: string }>;

export type SessionEnv = { root: string; inGit: boolean; toolchain: Toolchain };

export class LanguageSession {
  readonly profile: LanguageProfile;
  private readonly env: SessionEnv;
  private state: State = { kind: "idle" };
  private crashes: number[] = [];
  private syncCurrent: Promise<Synced> | undefined;
  private syncNext: Promise<Synced> | undefined;
  private readonly documents = new Map<string, OpenDocument>();
  private readonly published = new Map<string, PublishedDiagnostics>();
  private readonly publishWaiters = new Map<string, Set<() => void>>();
  private publishSeq = 0;
  /** Set while a code action command runs: the server applies its edits through `workspace/applyEdit`. */
  applyEditHandler: ApplyEditHandler | undefined;

  constructor(profile: LanguageProfile, env: SessionEnv) {
    this.profile = profile;
    this.env = env;
  }

  /** Runs `fn` against a running server synchronized after this call began. */
  async run<T>(fn: (scope: RequestScope) => Promise<T>): Promise<T> {
    const { running, basis } = await this.synced();
    return await fn(this.scope(running, basis));
  }

  status(): SessionStatus {
    const state = this.state;
    const base = { language: this.profile.id, name: this.profile.name, state: state.kind };
    switch (state.kind) {
      case "running":
        return { ...base, reason: undefined, summary: state.running.driver.summary() };
      case "crashed":
      case "failed":
        return { ...base, reason: state.reason, summary: undefined };
      case "idle":
      case "starting":
      case "stopping":
      case "stopped":
        return { ...base, reason: undefined, summary: undefined };
      default:
        return assertNever(state);
    }
  }

  /** Stops the server for good (session shutdown). Idempotent. */
  async stop(): Promise<void> {
    await this.halt();
    this.state = { kind: "stopped" };
  }

  /** Stops the server and forgets its crashes; the next request starts a fresh one. */
  async restart(): Promise<void> {
    await this.halt();
    this.crashes = [];
    this.state = { kind: "idle" };
  }

  /* ------------------------------------------------------------------------
   * Lifecycle
   * --------------------------------------------------------------------- */

  private async ensureRunning(): Promise<Running> {
    const state = this.state;
    switch (state.kind) {
      case "running":
        return state.running;
      case "starting":
        return await state.started;
      case "idle":
        return await this.start();
      case "crashed": {
        const now = Date.now();
        this.crashes = this.crashes.filter((at) => now - at < CRASH_WINDOW_MS);
        if (this.crashes.length >= CRASH_LIMIT) {
          const reason = `${this.profile.name} server failed ${this.crashes.length} times within ${CRASH_WINDOW_MS / 60_000} minutes; last failure: ${state.reason}. Run /lsp restart ${this.profile.id} after fixing the cause.`;
          this.state = { kind: "failed", reason };
          throw new Error(reason);
        } else {
          return await this.start();
        }
      }
      case "failed":
        throw new Error(state.reason);
      case "stopping":
      case "stopped":
        throw new Error(`the ${this.profile.name} server is shut down with the session`);
      default:
        return assertNever(state);
    }
  }

  private start(): Promise<Running> {
    const started = this.launch();
    this.state = { kind: "starting", started };
    return started.then(
      (running) => {
        if (this.state.kind === "starting" && this.state.started === started) {
          this.state = { kind: "running", running };
          void running.process.exited.then((status) => this.onExit(running, describeExit(status)));
          return running;
        } else {
          // stopped while starting: the halt path owns the cleanup of this server
          void this.dispose(running);
          throw new Error(`the ${this.profile.name} server was stopped while starting`);
        }
      },
      (error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        if (this.state.kind === "starting" && this.state.started === started) {
          this.crashes.push(Date.now());
          this.state = { kind: "crashed", reason };
        } else {
          // stopped while starting: the stop state stands
        }
        throw new Error(`cannot start the ${this.profile.name} server: ${reason}`);
      },
    );
  }

  private async launch(): Promise<Running> {
    const tempDir = await mkdtemp(join(tmpdir(), `harness-lsp-${this.profile.id}-`));
    const driver = this.profile.createDriver({ ...this.env, tempDir });
    let process: ServerProcess | undefined;
    try {
      await driver.prepare(await listFiles(this.env.root, this.env.inGit));
      process = await ServerProcess.spawn(driver.launch(), this.handlers(driver));
      const connection = process.connection;
      const initialized = await connection.request<{ capabilities: Record<string, unknown> }>(
        "initialize",
        {
          processId: globalThis.process.pid,
          clientInfo: { name: "harness" },
          locale: "en",
          rootUri: pathToFileURL(this.env.root).href,
          rootPath: this.env.root,
          workspaceFolders: [{ uri: pathToFileURL(this.env.root).href, name: basename(this.env.root) }],
          capabilities: mergeDeep(CLIENT_CAPABILITIES, driver.capabilities()),
          initializationOptions: driver.initializationOptions(),
        },
        { timeoutMs: TIMEOUTS.initialize },
      );
      connection.notify("initialized", {});
      const link: ServerLink = {
        request: (method, params, timeoutMs = TIMEOUTS.request) => connection.request(method, params, { timeoutMs }),
        notify: (method, params) => connection.notify(method, params),
        capabilities: initialized.capabilities,
      };
      await driver.initialized(link);
      return { process, link, driver, tempDir, snapshot: undefined };
    } catch (error) {
      const suffix = process?.stderrSuffix() ?? "";
      await process?.stop();
      await driver.dispose();
      await rm(tempDir, { recursive: true, force: true });
      throw new Error(`${error instanceof Error ? error.message : String(error)}${suffix}`);
    }
  }

  private onExit(running: Running, exit: string): void {
    if (this.state.kind === "running" && this.state.running === running) {
      this.crashes.push(Date.now());
      this.state = { kind: "crashed", reason: `the server exited unexpectedly (${exit})${running.process.stderrSuffix()}` };
      this.forgetDocuments();
      void this.dispose(running);
    } else {
      // an exit the halt path initiated
    }
  }

  private async halt(): Promise<void> {
    const state = this.state;
    switch (state.kind) {
      case "running": {
        const stopped = this.dispose(state.running);
        this.state = { kind: "stopping", stopped };
        await stopped;
        return;
      }
      case "starting": {
        const stopped = state.started.then(
          (running) => this.dispose(running),
          () => {
            // the start failed: nothing is running
          },
        );
        this.state = { kind: "stopping", stopped };
        await stopped;
        return;
      }
      case "stopping":
        await state.stopped;
        return;
      case "idle":
      case "crashed":
      case "failed":
      case "stopped":
        // nothing is running
        return;
      default:
        return assertNever(state);
    }
  }

  private async dispose(running: Running): Promise<void> {
    this.forgetDocuments();
    await running.process.stop();
    await running.driver.dispose();
    await rm(running.tempDir, { recursive: true, force: true });
  }

  private forgetDocuments(): void {
    this.documents.clear();
    this.published.clear();
    for (const waiters of this.publishWaiters.values()) {
      for (const wake of waiters) {
        wake();
      }
    }
    this.publishWaiters.clear();
  }

  /* ------------------------------------------------------------------------
   * Synchronization
   * --------------------------------------------------------------------- */

  /**
   * A synchronization that started after this call: joins the queued one if
   * a sync is already running (it began before this call and may have missed
   * a change), or starts one.
   */
  private synced(): Promise<Synced> {
    if (this.syncCurrent === undefined) {
      return this.startSync();
    } else if (this.syncNext === undefined) {
      const next = this.syncCurrent
        .catch(() => {
          // the running sync's failure belongs to its own callers
        })
        .then(() => {
          this.syncNext = undefined;
          return this.startSync();
        });
      this.syncNext = next;
      return next;
    } else {
      return this.syncNext;
    }
  }

  private startSync(): Promise<Synced> {
    const sync = this.ensureRunning().then((running) => this.sync(running));
    this.syncCurrent = sync;
    void sync
      .catch(() => {
        // reported to the callers of synced()
      })
      .finally(() => {
        if (this.syncCurrent === sync) {
          this.syncCurrent = undefined;
        } else {
          // a newer sync already took the slot
        }
      });
    return sync;
  }

  private async sync(running: Running): Promise<Synced> {
    const files = await listFiles(this.env.root, this.env.inGit);
    const snapshot = await stampFiles(files.filter((file) => this.profile.significant(file)));
    const first = running.snapshot === undefined;
    let diff: SnapshotDiff;
    if (running.snapshot === undefined) {
      diff = { created: [...snapshot.keys()], changed: [], deleted: [] };
    } else {
      diff = diffSnapshots(running.snapshot, snapshot);
      if (!isEmptyDiff(diff)) {
        await this.announce(running, diff);
      } else {
        // nothing changed on disk since the server last heard
      }
    }
    const outcome = await running.driver.sync(running.link, files, diff, first);
    switch (outcome) {
      case "current":
        await running.driver.ready(running.link, Date.now() + TIMEOUTS.ready);
        running.snapshot = snapshot;
        return { running, basis: snapshot };
      case "restart":
        await this.halt();
        this.state = { kind: "idle" };
        return await this.sync(await this.ensureRunning());
      default:
        return assertNever(outcome);
    }
  }

  /** Tells the server about the files that changed on disk, including open documents' new text. */
  private async announce(running: Running, diff: SnapshotDiff): Promise<void> {
    const changes: FileEvent[] = [
      ...diff.created.map((file) => ({ uri: pathToFileURL(file).href, type: 1 as const })),
      ...diff.changed.map((file) => ({ uri: pathToFileURL(file).href, type: 2 as const })),
      ...diff.deleted.map((file) => ({ uri: pathToFileURL(file).href, type: 3 as const })),
    ];
    running.link.notify("workspace/didChangeWatchedFiles", { changes });
    for (const file of diff.changed) {
      const uri = pathToFileURL(file).href;
      const document = this.documents.get(uri);
      if (document !== undefined) {
        await document.opened;
        document.version += 1;
        running.link.notify("textDocument/didChange", {
          textDocument: { uri, version: document.version },
          contentChanges: [{ text: await readFile(file, "utf8") }],
        });
      } else {
        // not open: the server reads it from disk
      }
    }
  }

  /* ------------------------------------------------------------------------
   * Requests
   * --------------------------------------------------------------------- */

  private scope(running: Running, basis: Snapshot): RequestScope {
    return {
      link: running.link,
      basis,
      withDocument: (file, fn) => this.withDocument(running, file, fn),
      diagnostics: (uri) => this.documentDiagnostics(running, uri),
    };
  }

  private async withDocument<T>(running: Running, file: string, fn: (uri: string) => Promise<T>): Promise<T> {
    const uri = pathToFileURL(file).href;
    let document = this.documents.get(uri);
    if (document === undefined) {
      const opening: OpenDocument = { count: 0, version: 1, opened: Promise.resolve(), publishSeq: this.publishSeq };
      opening.opened = readFile(file, "utf8").then((text) => {
        running.link.notify("textDocument/didOpen", {
          textDocument: { uri, languageId: this.profile.languageId(file), version: opening.version, text },
        });
      });
      this.documents.set(uri, opening);
      document = opening;
    } else {
      // already open for a concurrent request
    }
    document.count += 1;
    try {
      await document.opened;
      return await fn(uri);
    } finally {
      document.count -= 1;
      if (document.count === 0 && this.documents.get(uri) === document) {
        this.documents.delete(uri);
        if (running.process.running) {
          running.link.notify("textDocument/didClose", { textDocument: { uri } });
        } else {
          // the server is gone; nothing to close
        }
      } else {
        // still in use, or forgotten with a crashed server
      }
    }
  }

  private async documentDiagnostics(running: Running, uri: string): Promise<{ items: Diagnostic[]; complete: boolean }> {
    if (running.link.capabilities.diagnosticProvider !== undefined) {
      const report = await running.link.request<{ kind: string; items?: Diagnostic[] }>("textDocument/diagnostic", {
        textDocument: { uri },
      });
      return { items: report.items ?? [], complete: true };
    } else {
      const document = this.documents.get(uri);
      const after = document?.publishSeq ?? 0;
      const published = await this.nextPublish(uri, after, Date.now() + TIMEOUTS.diagnostics);
      if (published !== undefined) {
        return { items: published.items, complete: true };
      } else {
        return { items: [], complete: false };
      }
    }
  }

  private async nextPublish(uri: string, after: number, deadline: number): Promise<PublishedDiagnostics | undefined> {
    for (;;) {
      const current = this.published.get(uri);
      if (current !== undefined && current.seq > after) {
        return current;
      } else if (Date.now() >= deadline) {
        return undefined;
      } else {
        await new Promise<void>((resolve) => {
          const waiters = this.publishWaiters.get(uri) ?? new Set<() => void>();
          this.publishWaiters.set(uri, waiters);
          const timer = setTimeout(wake, Math.max(0, deadline - Date.now()));
          function wake(): void {
            clearTimeout(timer);
            waiters.delete(wake);
            resolve();
          }
          waiters.add(wake);
        });
      }
    }
  }

  /* ------------------------------------------------------------------------
   * The server's requests and notifications
   * --------------------------------------------------------------------- */

  private handlers(driver: LanguageDriver): ConnectionHandlers {
    return {
      request: async (method, params) => {
        switch (method) {
          case "workspace/configuration": {
            const items = (params as { items?: { section?: string }[] }).items ?? [];
            return items.map((item) => driver.configuration(item.section) ?? null);
          }
          case "workspace/workspaceFolders":
            return [{ uri: pathToFileURL(this.env.root).href, name: basename(this.env.root) }];
          case "client/registerCapability":
          case "client/unregisterCapability":
          case "window/workDoneProgress/create":
          case "window/showMessageRequest":
          case "workspace/codeLens/refresh":
          case "workspace/semanticTokens/refresh":
          case "workspace/inlayHint/refresh":
          case "workspace/diagnostic/refresh":
            return null;
          case "workspace/applyEdit": {
            const handler = this.applyEditHandler;
            if (handler !== undefined) {
              return await handler((params as { edit: WorkspaceEdit }).edit);
            } else {
              return { applied: false, failureReason: "the harness applies server edits only while a code action runs" };
            }
          }
          default:
            throw new RpcError(`unsupported client method ${method}`, ErrorCodes.MethodNotFound);
        }
      },
      notification: (method, params) => {
        switch (method) {
          case "textDocument/publishDiagnostics": {
            const { uri, version, diagnostics } = params as { uri: string; version?: number; diagnostics: Diagnostic[] };
            this.publishSeq += 1;
            this.published.set(uri, { seq: this.publishSeq, version, items: diagnostics });
            for (const wake of this.publishWaiters.get(uri) ?? []) {
              wake();
            }
            return;
          }
          default:
            driver.notification(method, params);
            return;
        }
      },
    };
  }
}

/** Plain-object deep merge: `extra` wins, objects merge recursively, arrays are replaced. */
function mergeDeep(base: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const existing = merged[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      merged[key] = mergeDeep(existing, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function uriToPath(uri: string): string {
  return fileURLToPath(uri);
}
