// The TUI's presentation runtime: how tool calls, custom entries and custom messages look. It loads
// the same extensions the agents run — the harness extension, pi's codemode, the bundled packages —
// against a recording API that keeps only their renderers; every other registration is inert (no
// handlers, commands, processes). Built-in tools come from pi's own definitions.

import {
  createBashToolDefinition,
  createCodemodeExtension,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type EntryRenderer,
  type ExtensionAPI,
  type ExtensionFactory,
  type MessageRenderer,
  type ToolDefinition,
  type ToolRendererResolver,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";
import { createHarnessExtension } from "#extension/index.ts";
import { GateCommentRow } from "#extension/presentation/tui/gate.ts";

export class Renderers {
  readonly tools = new Map<string, ToolRenderers | ToolDefinition>();
  readonly entries = new Map<string, EntryRenderer>();
  readonly messages = new Map<string, MessageRenderer>();
  private readonly resolvers: ToolRendererResolver[] = [];
  readonly problems: string[] = [];

  tool(name: string): ToolRenderers | ToolDefinition | undefined {
    const base = (): ToolRenderers | ToolDefinition | undefined => this.tools.get(name);
    return this.resolvers.reduceRight<() => ToolRenderers | ToolDefinition | undefined>((next, resolver) => () => resolver(name, next as () => ToolRenderers | undefined), base)();
  }

  /** A recording ExtensionAPI: renderers are kept, everything else does nothing. */
  api(): ExtensionAPI {
    const record = {
      registerTool: (tool: ToolDefinition) => {
        this.tools.set(tool.name, tool);
      },
      registerEntryRenderer: (type: string, renderer: EntryRenderer) => {
        this.entries.set(type, renderer);
      },
      registerMessageRenderer: (type: string, renderer: MessageRenderer) => {
        this.messages.set(type, renderer);
      },
      registerToolRenderer: (resolver: ToolRendererResolver) => {
        this.resolvers.push(resolver);
      },
      getSettings: () => ({}),
      getActiveTools: () => [],
      getAllTools: () => [],
      events: { on: () => () => {}, emit: () => {} },
    };
    return new Proxy(record, {
      get(target, property) {
        if (property in target) {
          return target[property as keyof typeof target];
        } else {
          return () => undefined;
        }
      },
    }) as unknown as ExtensionAPI;
  }

  async load(factory: ExtensionFactory, label: string): Promise<void> {
    try {
      await factory(this.api());
    } catch (error) {
      this.problems.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** The entry files of an extension path: the file itself, or a package's `pi.extensions`. */
function extensionEntries(path: string): string[] {
  if (statSync(path).isDirectory()) {
    const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8")) as { pi?: { extensions?: string[] } };
    return (manifest.pi?.extensions ?? []).map((entry) => resolve(path, entry));
  } else {
    return [path];
  }
}

/** Renderers for a client: pi's built-ins, harness, codemode, and the bundle's packages. */
export async function loadRenderers(cwd: string, extensionPaths: readonly string[]): Promise<Renderers> {
  const renderers = new Renderers();
  for (const definition of [
    createReadToolDefinition(cwd),
    createBashToolDefinition(cwd),
    createEditToolDefinition(cwd),
    createWriteToolDefinition(cwd),
    createGrepToolDefinition(cwd),
    createFindToolDefinition(cwd),
    createLsToolDefinition(cwd),
  ]) {
    renderers.tools.set(definition.name, definition as ToolDefinition);
  }

  const inert = createHarnessExtension({
    interactions: { ask: async () => undefined },
    publishState: () => {},
    dataDir: "/nonexistent",
    spawnChild: async () => {
      throw new Error("presentation only");
    },
  });
  await renderers.load(inert.factory, "harness");
  await renderers.load(createCodemodeExtension(), "codemode");
  // Packages ship TypeScript too: loaded as pi loads them (jiti), not by node's own loader.
  const jiti = createJiti(import.meta.url);
  for (const path of extensionPaths.flatMap(extensionEntries)) {
    try {
      const module = (await jiti.import(path)) as { default?: ExtensionFactory };
      if (typeof module.default === "function") {
        await renderers.load(module.default, path);
      } else {
        renderers.problems.push(`${path}: no default export`);
      }
    } catch (error) {
      renderers.problems.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // write calls stay expanded; an approved change's comment shows under its row
  for (const name of ["write", "edit", "lsp_refactor"]) {
    const base = renderers.tools.get(name);
    if (base !== undefined && "renderResult" in base && base.renderResult !== undefined) {
      const renderResult = base.renderResult.bind(base);
      const renderCall = name === "write" && base.renderCall !== undefined ? base.renderCall.bind(base) : undefined;
      renderers.tools.set(name, {
        ...base,
        renderCall: renderCall !== undefined ? (args: never, theme, context) => renderCall(args, theme, { ...context, expanded: true }) : base.renderCall,
        renderResult: (result, options, theme, context) => {
          const component = renderResult(result as never, options, theme, context);
          const comment = (result.details as { gateComment?: unknown } | undefined)?.gateComment;
          return typeof comment === "string" && component !== undefined ? new GateCommentRow(component, theme, comment) : component;
        },
      } as ToolDefinition);
    } else {
      // a tool without a result renderer draws its text: no comment row
    }
  }
  return renderers;
}
