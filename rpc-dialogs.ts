/**
 * harness - dialogs outside the TUI (RPC clients).
 *
 * In RPC mode pi forwards extension dialogs as plain select/input requests.
 * The write/edit gate is the one dialog harness asks there; its title and
 * option labels are a contract with the clients that render it natively
 * (remote/dialogs.ts of the Telegram gateway), so both sides import them from
 * here instead of repeating the strings.
 */

/** First line of the gate dialog's select title; the change details follow on the next lines. */
export const GATE_TITLE = "Allow file change?";

/** The gate dialog's select options, in display order. */
export const GATE_OPTIONS = {
  allow: "Allow",
  allowWithComment: "Allow with comment",
  rejectWithComment: "Reject with comment",
  stop: "Stop",
} as const;

/** Titles of the input dialog that follows a "with comment" option. */
export const GATE_COMMENT_PROMPTS = {
  allowWithComment: "Comment for the model (optional).",
  rejectWithComment: "Why reject? Required — the model sees this comment.",
} as const;

export type GateDecision = { action: "allow" | "reject" | "stop"; comment?: string };

/** The part of pi's dialog API the gate uses. */
export type DialogUI = {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
};

/**
 * The gate as plain dialogs: one select, and a comment only when the chosen
 * option asks for one. An empty reject comment, Stop and a cancelled dialog
 * all stop.
 */
export async function askGateViaDialogs(ui: DialogUI, detail: readonly string[]): Promise<GateDecision> {
  const choice = await ui.select(`${GATE_TITLE}\n${detail.join("\n")}`, [
    GATE_OPTIONS.allow,
    GATE_OPTIONS.allowWithComment,
    GATE_OPTIONS.rejectWithComment,
    GATE_OPTIONS.stop,
  ]);
  if (choice === GATE_OPTIONS.allow) {
    return { action: "allow" };
  } else if (choice === GATE_OPTIONS.allowWithComment) {
    const comment = (await ui.input(GATE_COMMENT_PROMPTS.allowWithComment, "Comment for the model…"))?.trim();
    return { action: "allow", comment: comment ? comment : undefined };
  } else if (choice === GATE_OPTIONS.rejectWithComment) {
    const comment = (await ui.input(GATE_COMMENT_PROMPTS.rejectWithComment, "What is wrong / what to fix…"))?.trim();
    return comment ? { action: "reject", comment } : { action: "stop" };
  } else {
    // "Stop" or a cancelled dialog: reject-and-stop without steer.
    return { action: "stop" };
  }
}
