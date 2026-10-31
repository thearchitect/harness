/**
 * The facade's operations: language-independent questions and edits over the
 * workspace, routed to the language session of the file they start from.
 *
 * Positions come in as { file, line, name }: a 1-based line and an
 * identifier on it. The model knows both reliably; it does not know UTF-16
 * columns. Results come back as places with the text of their line.
 */

import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { addMoves, planEdit, planReplacement, type ChangeSet } from "./edits.ts";
import type { LanguageProfile } from "./profile.ts";
import {
  symbolKindName,
  type CallHierarchyIncomingCall,
  type CallHierarchyItem,
  type CallHierarchyOutgoingCall,
  type CodeAction,
  type Command,
  type Diagnostic,
  type DocumentSymbol,
  type Hover,
  type Location,
  type LocationLink,
  type Position,
  type PrepareRenameResult,
  type Range,
  type SymbolInformation,
  type TypeHierarchyItem,
  type WorkspaceEdit,
  type WorkspaceSymbol,
} from "./protocol.ts";
import { TIMEOUTS, uriToPath, type LanguageSession, type RequestScope } from "./session.ts";
import type { Workspace } from "./workspace.ts";

export type SymbolRef = { file: string; line: number; name: string; occurrence?: number };
export type Place = { path: string; line: number; column: number; text: string };
export type SymbolEntry = { name: string; kind: string; detail: string | undefined; depth: number; place: Place };
export type HierarchyEntry = { name: string; kind: string; detail: string | undefined; place: Place; sites: Place[] };
export type DiagnosticEntry = { severity: Diagnostic["severity"]; message: string; source: string | undefined; code: string | undefined; place: Place };
export type FileDiagnostics = { path: string; complete: boolean; items: DiagnosticEntry[] };
export type ActionEntry = { title: string; kind: string | undefined; preferred: boolean; disabled: string | undefined };

/** Applies a server-computed change set (review gate, atomic write); the tools layer provides it. */
export type ApplyChanges = (set: ChangeSet) => Promise<{ applied: true } | { applied: false; reason: string }>;

type Located = { file: string; profile: LanguageProfile; session: LanguageSession; position: Position };

export class Facade {
  readonly workspace: Workspace;

  constructor(workspace: Workspace) {
    this.workspace = workspace;
  }

  /* ------------------------------------------------------------------------
   * Questions
   * --------------------------------------------------------------------- */

  async locations(ref: SymbolRef, method: "textDocument/definition" | "textDocument/typeDefinition" | "textDocument/implementation"): Promise<Place[]> {
    const at = await this.locate(ref);
    const result = await at.session.run((scope) =>
      scope.withDocument(at.file, (uri) =>
        scope.link.request<Location | Location[] | LocationLink[] | null>(method, { textDocument: { uri }, position: at.position }),
      ),
    );
    return await this.places(toLocations(result));
  }

  async references(ref: SymbolRef, includeDeclaration: boolean): Promise<Place[]> {
    const at = await this.locate(ref);
    const result = await at.session.run((scope) =>
      scope.withDocument(at.file, (uri) =>
        scope.link.request<Location[] | null>(
          "textDocument/references",
          { textDocument: { uri }, position: at.position, context: { includeDeclaration } },
          TIMEOUTS.edit,
        ),
      ),
    );
    return await this.places(result ?? []);
  }

  async hover(ref: SymbolRef): Promise<string | undefined> {
    const at = await this.locate(ref);
    const result = await at.session.run((scope) =>
      scope.withDocument(at.file, (uri) => scope.link.request<Hover | null>("textDocument/hover", { textDocument: { uri }, position: at.position })),
    );
    if (result === null) {
      return undefined;
    } else {
      return hoverText(result.contents);
    }
  }

  async documentSymbols(path: string): Promise<SymbolEntry[]> {
    const file = this.workspace.resolvePath(path);
    const session = this.workspace.session(this.workspace.profileFor(file));
    const result = await session.run((scope) =>
      scope.withDocument(file, (uri) =>
        scope.link.request<DocumentSymbol[] | SymbolInformation[] | null>("textDocument/documentSymbol", { textDocument: { uri } }),
      ),
    );
    const entries: SymbolEntry[] = [];
    const lines = await this.lines(file);
    const visit = (symbol: DocumentSymbol | SymbolInformation, depth: number): void => {
      if ("location" in symbol) {
        entries.push({ name: symbol.name, kind: symbolKindName(symbol.kind), detail: symbol.containerName, depth, place: this.placeIn(file, lines, symbol.location.range.start) });
      } else {
        entries.push({ name: symbol.name, kind: symbolKindName(symbol.kind), detail: symbol.detail, depth, place: this.placeIn(file, lines, symbol.selectionRange.start) });
        for (const child of symbol.children ?? []) {
          visit(child, depth + 1);
        }
      }
    };
    for (const symbol of result ?? []) {
      visit(symbol, 0);
    }
    return entries;
  }

  async workspaceSymbols(query: string, language: string | undefined): Promise<SymbolEntry[]> {
    const profiles = (await this.workspace.presentProfiles()).filter((profile) => language === undefined || profile.id === language);
    if (profiles.length === 0) {
      throw new Error(language === undefined ? "the workspace has no source files of a supported language" : `the workspace has no ${language} files`);
    } else {
      const perLanguage = await Promise.all(
        profiles.map(async (profile) => {
          const session = this.workspace.session(profile);
          return await session.run(async (scope) => {
            const symbols = (await scope.link.request<(WorkspaceSymbol | SymbolInformation)[] | null>("workspace/symbol", { query }, TIMEOUTS.edit)) ?? [];
            return await Promise.all(symbols.map((symbol) => this.resolveWorkspaceSymbol(scope, symbol)));
          });
        }),
      );
      return perLanguage.flat();
    }
  }

  async calls(ref: SymbolRef, direction: "incoming" | "outgoing"): Promise<HierarchyEntry[]> {
    const at = await this.locate(ref);
    const collected = await at.session.run((scope) =>
      scope.withDocument(at.file, async (uri) => {
        const items = (await scope.link.request<CallHierarchyItem[] | null>("textDocument/prepareCallHierarchy", { textDocument: { uri }, position: at.position })) ?? [];
        const results: { item: CallHierarchyItem; ranges: Range[]; rangesUri: string }[] = [];
        for (const item of items) {
          if (direction === "incoming") {
            const calls = (await scope.link.request<CallHierarchyIncomingCall[] | null>("callHierarchy/incomingCalls", { item }, TIMEOUTS.edit)) ?? [];
            results.push(...calls.map((call) => ({ item: call.from, ranges: call.fromRanges, rangesUri: call.from.uri })));
          } else {
            const calls = (await scope.link.request<CallHierarchyOutgoingCall[] | null>("callHierarchy/outgoingCalls", { item })) ?? [];
            results.push(...calls.map((call) => ({ item: call.to, ranges: call.fromRanges, rangesUri: item.uri })));
          }
        }
        return { items, results };
      }),
    );
    if (collected.items.length === 0) {
      throw new Error(`${ref.name} at ${this.workspace.display(at.file)}:${ref.line} is not a function or method the server can build a call hierarchy for`);
    } else {
      return await Promise.all(
        collected.results.map(async ({ item, ranges, rangesUri }) => ({
          name: item.name.startsWith("/") ? this.workspace.display(item.name) : item.name,
          kind: symbolKindName(item.kind),
          detail: item.detail,
          place: (await this.places([{ uri: item.uri, range: item.selectionRange }]))[0],
          sites: await this.places(ranges.map((range) => ({ uri: rangesUri, range }))),
        })),
      );
    }
  }

  async types(ref: SymbolRef, direction: "supertypes" | "subtypes"): Promise<HierarchyEntry[]> {
    const at = await this.locate(ref);
    const collected = await at.session.run((scope) =>
      scope.withDocument(at.file, async (uri) => {
        const items = (await scope.link.request<TypeHierarchyItem[] | null>("textDocument/prepareTypeHierarchy", { textDocument: { uri }, position: at.position })) ?? [];
        const related: TypeHierarchyItem[] = [];
        for (const item of items) {
          related.push(...((await scope.link.request<TypeHierarchyItem[] | null>(`typeHierarchy/${direction}`, { item }, TIMEOUTS.edit)) ?? []));
        }
        return { items, related };
      }),
    );
    if (collected.items.length === 0) {
      throw new Error(`${ref.name} at ${this.workspace.display(at.file)}:${ref.line} is not a type the server can build a type hierarchy for`);
    } else {
      return await Promise.all(
        collected.related.map(async (item) => ({
          name: item.name,
          kind: symbolKindName(item.kind),
          detail: item.detail,
          place: (await this.places([{ uri: item.uri, range: item.selectionRange }]))[0],
          sites: [],
        })),
      );
    }
  }

  async diagnostics(paths: readonly string[]): Promise<FileDiagnostics[]> {
    return await Promise.all(
      paths.map(async (path) => {
        const file = this.workspace.resolvePath(path);
        const session = this.workspace.session(this.workspace.profileFor(file));
        const result = await session.run((scope) => scope.withDocument(file, (uri) => scope.diagnostics(uri)));
        const lines = await this.lines(file);
        return {
          path: this.workspace.display(file),
          complete: result.complete,
          items: result.items
            .map((item) => ({
              severity: item.severity,
              message: item.message,
              source: item.source,
              code: item.code === undefined ? undefined : String(item.code),
              place: this.placeIn(file, lines, item.range.start),
            }))
            .sort((a, b) => a.place.line - b.place.line || a.place.column - b.place.column),
        };
      }),
    );
  }

  async codeActions(path: string, startLine: number, endLine: number, kinds: readonly string[] | undefined): Promise<ActionEntry[]> {
    const file = this.workspace.resolvePath(path);
    const session = this.workspace.session(this.workspace.profileFor(file));
    const actions = await session.run((scope) => scope.withDocument(file, (uri) => this.requestCodeActions(scope, file, uri, startLine, endLine, kinds)));
    return actions.map((action) => ({
      title: action.title,
      kind: "command" in action && typeof action.command === "string" ? undefined : (action as CodeAction).kind,
      preferred: (action as CodeAction).isPreferred === true,
      disabled: (action as CodeAction).disabled?.reason,
    }));
  }

  /* ------------------------------------------------------------------------
   * Edits: computed under one synchronization, applied through `apply`
   * --------------------------------------------------------------------- */

  /** The rename's change set, and the files that define the symbol (for the generated-code check). */
  async rename(ref: SymbolRef, newName: string): Promise<{ set: ChangeSet; definitions: string[] }> {
    const at = await this.locate(ref);
    return await at.session.run((scope) =>
      scope.withDocument(at.file, async (uri) => {
        const provider = scope.link.capabilities.renameProvider;
        if (typeof provider === "object" && provider !== null && (provider as { prepareProvider?: boolean }).prepareProvider === true) {
          const prepared = await scope.link.request<PrepareRenameResult>("textDocument/prepareRename", { textDocument: { uri }, position: at.position });
          if (prepared === null) {
            throw new Error(`${ref.name} at ${this.workspace.display(at.file)}:${ref.line} cannot be renamed`);
          } else {
            // renameable
          }
        } else {
          // the server validates in rename itself
        }
        const definitions = toLocations(
          await scope.link.request<Location | Location[] | LocationLink[] | null>("textDocument/definition", { textDocument: { uri }, position: at.position }),
        ).map((location) => uriToPath(location.uri));
        const edit = await scope.link.request<WorkspaceEdit | null>("textDocument/rename", { textDocument: { uri }, position: at.position, newName }, TIMEOUTS.edit);
        if (edit === null) {
          throw new Error(`the server found nothing to rename for ${ref.name}`);
        } else {
          return { set: this.inside(await planEdit(edit, scope.basis)), definitions: [...new Set(definitions)] };
        }
      }),
    );
  }

  async moveFiles(moves: readonly { from: string; to: string }[]): Promise<ChangeSet> {
    if (moves.length === 0) {
      throw new Error("no files to move");
    } else {
      const resolved = moves.map((move) => ({ from: this.workspace.resolvePath(move.from), to: this.workspace.resolvePath(move.to) }));
      const profiles = [...new Set(resolved.map((move) => this.workspace.profileFor(move.from)))];
      if (profiles.length !== 1) {
        throw new Error(`move files of one language per call; got ${profiles.map((profile) => profile.name).join(", ")}`);
      } else {
        const profile = profiles[0];
        for (const move of resolved) {
          if (!(await isFile(move.from))) {
            throw new Error(`${this.workspace.display(move.from)} is not a file`);
          } else if (this.workspace.profileFor(move.to) !== profile) {
            throw new Error(`${this.workspace.display(move.to)} would change the language of ${this.workspace.display(move.from)}`);
          } else {
            // a valid move
          }
        }
        switch (profile.moves) {
          case "lsp": {
            const session = this.workspace.session(profile);
            return await session.run(async (scope) => {
              const edit = await scope.link.request<WorkspaceEdit | null>(
                "workspace/willRenameFiles",
                { files: resolved.map((move) => ({ oldUri: pathToFileURL(move.from).href, newUri: pathToFileURL(move.to).href })) },
                TIMEOUTS.edit,
              );
              return this.inside(await addMoves(await planEdit(edit ?? {}, scope.basis), resolved));
            });
          }
          case "same-directory": {
            const across = resolved.find((move) => dirname(move.from) !== dirname(move.to));
            if (across !== undefined) {
              throw new Error(
                `${profile.name} files move only within their directory (package): moving ${this.workspace.display(across.from)} to another directory moves its declarations to another package; do that with edits and lsp_references`,
              );
            } else {
              return await addMoves(await planEdit({}, new Map()), resolved);
            }
          }
          default:
            return assertNeverMoves(profile.moves);
        }
      }
    }
  }

  /**
   * Applies the code action titled `title` on the lines: its edit through
   * `apply`, then its command, whose edits the server sends back through
   * `workspace/applyEdit` and which go through `apply` as well.
   */
  async applyCodeAction(path: string, startLine: number, endLine: number, title: string, apply: ApplyChanges): Promise<string> {
    const file = this.workspace.resolvePath(path);
    const session = this.workspace.session(this.workspace.profileFor(file));
    return await session.run((scope) =>
      scope.withDocument(file, async (uri) => {
        const actions = await this.requestCodeActions(scope, file, uri, startLine, endLine, undefined);
        const matches = actions.filter((action) => action.title === title);
        if (matches.length !== 1) {
          throw new Error(
            matches.length === 0
              ? `no code action titled ${JSON.stringify(title)} on lines ${startLine}-${endLine}; available: ${actions.map((action) => JSON.stringify(action.title)).join(", ") || "none"}`
              : `${matches.length} code actions are titled ${JSON.stringify(title)}`,
          );
        } else {
          let action = matches[0];
          if (isCommand(action)) {
            return await this.runCommand(session, scope, action, apply);
          } else {
            if (action.disabled !== undefined) {
              throw new Error(`the code action is disabled: ${action.disabled.reason}`);
            } else if (action.edit === undefined && action.command === undefined && action.data !== undefined) {
              action = await scope.link.request<CodeAction>("codeAction/resolve", action, TIMEOUTS.edit);
            } else {
              // complete as listed
            }
            const outcomes: string[] = [];
            if (action.edit !== undefined) {
              const result = await apply(this.inside(await planEdit(action.edit, scope.basis)));
              if (!result.applied) {
                return result.reason;
              } else {
                outcomes.push("edit applied");
              }
            } else {
              // no edit part
            }
            if (action.command !== undefined) {
              outcomes.push(await this.runCommand(session, scope, action.command, apply));
            } else {
              // no command part
            }
            return outcomes.join("; ") || "the code action changed nothing";
          }
        }
      }),
    );
  }

  /** An exact text replacement (`edit` semantics) in a workspace file. */
  async replaceText(path: string, oldText: string, newText: string): Promise<ChangeSet> {
    return await planReplacement(this.workspace.resolvePath(path), oldText, newText);
  }

  /** Coverage of every language present in the workspace; starts and synchronizes their servers. */
  async summary(): Promise<{ language: string; lines: string[]; facts: Record<string, unknown>; error: string | undefined }[]> {
    const profiles = await this.workspace.presentProfiles();
    return await Promise.all(
      profiles.map(async (profile) => {
        const session = this.workspace.session(profile);
        try {
          await session.run(async () => {});
          const summary = session.status().summary;
          return { language: profile.id, lines: summary?.lines ?? [], facts: summary?.facts ?? {}, error: undefined };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { language: profile.id, lines: [`${profile.name}: unavailable: ${message}`], facts: {}, error: message };
        }
      }),
    );
  }

  /* ------------------------------------------------------------------------
   * Helpers
   * --------------------------------------------------------------------- */

  /** A server's change set, refused when it touches anything outside the repository. */
  private inside(set: ChangeSet): ChangeSet {
    const outside = set.changes.find((change) => this.workspace.display(change.path) === change.path);
    if (outside !== undefined) {
      throw new Error(`the change touches ${outside.path}, outside the repository ${this.workspace.root}; nothing of this operation was written`);
    } else {
      return set;
    }
  }

  private async runCommand(session: LanguageSession, scope: RequestScope, command: Command, apply: ApplyChanges): Promise<string> {
    const outcomes: string[] = [];
    session.applyEditHandler = async (edit) => {
      const result = await apply(this.inside(await planEdit(edit, new Map())));
      if (result.applied) {
        outcomes.push("edit applied");
        return { applied: true };
      } else {
        outcomes.push(result.reason);
        return { applied: false, failureReason: result.reason };
      }
    };
    try {
      await scope.link.request("workspace/executeCommand", { command: command.command, arguments: command.arguments ?? [] }, TIMEOUTS.edit);
    } finally {
      session.applyEditHandler = undefined;
    }
    return outcomes.length > 0 ? outcomes.join("; ") : `command ${command.command} ran`;
  }

  private async requestCodeActions(
    scope: RequestScope,
    file: string,
    uri: string,
    startLine: number,
    endLine: number,
    kinds: readonly string[] | undefined,
  ): Promise<(CodeAction | Command)[]> {
    const lines = await this.lines(file);
    if (startLine < 1 || endLine < startLine || startLine > lines.length) {
      throw new Error(`lines ${startLine}-${endLine} are outside ${this.workspace.display(file)} (${lines.length} lines)`);
    } else {
      const last = Math.min(endLine, lines.length);
      const range: Range = { start: { line: startLine - 1, character: 0 }, end: { line: last - 1, character: lines[last - 1].length } };
      const diagnostics = (await scope.diagnostics(uri)).items.filter(
        (item) => item.range.start.line <= range.end.line && item.range.end.line >= range.start.line,
      );
      const request = async (only: readonly string[] | undefined): Promise<(CodeAction | Command)[]> =>
        (await scope.link.request<(CodeAction | Command)[] | null>("textDocument/codeAction", {
          textDocument: { uri },
          range,
          context: { diagnostics, ...(only !== undefined ? { only } : {}), triggerKind: 1 },
        })) ?? [];
      if (kinds !== undefined) {
        return await request(kinds);
      } else {
        // servers offer source actions (organize imports) only when asked for them by kind
        const all = [...(await request(undefined)), ...(await request(["source"]))];
        const unique = new Map(all.map((action) => [`${action.title}\u0000${isCommand(action) ? "" : (action.kind ?? "")}`, action]));
        return [...unique.values()];
      }
    }
  }

  private async resolveWorkspaceSymbol(scope: RequestScope, symbol: WorkspaceSymbol | SymbolInformation): Promise<SymbolEntry> {
    let location: Location;
    if ("range" in symbol.location) {
      location = symbol.location;
    } else {
      const provider = scope.link.capabilities.workspaceSymbolProvider;
      if (typeof provider === "object" && provider !== null && (provider as { resolveProvider?: boolean }).resolveProvider === true) {
        const resolved = await scope.link.request<WorkspaceSymbol>("workspaceSymbol/resolve", symbol);
        location = "range" in resolved.location ? resolved.location : { uri: resolved.location.uri, range: zeroRange() };
      } else {
        location = { uri: symbol.location.uri, range: zeroRange() };
      }
    }
    return {
      name: symbol.name,
      kind: symbolKindName(symbol.kind),
      detail: symbol.containerName,
      depth: 0,
      place: (await this.places([location]))[0],
    };
  }

  private async locate(ref: SymbolRef): Promise<Located> {
    const file = this.workspace.resolvePath(ref.file);
    const profile = this.workspace.profileFor(file);
    const lines = await this.lines(file);
    const text = lines[ref.line - 1];
    if (text === undefined) {
      throw new Error(`${this.workspace.display(file)} has ${lines.length} lines; line ${ref.line} does not exist`);
    } else {
      const columns = identifierColumns(text, ref.name);
      const occurrence = ref.occurrence ?? 1;
      if (columns.length === 0) {
        throw new Error(`${ref.name} does not occur as an identifier on ${this.workspace.display(file)}:${ref.line}: ${text.trim()}`);
      } else if (columns.length > 1 && ref.occurrence === undefined) {
        throw new Error(
          `${ref.name} occurs ${columns.length} times on ${this.workspace.display(file)}:${ref.line} (columns ${columns.map((column) => column + 1).join(", ")}); pass occurrence (1-based): ${text.trim()}`,
        );
      } else if (occurrence < 1 || occurrence > columns.length) {
        throw new Error(`occurrence ${occurrence} of ${ref.name} does not exist on ${this.workspace.display(file)}:${ref.line} (${columns.length} found)`);
      } else {
        return { file, profile, session: this.workspace.session(profile), position: { line: ref.line - 1, character: columns[occurrence - 1] } };
      }
    }
  }

  private async lines(file: string): Promise<string[]> {
    return splitLines(await readFile(file, "utf8"));
  }

  private placeIn(file: string, lines: readonly string[], position: Position): Place {
    return { path: this.workspace.display(file), line: position.line + 1, column: position.character + 1, text: (lines[position.line] ?? "").trim() };
  }

  /** Places of locations, sorted and without duplicates; lines read once per file. */
  private async places(locations: readonly Location[]): Promise<Place[]> {
    const cache = new Map<string, Promise<string[]>>();
    const places = await Promise.all(
      locations.map(async (location) => {
        const file = uriToPath(location.uri);
        let lines = cache.get(file);
        if (lines === undefined) {
          lines = this.lines(file).catch(() => []);
          cache.set(file, lines);
        } else {
          // read already
        }
        return this.placeIn(file, await lines, location.range.start);
      }),
    );
    const unique = new Map(places.map((place) => [`${place.path}:${place.line}:${place.column}`, place]));
    return [...unique.values()].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
  }
}

/** 0-based columns where `name` occurs as a whole identifier in `text`. */
export function identifierColumns(text: string, name: string): number[] {
  if (name === "") {
    return [];
  } else {
    const columns: number[] = [];
    const isIdentifierChar = (char: string | undefined): boolean => char !== undefined && /[\p{L}\p{N}_$]/u.test(char);
    let from = 0;
    for (;;) {
      const index = text.indexOf(name, from);
      if (index < 0) {
        return columns;
      } else {
        if (!isIdentifierChar(text[index - 1]) && !isIdentifierChar(text[index + name.length])) {
          columns.push(index);
        } else {
          // part of a longer identifier
        }
        from = index + 1;
      }
    }
  }
}

function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

function toLocations(result: Location | Location[] | LocationLink[] | null): Location[] {
  if (result === null) {
    return [];
  } else if (!Array.isArray(result)) {
    return [result];
  } else {
    return result.map((entry) => ("targetUri" in entry ? { uri: entry.targetUri, range: entry.targetSelectionRange } : entry));
  }
}

function hoverText(contents: Hover["contents"]): string {
  if (typeof contents === "string") {
    return contents;
  } else if (Array.isArray(contents)) {
    return contents.map((part) => hoverText(part)).join("\n\n");
  } else if ("kind" in contents) {
    return contents.value;
  } else {
    return `\`\`\`${contents.language}\n${contents.value}\n\`\`\``;
  }
}

function isCommand(action: CodeAction | Command): action is Command {
  return typeof (action as Command).command === "string";
}

function zeroRange(): Range {
  return { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function assertNeverMoves(value: never): never {
  throw new Error(`unknown move kind: ${JSON.stringify(value)}`);
}
