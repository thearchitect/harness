/**
 * Extension dialogs of one agent's pi process (RPC extension_ui_request) as
 * Telegram messages that stay the last message of the chat while open; they
 * need the user, so they come with sound. (The write/edit gate never asks
 * here: the server profile builds without asking.)
 *
 * - select: one button per option; confirm: Yes / No; input and editor: a
 *   force-reply prompt answered by the next text. A text sent instead of a
 *   button cancels a select or confirm.
 * - notify: a message (warnings and errors with sound), or a line appended to
 *   the open dialog.
 *
 * A dialog lives as long as the process: when the agent moves, it is sent
 * again where the agent now is; when the process ends, its message says so
 * and the user continues with a new message.
 *
 * Buttons: `d:<sessionId>:<dialog seq>:<action>`.
 */

import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";
import type { Clock, Timer } from "../core/clock.ts";
import type { Keyboard, Outbox } from "./outbox.ts";
import { escapeHtml, stripAnsi } from "./render.ts";

/** Where the dialogs of an agent show: a chat, with a header line and extra buttons in the background. */
export type DialogSurface = { outbox: Outbox; header?: string; extra?: Keyboard };

export type DialogHost = {
  clock: Clock;
  respond(response: RpcExtensionUIResponse): void;
};

export const INTERRUPTED = "interrupted. Send a message to continue.";

type Open =
  | { kind: "select"; id: string; seq: number; options: string[] }
  | { kind: "confirm"; id: string; seq: number }
  | { kind: "input"; id: string; seq: number };

export class Dialogs {
  private readonly host: DialogHost;
  private readonly sessionId: string;
  private surface: DialogSurface;
  private open: Open | undefined;
  private body = "";
  private keyboard: Keyboard | undefined;
  private timer: Timer | undefined;
  private seq = 0;

  constructor(host: DialogHost, sessionId: string, surface: DialogSurface) {
    this.host = host;
    this.sessionId = sessionId;
    this.surface = surface;
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
      case "select": {
        const seq = this.seq + 1;
        const buttons = request.options.map((option, index) => [{ text: oneLine(option), callback_data: this.data(seq, index) }]);
        await this.show({ kind: "select", id: request.id, seq, options: request.options }, html(request.title), buttons, request.timeout);
        return;
      }
      case "confirm": {
        const seq = this.seq + 1;
        await this.show(
          { kind: "confirm", id: request.id, seq },
          `<b>${html(request.title)}</b>\n${html(request.message)}`,
          [[{ text: "Yes", callback_data: this.data(seq, "yes") }, { text: "No", callback_data: this.data(seq, "no") }]],
          request.timeout,
        );
        return;
      }
      case "input":
      case "editor": {
        const prefill = request.method === "editor" && request.prefill ? `\n<pre>${html(request.prefill)}</pre>` : "";
        await this.show({ kind: "input", id: request.id, seq: this.seq + 1 }, `${html(request.title)}${prefill}`, undefined, request.method === "input" ? request.timeout : undefined);
        return;
      }
      default:
        assertNever(request);
    }
  }

  /** A button press; resolves with the toast text. */
  async press(seq: number, action: string): Promise<string> {
    const open = this.open;
    if (open === undefined || open.seq !== seq) {
      return "This question is closed.";
    } else {
      switch (open.kind) {
        case "select": {
          const option = open.options[Number(action)];
          if (option === undefined) {
            return "Unknown option.";
          } else {
            await this.close({ type: "extension_ui_response", id: open.id, value: option }, html(option));
            return option;
          }
        }
        case "confirm":
          await this.close({ type: "extension_ui_response", id: open.id, confirmed: action === "yes" }, action === "yes" ? "Yes" : "No");
          return action === "yes" ? "Yes" : "No";
        case "input":
          return "Reply with text.";
        default:
          return assertNever(open);
      }
    }
  }

  /** A text message where the agent is; true when it answered the open dialog. */
  async text(text: string): Promise<boolean> {
    const open = this.open;
    if (open === undefined) {
      return false;
    } else {
      switch (open.kind) {
        case "select":
        case "confirm":
          await this.close({ type: "extension_ui_response", id: open.id, cancelled: true }, "cancelled");
          return true;
        case "input":
          await this.close({ type: "extension_ui_response", id: open.id, value: text }, html(text));
          return true;
        default:
          return assertNever(open);
      }
    }
  }

  /** /stop or Stop: the open dialog is cancelled. */
  async cancel(): Promise<void> {
    const open = this.open;
    if (open === undefined) {
      // nothing open
    } else {
      await this.close({ type: "extension_ui_response", id: open.id, cancelled: true }, "stopped");
    }
  }

  /** The process is gone: the open dialog says so, nobody answers it. */
  async interrupt(): Promise<void> {
    if (this.open === undefined) {
      // nothing open
    } else {
      await this.finish(INTERRUPTED);
    }
  }

  /** The agent moved: the open dialog closes where it was (with `note`, unless that chat is gone) and opens again where the agent is now. */
  async moveTo(surface: DialogSurface, note?: string): Promise<void> {
    const previous = this.surface;
    this.surface = surface;
    if (this.open === undefined) {
      // nothing open
    } else {
      if (note !== undefined) await previous.outbox.closeSticky({ html: `${this.headed(previous)}\n\n${escapeHtml(note)}` });
      await this.post();
    }
  }

  /* ------------------------------------------------------------------------ */

  private data(seq: number, action: string | number): string {
    return `d:${this.sessionId}:${seq}:${action}`;
  }

  private headed(surface: DialogSurface): string {
    return surface.header !== undefined ? `${surface.header}\n${this.body}` : this.body;
  }

  private async show(open: Open, body: string, keyboard: Keyboard | undefined, timeout: number | undefined): Promise<void> {
    if (this.open !== undefined) {
      // pi asks one dialog at a time; a new one supersedes a stale one
      await this.surface.outbox.closeSticky({ html: `${this.headed(this.surface)}\n\nsuperseded` });
    } else {
      // the first open dialog
    }
    this.open = open;
    this.body = body;
    this.keyboard = keyboard;
    this.seq = open.seq;
    await this.post();
    this.timer?.cancel();
    this.timer = timeout !== undefined && timeout > 0
      ? this.host.clock.after(timeout, () => {
          // pi resolved the dialog itself on its timeout
          if (this.open === open) void this.finish("timed out");
        })
      : undefined;
  }

  private async post(): Promise<void> {
    const keyboard = this.keyboard !== undefined || this.surface.extra !== undefined ? [...(this.keyboard ?? []), ...(this.surface.extra ?? [])] : undefined;
    await this.surface.outbox.send(
      { html: this.headed(this.surface) },
      { role: "sticky", silent: false, keyboard, forceReply: keyboard === undefined ? "Reply…" : undefined },
    );
  }

  private async close(response: RpcExtensionUIResponse, outcome: string): Promise<void> {
    this.host.respond(response);
    await this.finish(outcome);
  }

  private async finish(outcome: string): Promise<void> {
    this.timer?.cancel();
    this.timer = undefined;
    this.open = undefined;
    await this.surface.outbox.closeSticky({ html: `${this.headed(this.surface)}\n\n${outcome}` });
  }

  private async notify(message: string, type: "info" | "warning" | "error"): Promise<void> {
    const prefix = type === "error" ? "Error: " : type === "warning" ? "Warning: " : "";
    const line = `${prefix}${html(message)}`;
    if (this.open !== undefined) {
      this.body = `${this.body}\n\n${line}`;
      await this.surface.outbox.editSticky({ html: this.headed(this.surface) });
    } else {
      const body = line.includes("\n") ? `${prefix}<pre>${html(message)}</pre>` : line;
      await this.surface.outbox.send({ html: this.surface.header !== undefined ? `${this.surface.header}\n${body}` : body }, { silent: type === "info" });
    }
  }
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
