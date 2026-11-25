// The look of modes: their colors, the mode chip that opens each run in the transcript, the
// "… finished" banner that closes it, the first-run system prompt entry. Pure functions of entry
// data and the theme.

import type { CustomEntry, EntryRenderOptions, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { RunMode } from "#protocol/state.ts";
import { isRunMode, MODE_TEXT } from "../core/modes.ts";

type ColorMode = ReturnType<Theme["getColorMode"]>;

const MODE_COLOR_ANSI: Record<ColorMode, Record<RunMode, string>> = {
  truecolor: {
    plan: "\x1b[38;2;255;139;61m",
    build: "\x1b[38;2;176;114;255m",
    simple: "\x1b[38;2;94;201;120m",
  },
  "256color": {
    plan: "\x1b[38;5;209m",
    build: "\x1b[38;5;135m",
    simple: "\x1b[38;5;78m",
  },
};

/** Mode colors as hex, for clients that are not terminals. */
export const MODE_COLOR_HEX: Record<RunMode, string> = { plan: "#ff8b3d", build: "#b072ff", simple: "#5ec978" };

export function modeColor(mode: RunMode, colorMode: ColorMode, text: string): string {
  const palette = MODE_COLOR_ANSI[colorMode] ?? MODE_COLOR_ANSI.truecolor;
  return `${palette[mode]}${text}\x1b[39m`;
}

export type ModeEntryData = { mode: RunMode };

export type FinishedEntryData = {
  mode: RunMode;
  model?: string;
  effort?: string;
  finishedAt?: number;
  durationMs?: number;
  costUsd?: number;
  interrupted?: boolean;
};

export type SystemPromptEntryData = { text: string; model: string };

function storedMode(data: { mode?: unknown } | undefined): RunMode {
  return isRunMode(data?.mode) ? data.mode : "plan";
}

export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  } else {
    return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  }
}

export function formatCost(costUsd: number): string {
  if (costUsd <= 0) {
    return "$0.000";
  } else if (costUsd < 0.001) {
    return `$${costUsd.toFixed(4)}`;
  } else if (costUsd < 1) {
    return `$${costUsd.toFixed(3)}`;
  } else {
    return `$${costUsd.toFixed(2)}`;
  }
}

export function formatTimestamp(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} • ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** The banner's text without colors: what it says, then the gray suffix. */
export function finishedText(data: FinishedEntryData | undefined): { text: string; suffix: string } {
  const mode = storedMode(data);
  const text = data?.interrupted === true ? MODE_TEXT[mode].interrupted : MODE_TEXT[mode].finished;
  const identity = [data?.model, data?.effort].filter((part): part is string => part !== undefined && part !== "");
  const stats: string[] = [];
  if (data?.finishedAt !== undefined) {
    stats.push(formatTimestamp(data.finishedAt));
  } else {
    // no finish time recorded
  }
  if (data?.durationMs !== undefined && data.costUsd !== undefined) {
    stats.push(formatDuration(data.durationMs), formatCost(data.costUsd));
  } else {
    // no cycle measured
  }
  const parts = identity.length > 0 ? [identity.join(" • "), ...stats] : stats;
  return { text, suffix: parts.join(" / ") };
}

export const entryRenderers = {
  mode(entry: CustomEntry<ModeEntryData>, _options: EntryRenderOptions, theme: Theme): Text {
    const mode = storedMode(entry.data);
    return new Text(modeColor(mode, theme.getColorMode(), theme.bold(`◆ ${MODE_TEXT[mode].chip}`)), 0, 0);
  },

  finished(entry: CustomEntry<FinishedEntryData>, _options: EntryRenderOptions, theme: Theme): Text {
    const { text, suffix } = finishedText(entry.data);
    const tail = suffix !== "" ? theme.fg("muted", `  ${suffix}`) : "";
    return new Text(modeColor(storedMode(entry.data), theme.getColorMode(), text) + tail, 0, 0);
  },

  /** A model reference chosen or resolved again: "opus: claude-opus-5-5 → claude-opus-5-6" when the model changed. */
  modelRef(entry: CustomEntry<{ ref?: string; resolved?: string; previous?: string }>, _options: EntryRenderOptions, theme: Theme): Text | undefined {
    const data = entry.data;
    if (data?.ref === undefined || data.resolved === undefined) {
      return undefined; // dropped for an exact model: nothing to show
    } else if (data.previous !== undefined && data.previous !== data.resolved) {
      return new Text(theme.fg("warning", `◆ ${data.ref}: ${data.previous} → ${data.resolved}`), 0, 0);
    } else {
      return new Text(theme.fg("muted", `◆ model ${data.ref} → ${data.resolved}`), 0, 0);
    }
  },

  systemPrompt(entry: CustomEntry<SystemPromptEntryData>, options: EntryRenderOptions, theme: Theme): Text {
    const data = entry.data;
    const summary = data !== undefined ? `◆ System prompt · ${data.model}` : "◆ System prompt";
    if (data === undefined || !options.expanded) {
      return new Text(summary + (data !== undefined ? theme.fg("muted", " · expand to view") : ""), 0, 0);
    } else {
      return new Text(
        `${theme.bold(summary)}${theme.fg("muted", ` · ${data.text.length.toLocaleString()} chars · first request of this session`)}\n\n${data.text}`,
        0,
        0,
      );
    }
  },
};
