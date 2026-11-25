// The transcript of one agent as pi draws it: pi's message components, tool rows from the
// presentation runtime, custom entries through their renderers. Kept in step with the AgentModel
// incrementally: appended items add components, a new snapshot rebuilds, the streaming message and
// the tool calls in flight update in place.

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
import { Container, Markdown, Spacer, Text, type Component, type MarkdownTheme, type TUI } from "@earendil-works/pi-tui";
import type { AgentModel, Message, TranscriptItem } from "#client/model/agent-model.ts";
import { splitPlanMessage, type Plan } from "#protocol/plan.ts";
import type { Renderers } from "./presentation.ts";

type ToolCall = { type: "toolCall"; id: string; name: string; arguments: unknown };

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
};

export class TranscriptView extends Container {
  private readonly tui: TUI;
  private readonly theme: () => Theme;
  private readonly renderers: Renderers;
  private readonly cwd: string;
  private readonly options: TranscriptOptions;
  private model: AgentModel | undefined;
  private rendered: TranscriptItem[] = [];
  private readonly toolComponents = new Map<string, ToolExecutionComponent>();
  private streamingComponent: AssistantMessageComponent | undefined;
  private streamingTools = new Map<string, ToolExecutionComponent>();
  expanded = false;
  private readonly firstComponent = new Map<string, Component>();

  constructor(tui: TUI, theme: () => Theme, renderers: Renderers, cwd: string, options: TranscriptOptions) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.renderers = renderers;
    this.cwd = cwd;
    this.options = options;
  }

  /** The trailing arguments of pi's message components: markdown theme, output pad, transformers. */
  private md(): [MarkdownTheme, number, readonly MarkdownTransformer[]] {
    return [this.options.markdownTheme(), this.options.outputPad(), this.options.transformers()];
  }

  /** A subagent's plan under the instruction it came with: its path, and the plan itself expanded. */
  private planBlock(plan: Plan): Component {
    const theme = this.theme();
    const container = new Container();
    container.addChild(new Spacer(1));
    if (this.expanded) {
      container.addChild(new Text(theme.fg("muted", `plan ${plan.path}:`), 1, 0));
      container.addChild(new Markdown(plan.text, 1, 0, this.options.markdownTheme()));
    } else {
      container.addChild(new Text(`${theme.fg("muted", "plan ")}${theme.fg("accent", plan.path)}${theme.fg("dim", ` · ${plan.text.split("\n").length} lines, expand to read`)}`, 1, 0));
    }
    return container;
  }

  private assistant(message: Message): AssistantMessageComponent {
    const [theme, pad, transformers] = this.md();
    return new AssistantMessageComponent(message as never, this.options.hideThinking(), theme, undefined, pad, transformers);
  }

  show(model: AgentModel | undefined): void {
    if (model !== this.model) {
      this.model = model;
      this.rebuild();
    } else {
      this.sync();
    }
  }

  /** Re-renders everything (a new model, a snapshot, expanded/collapsed tools). */
  rebuild(): void {
    this.clear();
    this.rendered = [];
    this.firstComponent.clear();
    this.toolComponents.clear();
    this.streamingComponent = undefined;
    this.streamingTools.clear();
    this.sync();
  }

  sync(): void {
    const model = this.model;
    if (model === undefined) {
      return;
    } else {
      const items = model.items;
      const prefix = this.rendered.length <= items.length && this.rendered.every((item, index) => items[index] === item);
      if (!prefix) {
        this.rebuild();
        return;
      } else if (items.length > this.rendered.length) {
        // appended: the new items go before the streaming components, which are drawn again after them
        this.dropStreaming();
        for (const item of items.slice(this.rendered.length)) {
          this.addItem(item);
        }
        this.rendered = [...items];
        this.drawStreaming(model);
        this.tui.requestRender();
      } else if (this.streamingComponent !== undefined && model.streaming !== undefined) {
        // the same message streams on: update it in place
        this.streamingComponent.updateContent(model.streaming as never, true);
        this.updateTools(model);
        this.tui.requestRender();
      } else {
        this.dropStreaming();
        this.drawStreaming(model);
        this.tui.requestRender();
      }
    }
  }

  private dropStreaming(): void {
    if (this.streamingComponent !== undefined) {
      this.removeChild(this.streamingComponent);
      this.streamingComponent = undefined;
    } else {
      // nothing streams
    }
    for (const component of this.streamingTools.values()) {
      this.removeChild(component);
    }
    this.streamingTools.clear();
  }

  private drawStreaming(model: AgentModel): void {
    const message = model.streaming;
    if (message !== undefined) {
      this.streamingComponent = this.assistant(message);
      this.addChild(this.streamingComponent);
      for (const block of (message.content as ToolCall[] | undefined) ?? []) {
        if (block.type === "toolCall" && block.id !== undefined && !this.toolComponents.has(block.id)) {
          const component = this.toolComponent(block.name, block.id, block.arguments);
          this.streamingTools.set(block.id, component);
          this.addChild(component);
        } else {
          // text and thinking are in the message component
        }
      }
    } else {
      // no message streams now
    }
    this.updateTools(model);
  }

  private updateTools(model: AgentModel): void {
    for (const run of model.tools.values()) {
      const component = this.toolComponents.get(run.toolCallId) ?? this.streamingTools.get(run.toolCallId);
      if (component !== undefined) {
        component.markExecutionStarted();
        if (run.partialResult !== undefined) {
          component.updateResult({ ...(run.partialResult as { content: [] }), isError: false }, true);
        } else {
          // started, no output yet
        }
      } else {
        // the call's message is not drawn (older than the snapshot)
      }
    }
  }

  private toolComponent(name: string, id: string, args: unknown): ToolExecutionComponent {
    const component = new ToolExecutionComponent(name, id, args, this.options.tools(), this.renderers.tool(name) as never, this.tui, this.cwd);
    component.setExpanded(this.expanded);
    return component;
  }

  /** The first line of an item at `width` (for the search to scroll to it); undefined when not drawn. */
  lineOf(key: string, width: number): number | undefined {
    const first = this.firstComponent.get(key);
    let line = 0;
    for (const child of this.children) {
      if (child === first) {
        return line;
      } else {
        line += child.render(width).length;
      }
    }
    return undefined;
  }

  private addItem(item: TranscriptItem): void {
    const before = this.children.length;
    this.addItemComponents(item);
    const first = this.children[before];
    if (first !== undefined) {
      this.firstComponent.set(item.key, first);
    } else {
      // the item draws nothing
    }
  }

  private addItemComponents(item: TranscriptItem): void {
    switch (item.kind) {
      case "message":
        this.addMessage(item.message);
        break;
      case "custom": {
        const renderer = this.renderers.entries.get(item.customType);
        if (renderer !== undefined) {
          const component = renderer({ type: "custom", customType: item.customType, data: item.data, id: item.key } as never, { expanded: this.expanded } as never, this.theme());
          if (component !== undefined) {
            this.addChild(component);
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
        component.setExpanded(this.expanded);
        this.addChild(new Spacer(1));
        this.addChild(component);
        break;
      }
      case "branch": {
        const component = new BranchSummaryMessageComponent({ role: "branchSummary", summary: item.summary, fromId: "", timestamp: Date.now() } as never, ...this.md());
        component.setExpanded(this.expanded);
        this.addChild(new Spacer(1));
        this.addChild(component);
        break;
      }
      default:
        throw new Error(`unknown transcript item: ${JSON.stringify(item satisfies never)}`);
    }
  }

  private addMessage(message: Message): void {
    switch (message.role) {
      case "user": {
        const text = userText(message);
        if (text !== "") {
          if (this.children.length > 0) {
            this.addChild(new Spacer(1));
          } else {
            // the first message
          }
          const skill = parseSkillBlock(text);
          if (skill !== null && skill !== undefined) {
            const component = new SkillInvocationMessageComponent(skill, ...this.md());
            component.setExpanded(this.expanded);
            this.addChild(component);
            if (skill.userMessage) {
              this.addChild(new Spacer(1));
              this.addChild(new UserMessageComponent(skill.userMessage, ...this.md()));
            } else {
              // the skill alone
            }
          } else {
            const { instruction, plan } = splitPlanMessage(text);
            this.addChild(new UserMessageComponent(instruction, ...this.md()));
            if (plan !== undefined) {
              this.addChild(this.planBlock(plan));
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
        this.addChild(this.assistant(message));
        const failed = message.stopReason === "aborted" || message.stopReason === "error";
        for (const block of (message.content as ToolCall[] | undefined) ?? []) {
          if (block.type === "toolCall") {
            const component = this.toolComponent(block.name, block.id, block.arguments);
            this.addChild(component);
            const result = this.model?.toolResult(block.id);
            if (result !== undefined) {
              component.updateResult(result as never);
            } else if (failed) {
              component.updateResult({ content: [{ type: "text", text: message.stopReason === "aborted" ? "Operation aborted" : String(message.errorMessage ?? "Error") }], isError: true });
            } else {
              this.toolComponents.set(block.id, component);
            }
          } else {
            // text and thinking are in the message component
          }
        }
        break;
      }
      case "toolResult": {
        const component = this.toolComponents.get(String(message.toolCallId));
        if (component !== undefined) {
          component.updateResult(message as never);
          this.toolComponents.delete(String(message.toolCallId));
        } else {
          // drawn with its call already (or its call is older than the snapshot)
        }
        break;
      }
      case "custom": {
        if (message.display !== false) {
          const component = new CustomMessageComponent(message as never, this.renderers.messages.get(String(message.customType)), ...this.md());
          component.setExpanded(this.expanded);
          this.addChild(component);
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
        this.addChild(component);
        break;
      }
      case "compactionSummary":
      case "branchSummary":
      case "system":
        break; // compactions and branches come as entries; the system prompt is not drawn
      default:
        this.addChild(new Text(this.theme().fg("dim", `[${message.role}]`), 0, 0));
    }
  }
}

export type { Component };
