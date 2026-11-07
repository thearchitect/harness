/**
 * Extension dialogs of one topic's pi process (RPC extension_ui_request) as
 * Telegram messages that stay the last message of the topic while open.
 *
 * - The write/edit gate (rpc-dialogs.ts contract): Allow, Allow + note,
 *   Reject…, Stop. A text sent instead of a button rejects with that text as
 *   the comment, like "No (why?)" in the TUI. harness asks for the comment in
 *   a follow-up input dialog; the gateway answers it with the text it already
 *   has.
 * - Any other select: one button per option; confirm: Yes / No; input and
 *   editor: a force-reply prompt answered by the next text.
 * - notify: a message (warnings and errors with sound), or a line appended to
 *   the open dialog.
 */

import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";
import { GATE_COMMENT_PROMPTS, GATE_OPTIONS, GATE_TITLE } from "../rpc-dialogs.ts";
import type { Clock, Timer } from "./clock.ts";
import type { Keyboard, Outbox } from "./outbox.ts";
import { escapeHtml, stripAnsi } from "./render.ts";

export type DialogHost = {
  outbox: Outbox;
  clock: Clock;
  respond(response: RpcExtensionUIResponse): void;
  /** A dialog opened: the run view pauses. */
  opened(): Promise<void>;
  /** The dialog closed: the run view resumes. */
  closed(): void;
};

type Open =
  | { kind: "gate"; id: string; seq: number; awaiting?: "note" | "reject" }
  | { kind: "select"; id: string; seq: number; options: string[] }
  | { kind: "confirm"; id: string; seq: number }
  | { kind: "input"; id: string; seq: number };

const GATE_OPTION_LIST: string[] = [GATE_OPTIONS.allow, GATE_OPTIONS.allowWithComment, GATE_OPTIONS.rejectWithComment, GATE_OPTIONS.stop];

export class Dialogs {
  private readonly host: DialogHost;
  private open: Open | undefined;
  private body = "";
  private timer: Timer | undefined;
  private seq = 0;
  /** The comment typed for the gate, answering harness's follow-up input dialog. */
  private gateComment: string | undefined;

  constructor(host: DialogHost) {
    this.host = host;
  }

  get isOpen(): boolean {
    return this.open !== undefined;
  }

  /** An extension_ui_request from pi. */
  async handle(request: RpcExtensionUIRequest): Promise<void> {
    switch (request.method) {
      case "notify":
        await this.notify(request.message, request.notifyType ?? "info");
        return;
      case "setStatus":
      case "setWidget":
      case "setTitle":
      case "set_editor_text":
        return; // TUI decorations: nothing to show in Telegram
      case "select":
        if (isGate(request.title, request.options)) {
          await this.openGate(request.id, request.title);
        } else {
          const seq = this.seq + 1;
          const buttons = request.options.map((option, index) => [{ text: oneLine(option), callback_data: data(seq, index) }]);
          await this.show({ kind: "select", id: request.id, seq, options: request.options }, `❓ ${html(request.title)}`, buttons, request.timeout);
        }
        return;
      case "confirm": {
        const seq = this.seq + 1;
        await this.show(
          { kind: "confirm", id: request.id, seq },
          `❓ <b>${html(request.title)}</b>\n${html(request.message)}`,
          [[{ text: "Yes", callback_data: data(seq, "yes") }, { text: "No", callback_data: data(seq, "no") }]],
          request.timeout,
        );
        return;
      }
      case "input":
      case "editor":
        if (this.gateComment !== undefined && isGateCommentPrompt(request.title)) {
          const value = this.gateComment;
          this.gateComment = undefined;
          this.host.respond({ type: "extension_ui_response", id: request.id, value });
        } else {
          const prefill = request.method === "editor" && request.prefill ? `\n<pre>${html(request.prefill)}</pre>` : "";
          await this.show({ kind: "input", id: request.id, seq: this.seq + 1 }, `✍️ ${html(request.title)}${prefill}`, undefined, request.method === "input" ? request.timeout : undefined);
        }
        return;
      default:
        assertNever(request);
    }
  }

  /** A button press: `d:<seq>:<action>`; resolves with the toast text. */
  async press(seq: number, action: string): Promise<string> {
    const open = this.open;
    if (open === undefined || open.seq !== seq) {
      return "This question is closed.";
    } else {
      switch (open.kind) {
        case "gate":
          return this.pressGate(open, action);
        case "select": {
          const option = open.options[Number(action)];
          if (option === undefined) {
            return "Unknown option.";
          } else {
            await this.close({ type: "extension_ui_response", id: open.id, value: option }, `✔️ ${html(option)}`);
            return option;
          }
        }
        case "confirm":
          await this.close({ type: "extension_ui_response", id: open.id, confirmed: action === "yes" }, action === "yes" ? "✔️ Yes" : "✖️ No");
          return action === "yes" ? "Yes" : "No";
        case "input":
          return "Reply with text.";
        default:
          return assertNever(open);
      }
    }
  }

  /** A text message in the topic; true when it answered the open dialog. */
  async text(text: string): Promise<boolean> {
    const open = this.open;
    if (open === undefined) {
      return false;
    } else {
      switch (open.kind) {
        case "gate":
          if (open.awaiting === "note") {
            await this.answerGate(open, GATE_OPTIONS.allowWithComment, text, `✅ allowed · note: ${html(text)}`);
          } else {
            await this.answerGate(open, GATE_OPTIONS.rejectWithComment, text, `❌ rejected: ${html(text)}`);
          }
          return true;
        case "select":
          await this.close({ type: "extension_ui_response", id: open.id, cancelled: true }, "✖️ cancelled — choose a button next time");
          return true;
        case "confirm":
          await this.close({ type: "extension_ui_response", id: open.id, cancelled: true }, "✖️ cancelled");
          return true;
        case "input":
          await this.close({ type: "extension_ui_response", id: open.id, value: text }, `✔️ ${html(text)}`);
          return true;
        default:
          return assertNever(open);
      }
    }
  }

  /** /stop or the stop button: the open dialog is cancelled. */
  async cancel(): Promise<void> {
    const open = this.open;
    if (open === undefined) {
      // nothing open
    } else if (open.kind === "gate") {
      await this.close({ type: "extension_ui_response", id: open.id, value: GATE_OPTIONS.stop }, "⏹ stopped");
    } else {
      await this.close({ type: "extension_ui_response", id: open.id, cancelled: true }, "⏹ stopped");
    }
  }

  /** The process is gone: forget the open dialog without answering it. */
  reset(): void {
    this.timer?.cancel();
    this.timer = undefined;
    this.open = undefined;
    this.gateComment = undefined;
  }

  /* ------------------------------------------------------------------------ */

  private async openGate(id: string, title: string): Promise<void> {
    const details = title.split("\n").slice(1).join("\n");
    const seq = this.seq + 1;
    await this.show(
      { kind: "gate", id, seq },
      `✏️ <b>Allow file change?</b>${details ? `\n<pre>${html(details)}</pre>` : ""}`,
      [
        [{ text: "✅ Allow", callback_data: data(seq, "allow") }, { text: "💬 Allow + note", callback_data: data(seq, "note") }],
        [{ text: "❌ Reject…", callback_data: data(seq, "reject") }, { text: "⏹ Stop", callback_data: data(seq, "stop") }],
      ],
      undefined,
    );
  }

  private async pressGate(open: Extract<Open, { kind: "gate" }>, action: string): Promise<string> {
    switch (action) {
      case "allow":
        await this.close({ type: "extension_ui_response", id: open.id, value: GATE_OPTIONS.allow }, "✅ allowed");
        return "Allowed";
      case "stop":
        await this.close({ type: "extension_ui_response", id: open.id, value: GATE_OPTIONS.stop }, "⏹ stopped");
        return "Stopped";
      case "note":
      case "reject":
        open.awaiting = action;
        await this.host.outbox.editSticky(
          { html: `${this.body}\n\n${action === "note" ? "💬 Write the note for the model:" : "❌ Write why — the model sees it:"}` },
          [[{ text: "⏹ Stop", callback_data: data(open.seq, "stop") }]],
        );
        return action === "note" ? "Write the note" : "Write the reason";
      default:
        return "Unknown action.";
    }
  }

  private async answerGate(open: Extract<Open, { kind: "gate" }>, option: string, comment: string, outcome: string): Promise<void> {
    this.gateComment = comment;
    await this.close({ type: "extension_ui_response", id: open.id, value: option }, outcome);
  }

  private async show(open: Open, body: string, keyboard: Keyboard | undefined, timeout: number | undefined): Promise<void> {
    if (this.open !== undefined) {
      // pi asks one dialog at a time; a new one supersedes a stale one
      await this.host.outbox.closeSticky({ html: `${this.body}\n\n⌛ superseded` });
    } else {
      await this.host.opened();
    }
    this.open = open;
    this.body = body;
    this.seq = open.seq;
    await this.host.outbox.send({ html: body }, { role: "sticky", silent: false, keyboard, forceReply: keyboard === undefined ? "Reply…" : undefined });
    this.timer?.cancel();
    this.timer = timeout !== undefined && timeout > 0
      ? this.host.clock.after(timeout, () => {
          // pi resolved the dialog itself on its timeout
          if (this.open === open) void this.finish("⌛ timed out");
        })
      : undefined;
  }

  private async close(response: RpcExtensionUIResponse, outcome: string): Promise<void> {
    this.host.respond(response);
    await this.finish(outcome);
  }

  private async finish(outcome: string): Promise<void> {
    this.timer?.cancel();
    this.timer = undefined;
    this.open = undefined;
    await this.host.outbox.closeSticky({ html: `${this.body}\n\n${outcome}` });
    this.host.closed();
  }

  private async notify(message: string, type: "info" | "warning" | "error"): Promise<void> {
    const icon = type === "error" ? "❌ " : type === "warning" ? "⚠️ " : "";
    const line = `${icon}${html(message)}`;
    if (this.open !== undefined) {
      this.body = `${this.body}\n\n${line}`;
      await this.host.outbox.editSticky({ html: this.body });
    } else {
      await this.host.outbox.send({ html: line.includes("\n") ? `${icon}<pre>${html(message)}</pre>` : line }, { silent: type === "info" });
    }
  }

}

/** callback_data of a dialog button: `d:<dialog seq>:<action>`. */
function data(seq: number, action: string | number): string {
  return `d:${seq}:${action}`;
}

function isGate(title: string, options: string[]): boolean {
  return title.split("\n")[0] === GATE_TITLE && options.length === GATE_OPTION_LIST.length && options.every((o, i) => o === GATE_OPTION_LIST[i]);
}

function isGateCommentPrompt(title: string): boolean {
  return title === GATE_COMMENT_PROMPTS.allowWithComment || title === GATE_COMMENT_PROMPTS.rejectWithComment;
}

function html(text: string): string {
  return escapeHtml(stripAnsi(text));
}

function oneLine(text: string): string {
  const line = stripAnsi(text).replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

function assertNever(value: never): never {
  throw new Error(`unexpected dialog: ${JSON.stringify(value)}`);
}
