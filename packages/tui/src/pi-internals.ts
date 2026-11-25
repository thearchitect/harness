// What pi's interactive mode gives its components that pi's package does not export: the
// process-wide theme instance, the theme controller (the terminal's colors and appearance, the
// system theme), the Mermaid transformer and the app keybindings (`app.*`, whose keys the components'
// hints show). Loaded from the files of the pinned pi itself, so one instance each;
// pi-internals.test.ts fails when an update of pi moves one of them.

import type { CustomEntry, EntryRenderer, KeybindingsManager, MarkdownTransformer, SettingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Container, KeybindingsConfig, TUI } from "@earendil-works/pi-tui";
import type { Clipboard } from "./clipboard.ts";

const PI = import.meta.resolve("@earendil-works/pi-coding-agent");

/** The modules, relative to pi's dist/index.js. */
export const PI_INTERNAL_MODULES = {
  theme: "./modes/interactive/theme/theme.js",
  themeController: "./modes/interactive/theme/theme-controller.js",
  mermaid: "./modes/interactive/components/mermaid.js",
  keybindings: "./core/keybindings.js",
  customEntry: "./modes/interactive/components/custom-entry.js",
  clipboard: "./utils/clipboard.js",
  clipboardImage: "./utils/clipboard-image.js",
} as const;

async function load<T>(path: string): Promise<T> {
  return (await import(new URL(path, PI).href)) as T;
}

const themeModule = await load<{ theme: Theme }>(PI_INTERNAL_MODULES.theme);

/** The theme pi's components draw with now. */
export function getTheme(): Theme {
  return themeModule.theme;
}

export type ThemeController = {
  applyFromSettings(): void;
  setThemeSetting(themeSetting: string): void;
  getThemeSelection(): string | undefined;
  dispose(): void;
};

const { InteractiveThemeController } = await load<{
  InteractiveThemeController: new (
    ui: TUI,
    options: { getSettingsManager: () => SettingsManager; showError: (message: string) => void; onChanged: () => void; initialThemeSetting?: string },
  ) => ThemeController;
}>(PI_INTERNAL_MODULES.themeController);

/**
 * The theme as pi applies it: the setting (or the system theme, from the terminal's colors), kept in
 * step with the terminal's light/dark switches. `onChanged` runs when the theme changed.
 */
export function themeController(
  ui: TUI,
  options: { settings: () => SettingsManager; theme: string | undefined; onError: (message: string) => void; onChanged: () => void },
): ThemeController {
  return new InteractiveThemeController(ui, {
    getSettingsManager: options.settings,
    showError: options.onError,
    onChanged: options.onChanged,
    ...(options.theme !== undefined ? { initialThemeSetting: options.theme } : {}),
  });
}

const { createMermaidMarkdownTransformer } = await load<{
  createMermaidMarkdownTransformer: (options: { getMode: () => ReturnType<SettingsManager["getMermaidRenderingMode"]>; theme?: Theme }) => MarkdownTransformer;
}>(PI_INTERNAL_MODULES.mermaid);

/** Mermaid code blocks drawn as diagrams, as pi draws them. */
export function mermaidTransformer(settings: () => SettingsManager): MarkdownTransformer {
  return createMermaidMarkdownTransformer({ getMode: () => settings().getMermaidRenderingMode(), theme: getTheme() });
}

export type CustomEntryComponent = Container & { hasContent(): boolean; setExpanded(expanded: boolean): void };

const customEntryModule = await load<{ CustomEntryComponent: new (entry: CustomEntry<unknown>, renderer: EntryRenderer, outputPad?: number) => CustomEntryComponent }>(
  PI_INTERNAL_MODULES.customEntry,
);

/** An extension's entry as pi draws it: a blank line above, the renderer's content, its key hints. */
export function customEntryComponent(entry: CustomEntry<unknown>, renderer: EntryRenderer, outputPad: number): CustomEntryComponent {
  return new customEntryModule.CustomEntryComponent(entry, renderer, outputPad);
}

const clipboardModule = await load<{ readClipboardFilePaths(): Promise<string[] | null>; readClipboardText(): Promise<string | null> }>(PI_INTERNAL_MODULES.clipboard);
const clipboardImageModule = await load<{
  readClipboardImage(): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
  extensionForImageMimeType(mimeType: string): string | null;
}>(PI_INTERNAL_MODULES.clipboardImage);

/** The system clipboard as pi reads it (native files, images through wl-paste/xclip/the native module, text). */
export const systemClipboard: Clipboard = {
  filePaths: () => clipboardModule.readClipboardFilePaths(),
  image: () => clipboardImageModule.readClipboardImage(),
  text: () => clipboardModule.readClipboardText(),
  extensionOf: (mimeType) => clipboardImageModule.extensionForImageMimeType(mimeType) ?? undefined,
};

const keybindingsModule = await load<{ KeybindingsManager: new (userBindings?: KeybindingsConfig) => KeybindingsManager }>(PI_INTERNAL_MODULES.keybindings);

/** pi's keybindings (`tui.*` and `app.*`) with `bindings` over their defaults. */
export function piKeybindings(bindings: KeybindingsConfig): KeybindingsManager {
  return new keybindingsModule.KeybindingsManager(bindings);
}
