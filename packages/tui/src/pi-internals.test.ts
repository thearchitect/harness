// pi's internal modules the TUI relies on are where pi-internals.ts looks for them, with the exports
// it uses: an update of pi that moves one fails here, not in front of the user.

import assert from "node:assert/strict";
import { test } from "node:test";
import { PI_INTERNAL_MODULES } from "./pi-internals.ts";

const EXPORTS: Record<keyof typeof PI_INTERNAL_MODULES, string[]> = {
  theme: ["theme"],
  themeController: ["InteractiveThemeController"],
  mermaid: ["createMermaidMarkdownTransformer"],
  keybindings: ["KeybindingsManager", "KEYBINDINGS"],
  customEntry: ["CustomEntryComponent"],
  clipboard: ["readClipboardFilePaths", "readClipboardText"],
  clipboardImage: ["readClipboardImage", "extensionForImageMimeType"],
};

test("pi's internal modules and their exports", async () => {
  const pi = import.meta.resolve("@earendil-works/pi-coding-agent");
  for (const [name, path] of Object.entries(PI_INTERNAL_MODULES)) {
    const module = (await import(new URL(path, pi).href)) as Record<string, unknown>;
    for (const symbol of EXPORTS[name as keyof typeof PI_INTERNAL_MODULES]) {
      assert.notEqual(module[symbol], undefined, `${path}: ${symbol}`);
    }
  }
});
