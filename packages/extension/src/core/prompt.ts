/**
 * harness - the system prompt.
 *
 * The harness owns the whole system prompt. Setting
 * systemPromptOptions.customPrompt (the documented SYSTEM.md mechanism) makes
 * pi drop its built-in preamble, <tools>, <rules> and <docs>;
 * assembleSystemPrompt renders their replacements from prompt.yaml and from
 * the same options pi would use. pi still renders <addendum>
 * (APPEND_SYSTEM.md), <project_context>, <skills> and <cwd>, and other
 * extensions keep contributing their own sections. A declared tool's rules in
 * <rules> are its own promptGuidelines unless prompt.yaml `tool_guidelines`
 * replaces them.
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

import { getDocsPath, type NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** prompt.yaml `sections`, rendered as <name> blocks in this order after <tools> and <rules>. */
const SECTION_NAMES = ["mode_policies", "engineering_principles", "code_exploration", "harness_docs"] as const;

/** The sources' root: the checkout, or share/harness/src of the bundle. */
export const HARNESS_SRC = fileURLToPath(new URL("../../../..", import.meta.url)).replace(/\/$/, "");

/** Where the prompt's documentation paths point: harness's documents, its sources, pi's documents of this bundle. */
export function documentationPaths(): { docs: string; src: string; piDocs: string } {
  const bundled = join(HARNESS_SRC, "pi", "coding-agent", "docs");
  return { docs: join(HARNESS_SRC, "docs"), src: HARNESS_SRC, piDocs: existsSync(bundled) ? bundled : getDocsPath() };
}
type SectionName = (typeof SECTION_NAMES)[number];

type PromptConfig = {
  preamble: string;
  sections: Record<SectionName, string>;
  /** Per tool name: the rule that replaces the tool's own promptGuidelines. */
  toolGuidelines: Record<string, string>;
  guidelines: string[];
  /** Guidelines by name (the `claude` block names the ones it takes). */
  namedGuidelines: Record<string, string>;
  claude: { preamble: string; sections: SectionName[]; guidelines: string[] };
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
    const guidelines = textMap(top.guidelines, "guidelines");
    const claude = (typeof top.claude === "object" && top.claude !== null ? top.claude : fail("claude must be a mapping")) as Record<string, unknown>;
    const names = (value: unknown, key: string, known: readonly string[]): string[] =>
      Array.isArray(value) && value.every((name) => typeof name === "string" && known.includes(name)) ? (value as string[]) : fail(`${key} must list names of ${known.join(", ")}`);
    return {
      preamble: text(top.preamble, "preamble"),
      sections: Object.fromEntries(
        SECTION_NAMES.map((name) => [name, text(sections[name], `sections.${name}`)]),
      ) as Record<SectionName, string>,
      toolGuidelines: textMap(top.tool_guidelines, "tool_guidelines"),
      guidelines: Object.values(guidelines),
      namedGuidelines: guidelines,
      claude: {
        preamble: text(claude.preamble, "claude.preamble"),
        sections: names(claude.sections, "claude.sections", SECTION_NAMES) as SectionName[],
        guidelines: names(claude.guidelines, "claude.guidelines", Object.keys(guidelines)),
      },
    };
  }
}

const PROMPT = loadPromptConfig();

/**
 * The prompt appended to Claude Code's own (engine `claude`): harness's preamble for Claude, the
 * profile's role, the `claude` block's sections and guidelines, and the rules of the harness tools
 * Claude gets (by their MCP names).
 */
export function claudeSystemPrompt(workspaceRoot: string, role: string, tools: { name: string; guidelines: string[] }[]): string {
  const fill = (text: string): string => text.replaceAll("{{WORKSPACE_TMP}}", workspaceRoot);
  const toolRules = tools.flatMap((tool) => {
    const rules = PROMPT.toolGuidelines[tool.name] !== undefined ? [PROMPT.toolGuidelines[tool.name] ?? ""] : tool.guidelines;
    return rules.map((rule) => `- ${tool.name} (mcp__harness__${tool.name}): ${rule.trim()}`);
  });
  return [
    fill(PROMPT.claude.preamble),
    `<role>\n${role}\n</role>`,
    ...PROMPT.claude.sections.map((name) => `<${name}>\n${fill(PROMPT.sections[name])}\n</${name}>`),
    `<rules>\n${[...PROMPT.claude.guidelines.map((name) => `- ${(PROMPT.namedGuidelines[name] ?? "").trim()}`), ...toolRules].join("\n")}\n</rules>`,
  ].join("\n\n");
}

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

/**
 * Bullets in order, each once: the declared tools' guidelines (prompt.yaml's
 * replacement where it has one), then the given ones.
 */
function renderRules(
  declaredTools: string[],
  toolGuidelines: Record<string, string[]>,
  guidelines: string[],
): string {
  const toolRules = declaredTools.flatMap((name) => {
    const replacement = PROMPT.toolGuidelines[name];
    if (replacement !== undefined) {
      return [replacement];
    } else {
      return toolGuidelines[name] ?? [];
    }
  });
  const rules = new Set<string>();
  for (const rule of [...toolRules, ...guidelines]) {
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
  const paths = documentationPaths();
  const placeholders: Record<string, string> = {
    "{{WORKSPACE_TMP}}": run.workspaceRoot,
    "{{HARNESS_DOCS}}": paths.docs,
    "{{HARNESS_SRC}}": paths.src,
    "{{PI_DOCS}}": paths.piDocs,
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

