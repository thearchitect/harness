/**
 * harness - the system prompt.
 *
 * The harness owns the whole system prompt. Setting
 * systemPromptOptions.customPrompt (the documented SYSTEM.md mechanism) makes
 * pi drop its built-in preamble, <tools>, <rules> and <docs>;
 * assembleSystemPrompt renders their replacements from prompt.yaml and from
 * the same options pi would use. pi still renders <addendum>
 * (APPEND_SYSTEM.md), <project_context>, <skills> and <cwd>, and other
 * extensions keep contributing their own sections.
 *
 * Limits of the pi 1.4 extension API, accepted by design:
 * - pi re-renders its own <tools>/<rules> before every turn; these are
 *   rendered once per run, in before_agent_start (the only hook with prompt
 *   options). A tool activated mid-run is declared to the model at once and
 *   listed in <tools>/<rules> from the next run on.
 * - promptGuidelines pushed by before_agent_start handlers that run after the
 *   harness are not rendered. Handlers run in extension load order and the
 *   launcher loads the harness first; every other guideline in use arrives
 *   through tool definitions (toolGuidelines), complete before any handler
 *   runs. The final run options are not public, so such a loss is not
 *   detectable.
 */

import {
  getDocsPath,
  getExamplesPath,
  getReadmePath,
  type NormalizedBuildSystemPromptOptions,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** prompt.yaml `sections`, rendered as <name> blocks in this order after <tools> and <rules>. */
const SECTION_NAMES = ["mode_policies", "engineering_principles", "code_exploration", "pi_docs"] as const;
type SectionName = (typeof SECTION_NAMES)[number];

type PromptConfig = {
  preamble: string;
  sections: Record<SectionName, string>;
  guidelines: string[];
};

/**
 * Openings of pi's built-in preamble and <docs>: either one in the final
 * prompt means pi's default prompt came back.
 */
const PI_PROMPT_MARKERS = [
  "You are an expert coding assistant operating inside pi",
  "Pi documentation (read only when the user asks about pi itself",
];

/**
 * codegraph's tool, named in <code_exploration>: deps.ts registers the server
 * as "codegraph", and pi names MCP tools mcp__<server>__<tool>.
 */
const CODEGRAPH_NAMESPACE = "mcp__codegraph";
const CODEGRAPH_TOOL = `${CODEGRAPH_NAMESPACE}__codegraph_explore`;

/**
 * pi's own `yaml` (it parses skill frontmatter with it): the extension ships no
 * node_modules and pi's loader aliases only the pi packages, so the module is
 * resolved from pi's CLI entry (process.argv[1]); a checkout with its own
 * node_modules resolves it from the extension directory instead.
 */
function loadYamlParser(): (text: string) => unknown {
  const anchors = [process.argv[1], import.meta.url].filter(
    (anchor): anchor is string => typeof anchor === "string",
  );
  for (const anchor of anchors) {
    try {
      return (createRequire(anchor)("yaml") as typeof import("yaml")).parse;
    } catch {
      // not resolvable from this anchor: try the next one
    }
  }
  throw new Error("harness: cannot resolve the `yaml` module from pi or the extension directory");
}

/**
 * Reads prompt.yaml next to this file and checks its shape: every expected
 * key present and non-empty. A malformed file fails extension load loudly
 * rather than producing a prompt with silently missing parts.
 */
function loadPromptConfig(): PromptConfig {
  const parseYaml = loadYamlParser();
  const fail = (what: string): never => {
    throw new Error(`harness: prompt.yaml: ${what}`);
  };
  /** A non-empty string, trimmed. */
  const text = (value: unknown, key: string): string => {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    } else {
      return fail(`${key} must be a non-empty string`);
    }
  };
  /** A mapping of non-empty strings, in file order. */
  const textMap = (value: unknown, key: string): Record<string, string> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return fail(`${key} must be a mapping`);
    } else {
      return Object.fromEntries(
        Object.entries(value).map(([name, entry]) => [name, text(entry, `${key}.${name}`)]),
      );
    }
  };

  const raw: unknown = parseYaml(
    readFileSync(fileURLToPath(new URL("./prompt.yaml", import.meta.url)), "utf8"),
  );
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return fail("top level must be a mapping");
  } else {
    const top = raw as Record<string, unknown>;
    const sections = textMap(top.sections, "sections");
    return {
      preamble: text(top.preamble, "preamble"),
      sections: Object.fromEntries(
        SECTION_NAMES.map((name) => [name, text(sections[name], `sections.${name}`)]),
      ) as Record<SectionName, string>,
      guidelines: Object.values(textMap(top.guidelines, "guidelines")),
    };
  }
}

const PROMPT = loadPromptConfig();

/** pi's <tools> format: one `- name: snippet` line per declared tool that has a snippet. */
function renderTools(declaredTools: string[], toolSnippets: Record<string, string>): string {
  const lines = declaredTools.flatMap((name) => {
    const snippet = toolSnippets[name];
    if (snippet) {
      return [`- ${name}: ${snippet}`];
    } else {
      // pi lists only tools that contribute a snippet
      return [];
    }
  });
  if (lines.length > 0) {
    return lines.join("\n");
  } else {
    return "(none)";
  }
}

/** Bullets in order, each once: the declared tools' guidelines, then the given ones. */
function renderRules(
  declaredTools: string[],
  toolGuidelines: Record<string, string[]>,
  guidelines: string[],
): string {
  const rules = new Set<string>();
  for (const rule of [...declaredTools.flatMap((name) => toolGuidelines[name] ?? []), ...guidelines]) {
    const normalized = rule.trim();
    if (normalized !== "") {
      rules.add(normalized);
    } else {
      // an empty contribution renders nothing
    }
  }
  return [...rules].map((rule) => `- ${rule}`).join("\n");
}

/**
 * Builds the whole system prompt into pi's options for this run: the preamble
 * (with a foreign customPrompt - SYSTEM.md or an earlier handler - appended
 * after it), <tools>, <rules> and the prompt.yaml sections.
 */
export function assembleSystemPrompt(
  options: NormalizedBuildSystemPromptOptions,
  run: { activeTools: string[]; workspaceRoot: string },
): { foreignCustomPrompt: boolean } {
  const foreignCustomPrompt = options.customPrompt?.trim() ?? "";
  // pi lists and rules only the declared tools; hidden ones reach the model through codemode.
  const declaredTools = run.activeTools.filter((name) => !options.hiddenTools.includes(name));
  const placeholders: Record<string, string> = {
    "{{WORKSPACE_TMP}}": run.workspaceRoot,
    "{{PI_README}}": getReadmePath(),
    "{{PI_DOCS}}": getDocsPath(),
    "{{PI_EXAMPLES}}": getExamplesPath(),
  };

  if (foreignCustomPrompt !== "") {
    options.customPrompt = `${PROMPT.preamble}\n\n${foreignCustomPrompt}`;
  } else {
    options.customPrompt = PROMPT.preamble;
  }
  options.sections.tools = renderTools(declaredTools, options.toolSnippets);
  options.sections.rules = renderRules(declaredTools, options.toolGuidelines, [
    ...PROMPT.guidelines,
    ...options.promptGuidelines,
  ]);
  for (const name of SECTION_NAMES) {
    options.sections[name] = Object.entries(placeholders).reduce(
      (text, [placeholder, value]) => text.replaceAll(placeholder, value),
      PROMPT.sections[name],
    );
  }
  return { foreignCustomPrompt: foreignCustomPrompt !== "" };
}

/**
 * What is wrong with the final rendered system prompt, or undefined when it is
 * the harness prompt: it must open with the harness preamble and contain
 * nothing of pi's built-in prompt.
 */
export function systemPromptProblem(systemPrompt: string): string | undefined {
  const marker = PI_PROMPT_MARKERS.find((candidate) => systemPrompt.includes(candidate));
  if (!systemPrompt.startsWith(PROMPT.preamble)) {
    return "the system prompt does not open with the harness preamble: another extension replaced customPrompt or forced the whole prompt";
  } else if (marker !== undefined) {
    return `pi's built-in system prompt leaked into the harness prompt (found "${marker}")`;
  } else {
    return undefined;
  }
}

/**
 * What is wrong with codegraph's tools, or undefined: the server is not
 * connected (yet), or its tool carries the name <code_exploration> uses.
 */
export function codegraphToolProblem(tools: ToolInfo[]): string | undefined {
  const codegraphTools = tools
    .filter((tool) => tool.namespace?.name === CODEGRAPH_NAMESPACE)
    .map((tool) => tool.name);
  if (codegraphTools.length === 0) {
    return undefined;
  } else if (codegraphTools.includes(CODEGRAPH_TOOL)) {
    return undefined;
  } else {
    return `codegraph is connected but ${CODEGRAPH_TOOL} is not registered (found: ${codegraphTools.join(", ")}); <code_exploration> names a tool the model does not have.`;
  }
}
