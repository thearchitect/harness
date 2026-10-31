/**
 * The facade's tools for the model, and their registration with pi.
 *
 * Read-only tools are callable from codemode (namespace `lsp`), where the
 * model batches them over many symbols; tools that change files are direct
 * and pass the harness change review once per whole change set.
 */

import { withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import { commitChanges, unifiedDiff, type ChangeSet, type LockPaths } from "./edits.ts";
import { Facade, type DiagnosticEntry, type HierarchyEntry, type Place, type SymbolEntry, type SymbolRef } from "./facade.ts";
import { severityName } from "./protocol.ts";

export type ChangeRequest = { tool: string; toolCallId: string; paths: string[]; lines: string[] };
export type ChangeAuthorization = { kind: "allowed" } | { kind: "blocked"; reason: string; terminate: boolean };
/** The harness change review (index.ts): mode policy, madness, the approval dialog. */
export type Authorize = (ctx: ExtensionContext, request: ChangeRequest) => Promise<ChangeAuthorization>;

const MAX_PLACES = 500;
const MAX_DIFF_LINES = 600;
const LANGUAGES = ["ts", "go", "rust"] as const;

const NAMESPACE = {
  name: "lsp",
  description:
    "Language servers for TypeScript/JavaScript (TypeScript 7), Go (gopls) and Rust (rust-analyzer) over the whole repository: definitions, references, implementations, hierarchies, symbols, hover, diagnostics, code actions",
  instructions: [
    "A symbol is addressed by { file, line, name }: the 1-based line and the identifier on it; pass occurrence (1-based) when the name occurs more than once on the line.",
    "Every workspace-wide answer covers the whole repository: all tsconfig projects and files outside them, every Go module (go.work plus every go.mod) with all build tags, every Cargo workspace with all features. lsp_workspace reports exactly what is covered and what is excluded.",
    "Each call first synchronizes the servers with the files on disk, so results reflect edits made just before. A failure is reported as an error, never as a partial result.",
    "Paths in results are relative to the repository root. The changing tools (lsp_rename, move_file, lsp_apply_code_action) are called directly by the model, never from scripts.",
  ].join("\n"),
};

const symbolRefShape = {
  file: Type.String({ description: "File path, relative to the repository root or absolute" }),
  line: Type.Integer({ minimum: 1, description: "1-based line of the identifier" }),
  name: Type.String({ description: "The identifier on that line" }),
  occurrence: Type.Optional(Type.Integer({ minimum: 1, description: "Which occurrence of the identifier on the line (1-based), when it occurs more than once" })),
};

const placeSchema = Type.Object({ path: Type.String(), line: Type.Integer(), column: Type.Integer(), text: Type.String() });
const placesOutput = Type.Object({ count: Type.Integer(), truncated: Type.Boolean(), places: Type.Array(placeSchema) });
const symbolsOutput = Type.Object({
  symbols: Type.Array(Type.Object({ name: Type.String(), kind: Type.String(), detail: Type.Optional(Type.String()), depth: Type.Integer(), place: placeSchema })),
});
const hierarchyOutput = Type.Object({
  entries: Type.Array(Type.Object({ name: Type.String(), kind: Type.String(), detail: Type.Optional(Type.String()), place: placeSchema, sites: Type.Array(placeSchema) })),
});
const diagnosticsOutput = Type.Object({
  files: Type.Array(
    Type.Object({
      path: Type.String(),
      complete: Type.Boolean(),
      items: Type.Array(Type.Object({ severity: Type.String(), message: Type.String(), source: Type.Optional(Type.String()), code: Type.Optional(Type.String()), place: placeSchema })),
    }),
  ),
});
const actionsOutput = Type.Object({
  actions: Type.Array(Type.Object({ title: Type.String(), kind: Type.Optional(Type.String()), preferred: Type.Boolean(), disabled: Type.Optional(Type.String()) })),
});
const workspaceOutput = Type.Object({
  root: Type.String(),
  languages: Type.Array(Type.Object({ language: Type.String(), lines: Type.Array(Type.String()), facts: Type.Unknown(), error: Type.Optional(Type.String()) })),
});

/** Nested pi file mutation locks over every path, in the given (sorted) order. */
const lockPaths: LockPaths = async <T>(paths: readonly string[], fn: () => Promise<T>): Promise<T> => {
  const [first, ...rest] = paths;
  if (first === undefined) {
    return await fn();
  } else {
    return await withFileMutationQueue(first, () => lockPaths(rest, fn));
  }
};

export function registerLspTools(pi: ExtensionAPI, facadeFor: (ctx: ExtensionContext) => Promise<Facade>, authorize: Authorize): void {
  const readTool = <P extends TSchema, O extends TSchema>(definition: {
    name: string;
    label: string;
    description: string;
    parameters: P;
    outputSchema: O;
    run: (facade: Facade, params: Static<P>) => Promise<{ text: string; data: Static<O> }>;
  }): void => {
    pi.registerTool({
      name: definition.name,
      label: definition.label,
      description: definition.description,
      parameters: definition.parameters,
      outputSchema: definition.outputSchema,
      exposure: "codemode",
      namespace: NAMESPACE,
      annotations: { readOnlyHint: true, openWorldHint: false },
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const { text, data } = await definition.run(await facadeFor(ctx), params);
        return { content: [{ type: "text", text }], details: undefined, structuredContent: data as never };
      },
    });
  };

  const placesTool = (name: string, label: string, description: string, method: "textDocument/definition" | "textDocument/typeDefinition" | "textDocument/implementation", noun: string): void =>
    readTool({
      name,
      label,
      description,
      parameters: Type.Object(symbolRefShape),
      outputSchema: placesOutput,
      run: async (facade, params) => placesResult(await facade.locations(params, method), noun),
    });

  placesTool("lsp_definition", "Definition", "Where the symbol at { file, line, name } is defined.", "textDocument/definition", "definitions");
  placesTool("lsp_type_definition", "Type definition", "Where the type of the symbol at { file, line, name } is defined.", "textDocument/typeDefinition", "type definitions");
  placesTool(
    "lsp_implementations",
    "Implementations",
    "Every implementation of the interface, abstract member or method at { file, line, name }, across the whole repository.",
    "textDocument/implementation",
    "implementations",
  );

  readTool({
    name: "lsp_references",
    label: "References",
    description: "Every reference to the symbol at { file, line, name } across the whole repository (all packages, modules and crates).",
    parameters: Type.Object({
      ...symbolRefShape,
      includeDeclaration: Type.Optional(Type.Boolean({ description: "Include the declaration itself (default true)" })),
    }),
    outputSchema: placesOutput,
    run: async (facade, params) => placesResult(await facade.references(params, params.includeDeclaration ?? true), "references"),
  });

  readTool({
    name: "lsp_hover",
    label: "Hover",
    description: "Type, signature and documentation of the symbol at { file, line, name }.",
    parameters: Type.Object(symbolRefShape),
    outputSchema: Type.Object({ text: Type.Union([Type.String(), Type.Null()]) }),
    run: async (facade, params) => {
      const text = await facade.hover(params);
      return { text: text ?? "No hover information.", data: { text: text ?? null } };
    },
  });

  readTool({
    name: "lsp_symbols",
    label: "Symbols",
    description: "Symbols of one file (pass file), or symbols matching a query across the whole repository (pass query, optionally language).",
    parameters: Type.Object({
      file: Type.Optional(Type.String({ description: "List this file's symbols as a tree" })),
      query: Type.Optional(Type.String({ description: "Search symbols by name across the repository" })),
      language: Type.Optional(Type.Union(LANGUAGES.map((id) => Type.Literal(id)), { description: "Limit a query to one language" })),
    }),
    outputSchema: symbolsOutput,
    run: async (facade, params) => {
      let symbols: SymbolEntry[];
      if (params.file !== undefined && params.query === undefined) {
        symbols = await facade.documentSymbols(params.file);
      } else if (params.query !== undefined && params.file === undefined) {
        symbols = await facade.workspaceSymbols(params.query, params.language);
      } else {
        throw new Error("pass either file or query");
      }
      return { text: symbolsText(symbols), data: { symbols: symbols.map(stripUndefined) } };
    },
  });

  readTool({
    name: "lsp_call_hierarchy",
    label: "Call hierarchy",
    description: "Callers (incoming, across the whole repository) or callees (outgoing) of the function or method at { file, line, name }, with the call sites.",
    parameters: Type.Object({ ...symbolRefShape, direction: Type.Union([Type.Literal("incoming"), Type.Literal("outgoing")]) }),
    outputSchema: hierarchyOutput,
    run: async (facade, params) => {
      const entries = await facade.calls(params, params.direction);
      return { text: hierarchyText(entries, params.direction === "incoming" ? "callers" : "callees"), data: { entries: entries.map(stripUndefined) } };
    },
  });

  readTool({
    name: "lsp_type_hierarchy",
    label: "Type hierarchy",
    description: "Supertypes or subtypes (across the whole repository) of the type at { file, line, name }.",
    parameters: Type.Object({ ...symbolRefShape, direction: Type.Union([Type.Literal("supertypes"), Type.Literal("subtypes")]) }),
    outputSchema: hierarchyOutput,
    run: async (facade, params) => {
      const entries = await facade.types(params, params.direction);
      return { text: hierarchyText(entries, params.direction), data: { entries: entries.map(stripUndefined) } };
    },
  });

  readTool({
    name: "lsp_diagnostics",
    label: "Diagnostics",
    description:
      "Errors and warnings the language server reports for the given files. The project's own build and type check stay authoritative (TypeScript is analyzed with TypeScript 7 whatever the project compiles with).",
    parameters: Type.Object({ files: Type.Array(Type.String(), { minItems: 1, description: "File paths" }) }),
    outputSchema: diagnosticsOutput,
    run: async (facade, params) => {
      const files = await facade.diagnostics(params.files);
      return {
        text: files.map(diagnosticsText).join("\n\n"),
        data: { files: files.map((file) => ({ ...file, items: file.items.map((item) => stripUndefined({ ...item, severity: severityName(item.severity) })) })) },
      };
    },
  });

  readTool({
    name: "lsp_code_actions",
    label: "Code actions",
    description: "Code actions (quick fixes, organize imports, source actions) the server offers for a line range; apply one with lsp_apply_code_action.",
    parameters: Type.Object({
      file: Type.String(),
      startLine: Type.Integer({ minimum: 1 }),
      endLine: Type.Optional(Type.Integer({ minimum: 1, description: "Default: startLine" })),
      kinds: Type.Optional(Type.Array(Type.String(), { description: 'Only these kinds, e.g. "quickfix", "source.organizeImports"' })),
    }),
    outputSchema: actionsOutput,
    run: async (facade, params) => {
      const actions = await facade.codeActions(params.file, params.startLine, params.endLine ?? params.startLine, params.kinds);
      const text =
        actions.length === 0
          ? "No code actions."
          : actions
              .map((action) => `- ${JSON.stringify(action.title)}${action.kind !== undefined ? ` [${action.kind}]` : ""}${action.preferred ? " (preferred)" : ""}${action.disabled !== undefined ? ` (disabled: ${action.disabled})` : ""}`)
              .join("\n");
      return { text, data: { actions: actions.map(stripUndefined) } };
    },
  });

  readTool({
    name: "lsp_workspace",
    label: "Workspace coverage",
    description: "What the language servers cover: the repository root and, per language present, its projects/modules/crates, exclusions with reasons, build tags and features.",
    parameters: Type.Object({}),
    outputSchema: workspaceOutput,
    run: async (facade) => {
      const languages = await facade.summary();
      return {
        text: [`root: ${facade.workspace.root}`, ...languages.flatMap((language) => language.lines)].join("\n"),
        data: { root: facade.workspace.root, languages: languages.map(stripUndefined) },
      };
    },
  });

  /* ------------------------------------------------------------------------
   * Changing tools
   * --------------------------------------------------------------------- */

  const review = async (
    ctx: ExtensionContext,
    toolCallId: string,
    tool: string,
    facade: Facade,
    headline: string,
    set: ChangeSet,
  ): Promise<{ applied: true; text: string } | { applied: false; reason: string; terminate: boolean }> => {
    if (set.changes.length === 0) {
      return { applied: true, text: `${headline}: nothing to change.` };
    } else {
      const summary = changeSummary(facade, set);
      const decision = await authorize(ctx, { tool, toolCallId, paths: set.changes.map((change) => change.path), lines: [headline, ...summary] });
      switch (decision.kind) {
        case "blocked":
          return { applied: false, reason: decision.reason, terminate: decision.terminate };
        case "allowed": {
          await commitChanges(set, lockPaths);
          return { applied: true, text: [headline, ...summary, "", diffText(facade, set)].join("\n") };
        }
        default:
          return assertNeverDecision(decision);
      }
    }
  };

  pi.registerTool({
    name: "lsp_rename",
    label: "Rename symbol",
    description:
      "Rename the symbol at { file, line, name } everywhere in the repository (all packages, modules and crates; renaming a module can move its file). The whole change set is reviewed once and written atomically; the result shows the diff.",
    promptSnippet: "Rename a symbol across the whole repository (TypeScript/JavaScript, Go, Rust)",
    parameters: Type.Object({ ...symbolRefShape, newName: Type.String({ description: "The new identifier" }) }),
    // declared to the model, never callable from scripts: every change and its diff stay visible
    exposure: "model-only",
    executionMode: "sequential",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const facade = await facadeFor(ctx);
      const ref: SymbolRef = params;
      const outcome = await review(ctx, toolCallId, "lsp_rename", facade, `rename ${params.name} → ${params.newName}`, await facade.rename(ref, params.newName));
      return toolResult(outcome);
    },
  });

  pi.registerTool({
    name: "move_file",
    label: "Move files",
    description:
      "Move or rename files and update everything that refers to them across the repository: TypeScript/JavaScript imports in every package, Rust `mod` paths. Go files move only within their directory (package). One language per call; a directory is moved as the list of its files. Reviewed once, written atomically.",
    promptSnippet: "Move or rename source files, updating imports and module paths across the repository",
    parameters: Type.Object({
      moves: Type.Array(Type.Object({ from: Type.String(), to: Type.String() }), { minItems: 1, description: "Files to move: { from, to } paths" }),
    }),
    exposure: "model-only",
    executionMode: "sequential",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const facade = await facadeFor(ctx);
      const headline = `move ${params.moves.length === 1 ? `${params.moves[0].from} → ${params.moves[0].to}` : `${params.moves.length} files`}`;
      const outcome = await review(ctx, toolCallId, "move_file", facade, headline, await facade.moveFiles(params.moves));
      return toolResult(outcome);
    },
  });

  pi.registerTool({
    name: "lsp_apply_code_action",
    label: "Apply code action",
    description: "Apply the code action with the given title (as listed by lsp_code_actions for the same lines). Its edits are reviewed and written atomically.",
    promptSnippet: "Apply a language server code action (quick fix, organize imports) listed by lsp_code_actions",
    parameters: Type.Object({
      file: Type.String(),
      startLine: Type.Integer({ minimum: 1 }),
      endLine: Type.Optional(Type.Integer({ minimum: 1, description: "Default: startLine" })),
      title: Type.String({ description: "Exact title from lsp_code_actions" }),
    }),
    exposure: "model-only",
    executionMode: "sequential",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const facade = await facadeFor(ctx);
      const texts: string[] = [];
      let blocked: { reason: string; terminate: boolean } | undefined;
      const result = await facade.applyCodeAction(params.file, params.startLine, params.endLine ?? params.startLine, params.title, async (set) => {
        const outcome = await review(ctx, toolCallId, "lsp_apply_code_action", facade, params.title, set);
        if (outcome.applied) {
          texts.push(outcome.text);
          return { applied: true };
        } else {
          blocked = { reason: outcome.reason, terminate: outcome.terminate };
          return { applied: false, reason: outcome.reason };
        }
      });
      if (blocked !== undefined) {
        return toolResult({ applied: false, ...blocked });
      } else {
        return toolResult({ applied: true, text: texts.length > 0 ? texts.join("\n\n") : result });
      }
    },
  });
}

/* ----------------------------------------------------------------------------
 * Formatting
 * ------------------------------------------------------------------------- */

function placesResult(places: Place[], noun: string): { text: string; data: Static<typeof placesOutput> } {
  const shown = places.slice(0, MAX_PLACES);
  const truncated = places.length > shown.length;
  const files = new Set(places.map((place) => place.path)).size;
  const header = places.length === 0 ? `No ${noun}.` : `${places.length} ${noun} in ${files} file${files === 1 ? "" : "s"}${truncated ? ` (first ${MAX_PLACES} shown)` : ""}:`;
  return { text: [header, ...groupPlaces(shown)].join("\n"), data: { count: places.length, truncated, places: shown } };
}

function groupPlaces(places: readonly Place[]): string[] {
  const lines: string[] = [];
  let current: string | undefined;
  for (const place of places) {
    if (place.path !== current) {
      current = place.path;
      lines.push(place.path);
    } else {
      // same file
    }
    lines.push(`  ${place.line}:${place.column}  ${place.text}`);
  }
  return lines;
}

function symbolsText(symbols: readonly SymbolEntry[]): string {
  if (symbols.length === 0) {
    return "No symbols.";
  } else {
    return symbols
      .slice(0, MAX_PLACES)
      .map((symbol) => `${"  ".repeat(symbol.depth)}${symbol.kind} ${symbol.name}${symbol.detail ? ` — ${symbol.detail}` : ""}  ${symbol.place.path}:${symbol.place.line}:${symbol.place.column}`)
      .join("\n");
  }
}

function hierarchyText(entries: readonly HierarchyEntry[], noun: string): string {
  if (entries.length === 0) {
    return `No ${noun}.`;
  } else {
    return [
      `${entries.length} ${noun}:`,
      ...entries.flatMap((entry) => [
        `${entry.kind} ${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}  ${entry.place.path}:${entry.place.line}:${entry.place.column}`,
        ...entry.sites.map((site) => `    ${site.path}:${site.line}:${site.column}  ${site.text}`),
      ]),
    ].join("\n");
  }
}

function diagnosticsText(file: { path: string; complete: boolean; items: DiagnosticEntry[] }): string {
  const header = `${file.path}: ${file.items.length === 0 ? "no diagnostics" : `${file.items.length} diagnostics`}${file.complete ? "" : " (the server published nothing within the wait; the list may be incomplete)"}`;
  return [
    header,
    ...file.items.map((item) => `  ${item.place.line}:${item.place.column} ${severityName(item.severity)}${item.code !== undefined ? ` ${item.code}` : ""}: ${item.message}${item.source !== undefined ? ` (${item.source})` : ""}`),
  ].join("\n");
}

function changeSummary(facade: Facade, set: ChangeSet): string[] {
  const moved = new Set(set.moves.flatMap((move) => [move.from, move.to]));
  const lines = set.moves.map((move) => `R ${facade.workspace.display(move.from)} → ${facade.workspace.display(move.to)}`);
  for (const change of set.changes) {
    const path = facade.workspace.display(change.path);
    if (change.before === undefined && !moved.has(change.path)) {
      lines.push(`A ${path}`);
    } else if (change.after === undefined && !moved.has(change.path)) {
      lines.push(`D ${path}`);
    } else if (change.before !== undefined && change.after !== undefined) {
      lines.push(`M ${path}`);
    } else {
      // the two halves of a move, listed above
    }
  }
  return lines;
}

function diffText(facade: Facade, set: ChangeSet): string {
  const moved = new Set(set.moves.flatMap((move) => [move.from, move.to]));
  const lines = set.changes
    .filter((change) => !moved.has(change.path) || (change.before !== undefined && change.after !== undefined))
    .flatMap((change) => unifiedDiff(change, facade.workspace.display(change.path)).split("\n"));
  const movedEdits = set.moves.flatMap((move) => {
    const before = set.changes.find((change) => change.path === move.from)?.before;
    const after = set.changes.find((change) => change.path === move.to)?.after;
    if (before !== undefined && after !== undefined && before !== after) {
      return unifiedDiff({ path: move.to, before, after, mode: undefined }, `${facade.workspace.display(move.to)} (moved)`).split("\n");
    } else {
      return [];
    }
  });
  const all = [...lines, ...movedEdits];
  if (all.length > MAX_DIFF_LINES) {
    return [...all.slice(0, MAX_DIFF_LINES), `… ${all.length - MAX_DIFF_LINES} more diff lines`].join("\n");
  } else {
    return all.join("\n");
  }
}

function toolResult(outcome: { applied: true; text: string } | { applied: false; reason: string; terminate: boolean }) {
  if (outcome.applied) {
    return { content: [{ type: "text" as const, text: outcome.text }], details: undefined };
  } else {
    return { content: [{ type: "text" as const, text: outcome.reason }], details: undefined, isError: true, terminate: outcome.terminate };
  }
}

/** Drops undefined fields so structured results match their JSON schema. */
function stripUndefined<T extends object>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertNeverDecision(value: never): never {
  throw new Error(`unknown change decision: ${JSON.stringify(value)}`);
}
