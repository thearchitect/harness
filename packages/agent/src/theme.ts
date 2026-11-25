// pi's process-wide theme instance (what ctx.ui.theme is in pi's own modes). pi exports the theme
// functions but not this instance, so it is read from the same module file pi loads: one module
// instance, initialized by initTheme().

import type { Theme } from "@earendil-works/pi-coding-agent";

const themeModuleUrl = new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
const themeModule = (await import(themeModuleUrl.href)) as { theme: Theme };

export function getTheme(): Theme {
  return themeModule.theme;
}
