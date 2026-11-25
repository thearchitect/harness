/**
 * The subset of the Language Server Protocol (3.17) the facade speaks, as
 * plain types. Positions are zero-based; `character` counts UTF-16 code
 * units, which is exactly a JavaScript string index within the line.
 */

export type Position = { line: number; character: number };
export type Range = { start: Position; end: Position };
export type Location = { uri: string; range: Range };
export type LocationLink = {
  originSelectionRange?: Range;
  targetUri: string;
  targetRange: Range;
  targetSelectionRange: Range;
};

export type TextEdit = { range: Range; newText: string };
export type TextDocumentEdit = {
  textDocument: { uri: string; version: number | null };
  edits: TextEdit[];
};
export type CreateFile = { kind: "create"; uri: string; options?: { overwrite?: boolean; ignoreIfExists?: boolean } };
export type RenameFile = {
  kind: "rename";
  oldUri: string;
  newUri: string;
  options?: { overwrite?: boolean; ignoreIfExists?: boolean };
};
export type DeleteFile = { kind: "delete"; uri: string; options?: { recursive?: boolean; ignoreIfNotExists?: boolean } };
export type DocumentChange = TextDocumentEdit | CreateFile | RenameFile | DeleteFile;
export type WorkspaceEdit = {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: DocumentChange[];
};

export type Diagnostic = {
  range: Range;
  severity?: 1 | 2 | 3 | 4;
  code?: string | number;
  source?: string;
  message: string;
};

export type MarkupContent = { kind: "plaintext" | "markdown"; value: string };
export type MarkedString = string | { language: string; value: string };
export type Hover = { contents: MarkupContent | MarkedString | MarkedString[]; range?: Range };

export type DocumentSymbol = {
  name: string;
  detail?: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
};
export type SymbolInformation = {
  name: string;
  kind: number;
  location: Location;
  containerName?: string;
};
export type WorkspaceSymbol = {
  name: string;
  kind: number;
  location: Location | { uri: string };
  containerName?: string;
};

export type CallHierarchyItem = {
  name: string;
  kind: number;
  detail?: string;
  uri: string;
  range: Range;
  selectionRange: Range;
  data?: unknown;
};
export type CallHierarchyIncomingCall = { from: CallHierarchyItem; fromRanges: Range[] };
export type CallHierarchyOutgoingCall = { to: CallHierarchyItem; fromRanges: Range[] };
export type TypeHierarchyItem = CallHierarchyItem;

export type Command = { title: string; command: string; arguments?: unknown[] };
export type CodeAction = {
  title: string;
  kind?: string;
  diagnostics?: Diagnostic[];
  isPreferred?: boolean;
  disabled?: { reason: string };
  edit?: WorkspaceEdit;
  command?: Command;
  data?: unknown;
};

/** FileChangeType: 1 created, 2 changed, 3 deleted. */
export type FileEvent = { uri: string; type: 1 | 2 | 3 };

export type PrepareRenameResult =
  | Range
  | { range: Range; placeholder: string }
  | { defaultBehavior: boolean }
  | null;

/** Human names of SymbolKind values (LSP 3.17 §SymbolKind). */
export const SYMBOL_KINDS: readonly string[] = [
  "",
  "file",
  "module",
  "namespace",
  "package",
  "class",
  "method",
  "property",
  "field",
  "constructor",
  "enum",
  "interface",
  "function",
  "variable",
  "constant",
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "key",
  "null",
  "enum member",
  "struct",
  "event",
  "operator",
  "type parameter",
];

export function symbolKindName(kind: number): string {
  return SYMBOL_KINDS[kind] ?? `kind ${kind}`;
}

/** Human names of DiagnosticSeverity values. */
export function severityName(severity: Diagnostic["severity"]): string {
  switch (severity) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "info";
    case 4:
      return "hint";
    case undefined:
      return "error";
    default:
      return assertNever(severity);
  }
}

export function assertNever(value: never): never {
  throw new Error(`unexpected value: ${JSON.stringify(value)}`);
}
