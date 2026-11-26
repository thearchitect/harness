// The transcript of one agent as pi draws it: pi's message components, tool rows from the
// presentation runtime, custom entries through their renderers — virtual (plan polish-3 D). Each
// item is a block whose components are made when it is first drawn and whose lines are kept per
// width; the transcript's lines are one array kept in step block by block, so a frame draws only
// the blocks in sight (and those that changed), whatever the session's length. Blocks not drawn
// yet stand there with their last known (or an estimated) height until they come into sight or the
// background draws them (renderAhead). Every agent keeps its blocks: switching tabs draws nothing
// again.

import {
  AssistantMessageComponent,
  BashExecutionComponent,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  CustomMessageComponent,
  parseSkillBlock,
  SkillInvocationMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
  type MarkdownTransformer,
  type Theme,
  type ToolExecutionOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, type Component, type MarkdownTheme, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { AgentModel, Message, TranscriptItem } from "#client/model/agent-model.ts";
import { splitPlanMessage, type Plan } from "#protocol/plan.ts";
import { customEntryComponent } from "./pi-internals.ts";
import type { Renderers } from "./presentation.ts";

type ToolCall = { type: "toolCall"; id: string; name: string; arguments: unknown };

/** The height a block not drawn yet is taken to have: a tool result draws with its call, nothing of its own. */
function estimatedHeight(item: TranscriptItem): number {
  return item.kind === "message" && item.message.role === "toolResult" ? 0 : 4;
}

/** Replaces `count` lines at `start` with `lines`, in pieces (a long output would overflow one call's arguments). */
function spliceLines(target: string[], start: number, count: number, lines: readonly string[]): void {
  const PIECE = 10_000;
  if (lines.length <= PIECE) {
    target.splice(start, count, ...lines);
  } else {
    target.splice(start, count);
    for (let offset = 0; offset < lines.length; offset += PIECE) {
      target.splice(start + offset, 0, ...lines.slice(offset, offset + PIECE));
    }
  }
}

function userText(message: Message): string {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  } else if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: "text"; text: string } => (block as { type?: string }).type === "text")
      .map((block) => block.text)
      .join("\n");
  } else {
    return "";
  }
}

/** What pi's interactive mode gives these components, read at each draw (settings may change). */
export type TranscriptOptions = {
  markdownTheme: () => MarkdownTheme;
  outputPad: () => 0 | 1;
  transformers: () => readonly MarkdownTransformer[];
  tools: () => ToolExecutionOptions;
  hideThinking: () => boolean;
  /** At most this many blocks keep their components (`ui.transcript.cacheBlocks`); undefined: no limit. */
  cacheBlocks: () => number | undefined;
};

/** The part of the transcript in sight: its first line and how many. */
export type Window = { top: number; height: number; followingEnd: boolean };

/** One transcript item (or the message streaming now): its components once made, its lines once drawn. */
type Block = {
  key: string;
  item: TranscriptItem | undefined;
  components: Component[] | undefined;
  /** Lines at `width`; undefined: not drawn at this width (or changed since). */
  lines: string[] | undefined;
  width: number;
  /** Its lines' count, or an estimate while not drawn. */
  height: number;
};

/** An agent's blocks and the transcript's lines made of them. */
class BlockStore {
  readonly model: AgentModel;
  blocks: Block[] = [];
  readonly byKey = new Map<string, Block>();
  /** The items the blocks show (the model's, in order). */
  items: TranscriptItem[] = [];
  /** Tool rows waiting for their results, by call id. */
  readonly tools = new Map<string, { block: Block; component: ToolExecutionComponent }>();
  /** The message streaming now and its tool calls, drawn after the items. */
  live: Block | undefined;
  /** The transcript's lines at `width` (the live block's last), and where each block starts in them. */
  lines: string[] = [];
  starts: number[] = [];
  /** How many lines at the end are the live block's. */
  liveShown = 0;
  width = 0;
  expanded = false;
  /** Draws since this store was shown (counted by tests). */
  drawn = 0;

  constructor(model: AgentModel) {
    this.model = model;
  }
}

export class TranscriptView implements Component {
  private readonly tui: TUI;
  private readonly theme: () => Theme;
  private readonly renderers: Renderers;
  private readonly cwd: string;
  private readonly options: TranscriptOptions;
  private readonly stores = new Map<AgentModel, BlockStore>();
  private store: BlockStore | undefined;
  /** Where the transcript is seen (the scroll view around it); the end when unknown. */
  private window: () => Window = () => ({ top: 0, height: 0, followingEnd: true });
  /** Moves the scroll by lines (blocks above the window changed height). */
  private shift: (lines: number) => void = () => undefined;
  expanded = false;
  /** Blocks drawn (lines made) since the start: for tests that the work does not grow with a session. */
  blockDraws = 0;
  /** The width of the last frame (the main area's). */
  private drawnWidth = 0;

  constructor(tui: TUI, theme: () => Theme, renderers: Renderers, cwd: string, options: TranscriptOptions) {
    this.tui = tui;
    this.theme = theme;
    this.renderers = renderers;
    this.cwd = cwd;
    this.options = options;
  }

  /** The scroll view around the transcript: where it is seen, and how to keep that place. */
  attach(window: () => Window, shift: (lines: number) => void): void {
    this.window = window;
    this.shift = shift;
  }

  /** The trailing arguments of pi's message components: markdown theme, output pad, transformers. */
  private md(): [MarkdownTheme, number, readonly MarkdownTransformer[]] {
    return [this.options.markdownTheme(), this.options.outputPad(), this.options.transformers()];
  }

  // ── the agent shown ─────────────────────────────────────────────────────────

  show(model: AgentModel | undefined): void {
    if (model === undefined) {
      this.store = undefined;
    } else {
      const known = this.stores.get(model);
      const store = known ?? new BlockStore(model);
      if (known === undefined) {
        this.stores.set(model, store);
      } else {
        // this agent's blocks, kept
      }
      this.store = store;
      this.applyExpanded(store);
      this.sync();
    }
  }

  /** Every block made again (expanded or collapsed tools, a new theme): heights stay as estimates. */
  rebuild(): void {
    const store = this.store;
    if (store !== undefined) {
      this.applyExpanded(store);
      this.drop(store);
      this.tui.requestRender();
    } else {
      // nothing shown
    }
  }

  private applyExpanded(store: BlockStore): void {
    if (store.expanded !== this.expanded) {
      store.expanded = this.expanded;
      this.drop(store);
    } else {
      // drawn with the same expansion
    }
  }

  /** Forgets a store's components and lines (they are made again when seen). */
  private drop(store: BlockStore): void {
    this.forget(store);
    store.tools.clear();
    for (const block of store.blocks) {
      block.components = undefined;
      block.lines = undefined;
    }
    store.width = 0; // the lines are laid out again at the next draw
  }

  invalidate(): void {
    for (const store of this.stores.values()) {
      for (const block of store.blocks) {
        block.lines = undefined;
        for (const component of block.components ?? []) {
          component.invalidate();
        }
      }
      store.width = 0;
    }
  }

  /** Lets go of a store's blocks (made again when seen): the components it no longer has go out of `made`. */
  private forget(store: BlockStore): void {
    for (const block of store.blocks) {
      this.made.delete(block);
    }
  }

  /** Follows the shown model: new items, older ones loaded, the streaming message, tool runs. */
  sync(): void {
    const store = this.store;
    if (store === undefined) {
      return;
    } else {
      const items = store.model.items;
      const known = store.items;
      const appended = known.length <= items.length && known.every((item, index) => items[index] === item);
      const prepended = !appended && known.length <= items.length && known.every((item, index) => items[items.length - known.length + index] === item);
      if (appended) {
        // the new blocks go at the end, before the live block's lines; nothing else moves
        const laidOut = store.width !== 0 && store.starts.length === store.blocks.length;
        if (laidOut) {
          store.lines.length -= store.liveShown;
          store.liveShown = 0;
        } else {
          // laid out at the next draw anyway
        }
        for (const item of items.slice(known.length)) {
          this.addBlock(store, item, store.blocks.length);
          if (laidOut) {
            const block = store.blocks[store.blocks.length - 1];
            store.starts.push(store.lines.length);
            for (let row = 0; row < (block?.height ?? 0); row += 1) {
              store.lines.push("");
            }
          } else {
            // laid out at the next draw
          }
        }
      } else if (prepended) {
        // older entries loaded at the top: their blocks go first, the rest stays
        items.slice(0, items.length - known.length).forEach((item, index) => this.addBlock(store, item, index));
      } else {
        // another set of items (another branch, a reload): the blocks of items it still has stay as drawn
        const kept = new Map(store.blocks.filter((block) => ![...store.tools.values()].some((tool) => tool.block === block)).map((block) => [block.item, block]));
        store.blocks = [];
        store.byKey.clear();
        store.tools.clear();
        for (const item of items) {
          const block = kept.get(item);
          if (block !== undefined) {
            store.blocks.push(block);
            store.byKey.set(item.key, block);
          } else {
            this.addBlock(store, item, store.blocks.length);
          }
        }
        store.width = 0; // laid out again at the next draw
      }
      store.items = [...items];
      this.syncLive(store);
      this.syncTools(store);
      this.tui.requestRender();
    }
  }

  private addBlock(store: BlockStore, item: TranscriptItem, at: number): void {
    // a tool result completes the call drawn earlier: that block changes, the result has none of its own
    if (item.kind === "message" && item.message.role === "toolResult") {
      const waiting = store.tools.get(String(item.message.toolCallId));
      if (waiting !== undefined) {
        waiting.component.updateResult(item.message as never);
        store.tools.delete(String(item.message.toolCallId));
        waiting.block.lines = undefined;
      } else {
        // its call is drawn with it already, or not made yet (it reads the result when made)
      }
    } else {
      // an item of its own
    }
    const block: Block = { key: item.key, item, components: undefined, lines: undefined, width: 0, height: estimatedHeight(item) };
    const appending = at === store.blocks.length;
    store.blocks.splice(at, 0, block);
    store.byKey.set(item.key, block);
    if (!appending) {
      store.width = 0; // inserted before others: laid out again at the next draw
    } else {
      // the caller places an appended block
    }
  }

  /** The streaming message and its calls: a block after the items, drawn at every frame. */
  private syncLive(store: BlockStore): void {
    const message = store.model.streaming;
    if (message === undefined) {
      store.live = undefined;
    } else {
      const live = store.live ?? { key: "live", item: undefined, components: undefined, lines: undefined, width: 0, height: 0 };
      const components = live.components ?? [];
      const head = components[0];
      if (head instanceof AssistantMessageComponent) {
        head.updateContent(message as never, true);
      } else {
        components.unshift(this.assistant(message));
      }
      const drawn = new Set(components.slice(1).map((component) => (component as unknown as { toolCallId?: string }).toolCallId));
      for (const block of (message.content as ToolCall[] | undefined) ?? []) {
        if (block.type === "toolCall" && block.id !== undefined && !drawn.has(block.id) && !store.tools.has(block.id)) {
          components.push(this.toolComponent(store, block.name, block.id, block.arguments));
        } else {
          // text and thinking are in the message component, or the call is drawn
        }
      }
      live.components = components;
      live.lines = undefined;
      store.live = live;
    }
  }

  /** Tool calls in flight: their rows show what they printed so far. */
  private syncTools(store: BlockStore): void {
    for (const run of store.model.tools.values()) {
      const waiting = store.tools.get(run.toolCallId);
      const live = store.live?.components?.find((component) => (component as unknown as { toolCallId?: string }).toolCallId === run.toolCallId) as ToolExecutionComponent | undefined;
      const component = waiting?.component ?? live;
      if (component !== undefined) {
        component.markExecutionStarted();
        if (run.partialResult !== undefined) {
          component.updateResult({ ...(run.partialResult as { content: [] }), isError: false }, true);
        } else {
          // started, no output yet
        }
        if (waiting !== undefined) {
          waiting.block.lines = undefined;
        } else {
          // the live block is drawn at every frame
        }
      } else {
        // the call's block is not made yet, or older than what is loaded
      }
    }
  }

  // ── components of an item ───────────────────────────────────────────────────

  private assistant(message: Message): AssistantMessageComponent {
    const [theme, pad, transformers] = this.md();
    return new AssistantMessageComponent(message as never, this.options.hideThinking(), theme, undefined, pad, transformers);
  }

  private toolComponent(store: BlockStore, name: string, id: string, args: unknown): ToolExecutionComponent {
    const component = new ToolExecutionComponent(name, id, args, this.options.tools(), this.renderers.tool(name) as never, this.tui, this.cwd);
    component.setExpanded(store.expanded);
    (component as unknown as { toolCallId: string }).toolCallId = id;
    return component;
  }

  /** A subagent's plan under the instruction it came with: its path, and the plan itself expanded. */
  private planBlock(plan: Plan, expanded: boolean): Component {
    const theme = this.theme();
    const container = new Container();
    container.addChild(new Spacer(1));
    if (expanded) {
      container.addChild(new Text(theme.fg("muted", `plan ${plan.path}:`), 1, 0));
      container.addChild(new Markdown(plan.text, 1, 0, this.options.markdownTheme()));
    } else {
      container.addChild(new Text(`${theme.fg("muted", "plan ")}${theme.fg("accent", plan.path)}${theme.fg("dim", ` · ${plan.text.split("\n").length} lines, expand to read`)}`, 1, 0));
    }
    return container;
  }

  /** The components of a block, made at its first draw. */
  private components(store: BlockStore, block: Block, first: boolean): Component[] {
    const item = block.item;
    const out: Component[] = [];
    if (item === undefined) {
      return block.components ?? [];
    } else {
      switch (item.kind) {
        case "message":
          this.messageComponents(store, block, item.message, first, out);
          break;
        case "custom": {
          const renderer = this.renderers.entries.get(item.customType);
          if (renderer !== undefined) {
            // as pi draws it: a blank line above, the output pad, the key hints
            const component = customEntryComponent({ type: "custom", customType: item.customType, data: item.data, id: item.key } as never, renderer, this.options.outputPad());
            component.setExpanded(store.expanded);
            if (component.hasContent()) {
              out.push(component);
            } else {
              // the renderer draws nothing for this entry
            }
          } else {
            // custom entries without a renderer are data, not transcript
          }
          break;
        }
        case "compaction": {
          const component = new CompactionSummaryMessageComponent({ role: "compactionSummary", summary: item.summary, tokensBefore: item.tokensBefore ?? 0, timestamp: Date.now() } as never, ...this.md());
          component.setExpanded(store.expanded);
          out.push(new Spacer(1), component);
          break;
        }
        case "branch": {
          const component = new BranchSummaryMessageComponent({ role: "branchSummary", summary: item.summary, fromId: "", timestamp: Date.now() } as never, ...this.md());
          component.setExpanded(store.expanded);
          out.push(new Spacer(1), component);
          break;
        }
        default:
          throw new Error(`unknown transcript item: ${JSON.stringify(item satisfies never)}`);
      }
      return out;
    }
  }

  private messageComponents(store: BlockStore, block: Block, message: Message, first: boolean, out: Component[]): void {
    switch (message.role) {
      case "user": {
        const text = userText(message);
        if (text !== "") {
          if (!first) {
            out.push(new Spacer(1));
          } else {
            // the first message
          }
          const skill = parseSkillBlock(text);
          if (skill !== null && skill !== undefined) {
            const component = new SkillInvocationMessageComponent(skill, ...this.md());
            component.setExpanded(store.expanded);
            out.push(component);
            if (skill.userMessage) {
              out.push(new Spacer(1), new UserMessageComponent(skill.userMessage, ...this.md()));
            } else {
              // the skill alone
            }
          } else {
            const { instruction, plan } = splitPlanMessage(text);
            out.push(new UserMessageComponent(instruction, ...this.md()));
            if (plan !== undefined) {
              out.push(this.planBlock(plan, store.expanded));
            } else {
              // a message without a plan
            }
          }
        } else {
          // an image-only message
        }
        break;
      }
      case "assistant": {
        out.push(this.assistant(message));
        const failed = message.stopReason === "aborted" || message.stopReason === "error";
        for (const call of (message.content as ToolCall[] | undefined) ?? []) {
          if (call.type === "toolCall") {
            const component = this.toolComponent(store, call.name, call.id, call.arguments);
            out.push(component);
            const result = store.model.toolResult(call.id);
            if (result !== undefined) {
              component.updateResult(result as never);
            } else if (failed) {
              component.updateResult({ content: [{ type: "text", text: message.stopReason === "aborted" ? "Operation aborted" : String(message.errorMessage ?? "Error") }], isError: true });
            } else {
              store.tools.set(call.id, { block, component });
            }
          } else {
            // text and thinking are in the message component
          }
        }
        break;
      }
      case "toolResult":
        break; // drawn with its call
      case "custom": {
        if (message.display !== false) {
          const component = new CustomMessageComponent(message as never, this.renderers.messages.get(String(message.customType)), ...this.md());
          component.setExpanded(store.expanded);
          out.push(component);
        } else {
          // hidden context
        }
        break;
      }
      case "bashExecution": {
        const component = new BashExecutionComponent(String(message.command), this.tui, message.excludeFromContext === true, this.options.outputPad());
        if (typeof message.output === "string" && message.output !== "") {
          component.appendOutput(message.output);
        } else {
          // no output
        }
        component.setComplete(message.exitCode as number | undefined, message.cancelled === true, message.truncated === true ? ({ truncated: true } as never) : undefined, message.fullOutputPath as string | undefined);
        out.push(component);
        break;
      }
      case "compactionSummary":
      case "branchSummary":
      case "system":
        break; // compactions and branches come as entries; the system prompt is not drawn
      default:
        out.push(new Text(this.theme().fg("dim", `[${message.role}]`), 0, 0));
    }
  }

  // ── drawing ─────────────────────────────────────────────────────────────────

  /** Makes a block's lines at `width`: its components made first if they are not. */
  private draw(store: BlockStore, block: Block, index: number, width: number): string[] {
    if (block.components === undefined) {
      block.components = this.components(store, block, index === 0);
    } else {
      // made already
    }
    const lines: string[] = [];
    for (const component of block.components) {
      for (const line of component.render(width)) {
        lines.push(line);
      }
    }
    block.lines = lines;
    block.width = width;
    block.height = lines.length;
    this.keepMade(store, block);
    this.blockDraws += block.item !== undefined ? 1 : 0; // the live block draws at every frame by design
    return lines;
  }

  /** Blocks with components, least recently drawn first (what a limit lets go of first). */
  private readonly made = new Map<Block, BlockStore>();

  /** A block drawn: the most recent; past the limit the least recent ones let their components go (made again when seen). */
  private keepMade(store: BlockStore, block: Block): void {
    if (block.item === undefined) {
      return; // the live block is the stream's
    } else {
      this.made.delete(block);
      this.made.set(block, store);
      const limit = this.options.cacheBlocks();
      for (const [old, owner] of this.made) {
        if (limit === undefined || this.made.size <= limit) {
          break;
        } else if ([...owner.tools.values()].some((tool) => tool.block === old)) {
          continue; // waits for its tool's result
        } else {
          // its lines stay (the layout keeps its place); a new width or a change makes it again
          old.components = undefined;
          this.made.delete(old);
        }
      }
    }
  }

  /** The transcript's lines laid out again at a width: drawn blocks as they are, the others as their height. */
  private layout(store: BlockStore, width: number): void {
    store.liveShown = 0;
    const lines: string[] = [];
    const starts: number[] = [];
    for (const block of store.blocks) {
      starts.push(lines.length);
      const shown = block.width === width ? block.lines : undefined;
      if (shown !== undefined) {
        for (const line of shown) {
          lines.push(line);
        }
      } else {
        block.lines = undefined;
        for (let row = 0; row < block.height; row += 1) {
          lines.push("");
        }
      }
    }
    store.lines = lines;
    store.starts = starts;
    store.width = width;
  }

  /** The block at a line of the laid-out lines (binary search over the starts). */
  private blockAt(store: BlockStore, line: number): number {
    let low = 0;
    let high = store.blocks.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((store.starts[middle] ?? 0) <= line) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return low;
  }

  /** Replaces a block's place in the lines with what it draws now; the blocks after it move. */
  private place(store: BlockStore, index: number, width: number): number {
    const block = store.blocks[index];
    if (block === undefined) {
      return 0;
    } else {
      const before = block.lines !== undefined && block.width === width ? block.lines.length : block.height;
      const start = store.starts[index] ?? 0;
      const fresh = block.lines !== undefined && block.width === width ? block.lines : this.draw(store, block, index, width);
      spliceLines(store.lines, start, before, fresh);
      const delta = fresh.length - before;
      if (delta !== 0) {
        for (let after = index + 1; after < store.starts.length; after += 1) {
          store.starts[after] = (store.starts[after] ?? 0) + delta;
        }
      } else {
        // the same height: nothing moves
      }
      return delta;
    }
  }

  render(width: number): string[] {
    const store = this.store;
    if (store === undefined) {
      return [];
    } else {
      store.drawn += 1;
      this.drawnWidth = width;
      if (store.width !== width || store.starts.length !== store.blocks.length) {
        this.layout(store, width);
      } else {
        // laid out at this width
      }
      // the streaming message after the items: drawn at every frame, at the end of the lines
      store.lines.length -= store.liveShown;
      store.liveShown = 0;
      if (store.live !== undefined) {
        const lines = this.draw(store, store.live, store.blocks.length, width);
        for (const line of lines) {
          store.lines.push(line);
        }
        store.liveShown = lines.length;
      } else {
        // nothing streams
      }
      // the blocks in sight (and a screen around) drawn; those above that change height keep the view in place
      const window = this.window();
      const height = Math.max(1, window.height);
      const total = store.lines.length;
      const top = window.followingEnd ? Math.max(0, total - height) : window.top;
      const from = this.blockAt(store, Math.max(0, top - height));
      const firstSeen = this.blockAt(store, top);
      let shift = 0;
      for (let index = from; index < store.blocks.length && (store.starts[index] ?? 0) <= top + 2 * height + shift; index += 1) {
        const block = store.blocks[index];
        if (block !== undefined && (block.lines === undefined || block.width !== width)) {
          const delta = this.place(store, index, width);
          if (index < firstSeen && !window.followingEnd) {
            shift += delta;
          } else {
            // in sight or below: the view shows it as it is now
          }
        } else {
          // drawn at this width
        }
      }
      if (shift !== 0) {
        this.shift(shift);
      } else {
        // nothing above moved
      }
      return store.lines;
    }
  }

  /**
   * Draws blocks not drawn yet at the current width, nearest the view first, for about `budgetMs`;
   * true when some are left. The background calls it between frames.
   */
  renderAhead(budgetMs: number): boolean {
    const width = this.drawnWidth;
    if (width === 0) {
      return false; // not drawn yet: the first frame sets the width
    } else {
      // drawn at a width: the rest at it
    }
    const started = Date.now();
    const stores = [...(this.store !== undefined ? [this.store] : []), ...[...this.stores.values()].filter((store) => store !== this.store)];
    for (const store of stores) {
      if (store.width !== width || store.starts.length !== store.blocks.length) {
        this.layout(store, width);
      } else {
        // laid out at this width
      }
      const shown = store === this.store;
      const window = this.window();
      const near = shown ? this.blockAt(store, window.followingEnd ? Math.max(0, store.lines.length - window.height) : window.top) : store.blocks.length - 1;
      // outward from the view: below and above in turn
      for (let distance = 0; distance < store.blocks.length; distance += 1) {
        for (const index of [near + distance, near - distance - 1]) {
          const block = store.blocks[index];
          if (block !== undefined && (block.lines === undefined || block.width !== width)) {
            const delta = this.place(store, index, width);
            if (shown && index < near && !window.followingEnd && delta !== 0) {
              this.shift(delta);
            } else {
              // below the view, or another agent's
            }
            if (Date.now() - started >= budgetMs) {
              return true;
            } else {
              // time for more
            }
          } else {
            // drawn
          }
        }
      }
    }
    return false;
  }

  // ── places in the transcript ────────────────────────────────────────────────

  /** The width the transcript was last drawn at (0: not drawn yet). */
  get width(): number {
    return this.drawnWidth;
  }

  /** The transcript's lines (as laid out: blocks not drawn yet count with their estimates). */
  get height(): number {
    return this.store?.lines.length ?? 0;
  }

  /** The item drawn at a line, and the line's offset in it (where a tab's scroll is kept); undefined past the end. */
  itemAt(line: number): { key: string; offset: number } | undefined {
    const store = this.store;
    const width = this.drawnWidth;
    if (store === undefined || store.blocks.length === 0 || width === 0) {
      return undefined;
    } else {
      if (store.width !== width || store.starts.length !== store.blocks.length) {
        this.layout(store, width);
      } else {
        // laid out
      }
      if (line >= store.lines.length) {
        return undefined;
      } else {
        const index = this.blockAt(store, line);
        const block = store.blocks[index];
        return block !== undefined ? { key: block.key, offset: line - (store.starts[index] ?? 0) } : undefined;
      }
    }
  }

  /** The first line of an item, its block drawn (to scroll to it); undefined when not loaded or not drawn yet. */
  lineOf(key: string): number | undefined {
    const store = this.store;
    const block = store?.byKey.get(key);
    const width = this.drawnWidth;
    if (store === undefined || block === undefined || width === 0) {
      return undefined;
    } else {
      if (store.width !== width || store.starts.length !== store.blocks.length) {
        this.layout(store, width);
      } else {
        // laid out
      }
      const index = store.blocks.indexOf(block);
      if (block.lines === undefined || block.width !== width) {
        this.place(store, index, width);
      } else {
        // drawn
      }
      return store.starts[index];
    }
  }

  // ── the pointer ─────────────────────────────────────────────────────────────

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const store = this.store;
    if (store === undefined || event.y < 0 || event.y >= store.lines.length) {
      return undefined;
    } else {
      // the component under the line, the event in its own lines
      const index = this.blockAt(store, event.y);
      const block = store.blocks[index];
      let at = store.starts[index] ?? 0;
      for (const component of block?.components ?? []) {
        const height = component.render(event.width).length;
        if (event.y < at + height) {
          return component.handleMouse?.({ ...event, y: event.y - at, height });
        } else {
          at += height;
        }
      }
      return undefined;
    }
  }
}

export type { Component };
