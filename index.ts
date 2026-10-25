/**
 * harness - personal Pi workflow extension.
 *
 * Per-message PLAN/BUILD mode (custom editor, mode colors, mode selector
 * message), plan-mode write/edit gating, and per-cycle "planning/building
 * finished" banners annotated with finish time, duration and USD cost. BUILD
 * write/edit
 * gates use an interactive Yes / No (why?) / Stop dialog whose comment is
 * fed back to the running model without interrupting it. The "/-" command
 * aborts the bash call that is currently executing (its process tree only)
 * and steers the given message to the model without aborting the run.
 * System prompt: pi assembles it; the extension only contributes the
 * <mode_policies> section and guideline bullets (see Prompt contributions).
 * Temporary workarounds for upstream gaps are isolated in workarounds.ts.
 * Static CONFIG block (top of file) drives all tunables: edit it, not the logic.
 *
 * // generate blocks using `echo "block name" | dev-fig-code-small`
 */

import {
  createBashToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
  CustomEditor,
  getAgentDir,
  SettingsManager,
  isToolCallEventType,
  type BeforeAgentStartEventResult,
  type CustomEntry,
  type EntryRenderOptions,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionEvent,
  type InputEventResult,
  type KeybindingsManager,
  type SessionEntry,
  type Theme,
  type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  decodeKittyPrintable,
  Editor,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { installWorkarounds } from "./workarounds.ts";
import { claimHarnessInstance, installDeps } from "./deps.ts";

/* ============================================================================
 * ▄▀▀▀▀ ▀▀█▀▀ ▄▀▀▀▄ ▀▀█▀▀ ▀▀█▀▀ ▄▀▀▀▀       ▄▀▀▀▀ ▄▀▀▀▄ █▄  █ █▀▀▀▀ ▀▀█▀▀ ▄▀▀▀▀
 *  ▀▀▀▄   █   █▀▀▀█   █     █   █           █     █   █ █ ▀▄█ █▀▀     █   █ ▀▀█
 * ▀▀▀▀    ▀   ▀   ▀   ▀   ▀▀▀▀▀  ▀▀▀▀        ▀▀▀▀  ▀▀▀  ▀   ▀ ▀     ▀▀▀▀▀  ▀▀▀
 * ----------------------------------------------------------------------------
 * Static configuration - single source of truth for personal defaults.
 * Pull settings from CONFIG below; don't hardcode values in the logic.
 *
 * providers.*.modelOverrides mirrors the semantics of pi's models.json:
 * entries apply to the active model when provider/model match.
 * showSystemPromptOnFirstRun surfaces the final system prompt (after every
 * extension's contributions) as a collapsible transcript entry on the
 * session's first request.
 * ========================================================================== */

type ModelOverrideConfig = { contextWindow?: number };
type ProviderConfig = { modelOverrides?: Record<string, ModelOverrideConfig> };
type ExtensionConfig = {
  /** Debug aid: dump the assembled system prompt into the transcript on the session's first request (display-only, never sent to the model). */
  showSystemPromptOnFirstRun?: boolean;
  providers: Record<string, ProviderConfig>;
};

/**
 * Extension-level static configuration.
 *
 * The models below ship with pi's 272000-token default context window;
 * the override raises it so long sessions run further before compaction.
 * (OpenAI bills the whole request at the long-context rate once input
 * exceeds 272K tokens regardless of the configured window.)
 */
const CONFIG: ExtensionConfig = {
  showSystemPromptOnFirstRun: true,
  providers: {
    "openai-codex": {
      modelOverrides: {
        //"gpt-6-astra": { contextWindow: 872_000 },
        //"gpt-5.6-sol": { contextWindow: 872_000 },
      },
    },
  },
};

/**
 * Apply CONFIG model overrides to a live model object. ctx.model / event.model
 * is the session's active model - the same object pi reads for requests and
 * compaction decisions - so setting contextWindow here is the extension-level
 * equivalent of a models.json override. No-op for models without an entry.
 */
function applyContextWindowOverrides(model: ExtensionContext["model"]): void {
  if (!model) return;
  const override =
    CONFIG.providers[model.provider]?.modelOverrides?.[model.id];
  const target = override?.contextWindow;
  if (target !== undefined && model.contextWindow !== target) {
    model.contextWindow = target;
  }
}

/* ============================================================================
 * ▄▀▀▀▀ █   █ ▄▀▀▀▀ ▀▀█▀▀ █▀▀▀▀ █▀▄▀█       █▀▀▀▄ █▀▀▀▄ ▄▀▀▀▄ █▀▄▀█ █▀▀▀▄ ▀▀█▀▀
 *  ▀▀▀▄ ▀▀▀▀█  ▀▀▀▄   █   █▀▀   █   █       █▀▀▀  █▀▀▀▄ █   █ █   █ █▀▀▀    █
 * ▀▀▀▀  ▀▀▀▀▀ ▀▀▀▀    ▀   ▀▀▀▀▀ ▀   ▀       ▀     ▀   ▀  ▀▀▀  ▀   ▀ ▀       ▀
 * ▄▀▀▀▄ ▄▀▀▀▀ ▄▀▀▀▀ █▀▀▀▀ █▀▄▀█ █▀▀▀▄ █     █   █
 * █▀▀▀█  ▀▀▀▄  ▀▀▀▄ █▀▀   █   █ █▀▀▀▄ █     ▀▀▀▀█
 * ▀   ▀ ▀▀▀▀  ▀▀▀▀  ▀▀▀▀▀ ▀   ▀ ▀▀▀▀  ▀▀▀▀▀ ▀▀▀▀▀
 * ----------------------------------------------------------------------------
 * Prompt contributions. pi owns the system prompt (its preamble, tools, rules,
 * docs, project context, skills, cwd); this extension only adds its own parts
 * through the structured systemPromptOptions in before_agent_start. Every
 * text lives in prompt.yaml: `sections` become <mode_policies> and
 * <engineering_principles>, `guidelines` become promptGuidelines bullets,
 * `conditional_guidelines` are added while their tool is active. All are
 * mode-independent, so PLAN/BUILD switches never change the prompt (provider
 * prompt caching survives).
 * ----------------------------------------------------------------------------
 * ❤︎ → × ✻
 * ========================================================================== */
const MODE_POLICIES_SECTION = "mode_policies";
const ENGINEERING_PRINCIPLES_SECTION = "engineering_principles";

type PromptConfig = {
  sections: Record<typeof MODE_POLICIES_SECTION | typeof ENGINEERING_PRINCIPLES_SECTION, string>;
  guidelines: Record<string, string>;
  conditional_guidelines: Record<"codegraph_explore", string>;
};

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
  /** A mapping of non-empty strings, in file order. */
  const textMap = (value: unknown, key: string): Record<string, string> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return fail(`${key} must be a mapping`);
    } else {
      for (const [name, text] of Object.entries(value)) {
        if (typeof text !== "string" || text.trim() === "") {
          fail(`${key}.${name} must be a non-empty string`);
        } else {
          // a valid entry
        }
      }
      return value as Record<string, string>;
    }
  };
  const text = (map: Record<string, string>, key: string, name: string): string => {
    if (name in map) {
      return map[name].trim();
    } else {
      return fail(`${key}.${name} is missing`);
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
    const conditional = textMap(top.conditional_guidelines, "conditional_guidelines");
    return {
      sections: {
        [MODE_POLICIES_SECTION]: text(sections, "sections", MODE_POLICIES_SECTION),
        [ENGINEERING_PRINCIPLES_SECTION]: text(sections, "sections", ENGINEERING_PRINCIPLES_SECTION),
      },
      guidelines: textMap(top.guidelines, "guidelines"),
      conditional_guidelines: {
        codegraph_explore: text(conditional, "conditional_guidelines", "codegraph_explore"),
      },
    };
  }
}

const PROMPT = loadPromptConfig();

/** {{WORKSPACE_TMP}} is filled per session in before_agent_start. */
const MODE_POLICIES_PROMPT = PROMPT.sections[MODE_POLICIES_SECTION];
const ENGINEERING_PRINCIPLES = PROMPT.sections[ENGINEERING_PRINCIPLES_SECTION];
/** Guideline bullets contributed to pi's <rules>, in prompt.yaml order. */
const HARNESS_GUIDELINES = Object.values(PROMPT.guidelines);

/**
 * codegraph's tool: deps.ts registers the server as "codegraph", and pi names
 * MCP tools mcp__<server>__<tool>.
 */
const CODEGRAPH_NAMESPACE = "mcp__codegraph";
const CODEGRAPH_TOOL = `${CODEGRAPH_NAMESPACE}__codegraph_explore`;

/** Added to <rules> only while CODEGRAPH_TOOL is active. */
const CODEGRAPH_EXPLORE_RULE = PROMPT.conditional_guidelines.codegraph_explore;

/* ============================================================================
 * █▀▀▀▄ █▀▀▀▀ █▀▀▀▄       █▀▄▀█ █▀▀▀▀ ▄▀▀▀▀ ▄▀▀▀▀ ▄▀▀▀▄ ▄▀▀▀▀ █▀▀▀▀
 * █▀▀▀  █▀▀   █▀▀▀▄ ▀▀▀▀▀ █   █ █▀▀    ▀▀▀▄  ▀▀▀▄ █▀▀▀█ █ ▀▀█ █▀▀
 * ▀     ▀▀▀▀▀ ▀   ▀       ▀   ▀ ▀▀▀▀▀ ▀▀▀▀  ▀▀▀▀  ▀   ▀  ▀▀▀  ▀▀▀▀▀
 * █▀▀▀▄ █     ▄▀▀▀▄ █▄  █    ▄▀ █▀▀▀▄ █   █ ▀▀█▀▀ █     █▀▀▀▄
 * █▀▀▀  █     █▀▀▀█ █ ▀▄█  ▄▀   █▀▀▀▄ █   █   █   █     █   █
 * ▀     ▀▀▀▀▀ ▀   ▀ ▀   ▀ ▀     ▀▀▀▀   ▀▀▀  ▀▀▀▀▀ ▀▀▀▀▀ ▀▀▀▀
 * █▀▄▀█ ▄▀▀▀▄ █▀▀▀▄ █▀▀▀▀
 * █   █ █   █ █   █ █▀▀
 * ▀   ▀  ▀▀▀  ▀▀▀▀  ▀▀▀▀▀
 * ----------------------------------------------------------------------------
 * Per-message !plan/!build switching: custom editor, mode colors, working message, and the <active-mode> selector message.
 * ========================================================================== */
const MODE_ENTRY_TYPE = "per-message-mode";
const MODE_SELECTOR_MESSAGE_TYPE = "harness-active-mode";
const FINISHED_ENTRY_TYPE = "per-message-mode-finished";
const SYSTEM_PROMPT_ENTRY_TYPE = "harness-system-prompt";
/**
 * Entry types written by sessions created before the rename to "harness".
 * Renderers are registered for them too, so old transcripts still display.
 * (The old mode selector message type needs no alias: it has no renderer and
 * reaches the model by content.)
 */
const LEGACY_SYSTEM_PROMPT_ENTRY_TYPE = "thearchitect-system-prompt";

type SystemPromptEntryData = { text: string; model: string };

type TurnMode = "plan" | "normal";
type ModeDetails = { mode: TurnMode; model?: string; effort?: string; finishedAt?: number; durationMs?: number; costUsd?: number; interrupted?: boolean };
type ColorMode = ReturnType<Theme["getColorMode"]>;
type EventOf<TType extends ExtensionEvent["type"]> = Extract<
  ExtensionEvent,
  { type: TType }
>;

function stripNormalPrefix(text: string): string {
  if (!text.startsWith("!")) return text;
  return text.startsWith("! ") ? text.slice(2) : text.slice(1);
}

const MODE_COLOR_ANSI: Record<ColorMode, Record<TurnMode, string>> = {
  truecolor: {
    plan: "\x1b[38;2;255;139;61m",
    normal: "\x1b[38;2;176;114;255m",
  },
  "256color": {
    plan: "\x1b[38;5;209m",
    normal: "\x1b[38;5;135m",
  },
};

function applyModeColor(mode: TurnMode, colorMode: ColorMode, text: string): string {
  // ?? guards against future ColorMode additions: extensions load via jiti
  // without typechecking, so an unknown mode would otherwise crash at render.
  const palette = MODE_COLOR_ANSI[colorMode] ?? MODE_COLOR_ANSI.truecolor;
  return `${palette[mode]}${text}\x1b[39m`;
}

class PerMessageModeEditor extends CustomEditor {
  constructor(
    tui: TUI,
    theme: EditorTheme,
    private readonly modeKeybindings: KeybindingsManager,
    private readonly modeBorderColors: Record<TurnMode, EditorTheme["borderColor"]>,
    private readonly inheritedMode: () => TurnMode | undefined,
    private readonly onModeSelected: (mode: TurnMode) => void,
  ) {
    super(tui, theme, modeKeybindings);
  }

  override render(width: number): string[] {
    const requestedMode = this.getText().startsWith("!") ? "normal" : "plan";
    const mode = this.inheritedMode() ?? requestedMode;
    this.borderColor = this.modeBorderColors[mode];
    return super.render(width);
  }

  override handleInput(data: string): void {
    const isSubmission =
      this.modeKeybindings.matches(data, "tui.input.submit") ||
      this.modeKeybindings.matches(data, "app.message.followUp");

    if (isSubmission) {
      const text = this.getExpandedText();
      if (text.startsWith("!")) {
        this.setText(stripNormalPrefix(text));
        this.onModeSelected("normal");
      } else {
        this.onModeSelected("plan");
      }
    }

    super.handleInput(data);
  }
}

function applyModeWorkingMessage(ctx: ExtensionContext, mode: TurnMode): void {
  const text = mode === "plan" ? "Planning..." : "Building...";
  ctx.ui.setWorkingMessage(
    applyModeColor(mode, ctx.ui.theme.getColorMode(), text),
  );
}

function modeName(mode: TurnMode): "plan" | "build" {
  return mode === "plan" ? "plan" : "build";
}

function formatModeSelector(mode: TurnMode): string {
  return `<active-mode mode="${modeName(mode)}" />`;
}

/* ============================================================================
 * ▄▀▀▀▀ █   █ ▄▀▀▀▀ █     █▀▀▀▀
 * █     ▀▀▀▀█ █     █     █▀▀
 *  ▀▀▀▀ ▀▀▀▀▀  ▀▀▀▀ ▀▀▀▀▀ ▀▀▀▀▀
 * █▀▀▀▀ ▀▀█▀▀ █▄  █ ▀▀█▀▀ ▄▀▀▀▀ █   █ █▀▀▀▀ █▀▀▀▄
 * █▀▀     █   █ ▀▄█   █    ▀▀▀▄ █▀▀▀█ █▀▀   █   █
 * ▀     ▀▀▀▀▀ ▀   ▀ ▀▀▀▀▀ ▀▀▀▀  ▀   ▀ ▀▀▀▀▀ ▀▀▀▀
 * ▄▀▀▀▀ ▀▀█▀▀ ▄▀▀▀▄ ▀▀█▀▀ ▄▀▀▀▀
 *  ▀▀▀▄   █   █▀▀▀█   █    ▀▀▀▄
 * ▀▀▀▀    ▀   ▀   ▀   ▀   ▀▀▀▀
 * ----------------------------------------------------------------------------
 * Finish time + duration + USD cost of the last cycle, diffed from session usage; rendered gray after "planning/building finished".
 * ========================================================================== */
function totalSessionCost(entries: SessionEntry[]): number {
  let cost = 0;
  for (const entry of entries) {
    if (entry.type === "message") {
      const message = entry.message;
      if (message.role === "assistant") {
        cost += message.usage.cost.total;
      } else if (message.role === "toolResult" && message.usage) {
        cost += message.usage.cost.total;
      }
    } else if (
      (entry.type === "branch_summary" || entry.type === "compaction") &&
      entry.usage
    ) {
      cost += entry.usage.cost.total;
    }
  }
  return cost;
}

function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

function formatCost(costUsd: number): string {
  if (costUsd <= 0) return "$0.000";
  if (costUsd < 0.001) return `$${costUsd.toFixed(4)}`;
  if (costUsd < 1) return `$${costUsd.toFixed(3)}`;
  return `$${costUsd.toFixed(2)}`;
}

function formatTimestamp(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` • ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/* ============================================================================
 * █▀▀▀▀ █▀▀▀▄ █  ▄▀ █▀▀▀▀ █▀▀▀▄       ▄▀▀▀▀ █▀▀▀▀ ▀▀█▀▀ █▀▀▀▀ █▀▀▀▀ ▄▀▀▀▀ █▀▀▀▀
 * █▀▀   █▀▀▀▄ █▀▀▄  █▀▀   █   █       █     █▀▀     █   █▀▀   █▀▀    ▀▀▀▄  █▀▀
 * ▀▀▀▀▀ ▀   ▀ ▀   ▀ ▀▀▀▀▀ ▀▀▀▀        ▀▀▀▀  ▀▀▀▀▀   ▀   ▀▀▀▀▀ ▀▀▀▀▀ ▀▀▀▀  ▀▀▀▀▀
 * ▄▀▀▀▀ ▄▀▀▀▄ █▀▀▀▄ █▀▀▀▀ ▄▀▀▀▀ ▀▀█▀▀  █  ▄▀ █▀▀▀▀ █▀▀▀▄ █▀▀▀▀ ▄▀▀▀▀ ▀▀█▀▀
 * █   █ █   █ █   █ █▀▀   █  ▀▀▄   █   █▀▀▄  █▀▀   █▀▀▀▄ █▀▀    ▀▀▀▄   █
 * ▀   ▀  ▀▀▀  ▀▀▀▀  ▀▀▀▀▀  ▀▀▀▀  ▀▀▀▀▀  ▀   ▀ ▀▀▀▀▀ ▀   ▀ ▀▀▀▀▀ ▀▀▀▀  ▀▀▀▀▀
 * ----------------------------------------------------------------------------
 * Permission-gate dialog: BUILD write/edit confirmations offer Yes / No (why?) /
 * Stop with a multiline comment field (options left, wider textarea right). The
 * comment is delivered back to the model without interrupting the run: as the
 * tool-result text (error reason for No/Stop, appended content for Yes) and as
 * a steer message — Stop carries it in the tool result only.
 * ========================================================================== */

type GateAction = "allow" | "reject" | "stop";
type GateDecision = { action: GateAction; comment?: string };

const GATE_MIN_EDITOR_WIDTH = 34;
const GATE_LEFT_WIDTH = 24;
const GATE_COMMENT_FIFO_LIMIT = 256;

const GATE_OPTION_LABELS: readonly { action: GateAction; label: string }[] = [
  { action: "allow", label: "Yes" },
  { action: "reject", label: "No (why?)" },
  { action: "stop", label: "Stop" },
];

/** Minimal select-list palette the Editor theme requires (mirrors pi-ask-user). */
function gateSelectListTheme(theme: Theme): EditorTheme["selectList"] {
  return {
    selectedPrefix: (t: string): string => theme.fg("accent", t),
    selectedText: (t: string): string => theme.fg("accent", t),
    description: (t: string): string => theme.fg("muted", t),
    scrollInfo: (t: string): string => theme.fg("dim", t),
    noMatch: (t: string): string => theme.fg("warning", t),
  };
}

/** Editor theme whose border color follows the dialog's active zone. */
function gateEditorTheme(theme: Theme, commentActive: () => boolean): EditorTheme {
  return {
    borderColor: (s: string): string =>
      theme.fg(commentActive() ? "accent" : "borderMuted", s),
    selectList: gateSelectListTheme(theme),
  };
}

function gateTopBorder(theme: Theme, width: number, title: string): string {
  const inner = Math.max(1, width - 2);
  const label = ` ${title} `;
  if (inner < label.length + 2) {
    return theme.fg("accent", "╭" + "─".repeat(inner) + "╮");
  }
  return (
    theme.fg("accent", "╭─") +
    theme.fg("dim", theme.bold(label)) +
    theme.fg("accent", "─".repeat(Math.max(0, inner - 1 - label.length)) + "╮")
  );
}

function gateBottomBorder(theme: Theme, width: number): string {
  const inner = Math.max(1, width - 2);
  return theme.fg("accent", "╰" + "─".repeat(inner) + "╯");
}

/** Pad an ANSI-aware line to exactly `width` columns (no truncation). */
function padLineToWidth(line: string, width: number): string {
  const used = visibleWidth(line);
  return used >= width ? line : line + " ".repeat(width - used);
}

/** First printable single character of the data, or undefined for controls. */
function printableChar(data: string): string | undefined {
  const kittyPrintable = decodeKittyPrintable(data);
  if (kittyPrintable !== undefined) return kittyPrintable;
  const characters = [...data];
  if (characters.length !== 1) return undefined;
  const [character] = characters;
  if (!character) return undefined;
  const code = character.charCodeAt(0);
  if (code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return undefined;
  return character;
}

/**
 * Inline (editor-slot) dialog: option column on the left, multiline comment
 * editor taking the larger share of the width on the right.
 *
 * Keys:
 * - options zone: ↑/↓ choose, Enter submit, Tab ⇄ comment, Esc = cancel (null)
 * - comment zone: Enter newline, Ctrl+Enter submit, Shift+Enter/Ctrl+J newline,
 *   Esc back to options, Tab ⇄ options. Typing in the options zone drops
 *   straight into the comment field.
 */
class GateDialog implements Component {
  private readonly editor: Editor;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly onDone: (result: GateDecision | null) => void;
  private readonly detail: string;

  private selectedIndex = 0; // Yes
  private zone: "options" | "comment" = "options";
  private warning: string | undefined;
  private _focused = false;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    tool: string,
    path: string,
    onDone: (result: GateDecision | null) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.onDone = onDone;
    this.detail = `${tool}: ${path}`;
    // Enter must insert a newline in the comment field; submission happens via
    // Ctrl+Enter or from the options zone. disableSubmit makes the editor
    // swallow plain Enter instead of invoking onSubmit. The border color
    // follows the active zone (see gateEditorTheme).
    this.editor = new Editor(
      tui,
      gateEditorTheme(theme, () => this.zone === "comment"),
      { paddingX: 1 },
    );
    this.editor.disableSubmit = true;
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    if (this._focused === value) return;
    this._focused = value;
    this.editor.focused = value && this.zone === "comment";
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  private comment(): string {
    return this.editor.getText().trim();
  }

  private setZone(zone: "options" | "comment"): void {
    if (this.zone === zone) return;
    this.zone = zone;
    this.editor.focused = zone === "comment" && this._focused;
    this.tui.requestRender();
  }

  private submit(): void {
    const option = GATE_OPTION_LABELS[this.selectedIndex];
    const text = this.comment();
    if (option.action === "reject" && text.length === 0) {
      this.warning = "No (why?) requires a comment — say what is wrong / what to fix";
      this.setZone("comment");
      return;
    }
    this.warning = undefined;
    this.onDone({ action: option.action, comment: text.length > 0 ? text : undefined });
  }

  private moveSelection(delta: number): void {
    this.selectedIndex = Math.max(
      0,
      Math.min(GATE_OPTION_LABELS.length - 1, this.selectedIndex + delta),
    );
    this.warning = undefined;
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.zone === "comment") {
      // Ctrl+Enter submits from the comment field; plain Enter is a newline.
      if (matchesKey(data, Key.ctrl("enter"))) {
        this.submit();
        return;
      }
      if (matchesKey(data, Key.escape)) {
        this.setZone("options");
        return;
      }
      if (this.keybindings.matches(data, "tui.input.newLine")) {
        this.editor.handleInput(data);
        this.tui.requestRender();
        return;
      }
      if (this.keybindings.matches(data, "tui.input.submit")) {
        this.editor.insertTextAtCursor("\n");
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
        this.setZone("options");
        return;
      }
      this.editor.handleInput(data);
      this.tui.requestRender();
      return;
    }

    // Options zone.
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      this.moveSelection(1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.submit();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.onDone(null);
      return;
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
      this.setZone("comment");
      return;
    }
    if (printableChar(data) !== undefined) {
      // Typing jumps straight into the comment field.
      this.setZone("comment");
      this.editor.handleInput(data);
      this.tui.requestRender();
    }
  }

  private optionRow(index: number, width: number): string {
    const option = GATE_OPTION_LABELS[index];
    const selected = index === this.selectedIndex;
    const mark = selected ? "●" : "○";
    const line = `${mark} ${option.label}`;
    let styled: string;
    if (this.zone === "comment") {
      // The list is inert while the comment field is active, but the armed
      // submit target must stay readable: accent without bold, peers muted.
      styled = selected
        ? this.theme.fg("accent", line)
        : this.theme.fg("muted", line);
    } else if (selected) {
      styled = this.theme.fg("accent", this.theme.bold(line));
    } else {
      styled = this.theme.fg("text", line);
    }
    return truncateToWidth(styled, width, "", true);
  }

  render(width: number): string[] {
    const theme = this.theme;
    const lines: string[] = [];
    lines.push(gateTopBorder(theme, width, "Allow file change?"));
    lines.push(
      padLineToWidth(
        truncateToWidth(theme.fg("muted", this.detail), width - 2, "", false),
        width,
      ),
    );
    lines.push("");

    // The comment field takes everything left over after the option list.
    const split = width >= GATE_LEFT_WIDTH + 1 + GATE_MIN_EDITOR_WIDTH;
    const rightWidth = split ? width - GATE_LEFT_WIDTH - 1 : width;
    const editorLines = this.editor.render(rightWidth).map((line) =>
      padLineToWidth(line, rightWidth),
    );

    if (split) {
      const bodyRows = Math.max(GATE_OPTION_LABELS.length, editorLines.length);
      for (let row = 0; row < bodyRows; row++) {
        const left =
          row < GATE_OPTION_LABELS.length
            ? this.optionRow(row, GATE_LEFT_WIDTH)
            : " ".repeat(GATE_LEFT_WIDTH);
        const right = editorLines[row] ?? " ".repeat(rightWidth);
        lines.push(left + " " + right);
      }
    } else {
      for (let row = 0; row < GATE_OPTION_LABELS.length; row++) {
        lines.push(this.optionRow(row, width));
      }
      lines.push("");
      for (const editorLine of editorLines) {
        lines.push(editorLine);
      }
    }

    lines.push("");
    const submitTarget = GATE_OPTION_LABELS[this.selectedIndex].label;
    const status =
      this.warning ??
      (this.zone === "comment"
        ? `submit: ${submitTarget} · Enter newline · Ctrl+Enter submit · Tab/Esc → options`
        : `↑/↓ choose · Enter submit · Tab → comment · Esc = Stop`);
    const zoneTag =
      this.zone === "comment" ? theme.fg("accent", "▸ comment") : theme.fg("accent", "▸ options");
    const styledStatus = this.warning
      ? theme.fg("warning", status)
      : theme.fg("dim", status);
    lines.push(
      padLineToWidth(
        truncateToWidth(`${zoneTag} ${styledStatus}`, width - 2, "", false),
        width,
      ),
    );
    lines.push(gateBottomBorder(theme, width));
    return lines;
  }
}

/**
 * Wraps a tool-call renderer, appending the user's gate comment below the
 * rendered call content (approve-with-comment only). Display-only: the
 * comment itself still travels to the model through the tool result and the
 * steer message.
 */
class GateCommentRow implements Component {
  constructor(
    private readonly base: Component,
    private readonly theme: Theme,
    private readonly comment: string,
  ) {}

  invalidate(): void {
    this.base.invalidate();
  }

  render(width: number): string[] {
    const label = `${this.theme.fg("dim", "✻ your comment:")} ${this.comment}`;
    const commentLines = wrapTextWithAnsi(label, Math.max(8, width)).map((line) =>
      padLineToWidth(line, width),
    );
    return [...this.base.render(width), "", ...commentLines];
  }
}

/**
 * Show the permission-gate dialog. Returns the decision, or null when the
 * user cancels (Esc) — treated by the caller as Stop without a comment.
 * TUI uses the rich GateDialog component; other dialog-capable modes fall
 * back to a select + input chain.
 */
async function askGateDecision(
  ctx: ExtensionContext,
  tool: string,
  path: string,
): Promise<GateDecision | null> {
  if (ctx.mode === "tui") {
    try {
      return await ctx.ui.custom<GateDecision | null>(
        (tui, theme, keybindings, done) => {
          let closed = false;
          const close = (result: GateDecision | null): void => {
            if (closed) return;
            closed = true;
            ctx.signal?.removeEventListener("abort", onAbort);
            done(result);
          };
          const onAbort = (): void => close(null);
          ctx.signal?.addEventListener("abort", onAbort, { once: true });
          return new GateDialog(tui, theme, keybindings, tool, path, close);
        },
      );
    } catch {
      // Component failed to mount; degrade to the dialog chain below.
    }
  }

  const prompt = `Allow file change?\n${tool}: ${path}`;
  const choice = await ctx.ui.select(prompt, [
    "Yes",
    "No — reject (comment required)",
    "Stop",
  ]);
  if (choice === "Yes") {
    const comment = await ctx.ui.input(
      "Optional comment (Enter to skip).",
      "Comment for the model…",
    );
    const trimmed = comment?.trim();
    return { action: "allow", comment: trimmed ? trimmed : undefined };
  }
  if (choice === "No — reject (comment required)") {
    const comment = await ctx.ui.input(
      "Why reject? Required — the model sees this comment.",
      "What is wrong / what to fix…",
    );
    const trimmed = comment?.trim();
    if (!trimmed) return { action: "stop" };
    return { action: "reject", comment: trimmed };
  }
  // "Stop" or a cancelled dialog both mean reject-and-stop without steer.
  return { action: "stop" };
}


/* ============================================================================
 * █▀▀▀▀ ▀▀█▀▀ █     █▀▀▀▀       ▄▀▀▀▀ █   █ ▄▀▀▀▄ █▄  █ ▄▀▀▀▀ █▀▀▀▀
 * █▀▀     █   █     █▀▀         █     █▀▀▀█ █▀▀▀█ █ ▀▄█ █ ▀▀█ █▀▀
 * ▀     ▀▀▀▀▀ ▀▀▀▀▀ ▀▀▀▀▀        ▀▀▀▀ ▀   ▀ ▀   ▀ ▀   ▀  ▀▀▀  ▀▀▀▀▀
 * ▄▀▀▀▀ ▄▀▀▀▄ ▀▀█▀▀ ▀▀█▀▀ █▄  █ ▄▀▀▀▀
 * █ ▀▀█ █▀▀▀█   █     █   █ ▀▄█ █ ▀▀█
 *  ▀▀▀  ▀   ▀   ▀   ▀▀▀▀▀ ▀   ▀  ▀▀▀
 * ----------------------------------------------------------------------------
 * Plan mode blocks write/edit outside /tmp and the session workspace; build mode asks for UI confirmation (madness bypasses).
 * ========================================================================== */
async function canonicalizeProspectivePath(path: string): Promise<string> {
  let cursor = resolve(path);
  const missingSegments: string[] = [];

  for (;;) {
    try {
      const existing = await realpath(cursor);
      return resolve(existing, ...missingSegments.reverse());
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;

      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missingSegments.push(basename(cursor));
      cursor = parent;
    }
  }
}

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!isAbsolute(pathFromRoot) && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`))
  );
}

async function isInsideTemp(path: string, cwd: string, tempRoot: string): Promise<boolean> {
  const candidate = await canonicalizeProspectivePath(resolve(cwd, path));
  return isInside(tempRoot, candidate);
}

/** Minimal view of the session manager needed to locate the session workspace. */
type SessionWorkspaceManager = {
  getHeader(): { id: string; timestamp: string } | null;
};

function formatSessionDate(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `--${pad(date.getHours())}-${pad(date.getMinutes())}`
  );
}

/**
 * Per-session disposable workspace root: <cwd>/.agent-workspace-tmp/<creation-date>--<session-id>.
 * Canonicalized so a symlinked cwd still compares correctly; undefined without a session header.
 */
async function sessionWorkspaceRoot(
  cwd: string,
  sessionManager: SessionWorkspaceManager,
): Promise<string | undefined> {
  const header = sessionManager.getHeader();
  if (!header) return undefined;
  return canonicalizeProspectivePath(
    resolve(
      cwd,
      ".agent-workspace-tmp",
      `${formatSessionDate(new Date(header.timestamp))}--${header.id}`,
    )
  );
}

/** Per-call bash interrupt handle for "/-": abort the controller and record why. */
type BashInterrupt = { controller: AbortController; reason?: string };

export default async function harnessExtension(pi: ExtensionAPI): Promise<void> {
  // Only one harness copy per process (dev checkout vs installed package).
  if (!claimHarnessInstance()) return;

  process.env.PI_ASK_USER_DISPLAY_MODE ??= "inline";

  // Temporary workarounds for upstream gaps live in workarounds.ts.
  installWorkarounds(pi);
  // Bundled dependencies: MCP servers from the Nix bundle manifest + /deps (deps.ts).
  installDeps(pi);

  // Bundled skills: web-research (ollama web tools + lightpanda fallback),
  // explore-and-refactor (codegraph + LSP exploration, semantic refactoring).
  const extensionDir = dirname(fileURLToPath(import.meta.url));
  pi.on("resources_discover", () => ({
    skillPaths: ["web-research", "explore-and-refactor"].map((name) =>
      join(extensionDir, "skills", name, "SKILL.md"),
    ),
  }));
  // Долгая кэш-ретенция промптов (читается при каждом запросе модели).
  process.env.PI_CACHE_RETENTION ??= "long";

  // Keep write calls fully visible without expanding every tool row. Reuse
  // Pi's definition and renderer; only override the renderer's expansion input.
  // renderCall also appends the user's gate comment (approve-with-comment)
  // below the rendered content — see GateCommentRow.
  const writeTool = createWriteToolDefinition(process.cwd());
  pi.registerTool({
    ...writeTool,
    renderCall: (args, theme, context) => {
      const base = writeTool.renderCall!(args, theme, { ...context, expanded: true });
      const comment = pendingGateComments.get(context.toolCallId);
      return comment === undefined ? base : new GateCommentRow(base, theme, comment);
    },
  });

  // Mirror the same comment row for edit gates (keeps Pi's own renderer and
  // its collapse behavior otherwise untouched).
  const editTool = createEditToolDefinition(process.cwd());
  pi.registerTool({
    ...editTool,
    renderCall: (args, theme, context) => {
      const base = editTool.renderCall!(args, theme, context);
      const comment = pendingGateComments.get(context.toolCallId);
      return comment === undefined ? base : new GateCommentRow(base, theme, comment);
    },
  });

  // Built-in bash is re-registered only to give "/-" a per-call interrupt
  // handle: the wrapper combines the run's abort signal with its own
  // controller, so aborting the controller kills this command's process tree
  // (the tool then reports "Command aborted") without aborting the run.
  // Everything else - spawn, timeout, truncation, renderers, snippet - comes
  // from pi's definition unchanged.
  // Each call runs a definition built for the session cwd with the shell
  // settings pi applies to its own bash tool (shellPath, shellCommandPrefix
  // from global + trusted project settings), resolved through the public
  // SettingsManager exactly like pi's session does.
  const bashTool = createBashToolDefinition(process.cwd());
  pi.registerTool({
    ...bashTool,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const interrupt: BashInterrupt = { controller: new AbortController() };
      bashInterrupts.set(toolCallId, interrupt);
      try {
        const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
          projectTrusted: ctx.isProjectTrusted(),
        });
        const sessionBashTool = createBashToolDefinition(ctx.cwd, {
          commandPrefix: settings.getShellCommandPrefix(),
          shellPath: settings.getShellPath(),
        });
        return await sessionBashTool.execute(
          toolCallId,
          params,
          signal
            ? AbortSignal.any([signal, interrupt.controller.signal])
            : interrupt.controller.signal,
          onUpdate,
          ctx,
        );
      } catch (error) {
        // "/-" records the user's reason on the handle before aborting; append
        // it to the tool error so the model sees why the command stopped even
        // before the steer message arrives.
        if (interrupt.reason !== undefined && error instanceof Error) {
          // ". " keeps the sentence boundary readable for errors that do not
          // end with a final period (bash's "Command aborted" does not).
          const separator = error.message.endsWith(".") ? " " : ". ";
          throw new Error(
            error.message +
              `${separator}Aborted by user. User-provided abort reason: ${interrupt.reason}`,
          );
        }
        throw error;
      } finally {
        bashInterrupts.delete(toolCallId);
      }
    },
  });

  const tempRoot = await canonicalizeProspectivePath(tmpdir());
  let pendingSubmissionMode: TurnMode | undefined;
  let activeMode: TurnMode = "plan";
  let madnessEnabled = false;
  let cycleStartTime: number | undefined;
  let baselineCost = 0;
  let systemPromptEntryShown = false;
  let codegraphNameErrorShown = false;
  const blockedToolCalls = new Set<string>();
  // toolCallId -> comment for write/edit calls approved with a comment: the
  // comment is appended to the real tool result once the tool completes.
  const pendingGateComments = new Map<string, string>();
  // toolCallId -> interrupt handle of a running wrapped bash call: "/-" aborts
  // it to kill the command without aborting its run and records the reason.
  const bashInterrupts = new Map<string, BashInterrupt>();

  /**
   * Deliver a gate comment to the running agent as a steer message (same path
   * as user typing while streaming). expandPromptTemplates=false keeps the
   * comment verbatim: a leading "/" must not trigger a command or template.
   */
  function sendGateSteer(comment: string): void {
    try {
      pi.sendUserMessage(comment, { deliverAs: "steer", expandPromptTemplates: false });
    } catch {
      // Best-effort: the tool-result channel still carries the comment.
    }
  }

  /**
   * Remember an approved-with-comment tool call. Entries stay until the
   * session starts over (bounded FIFO) so tool rows keep showing the comment
   * on any later re-render.
   */
  function rememberGateComment(toolCallId: string, comment: string): void {
    if (pendingGateComments.size >= GATE_COMMENT_FIFO_LIMIT) {
      const oldest = pendingGateComments.keys().next().value;
      if (oldest !== undefined) pendingGateComments.delete(oldest);
    }
    pendingGateComments.set(toolCallId, comment);
  }

/* ============================================================================
 * █   █ █▀▀▀▀ █▀▀▀▄ █▀▀▀▄ █▀▀▀▄       █▀▀▀▄ █     ▄▀▀▀▄ ▄▀▀▀▀ █  ▄▀ █▀▀▀▀ █▀▀▀▄
 * █▀▀▀█ █▀▀   █▀▀▀▄ █   █ █▀▀▀▄       █▀▀▀▄ █     █   █ █     █▀▀▄  █▀▀   █   █
 * ▀   ▀ ▀▀▀▀▀ ▀   ▀ ▀▀▀▀  ▀   ▀       ▀▀▀▀  ▀▀▀▀▀  ▀▀▀   ▀▀▀▀ ▀   ▀ ▀▀▀▀▀ ▀▀▀▀
 * █▀▀▀▀ █   █ █▀▀▀▀ █▄  █ ▀▀█▀▀ ▄▀▀▀▀
 * █▀▀    █ █  █▀▀   █ ▀▄█   █    ▀▀▀▄
 * ▀▀▀▀▀   ▀   ▀▀▀▀▀ ▀   ▀   ▀   ▀▀▀▀
 * ----------------------------------------------------------------------------
 * Emits "herdr:blocked" while ask_user dialogs and approval prompts are pending.
 * ========================================================================== */

  const HERDR_BLOCKED_EVENT = "herdr:blocked";

  function reportBlocked(active: boolean, label: string): void {
    pi.events.emit(HERDR_BLOCKED_EVENT, { active, label });
  }

  function startBlockedTool(toolCallId: string, label: string): void {
    if (blockedToolCalls.has(toolCallId)) return;
    blockedToolCalls.add(toolCallId);
    reportBlocked(true, label);
  }

  function finishBlockedTool(toolCallId: string, label: string): void {
    if (!blockedToolCalls.delete(toolCallId)) return;
    reportBlocked(false, label);
  }

/* ============================================================================
 * █▀▄▀█ ▄▀▀▀▄ █▀▀▀▄ █▄  █ █▀▀▀▀ ▄▀▀▀▀ ▄▀▀▀▀
 * █   █ █▀▀▀█ █   █ █ ▀▄█ █▀▀    ▀▀▀▄  ▀▀▀▄
 * ▀   ▀ ▀   ▀ ▀▀▀▀  ▀   ▀ ▀▀▀▀▀ ▀▀▀▀  ▀▀▀▀
 * ▄▀▀▀▀ ▄▀▀▀▄ █▀▄▀█ █▀▄▀█ ▄▀▀▀▄ █▄  █ █▀▀▀▄
 * █     █   █ █   █ █   █ █▀▀▀█ █ ▀▄█ █   █
 *  ▀▀▀▀  ▀▀▀  ▀   ▀ ▀   ▀ ▀   ▀ ▀   ▀ ▀▀▀▀
 * ----------------------------------------------------------------------------
 * "/madness" command and Ctrl+\\ shortcut: bypasses write/edit permission gates.
 * ========================================================================== */

  const STATUS_WIDGET_KEY = "harness:status";

  // Single status line below the editor: "❤︎ <gate> × session <id>".
  function updateStatusWidget(ctx: ExtensionContext): void {
    const theme = ctx.ui.theme;
    const gate = madnessEnabled
      ? theme.fg("error", theme.bold("this is madness"))
      : theme.fg("dim", "you shall not pass");
    const id = ctx.sessionManager.getSessionId();
    const line = id
      ? `${theme.fg("dim", "✻")} ${gate} ${theme.fg("dim", "✻")} ${theme.fg("dim", `session ${id}`)}`
      : `${theme.fg("dim", "✻")} ${gate}`;
    ctx.ui.setWidget(STATUS_WIDGET_KEY, [line], { placement: "belowEditor" });
  }

  function toggleMadness(ctx: ExtensionContext): void {
    madnessEnabled = !madnessEnabled;
    updateStatusWidget(ctx);
    ctx.ui.notify(
      madnessEnabled
        ? "madness mode enabled: permission gates disabled"
        : "madness mode disabled: permission gates restored",
      "info",
    );
  }

  pi.registerCommand("madness", {
    description: "Toggle full write/edit permission bypass",
    handler: async (
      _args: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Madness requires dialog-capable UI (TUI or RPC).", "error");
        return;
      }

      toggleMadness(ctx);
    },
  });

  pi.registerShortcut("ctrl+\\", {
    description: "Toggle madness mode",
    handler: (ctx: ExtensionContext): void => {
      toggleMadness(ctx);
    },
  });

/* ============================================================================
 * ▄▀▀▀▀ █     ▄▀▀▀▄ ▄▀▀▀▀ █   █       █▀▀▀▄ ▄▀▀▀▄ ▄▀▀▀▀ █   █
 *  ▀▀▀▄ █     █▀▀▀█  ▀▀▀▄ █▀▀▀█       █   █ █▀▀▀█  ▀▀▀▄ █▀▀▀█
 * ▀▀▀▀  ▀▀▀▀▀ ▀   ▀ ▀▀▀▀  ▀   ▀       ▀▀▀▀  ▀   ▀ ▀▀▀▀  ▀   ▀
 * ----------------------------------------------------------------------------
 * "/- <message>": aborts the bash call that is currently executing (its
 * process tree only - the run keeps going) and steers <message> to the running
 * model. The aborted call's error also carries "Aborted by user. User-provided
 * abort reason: <message>" so the model sees the reason even before the steer
 * message arrives. Without a live bash call the message is simply steered: it
 * waits for the current tool batch, or starts the next turn when the session
 * is idle. No run is ever aborted here - that stays on Esc.
 * ========================================================================== */

  /** Abort every in-flight wrapped bash call; returns how many were running. */
  function interruptRunningBash(reason: string): number {
    let killed = 0;
    for (const interrupt of bashInterrupts.values()) {
      if (interrupt.controller.signal.aborted) continue;
      // Recorded before abort() so the wrapper can append it to the tool error.
      interrupt.reason = reason;
      interrupt.controller.abort();
      killed += 1;
    }
    return killed;
  }

  pi.registerCommand("-", {
    description: "Abort the running bash call and steer the message",
    handler: async (
      args: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> => {
      // Everything after "/- ", newlines included; trim only the edges.
      const text = args.trim();
      if (text.length === 0) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /- <message>", "warning");
        return;
      }
      const wasIdle = ctx.isIdle();
      const killed = interruptRunningBash(text);
      // Same delivery channel as the gate comments (sendGateSteer):
      // expandPromptTemplates=false keeps the text verbatim, so a leading "/"
      // must not trigger a command or template, and "steer" continues the
      // current run once its tool batch finishes.
      pi.sendUserMessage(text, { deliverAs: "steer", expandPromptTemplates: false });
      if (!ctx.hasUI) return;
      ctx.ui.notify(
        killed > 0
          ? `bash aborted (${killed}) — message steered to the model`
          : wasIdle
            ? "message sent to the model"
            : "message steered to the model",
        "info",
      );
    },
  });

/* ============================================================================
 * █▀▄▀█ ▄▀▀▀▄ █▀▀▀▄ █▀▀▀▀       █▀▀▀▄ ▄▀▀▀▄ █▄  █ █▄  █ █▀▀▀▀ █▀▀▀▄
 * █   █ █   █ █   █ █▀▀         █▀▀▀▄ █▀▀▀█ █ ▀▄█ █ ▀▄█ █▀▀   █▀▀▀▄
 * ▀   ▀  ▀▀▀  ▀▀▀▀  ▀▀▀▀▀       ▀▀▀▀  ▀   ▀ ▀   ▀ ▀   ▀ ▀▀▀▀▀ ▀   ▀
 * █▀▀▀▀ █▄  █ ▀▀█▀▀ █▀▀▀▄ ▀▀█▀▀ █▀▀▀▀ ▄▀▀▀▀
 * █▀▀   █ ▀▄█   █   █▀▀▀▄   █   █▀▀    ▀▀▀▄
 * ▀▀▀▀▀ ▀   ▀   ▀   ▀   ▀ ▀▀▀▀▀ ▀▀▀▀▀ ▀▀▀▀
 * ----------------------------------------------------------------------------
 * Chat chips: "◆ PLAN/◆ BUILD" markers and the "planning/building finished" banners (with gray finish-time/duration/cost suffix).
 * ========================================================================== */

  pi.registerEntryRenderer<ModeDetails>(
    MODE_ENTRY_TYPE,
    (
      entry: CustomEntry<ModeDetails>,
      _options: EntryRenderOptions,
      theme: Theme,
    ): Text => {
      const mode = entry.data?.mode === "normal" ? "normal" : "plan";
      const label = mode === "normal" ? "BUILD" : "PLAN";
      return new Text(
        applyModeColor(mode, theme.getColorMode(), theme.bold(`◆ ${label}`)),
        0,
        0,
      );
    },
  );

  pi.registerEntryRenderer<ModeDetails>(
    FINISHED_ENTRY_TYPE,
    (
      entry: CustomEntry<ModeDetails>,
      _options: EntryRenderOptions,
      theme: Theme,
    ): Text => {
      const mode = entry.data?.mode === "normal" ? "normal" : "plan";
      const interrupted = entry.data?.interrupted === true;
      const text = interrupted
        ? mode === "plan" ? "planning interrupted" : "building interrupted"
        : mode === "plan" ? "planning finished" : "building finished";
      const identityParts: string[] = [];
      if (entry.data?.model) identityParts.push(entry.data.model);
      if (entry.data?.effort) identityParts.push(entry.data.effort);
      const statsParts: string[] = [];
      if (entry.data?.finishedAt !== undefined) {
        statsParts.push(formatTimestamp(entry.data.finishedAt));
      }
      if (
        entry.data?.durationMs !== undefined &&
        entry.data?.costUsd !== undefined
      ) {
        statsParts.push(
          formatDuration(entry.data.durationMs),
          formatCost(entry.data.costUsd),
        );
      }
      // Model • effort form one identity group; groups stay " / "-separated.
      const suffixParts =
        identityParts.length > 0
          ? [identityParts.join(" • "), ...statsParts]
          : statsParts;
      const statsSuffix =
        suffixParts.length > 0
          ? theme.fg("muted", `  ${suffixParts.join(" / ")}`)
          : "";
      return new Text(
        applyModeColor(mode, theme.getColorMode(), text) + statsSuffix,
        0,
        0,
      );
    },
  );

  // ------------------------------------------------------------------
  // First-run system prompt dump: collapsible transcript entry showing the
  // exact prompt assembled for the first request of the session. Collapsed
  // it is a one-line chip; expanded it shows the full prompt text.
  // ------------------------------------------------------------------
  const renderSystemPromptEntry = (
    entry: CustomEntry<SystemPromptEntryData>,
    options: EntryRenderOptions,
    theme: Theme,
  ): Text => {
    const data = entry.data;
    const summary = data
      ? `◆ System prompt · ${data.model}`
      : "◆ System prompt";
    if (!data || !options.expanded) {
      return new Text(
        summary + (data ? theme.fg("muted", " · expand to view") : ""),
        0,
        0,
      );
    }
    return new Text(
      `${theme.bold(summary)}${theme.fg(
        "muted",
        ` · ${data.text.length.toLocaleString()} chars · first request of this session`,
      )}\n\n${data.text}`,
      0,
      0,
    );
  };
  for (const type of [SYSTEM_PROMPT_ENTRY_TYPE, LEGACY_SYSTEM_PROMPT_ENTRY_TYPE]) {
    pi.registerEntryRenderer<SystemPromptEntryData>(type, renderSystemPromptEntry);
  }

  // ------------------------------------------------------------------
  // Session lifecycle: per-message editor component + state reset
  // ------------------------------------------------------------------
  pi.on(
    "session_start",
    (_event: EventOf<"session_start">, ctx: ExtensionContext): void => {
      pendingSubmissionMode = undefined;
      activeMode = "plan";
      madnessEnabled = false;
      cycleStartTime = undefined;
      baselineCost = 0;
      systemPromptEntryShown = false;
      codegraphNameErrorShown = false;
      blockedToolCalls.clear();
      pendingGateComments.clear();
      bashInterrupts.clear();
      applyContextWindowOverrides(ctx.model);
      updateStatusWidget(ctx);
      if (ctx.mode !== "tui") return;
      ctx.ui.setEditorComponent(
        (
          tui: TUI,
          theme: EditorTheme,
          keybindings: KeybindingsManager,
        ): PerMessageModeEditor => {
          const colorMode = ctx.ui.theme.getColorMode();
          const modeBorderColors: Record<TurnMode, EditorTheme["borderColor"]> = {
            plan: (text: string): string => applyModeColor("plan", colorMode, text),
            normal: (text: string): string => applyModeColor("normal", colorMode, text),
          };
          return new PerMessageModeEditor(
            tui,
            theme,
            keybindings,
            modeBorderColors,
            (): TurnMode | undefined => (ctx.isIdle() ? undefined : activeMode),
            (mode: TurnMode): void => {
              pendingSubmissionMode = mode;
            },
          );
        },
      );
    },
  );

  // Model changes (/model, Ctrl+P cycle, session restore): apply static
  // overrides to the freshly selected model object.
  pi.on(
    "model_select",
    (event: EventOf<"model_select">, _ctx: ExtensionContext): void => {
      applyContextWindowOverrides(event.model);
    },
  );

  pi.on(
    "session_shutdown",
    (_event: EventOf<"session_shutdown">, ctx: ExtensionContext): void => {
      madnessEnabled = false;
      for (const toolCallId of blockedToolCalls) {
        finishBlockedTool(toolCallId, "question");
      }
      ctx.ui.setWidget(STATUS_WIDGET_KEY, undefined);
    },
  );

  // ------------------------------------------------------------------
  // herdr: block indicator while ask_user runs
  // ------------------------------------------------------------------
  pi.on(
    "tool_execution_start",
    (event: EventOf<"tool_execution_start">, ctx: ExtensionContext): void => {
      if (event.toolName === "ask_user" && ctx.hasUI) {
        startBlockedTool(event.toolCallId, "question");
      }
    },
  );

  pi.on("tool_execution_end", (event: EventOf<"tool_execution_end">): void => {
    if (event.toolName === "ask_user") {
      finishBlockedTool(event.toolCallId, "question");
    }
  });

  // ------------------------------------------------------------------
  // Input: per-message mode selection (steering/follow-up keep the run)
  // ------------------------------------------------------------------
  pi.on("input", (event: EventOf<"input">): InputEventResult => {
    // Extension-originated prompts (gate steer comments) must pass through
    // verbatim: no "!"-prefix handling, no mode chip, no mode flip.
    if (event.source === "extension") return { action: "continue" };
    let text = event.text;
    let requestedMode: TurnMode;

    if (text.startsWith("!")) {
      requestedMode = "normal";
      text = stripNormalPrefix(text);
    } else if (event.source === "interactive") {
      requestedMode = pendingSubmissionMode ?? "plan";
    } else {
      requestedMode = "plan";
    }
    pendingSubmissionMode = undefined;

    // Steering and follow-up messages continue the existing agent run.
    if (!event.streamingBehavior) activeMode = requestedMode;
    pi.appendEntry<ModeDetails>(MODE_ENTRY_TYPE, { mode: activeMode });

    return text === event.text
      ? { action: "continue" }
      : { action: "transform", text };
  });

  /**
   * Adds CODEGRAPH_EXPLORE_RULE while CODEGRAPH_TOOL is active and removes it
   * otherwise. No codegraph tools at all means the server is not connected
   * (yet): no rule, checked again next prompt. Codegraph tools without
   * CODEGRAPH_TOOL means the assumed name is wrong: reported once.
   */
  function applyCodegraphRule(guidelines: string[], ctx: ExtensionContext): void {
    const index = guidelines.indexOf(CODEGRAPH_EXPLORE_RULE);
    if (index !== -1) guidelines.splice(index, 1);
    const active = new Set(pi.getActiveTools());
    if (active.has(CODEGRAPH_TOOL)) {
      guidelines.push(CODEGRAPH_EXPLORE_RULE);
      return;
    }
    if (codegraphNameErrorShown) return;
    const codegraphTools = pi
      .getAllTools()
      .filter((tool) => tool.namespace?.name === CODEGRAPH_NAMESPACE)
      .map((tool) => tool.name);
    // Registered but deactivated on purpose (setActiveTools) is not an error.
    if (codegraphTools.length === 0 || codegraphTools.includes(CODEGRAPH_TOOL)) return;
    codegraphNameErrorShown = true;
    const message = `[harness] codegraph is connected but ${CODEGRAPH_TOOL} is not registered (found: ${codegraphTools.join(", ")}); codegraph rule not added.`;
    console.error(message);
    if (ctx.hasUI) ctx.ui.notify(message, "error");
  }

  // ------------------------------------------------------------------
  // Cycle start: mode selector message + cost baseline snapshot
  // ------------------------------------------------------------------
  pi.on(
    "before_agent_start",
    async (
      event: EventOf<"before_agent_start">,
      ctx: ExtensionContext,
    ): Promise<BeforeAgentStartEventResult> => {
      // Idempotent re-assertion each cycle: survives /reload mid-session and
      // catalog refreshes that replace the model object.
      applyContextWindowOverrides(ctx.model);
      applyModeWorkingMessage(ctx, activeMode);
      cycleStartTime = Date.now();
      baselineCost = totalSessionCost(ctx.sessionManager.getEntries());
      // Prompt contributions go into the structured options; pi renders the
      // prompt (never return systemPrompt: it would discard every later
      // handler's section changes).
      const workspaceRoot =
        (await sessionWorkspaceRoot(ctx.cwd, ctx.sessionManager)) ??
        resolve(ctx.cwd, ".agent-workspace-tmp");
      const options = event.systemPromptOptions;
      options.sections[MODE_POLICIES_SECTION] = MODE_POLICIES_PROMPT.replaceAll(
        "{{WORKSPACE_TMP}}",
        workspaceRoot,
      );
      options.sections[ENGINEERING_PRINCIPLES_SECTION] = ENGINEERING_PRINCIPLES;
      for (const guideline of HARNESS_GUIDELINES) {
        if (!options.promptGuidelines.includes(guideline)) {
          options.promptGuidelines.push(guideline);
        }
      }
      applyCodegraphRule(options.promptGuidelines, ctx);
      return {
        message: {
          customType: MODE_SELECTOR_MESSAGE_TYPE,
          content: formatModeSelector(activeMode),
          display: false,
          details: { mode: activeMode } satisfies ModeDetails,
        },
      };
    },
  );

  // First run of the session: surface the final prompt - after every
  // before_agent_start handler, including other extensions - as a
  // collapsible transcript entry (display only, never sent to the model).
  // Reset on session_start, so a /reload shows it again.
  pi.on(
    "agent_start",
    (_event: EventOf<"agent_start">, ctx: ExtensionContext): void => {
      if (
        CONFIG.showSystemPromptOnFirstRun === false ||
        systemPromptEntryShown
      ) {
        return;
      }
      systemPromptEntryShown = true;
      pi.appendEntry<SystemPromptEntryData>(SYSTEM_PROMPT_ENTRY_TYPE, {
        text: ctx.getSystemPrompt(),
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown",
      });
    },
  );

  // ------------------------------------------------------------------
  // Cycle end: "… finished" banner with finish time / duration / USD cost
  // ------------------------------------------------------------------
  pi.on(
    "agent_settled",
    (_event: EventOf<"agent_settled">, ctx: ExtensionContext): void => {
      if (ctx.mode !== "tui" || !ctx.isIdle()) return;
      const now = Date.now();
      const durationMs =
        cycleStartTime !== undefined ? now - cycleStartTime : undefined;
      const costUsd =
        durationMs !== undefined
          ? totalSessionCost(ctx.sessionManager.getEntries()) - baselineCost
          : undefined;
      // Best-effort abort/error detection: the settled leaf is normally the
      // final assistant message; anything else counts as a normal finish.
      const leaf = ctx.sessionManager.getLeafEntry();
      const interrupted =
        leaf?.type === "message" &&
        leaf.message.role === "assistant" &&
        (leaf.message.stopReason === "aborted" || leaf.message.stopReason === "error");
      pi.appendEntry<ModeDetails>(FINISHED_ENTRY_TYPE, {
        mode: activeMode,
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        effort: ctx.thinkingLevel,
        finishedAt: now,
        durationMs,
        costUsd,
        interrupted,
      });
    },
  );

  // ------------------------------------------------------------------
  // Tool-call interception:
  //  - ask_user: always offer the optional-comment row and the custom
  //    (freeform) answer row in the dialog, whatever the model passed.
  //  - write/edit gate: plan blocks outside /tmp + session workspace,
  //    build asks the Yes/No(why?)/Stop dialog (TUI or RPC), madness bypasses
  // ------------------------------------------------------------------
  pi.on(
    "tool_call",
    async (
      event: EventOf<"tool_call">,
      ctx: ExtensionContext,
    ): Promise<ToolCallEventResult | void> => {
      // ask_user renders "[ ] Add extra context after selection" only with
      // allowComment=true and "Type something." only with allowFreeform=true,
      // so force them on every call (mutating event.input is the sanctioned
      // way to patch tool arguments before execution). In the `questions`
      // batch form, allowFreeform is only legal per entry: a top-level copy
      // makes pi-ask-user >= 0.16.0 reject the whole call before any UI opens.
      if (event.toolName === "ask_user") {
        event.input.allowComment = true;
        event.input.contextExpanded = true;
        const questions = event.input.questions;
        if (Array.isArray(questions)) {
          for (const entry of questions) {
            if (entry !== null && typeof entry === "object") {
              (entry as Record<string, unknown>).allowFreeform = true;
            }
          }
        } else {
          event.input.allowFreeform = true;
        }
        return;
      }

      const mode = activeMode;

      let tool: "write" | "edit";
      let path: string;
      if (isToolCallEventType("write", event)) {
        tool = "write";
        path = event.input.path;
      } else if (isToolCallEventType("edit", event)) {
        tool = "edit";
        path = event.input.path;
      } else {
        return;
      }

      if (!path) {
        return {
          block: true,
          reason: `${tool} blocked: File path is required`,
        };
      }

      if (madnessEnabled) return;

      let workspaceRoot: string | undefined;
      try {
        if (await isInsideTemp(path, ctx.cwd, tempRoot)) return;
        // Same fallback as the system-prompt substitution so the gate and the
        // prompt never disagree about where the workspace is.
        workspaceRoot =
          (await sessionWorkspaceRoot(ctx.cwd, ctx.sessionManager)) ??
          (await canonicalizeProspectivePath(resolve(ctx.cwd, ".agent-workspace-tmp")));
        if (await isInsideTemp(path, ctx.cwd, workspaceRoot)) return;
      } catch (error) {
        if (mode === "plan") {
          return {
            block: true,
            reason: `PLAN could not safely resolve ${path}: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }

      if (mode === "plan") {
        return {
          block: true,
          reason: `PLAN allows ${tool} only inside ${tempRoot} or your session workspace (${workspaceRoot ?? "unavailable"}). Use a disposable copy there.`,
        };
      }

      if (!ctx.hasUI) {
        return {
          block: true,
          reason: `Change to ${path} blocked: confirmation requires dialog-capable UI (TUI or RPC).`,
        };
      }

      reportBlocked(true, `${tool} approval`);
      try {
        const decision = await askGateDecision(ctx, tool, path);
        if (!decision || decision.action === "stop") {
          // Esc or Stop: reject and end the run (tool result only, no steer —
          // the agent stops after this batch, so there is nowhere to steer to).
          const comment = decision?.comment;
          return {
            block: true,
            terminate: true,
            reason: comment
              ? `File change stopped by user — ${comment}`
              : "File change stopped by user",
          };
        }
        if (decision.action === "reject") {
          // No (why?): reject this call and let the model correct course — the
          // comment reaches it both as the error result and as a steer message.
          const comment = decision.comment ?? "";
          if (comment) sendGateSteer(comment);
          return {
            block: true,
            reason: comment
              ? `File change rejected by user — ${comment}`
              : "Rejected by user",
          };
        }
        // Yes: allow the change; an optional comment is appended to the tool
        // result after execution and also steered to the model.
        if (decision.comment) {
          rememberGateComment(event.toolCallId, decision.comment);
          sendGateSteer(decision.comment);
        }
        return;
      } finally {
        reportBlocked(false, `${tool} approval`);
      }
    },
  );

  // ------------------------------------------------------------------
  // Approved-with-comment write/edit calls: the comment opens the tool's
  // result content (so the model always sees it attached to the executed
  // change) and stays in pendingGateComments for the row renderer to draw it
  // under the call content. Blocked calls never reach this hook — their
  // comment is already part of the error reason.
  // ------------------------------------------------------------------
  pi.on(
    "tool_result",
    (event: EventOf<"tool_result">) => {
      const comment = pendingGateComments.get(event.toolCallId);
      if (comment === undefined) return;
      if (event.isError) return; // nothing was written; the row marker stays
      return {
        content: [
          { type: "text", text: `✻ your comment: ${comment}` },
          ...(event.content ?? []),
        ],
      };
    },
  );
}
