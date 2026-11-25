// The `questions` interaction in the TUI: pi-ask-user's own prompt, as harness showed it before the
// platform. pi-ask-user's tool runs here, in the client, against a UI context of the editor's place:
// its prompt component (`ui.custom`) and pi's input dialog (`ui.input`, a question without options)
// show where the editor was, take the keys, and its result — the text for the model and the
// details its renderers draw — is the answer. Inline, as interactions are (plan A25).

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, getKeybindings, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { QuestionsAnswer, QuestionsPayload } from "#protocol/interactions.ts";
import { piDialog } from "#extension/presentation/tui/dialogs.ts";
import { piAskUserTool } from "#extension/tools/ask_user.ts";

export class AskUserView extends Container implements Focusable {
  private readonly tui: TUI;
  private readonly abort = new AbortController();
  private child: Component | undefined;
  private focusedState = false;

  constructor(tui: TUI, theme: () => Theme, payload: QuestionsPayload, done: (answer: QuestionsAnswer) => void, notify: (message: string) => void) {
    super();
    this.tui = tui;
    const ui = {
      custom: <T>(factory: (tui: TUI, theme: Theme, keybindings: unknown, done: (value: T) => void) => Component | Promise<Component>) =>
        new Promise<T>((resolve, reject) => {
          Promise.resolve(factory(tui, theme(), getKeybindings(), resolve))
            .then((component) => this.show(component))
            .catch(reject);
        }),
      input: (title: string, placeholder?: string) =>
        new Promise<string | undefined>((resolve) => {
          this.show(piDialog(tui, { method: "input", title, ...(placeholder !== undefined ? { placeholder } : {}) }, (answer) => resolve("value" in answer ? answer.value : undefined)));
        }),
      select: (title: string, options: string[]) =>
        new Promise<string | undefined>((resolve) => {
          this.show(piDialog(tui, { method: "select", title, options }, (answer) => resolve("value" in answer ? answer.value : undefined)));
        }),
      notify: (message: string) => notify(message),
      theme: theme(),
    };
    const ctx = { hasUI: true, ui, signal: this.abort.signal } as unknown as Parameters<typeof piAskUserTool.execute>[4];
    // inline: in the editor's place, as every interaction
    const params = { ...payload.params, displayMode: "inline" };
    Promise.resolve(piAskUserTool.execute("tui", params as never, this.abort.signal, undefined, ctx))
      .then((result) => done({ result: { content: result.content as never, details: result.details } }))
      .catch((error: unknown) => done({ error: error instanceof Error ? error.message : String(error) }));
  }

  /** The prompt (or a dialog) takes the place and the keys. */
  private show(component: Component): void {
    this.child = component;
    this.clear();
    this.addChild(component);
    (component as Partial<Focusable>).focused = this.focusedState;
    this.tui.requestRender();
  }

  get focused(): boolean {
    return this.focusedState;
  }

  set focused(value: boolean) {
    this.focusedState = value;
    if (this.child !== undefined) {
      (this.child as Partial<Focusable>).focused = value;
    } else {
      // nothing shown yet
    }
  }

  handleInput(data: string): void {
    this.child?.handleInput?.(data);
    this.tui.requestRender();
  }

  /** The interaction went away (answered elsewhere, the run stopped): pi-ask-user's prompt ends. */
  dispose(): void {
    this.abort.abort();
  }
}
