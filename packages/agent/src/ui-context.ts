// pi's ExtensionUIContext for extensions running inside a harness-agent. Dialogs of foreign
// packages (select / confirm / input / editor) become `pi-dialog` interactions every client can
// answer; notifications, statuses, string widgets and the title become harness_ui records. What
// belongs to a client — the editor, working indicators, themes, raw terminal input — does nothing
// here. Components (custom(), component widgets) go through the component bridge to terminal
// clients; footers and headers belong to the client and are not drawn.

import { initTheme, type ExtensionUIContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { HapEvent } from "#protocol/hap.ts";
import type { InteractionHub } from "./interactions.ts";
import type { ComponentBridge } from "./component-bridge.ts";

let themeReady = false;

/** pi's theme module must be initialized for extensions that read ctx.ui.theme in headless mode. */
export function ensureTheme(): void {
  if (!themeReady) {
    initTheme(undefined, false);
    themeReady = true;
  } else {
    // initialized once per process
  }
}

export function createUiContext(hub: InteractionHub, emit: (event: HapEvent) => void, theme: () => Theme, bridge: ComponentBridge): ExtensionUIContext {
  const widgets = new Map<string, () => void>();
  const dialog = async (payload: Parameters<InteractionHub["ask"]>[1], signal: AbortSignal | undefined) => hub.ask("pi-dialog", payload as never, { signal });

  const context = {
    async select(title: string, options: string[], opts?: { signal?: AbortSignal }) {
      const answer = await dialog({ method: "select", title, options }, opts?.signal);
      return answer !== undefined && "value" in answer ? answer.value : undefined;
    },
    async confirm(title: string, message: string, opts?: { signal?: AbortSignal }) {
      const answer = await dialog({ method: "confirm", title, message }, opts?.signal);
      return answer !== undefined && "confirmed" in answer ? answer.confirmed : false;
    },
    async input(title: string, placeholder?: string, opts?: { signal?: AbortSignal }) {
      const answer = await dialog({ method: "input", title, placeholder }, opts?.signal);
      return answer !== undefined && "value" in answer ? answer.value : undefined;
    },
    async editor(title: string, prefill?: string) {
      const answer = await dialog({ method: "editor", title, prefill }, undefined);
      return answer !== undefined && "value" in answer ? answer.value : undefined;
    },
    notify(message: string, type?: "info" | "warning" | "error") {
      emit({ type: "harness_ui", method: "notify", message, level: type ?? "info" });
    },
    onTerminalInput() {
      return () => {};
    },
    setStatus(key: string, text: string | undefined) {
      emit({ type: "harness_ui", method: "status", key, text });
    },
    setWorkingMessage() {},
    setWorkingVisible() {},
    setWorkingIndicator() {},
    setHiddenThinkingLabel() {},
    setWidget(key: string, content: unknown) {
      widgets.get(key)?.();
      widgets.delete(key);
      if (content === undefined || Array.isArray(content)) {
        emit({ type: "harness_ui", method: "widget", key, lines: content as string[] | undefined });
      } else {
        // a component widget: drawn here into lines
        widgets.set(key, bridge.widget(content as never, (lines) => emit({ type: "harness_ui", method: "widget", key, lines })));
      }
    },
    setFooter() {},
    setHeader() {},
    setTitle(title: string) {
      emit({ type: "harness_ui", method: "title", title });
    },
    async custom(factory: never, options?: { overlay?: boolean }) {
      return bridge.custom(factory, options);
    },
    pasteToEditor(text: string) {
      emit({ type: "harness_ui", method: "editor_text", text });
    },
    setEditorText(text: string) {
      emit({ type: "harness_ui", method: "editor_text", text });
    },
    getEditorText() {
      return "";
    },
    addAutocompleteProvider() {},
    setEditorComponent() {},
    getEditorComponent() {
      return undefined;
    },
    get theme() {
      return theme();
    },
    getAllThemes() {
      return [];
    },
    getTheme() {
      return undefined;
    },
    setTheme() {
      return { success: false, error: "themes belong to the client" };
    },
    getToolsExpanded() {
      return false;
    },
    setToolsExpanded() {},
  };
  return context as unknown as ExtensionUIContext;
}
