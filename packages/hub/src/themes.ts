// Themes for clients that draw them themselves (the app): pi resolves a theme — its own dark and
// light, or the user's `~/.harness/themes/*.json` (PI_CODING_AGENT_DIR) — to hex colors. pi's theme
// module is not among its package exports; it is loaded from the package directory.

import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ThemeColors } from "#protocol/hub.ts";

type ThemeModule = {
  getResolvedThemeColors(name: string): Record<string, string>;
  getThemeExportColors(name: string): { pageBg?: string; cardBg?: string; infoBg?: string };
  getAvailableThemes(): string[];
  isLightTheme(name: string): boolean;
};

let module: Promise<ThemeModule> | undefined;

function themes(): Promise<ThemeModule> {
  module ??= import(pathToFileURL(join(getPackageDir(), "dist/modes/interactive/theme/theme.js")).href) as Promise<ThemeModule>;
  return module;
}

/** The colors of `name` (dark when unknown); the user's themes are found under `dataDir/themes`. */
export async function themeColors(dataDir: string, name: string | undefined): Promise<ThemeColors> {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dataDir;
  try {
    const theme = await themes();
    const names = theme.getAvailableThemes();
    const chosen = name !== undefined && names.includes(name) ? name : "dark";
    const colors = theme.getResolvedThemeColors(chosen);
    const page = theme.getThemeExportColors(chosen);
    const light = theme.isLightTheme(chosen);
    return {
      name: chosen,
      appearance: light ? "light" : "dark",
      // a theme without page colors: pi's export defaults
      colors: { ...colors, pageBg: page.pageBg ?? (light ? "#f8f8f8" : "#18181e"), cardBg: page.cardBg ?? (light ? "#ffffff" : "#1e1e24"), infoBg: page.infoBg ?? colors.searchMatchBg ?? "#3c3c1e" },
      names,
    };
  } finally {
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previous;
    }
  }
}
