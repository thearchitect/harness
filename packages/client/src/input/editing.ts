// The keys that edit a field — the chat's and every single-line one — without letters but undo: the
// cursor by arrows, Home/End and words (Ctrl or Alt with ←/→), deleting by Backspace/Delete and words
// (Ctrl or Alt with them), undo Ctrl/Alt+Z. No emacs chords: Ctrl and Alt with a letter are the
// workbench's (actions.ts). The TUI installs these as pi-tui's editor keys; pi's defaults are not used.

export const EDITING_KEYS: Record<string, string[]> = {
  "tui.editor.cursorUp": ["up"],
  "tui.editor.cursorDown": ["down"],
  "tui.editor.cursorLeft": ["left"],
  "tui.editor.cursorRight": ["right"],
  "tui.editor.cursorWordLeft": ["ctrl+left", "alt+left"],
  "tui.editor.cursorWordRight": ["ctrl+right", "alt+right"],
  "tui.editor.cursorLineStart": ["home"],
  "tui.editor.cursorLineEnd": ["end"],
  "tui.editor.jumpForward": [],
  "tui.editor.jumpBackward": [],
  // PgUp/PgDn scroll the transcript: the focus stays in the field
  "tui.editor.pageUp": [],
  "tui.editor.pageDown": [],
  "tui.editor.deleteCharBackward": ["backspace"],
  "tui.editor.deleteCharForward": ["delete"],
  "tui.editor.deleteWordBackward": ["ctrl+backspace", "alt+backspace"],
  "tui.editor.deleteWordForward": ["ctrl+delete", "alt+delete"],
  "tui.editor.deleteToLineStart": [],
  "tui.editor.deleteToLineEnd": [],
  "tui.editor.yank": [],
  "tui.editor.yankPop": [],
  "tui.editor.undo": ["ctrl+z", "alt+z"],
  "tui.input.copy": [],
  "tui.select.cancel": ["escape"],
};

/** Every key editing takes, for the policy's check that no global key is among them. */
export function editingKeys(): string[] {
  return Object.values(EDITING_KEYS).flat();
}
