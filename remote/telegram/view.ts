/**
 * What one agent shows, wherever it currently is.
 *
 * - Attached to a workspace: every run as blocks (blocks.ts), the banner with
 *   sound, dialogs, problems.
 * - In the background: no live output; what needs the user comes to their
 *   private chat with the bot, with sound, under a header line naming the
 *   agent and with an "Attach here" button: the final answer with the
 *   banner, dialogs, problems, an unexpected end of pi.
 *
 * Status lines (banner, header) link to the Mini App of the chat they are in.
 */

import type { Agent, AgentListener, Settled } from "../core/agent.ts";
import type { Clock } from "../core/clock.ts";
import type { RpcEvent } from "../core/rpc.ts";
import type { RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";
import { BlockStream } from "./blocks.ts";
import { type DialogSurface, Dialogs } from "./dialogs.ts";
import type { Keyboard, Outbox } from "./outbox.ts";
import { bannerLine, escapeHtml, link, splitText, PAGE_LIMIT } from "./render.ts";

export type Surface = { kind: "workspace"; outbox: Outbox } | { kind: "background"; outbox: Outbox };

export type ViewDeps = {
  clock: Clock;
  /** `~/proj` for the agent's directory. */
  dir(agent: Agent): string;
  /** The Mini App link of a chat. */
  link(chatId: number): string;
};

export class AgentView implements AgentListener {
  private readonly deps: ViewDeps;
  private readonly agent: Agent;
  private surface: Surface;
  private readonly dialogs: Dialogs;
  private blocks: BlockStream | undefined;

  constructor(deps: ViewDeps, agent: Agent, surface: Surface) {
    this.deps = deps;
    this.agent = agent;
    this.surface = surface;
    this.dialogs = new Dialogs({ clock: deps.clock, respond: (response) => agent.respondUi(response) }, agent.sessionId, this.dialogSurface(surface));
    agent.listener = this;
  }

  /** A text where the agent is: it answers the open dialog, if any; true when it did. */
  answer(text: string): Promise<boolean> {
    return this.dialogs.text(text);
  }

  pressDialog(seq: number, action: string): Promise<string> {
    return this.dialogs.press(seq, action);
  }

  /** /stop and Stop: the open dialog is cancelled and the run aborted. */
  async stop(): Promise<void> {
    await this.dialogs.cancel();
    await this.agent.abort();
  }

  /** The agent moved: what runs closes where it was (with `note`, unless that chat is gone) and goes on where it is now. */
  async moveTo(surface: Surface, note?: string): Promise<void> {
    const blocks = this.blocks;
    this.blocks = undefined;
    await blocks?.close(note);
    this.surface = surface;
    await this.dialogs.moveTo(this.dialogSurface(surface), note);
    if (this.agent.inRun && surface.kind === "workspace") this.blocks = this.newBlocks(surface.outbox);
  }

  /** The gateway stops: a run in progress and an open dialog are told so. */
  async interrupt(): Promise<void> {
    if (this.agent.inRun) {
      const blocks = this.blocks;
      this.blocks = undefined;
      await blocks?.close();
      await this.post(`Server restarting: run interrupted. Send a message to continue.`, true);
    } else {
      // idle: nothing to tell
    }
    await this.dialogs.interrupt();
  }

  /** The agent ceased to exist: it no longer reports here. */
  detach(): void {
    if (this.agent.listener === this) this.agent.listener = undefined;
  }

  /* AgentListener ----------------------------------------------------------- */

  runStarted(_build: boolean): void {
    this.blocks = this.surface.kind === "workspace" ? this.newBlocks(this.surface.outbox) : undefined;
  }

  event(event: RpcEvent): void {
    this.blocks?.onEvent(event);
  }

  uiRequest(request: RpcExtensionUIRequest): void {
    void this.dialogs.handle(request);
  }

  settled(result: Settled): void {
    const blocks = this.blocks;
    this.blocks = undefined;
    const banner = result.banner !== undefined ? bannerLine({ ...result.banner, interrupted: result.aborted || result.banner.interrupted === true }) : result.aborted ? "interrupted" : "finished";
    const line = link(`${this.deps.dir(this.agent)} · ${banner}`, this.deps.link(this.surface.outbox.chatId));
    switch (this.surface.kind) {
      case "workspace":
        if (blocks !== undefined) {
          void blocks.finish(line);
        } else {
          void this.surface.outbox.send({ markdown: line }, { silent: false });
        }
        return;
      case "background": {
        const parts = [this.headerLine(), ...(result.lastText !== "" ? [result.lastText] : []), line].join("\n\n");
        const pages = splitText(parts, PAGE_LIMIT);
        void (async () => {
          for (const [index, page] of pages.entries()) {
            const last = index === pages.length - 1;
            await this.surface.outbox.send({ markdown: page }, { silent: !last, keyboard: last ? this.attachKeyboard() : undefined });
          }
        })();
        return;
      }
      default:
        assertNever(this.surface);
    }
  }

  exited(problem: string | undefined): void {
    const blocks = this.blocks;
    this.blocks = undefined;
    void (async () => {
      await blocks?.close();
      await this.dialogs.interrupt();
      if (problem !== undefined) await this.post(`Error: ${problem}\n\nSend a message to continue.`, true);
    })();
  }

  problem(message: string): void {
    void this.post(`Error: ${message}`, true);
  }

  changed(): void {
    // the Mini App polls the state; nothing to post
  }

  /* ------------------------------------------------------------------------ */

  private newBlocks(outbox: Outbox): BlockStream {
    return new BlockStream(outbox, this.deps.clock, `x:${this.agent.sessionId}`);
  }

  private headerLine(): string {
    return link(`${this.deps.dir(this.agent)} · ${this.agent.title || "new session"}`, this.deps.link(this.surface.outbox.chatId));
  }

  private attachKeyboard(): Keyboard {
    return [[{ text: "Attach here", callback_data: `t:${this.agent.sessionId}` }]];
  }

  private dialogSurface(surface: Surface): DialogSurface {
    switch (surface.kind) {
      case "workspace":
        return { outbox: surface.outbox };
      case "background":
        return {
          outbox: surface.outbox,
          header: `<a href="${escapeHtml(this.deps.link(surface.outbox.chatId))}">${escapeHtml(`${this.deps.dir(this.agent)} · ${this.agent.title || "new session"}`)}</a>`,
          extra: this.attachKeyboard(),
        };
      default:
        return assertNever(surface);
    }
  }

  /** A message where the agent is (under the header in the background). */
  private async post(text: string, loud: boolean): Promise<void> {
    const body = this.surface.kind === "background" ? `${this.headerLine()}\n\n${text}` : text;
    await this.surface.outbox.send({ markdown: body }, { silent: !loud, keyboard: this.surface.kind === "background" ? this.attachKeyboard() : undefined });
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected surface: ${JSON.stringify(value)}`);
}
