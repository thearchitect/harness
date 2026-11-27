// The app's look: pi's theme tokens (the user's theme, from the hub) and the fonts of the two
// zones — `chrome` (strips, lists, footer, dialogs) and `chat` (transcript, editor). Components take
// every color and font from here; none has its own.

import { createContext, useContext } from "react";
import { Platform } from "react-native";
import { FALLBACK_COLORS } from "./fallback.generated.ts";

export type Token = keyof typeof FALLBACK_COLORS;
export type Colors = Record<Token, string>;

export type FontFamily = "jetbrains-mono" | "iosevka-term" | "terminus" | "system";
export type FontZone = { family: FontFamily; size: number };

export type Theme = {
  name: string;
  colors: Colors;
  chrome: FontZone;
  chat: FontZone;
};

export const FONT_FAMILIES: Record<FontFamily, string> = {
  "jetbrains-mono": "JetBrains Mono",
  "iosevka-term": "Iosevka Term",
  terminus: "Terminus",
  system: Platform.select({ web: 'ui-monospace, "SF Mono", "DejaVu Sans Mono", monospace', ios: "Menlo", default: "monospace" }),
};

/** Terminus is sharp only at its bitmap sizes. */
export const TERMINUS_SIZES = [12, 14, 16, 18, 20, 22, 24, 28, 32];

export const DEFAULT_THEME: Theme = {
  name: "dark",
  colors: FALLBACK_COLORS,
  chrome: { family: "jetbrains-mono", size: 13 },
  chat: { family: "jetbrains-mono", size: 13 },
};

/** The line height of a zone: dense, as in the terminal. */
export function lineHeight(zone: FontZone): number {
  return Math.round(zone.size * 1.35);
}

/** A zone's text style. */
export function fontOf(zone: FontZone): { fontFamily: string; fontSize: number; lineHeight: number } {
  return { fontFamily: FONT_FAMILIES[zone.family], fontSize: zone.size, lineHeight: lineHeight(zone) };
}

/** The width of a character of a zone's font (the app turns the workbench's columns into pixels with it). */
export function charWidth(zone: FontZone): number {
  return zone.size * 0.6;
}

function isFamily(value: unknown): value is FontFamily {
  return value === "jetbrains-mono" || value === "iosevka-term" || value === "terminus" || value === "system";
}

/** `ui.font.chrome` / `ui.font.chat` of the user's settings: { family, size }. */
export function zoneOf(setting: unknown, fallback: FontZone): FontZone {
  const value = (typeof setting === "object" && setting !== null ? setting : {}) as { family?: unknown; size?: unknown };
  const family = isFamily(value.family) ? value.family : fallback.family;
  const size = typeof value.size === "number" && value.size >= 8 && value.size <= 40 ? value.size : fallback.size;
  return { family, size: family === "terminus" ? TERMINUS_SIZES.reduce((best, candidate) => (Math.abs(candidate - size) < Math.abs(best - size) ? candidate : best)) : size };
}

export const ThemeContext = createContext<Theme>(DEFAULT_THEME);

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
