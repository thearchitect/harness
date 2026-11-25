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

import { formatSkillsForPrompt, getDocsPath, type NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import type { RunMode } from "#protocol/state.ts";
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

/** pi's tools that Claude has natively: the bridge leaves them out, the rules name Claude's own. */
export const CLAUDE_NATIVE_TOOLS: Record<string, string> = { read: "Read", edit: "Edit", write: "Write" };

/** The name Claude calls a harness tool by: its own for the native ones, the bridge's otherwise. */
export function claudeToolName(name: string): string {
  return CLAUDE_NATIVE_TOOLS[name] ?? `mcp__harness__${name}`;
}

/**
 * A text of harness's prompt as Claude reads it: every tool name in backticks (`edit`, `lsp_*`), and
 * the given tools' names with an underscore written bare (send_file), become the names Claude calls
 * them by. Bare plain words (bash, read) stay: in prose they are not names.
 */
export function forClaude(text: string, tools: readonly string[]): string {
  const bare = tools.filter((name) => name.includes("_")).sort((a, b) => b.length - a.length);
  const unquoted =
    bare.length > 0 ? text.replace(new RegExp(`(?<![\\w\`.])(${bare.join("|")})(?![\\w\`])`, "g"), (name: string) => claudeToolName(name)) : text;
  return unquoted.replace(/`([a-z][a-z0-9_]*)(\*?)`/g, (whole, name: string, star: string) => {
    if (star === "*" && tools.some((tool) => tool.startsWith(name))) {
      return `\`mcp__harness__${name}*\``;
    } else if (star === "" && (tools.includes(name) || name in CLAUDE_NATIVE_TOOLS)) {
      return `\`${claudeToolName(name)}\``;
    } else {
      return whole;
    }
  });
}

/** The policy of one mode, as prompt.yaml's mode_policies gives it to harness's own models. */
function modePolicy(mode: RunMode, placeholders: Record<string, string>): string {
  const policy = new RegExp(`<mode-prompt mode="${mode}">([\\s\\S]*?)</mode-prompt>`).exec(PROMPT.sections.mode_policies)?.[1];
  if (policy === undefined) {
    throw new Error(`harness: prompt.yaml: mode_policies has no mode-prompt for ${mode}`);
  } else {
    const body = policy
      .split("\n")
      .map((line) => line.replace(/^ {8}/, ""))
      .join("\n")
      .trim();
    return fillPlaceholders(body, placeholders);
  }
}

export type ClaudePromptInput = {
  workspaceRoot: string;
  role: string;
  mode: RunMode;
  /** The calling agent's own run options: its project context, skills and other extensions' sections. */
  run: NormalizedBuildSystemPromptOptions;
  /** The harness tools Claude gets through the bridge, with their own guidelines. */
  tools: { name: string; guidelines: string[] }[];
};

/**
 * The prompt appended to Claude Code's own (engine `claude`), assembled from the same parts as
 * harness's: the preamble for Claude, the profile's role, the calling agent's project context and
 * skills (Claude loads none of its own: see launch.ts), the rules of the `claude` block and of every
 * harness tool Claude gets, the current mode's policy, the `claude` block's sections and the MCP
 * servers it reaches through codemode. Tool names are the ones Claude calls.
 */
export function claudeSystemPrompt(input: ClaudePromptInput): string {
  const toolNames = input.tools.map((tool) => tool.name);
  const placeholders = promptPlaceholders(input.workspaceRoot);
  const claudeText = (text: string): string => forClaude(fillPlaceholders(text, placeholders), toolNames);
  const block = (name: string, text: string): string => `<${name}>\n${text}\n</${name}>`;

  const toolRules = input.tools.flatMap((tool) => {
    const replacement = PROMPT.toolGuidelines[tool.name];
    return replacement !== undefined ? [replacement] : tool.guidelines;
  });
  const rules = [...new Set([...PROMPT.claude.guidelines.map((name) => PROMPT.namedGuidelines[name] ?? ""), ...toolRules].map((rule) => rule.trim()))].filter((rule) => rule !== "");
  const skills = input.run.skills.filter((skill) => !skill.name.startsWith("subagent-"));
  const mcpServers = input.run.sections.mcp_servers;

  return [
    claudeText(PROMPT.claude.preamble),
    block("role", input.role),
    ...(input.run.contextFiles.length > 0
      ? [block("project_context", ["Project-specific instructions and guidelines:", ...input.run.contextFiles.map(({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`)].join("\n\n"))]
      : []),
    ...(skills.length > 0 ? [block("skills", formatSkillsForPrompt(skills, "indirect").trim())] : []),
    block("rules", rules.map((rule) => `- ${claudeText(rule)}`).join("\n")),
    block("mode_policy", `harness runs you in ${input.mode.toUpperCase()} mode for this whole run; the caller's instruction works within it, and harness's checks of your changes follow it.\n\n${claudeText(modePolicy(input.mode, placeholders))}`),
    ...PROMPT.claude.sections.map((name) => block(name, claudeText(PROMPT.sections[name]))),
    ...(mcpServers !== undefined && mcpServers.trim() !== ""
      ? [block("mcp_servers", `${mcpServers.trim()}\n\nThese are harness's MCP servers; whatever the list says about codemode, their tools reach you directly through harness's bridge as \`mcp__harness__mcp__<server>__<tool>\`.`)]
      : []),
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

function promptPlaceholders(workspaceRoot: string): Record<string, string> {
  const paths = documentationPaths();
  return {
    "{{WORKSPACE_TMP}}": workspaceRoot,
    "{{HARNESS_DOCS}}": paths.docs,
    "{{HARNESS_SRC}}": paths.src,
    "{{PI_DOCS}}": paths.piDocs,
  };
}

function fillPlaceholders(text: string, placeholders: Record<string, string>): string {
  return Object.entries(placeholders).reduce((filled, [placeholder, value]) => filled.replaceAll(placeholder, value), text);
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
  const placeholders = promptPlaceholders(run.workspaceRoot);

  if (foreignCustomPrompt !== "") {
    options.customPrompt = `${PROMPT.preamble}\n\n${foreignCustomPrompt}`;
  } else {
    options.customPrompt = PROMPT.preamble;
  }

  // pi renders sections in key order: harness's own first, then other extensions' in the order they
  // came, whichever extension loaded first.
  const own: Record<string, string> = {
    tools: renderTools(declaredTools, options.toolSnippets),
    rules: renderRules(declaredTools, options.toolGuidelines, [...PROMPT.guidelines, ...options.promptGuidelines]),
    ...Object.fromEntries(SECTION_NAMES.map((name) => [name, fillPlaceholders(PROMPT.sections[name], placeholders)])),
  };
  const foreign = Object.entries(options.sections).filter(([name]) => !(name in own));
  for (const name of Object.keys(options.sections)) {
    delete options.sections[name];
  }
  for (const [name, text] of [...Object.entries(own), ...foreign]) {
    options.sections[name] = text;
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

