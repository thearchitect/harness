// pi's process-wide theme instance, as its own components read it (pi exports the functions around
// it but not the instance): the same module file pi loads, so one instance.

import type { Theme } from "@earendil-works/pi-coding-agent";

const themeModuleUrl = new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
const themeModule = (await import(themeModuleUrl.href)) as { theme: Theme };

export function getTheme(): Theme {
  return themeModule.theme;
}
