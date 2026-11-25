// The harness TUI: the full-screen workbench over a ClientModel. Three columns — the tabs of open
// sessions, the active session (transcript, the editor or the interaction in its place, status,
// footer), the session's items (itself, tasks, subagents) — drawn from the Workbench; keys map to
// the shared keymap's actions. Everything the TUI shows comes from its nodes; it keeps no session
// state of its own.

import { getMarkdownTheme, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  HStack,
  KeybindingsManager,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  SelectList,
  setKeybindings,
  Text,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  VStack,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import type { AgentModel } from "#client/model/agent-model.ts";
import type { ClientModel } from "#client/model/client-model.ts";
import { ACTIONS, TAB_GOTO_KEYS, type ActionId } from "#client/keymap.ts";
import { Workbench, type Tab } from "#client/workbench/workbench.ts";
import type { InteractionRequest } from "#protocol/interactions.ts";
import type { RunMode } from "#protocol/state.ts";
import { modeOfText } from "#extension/core/modes.ts";
import { modeColor } from "#extension/presentation/modes.ts";
import { GateDialog, selectListTheme } from "#extension/presentation/tui/gate.ts";
import { QuestionsDialog } from "#extension/presentation/tui/questions.ts";
import { SecretDialog } from "#extension/presentation/tui/secret.ts";
import { choiceDialog, piDialog } from "#extension/presentation/tui/dialogs.ts";
import { ItemsColumn, Lines, TabsColumn } from "./columns.ts";
import { Footer } from "./footer.ts";
import type { Renderers } from "./presentation.ts";
import { TranscriptView } from "./transcript.ts";
import { getTheme } from "./theme.ts";

const LEFT_WIDTH = 26;
const RIGHT_WIDTH = 30;
/** Below these widths a side column hides. */
const LEFT_MIN_SCREEN = 80;
const RIGHT_MIN_SCREEN = 110;

export type AppOptions = {
  client: ClientModel;
  workbench: Workbench;
  renderers: Renderers;
  /** Where new sessions start. */
  cwd: string;
  onQuit(): void;
};

/** pi-tui's editor keys with harness submit keys: Ctrl+Enter sends, Enter starts a new line. */
function installKeybindings(): void {
  setKeybindings(
    new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.input.submit": [...ACTIONS["editor.submit"].keys],
      "tui.input.newLine": [...ACTIONS["editor.newline"].keys],
    } as never),
  );
}

function actionOf(data: string): ActionId | undefined {
  for (const goto of TAB_GOTO_KEYS) {
    if (matchesKey(data, goto.key as never)) {
      return goto.action;
    } else {
      // another key
    }
  }
  for (const [action, spec] of Object.entries(ACTIONS)) {
    if (spec.keys.some((key) => matchesKey(data, key as never))) {
      return action as ActionId;
    } else {
      // another action
    }
  }
  return undefined;
}

export class App {
  private readonly client: ClientModel;
  private readonly workbench: Workbench;
  private readonly tui: TuiAltScreen;
  private readonly renderers: Renderers;
  private readonly cwd: string;
  private readonly onQuit: () => void;
  private readonly tabsColumn: TabsColumn;
  private readonly itemsColumn: ItemsColumn;
  private readonly transcript: TranscriptView;
  private readonly taskOutput = new Lines();
  private readonly mainArea = new Container();
  private readonly aboveEditor = new Lines();
  private readonly editorZone = new Container();
  private readonly status = new Lines();
  private readonly footer: Footer;
  private readonly editor: Editor;
  private interactionShown: string | undefined;
  private interactionComponent: Component | undefined;
  private current: AgentModel | undefined;
  private currentTab: Tab | undefined;
  private overlay: { hide(): void } | undefined;
  private taskPoll: ReturnType<typeof setInterval> | undefined;
  private quitArmed = false;

  constructor(options: AppOptions) {
    installKeybindings();
    this.client = options.client;
    this.workbench = options.workbench;
    this.renderers = options.renderers;
    this.cwd = options.cwd;
    this.onQuit = options.onQuit;
    this.tui = new TuiAltScreen(new ProcessTerminal(), true, undefined, { mouse: true });
    const theme = (): Theme => getTheme();
    this.tabsColumn = new TabsColumn(theme);
    this.itemsColumn = new ItemsColumn(theme);
    this.transcript = new TranscriptView(this.tui, theme, this.renderers, this.cwd);
    this.footer = new Footer(theme);
    this.editor = new Editor(this.tui, { borderColor: (text) => modeColor(this.editorMode(), getTheme().getColorMode(), text), selectList: selectListTheme(getTheme()) }, { paddingX: 1 });
    this.editor.onSubmit = (text) => void this.submit(text);
    this.mainArea.addChild(this.transcript);
    this.editorZone.addChild(this.editor);

    const main = new VStack([
      { component: new ScrollView(this.mainArea, { follow: "end", primary: true }), basis: 0, grow: 1, minSize: 3 },
      { component: this.aboveEditor, basis: "auto" },
      { component: this.editorZone, basis: "auto", shrink: 1, minSize: 3 },
      { component: this.status, basis: "auto" },
      { component: this.footer, basis: "auto" },
    ]);
    this.tui.setLayoutRoot(
      new HStack(
        [
          { component: new ScrollView(this.tabsColumn), basis: LEFT_WIDTH, visible: (viewport) => viewport.width >= LEFT_MIN_SCREEN },
          { component: main, basis: 0, grow: 1 },
          { component: new ScrollView(this.itemsColumn), basis: RIGHT_WIDTH, visible: (viewport) => viewport.width >= RIGHT_MIN_SCREEN },
        ],
        { gap: 1 },
      ),
    );
    this.tui.addInputListener((data) => this.onKey(data));
    this.client.onChange(() => this.refresh());
  }

  async start(): Promise<void> {
    this.tui.start();
    this.tui.setFocus(this.editor);
    await this.workbench.ensureAgent(this.workbench.activeTab());
    await this.workbench.activate(this.workbench.active);
    this.refresh();
  }

  stop(): void {
    if (this.taskPoll !== undefined) {
      clearInterval(this.taskPoll);
    } else {
      // no task view open
    }
    this.tui.stop();
  }

  /** The mode the editor's border shows: the run's while it runs, else what the text asks for. */
  private editorMode(): RunMode {
    const model = this.current;
    if (model === undefined) {
      return "plan";
    } else if (model.running) {
      return model.state.mode;
    } else {
      return modeOfText(this.editor.getText(), model.state.variant).mode;
    }
  }

  private notify(level: "info" | "warning" | "error", message: string): void {
    this.current?.notice(level, message);
    const theme = getTheme();
    this.status.lines = [theme.fg(level === "error" ? "error" : level === "warning" ? "warning" : "dim", ` ${message}`)];
    this.tui.requestRender();
  }

  /** Redraws from the models: tabs, items, the active session, its interaction. */
  private refresh(): void {
    const theme = getTheme();
    const tabs = this.workbench.tabs();
    const tab = this.workbench.activeTab();
    this.currentTab = tab;
    if (tab !== undefined && (tab.glyph === "✓" || tab.glyph === "✗")) {
      // the user is looking at it: what it finished is seen
      void this.workbench.markSeen(tab).catch(() => undefined);
    } else {
      // nothing unseen in the active tab
    }
    this.tabsColumn.tabs = tabs;
    this.tabsColumn.active = this.workbench.active;
    const model = tab?.agent !== undefined ? this.client.full.get(`${tab.node}/${tab.agent.id}`) : undefined;
    if (model !== this.current) {
      this.current = model;
      this.editor.setText("");
    } else {
      // the same session
    }
    this.footer.model = model;
    this.footer.node = tab?.node ?? "";
    this.itemsColumn.mode = model?.state.mode ?? tab?.mode ?? "plan";
    this.itemsColumn.items = tab !== undefined ? this.workbench.items(tab, model?.state) : [];
    const selected = tab !== undefined ? this.workbench.selectedItem(tab) : "session";
    this.itemsColumn.selected = selected;

    this.showMain(selected);
    this.showInteraction(model?.interactions[0]);

    const queue = model?.session?.queue;
    const notices = model?.notices.slice(-1) ?? [];
    this.aboveEditor.lines = [
      ...(queue !== undefined ? [...queue.steering.map((text) => theme.fg("dim", ` ⤷ steer: ${text}`)), ...queue.followUp.map((text) => theme.fg("dim", ` ⤷ next: ${text}`))] : []),
      ...Object.values(model?.widgets ?? {}).flat(),
    ];
    const notice = notices[0];
    const statusParts = Object.values(model?.status ?? {});
    this.status.lines = [
      ...(notice !== undefined && Date.now() - notice.at < 15_000 ? [theme.fg(notice.level === "error" ? "error" : notice.level === "warning" ? "warning" : "dim", ` ${notice.message.split("\n")[0]}`)] : []),
      ...(statusParts.length > 0 ? [theme.fg("dim", ` ${statusParts.join(" · ")}`)] : []),
      ...(model?.running === true ? [modeColor(model.state.mode, theme.getColorMode(), " ⠿ working… (Esc to stop)")] : []),
      ...(tab?.unavailable !== undefined ? [theme.fg("warning", ` ⊘ ${tab.unavailable}`)] : []),
    ];
    const waiting = tabs.filter((candidate, index) => index !== this.workbench.active && candidate.glyph === "◆").length;
    if (waiting > 0) {
      this.status.lines.push(theme.fg("warning", ` ◆ ${waiting} other session${waiting > 1 ? "s" : ""} waiting for you`));
    } else {
      // nobody else waits
    }
    this.tui.requestRender();
  }

  /** The main area shows the session's transcript or a task's output. */
  private showMain(selected: string): void {
    const model = this.current;
    if (selected === "session" || model === undefined) {
      if (this.taskPoll !== undefined) {
        clearInterval(this.taskPoll);
        this.taskPoll = undefined;
      } else {
        // the transcript was shown already
      }
      if (this.mainArea.children[0] !== this.transcript) {
        this.mainArea.clear();
        this.mainArea.addChild(this.transcript);
      } else {
        // shown
      }
      this.transcript.show(model);
    } else {
      if (this.mainArea.children[0] !== this.taskOutput) {
        this.mainArea.clear();
        this.mainArea.addChild(this.taskOutput);
      } else {
        // shown
      }
      if (this.taskPoll === undefined) {
        void this.pollTask(selected);
        this.taskPoll = setInterval(() => void this.pollTask(selected), 700);
      } else {
        // polling
      }
    }
  }

  private async pollTask(taskId: string): Promise<void> {
    const tab = this.currentTab;
    if (tab?.agent === undefined) {
      return;
    } else {
      try {
        const output = await this.client.connection(tab.node).call<{ text: string }>(tab.agent.id, { type: "harness_task_output", taskId, offset: 0 });
        const task = this.current?.state.tasks.find((candidate) => candidate.id === taskId);
        const theme = getTheme();
        this.taskOutput.lines = [theme.bold(` ${task?.command ?? taskId}`), theme.fg("dim", ` ${task?.state ?? ""}${task?.exitCode !== undefined ? ` · exit ${task.exitCode}` : ""} · Alt+↑ back`), "", ...output.text.split("\n")];
        this.tui.requestRender();
      } catch (error) {
        this.taskOutput.lines = [` ${error instanceof Error ? error.message : String(error)}`];
      }
    }
  }

  /** The first open interaction takes the editor's place until it closes. */
  private showInteraction(request: InteractionRequest | undefined): void {
    if (request?.id === this.interactionShown) {
      return;
    } else {
      this.interactionShown = request?.id;
      this.editorZone.clear();
      if (request === undefined) {
        this.interactionComponent = undefined;
        this.editorZone.addChild(this.editor);
        this.tui.setFocus(this.editor);
      } else {
        const component = this.interactionView(request);
        this.interactionComponent = component;
        this.editorZone.addChild(component);
        this.tui.setFocus(component);
      }
    }
  }

  private interactionView(request: InteractionRequest): Component {
    const theme = getTheme();
    const answer = (value: unknown): void => void this.answer(request.id, value);
    switch (request.kind) {
      case "gate":
        return new GateDialog(this.tui, theme, request.payload, answer);
      case "secret":
        return new SecretDialog(this.tui, theme, request.payload, answer);
      case "questions":
        return new QuestionsDialog(this.tui, theme, request.payload, answer);
      case "choice":
        return choiceDialog(theme, request.payload, answer);
      case "pi-dialog":
        return piDialog(this.tui, theme, request.payload, answer);
      case "display":
        return new Text(theme.fg("dim", ` display ${request.payload.path}`), 0, 0);
      default:
        throw new Error(`unknown interaction: ${JSON.stringify(request satisfies never)}`);
    }
  }

  private async answer(interactionId: string, value: unknown): Promise<void> {
    const tab = this.currentTab;
    if (tab?.agent !== undefined) {
      try {
        await this.client.connection(tab.node).call(tab.agent.id, { type: "harness_interaction_response", interactionId, answer: value });
      } catch (error) {
        this.notify("error", `answer not delivered: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      this.notify("error", "the session's agent is gone");
    }
  }

  private async submit(text: string): Promise<void> {
    const trimmed = text.trim();
    const tab = this.currentTab;
    if (trimmed === "") {
      return;
    } else if (await this.clientCommand(trimmed)) {
      this.editor.setText("");
    } else if (tab?.agent === undefined || this.current === undefined) {
      this.notify("warning", "no session here: Ctrl+T starts one, Ctrl+O opens one");
    } else {
      this.editor.addToHistory(text);
      this.editor.setText("");
      const { mode, text: message } = modeOfText(text, this.current.state.variant);
      try {
        await this.client.connection(tab.node).call(tab.agent.id, { type: "harness_prompt", text: message, mode });
      } catch (error) {
        this.notify("error", error instanceof Error ? error.message : String(error));
      }
    }
  }

  /** Commands of the client itself (the agent's own commands go to the agent as text). */
  private async clientCommand(text: string): Promise<boolean> {
    const [command] = text.split(/\s+/);
    switch (command) {
      case "/new":
        await this.act("tabs.new");
        return true;
      case "/open":
      case "/resume":
        await this.act("tabs.open");
        return true;
      case "/quit":
      case "/exit":
        this.onQuit();
        return true;
      case "/model":
        await this.act("model.select");
        return true;
      default:
        return false;
    }
  }

  private onKey(data: string): { consume: boolean } | undefined {
    const action = actionOf(data);
    if (matchesKey(data, "ctrl+c" as never)) {
      if (this.editor.getText() !== "" && this.interactionComponent === undefined) {
        this.editor.setText("");
        this.quitArmed = false;
      } else if (this.quitArmed) {
        this.onQuit();
      } else {
        this.quitArmed = true;
        this.notify("info", "Ctrl+C again to quit (agents keep running on their node)");
      }
      this.tui.requestRender();
      return { consume: true };
    } else if (action === "editor.submit" && this.interactionComponent === undefined && this.overlay === undefined) {
      // the app submits: pi-tui's editor takes Alt+Enter for a new line
      const text = this.editor.getExpandedText();
      this.editor.setText("");
      void this.submit(text);
      return { consume: true };
    } else if (action === undefined || action === "editor.submit" || action === "editor.newline") {
      return undefined;
    } else if (action === "run.abort") {
      if (this.overlay !== undefined) {
        this.overlay.hide();
        this.overlay = undefined;
        return { consume: true };
      } else if (this.interactionComponent === undefined && this.current?.running === true) {
        void this.act(action);
        return { consume: true };
      } else {
        return undefined; // Esc belongs to the dialog or the editor
      }
    } else if (action === "thinking.cycle" && this.interactionComponent !== undefined) {
      return undefined; // Shift+Tab moves inside a dialog
    } else {
      void this.act(action);
      return { consume: true };
    }
  }

  async act(action: ActionId): Promise<void> {
    const tab = this.currentTab;
    const connection = tab !== undefined ? this.client.connections.get(tab.node) : undefined;
    try {
      if (action.startsWith("tabs.goto.")) {
        await this.workbench.ensureAgent(this.workbench.tabs()[Number(action.slice("tabs.goto.".length)) - 1]);
        await this.workbench.activate(Number(action.slice("tabs.goto.".length)) - 1);
      } else {
        switch (action as keyof typeof ACTIONS) {
          case "tabs.next":
          case "tabs.prev": {
            const count = this.workbench.tabs().length;
            const next = count === 0 ? 0 : (this.workbench.active + (action === "tabs.next" ? 1 : count - 1)) % count;
            await this.workbench.ensureAgent(this.workbench.tabs()[next]);
            await this.workbench.activate(next);
            break;
          }
          case "tabs.new":
            await this.workbench.newTab(this.client.home ?? "", this.cwd);
            break;
          case "tabs.close":
            await this.workbench.closeTab(this.workbench.active);
            break;
          case "tabs.open":
            await this.openSessionPicker();
            break;
          case "items.next":
          case "items.prev": {
            if (tab !== undefined) {
              const items = this.workbench.items(tab, this.current?.state);
              const index = items.findIndex((item) => item.id === this.workbench.selectedItem(tab));
              const next = items[Math.max(0, Math.min(items.length - 1, index + (action === "items.next" ? 1 : -1)))];
              this.workbench.select(tab, next?.id ?? "session");
            } else {
              // no session
            }
            break;
          }
          case "panel.toggle":
            this.togglePanel();
            break;
          case "model.select":
            await this.openModelPicker();
            break;
          case "model.cycle":
            if (connection !== undefined && tab?.agent !== undefined) {
              await connection.call(tab.agent.id, { type: "cycle_model" });
            } else {
              // no session
            }
            break;
          case "thinking.cycle":
            if (connection !== undefined && tab?.agent !== undefined) {
              await connection.call(tab.agent.id, { type: "cycle_thinking_level" });
            } else {
              // no session
            }
            break;
          case "tools.expand":
            this.transcript.expanded = !this.transcript.expanded;
            this.transcript.rebuild();
            break;
          case "run.abort":
            if (connection !== undefined && tab?.agent !== undefined) {
              await connection.call(tab.agent.id, { type: "abort" });
            } else {
              // no session
            }
            break;
          case "app.quit":
            this.onQuit();
            break;
          case "editor.submit":
          case "editor.newline":
            break; // the editor handles these
          default:
            throw new Error(`unknown action: ${String(action)}`);
        }
      }
    } catch (error) {
      this.notify("error", error instanceof Error ? error.message : String(error));
    }
    this.refresh();
  }

  /** A list overlay: the selected value goes to `chosen`. */
  private pick(title: string, items: { value: string; label: string; description?: string }[], chosen: (value: string) => void): void {
    const theme = getTheme();
    const list = new SelectList(items, Math.min(15, Math.max(1, items.length)), selectListTheme(theme));
    const frame = new Container();
    frame.addChild(new Text(theme.fg("accent", theme.bold(` ${title}`)), 0, 0));
    frame.addChild(list);
    frame.addChild(new Text(theme.fg("dim", " ↑/↓ · Enter · Esc"), 0, 0));
    const close = (): void => {
      handle.hide();
      this.overlay = undefined;
      this.tui.setFocus(this.interactionComponent ?? this.editor);
    };
    list.onSelect = (item) => {
      close();
      chosen(item.value);
    };
    list.onCancel = close;
    const handle = this.tui.showOverlay(frame, { width: "70%", anchor: "center" } as never);
    this.overlay = handle;
    this.tui.setFocus(list);
  }

  private async openSessionPicker(): Promise<void> {
    const node = this.client.home;
    if (node === undefined) {
      this.notify("error", "no node connected");
    } else {
      const sessions = await this.client.sessions(node);
      this.pick(
        `Open a session on ${node}`,
        sessions.slice(0, 200).map((session) => ({
          value: session.id,
          label: `${session.agent !== undefined ? "● " : "  "}${session.name ?? session.firstMessage?.split("\n")[0]?.slice(0, 60) ?? session.id.slice(0, 8)}`,
          description: `${session.cwd} · ${new Date(session.modified).toLocaleString()}`,
        })),
        (id) => {
          const session = sessions.find((candidate) => candidate.id === id);
          if (session !== undefined) {
            void this.workbench.openSession(node, session).catch((error: unknown) => this.notify("error", error instanceof Error ? error.message : String(error)));
          } else {
            // the list changed meanwhile
          }
        },
      );
    }
  }

  private async openModelPicker(): Promise<void> {
    const tab = this.currentTab;
    if (tab?.agent === undefined) {
      this.notify("warning", "no session");
    } else {
      const connection = this.client.connection(tab.node);
      const agentId = tab.agent.id;
      const { models } = await connection.call<{ models: { provider: string; id: string; name?: string }[] }>(agentId, { type: "get_available_models" });
      this.pick(
        "Model",
        models.map((model) => ({ value: `${model.provider}/${model.id}`, label: `${model.provider}/${model.id}`, description: model.name })),
        (value) => {
          const slash = value.indexOf("/");
          void connection
            .call(agentId, { type: "set_model", provider: value.slice(0, slash), modelId: value.slice(slash + 1) })
            .catch((error: unknown) => this.notify("error", error instanceof Error ? error.message : String(error)));
        },
      );
    }
  }

  private togglePanel(): void {
    const model = this.current;
    const tab = this.currentTab;
    if (this.overlay !== undefined) {
      this.overlay.hide();
      this.overlay = undefined;
      this.tui.setFocus(this.interactionComponent ?? this.editor);
    } else if (model === undefined || tab?.agent === undefined) {
      this.notify("warning", "no session");
    } else {
      const connection = this.client.connection(tab.node);
      const agentId = tab.agent.id;
      const state = model.state;
      const set = (change: Record<string, unknown>): void => {
        void connection.call(agentId, { type: "harness_set", ...change }).catch((error: unknown) => this.notify("error", error instanceof Error ? error.message : String(error)));
      };
      this.pick(
        "harness",
        [
          { value: "madness", label: `${state.madness ? "[x]" : "[ ]"} madness`, description: "write/edit without gates" },
          { value: "simple", label: `${state.variant === "simple" ? "[x]" : "[ ]"} simple`, description: "one mode instead of PLAN/BUILD" },
          { value: "implementer", label: `implementer: ${state.implementer}`, description: "self or a subagent profile (builder)" },
        ],
        (value) => {
          switch (value) {
            case "madness":
              set({ madness: !state.madness });
              break;
            case "simple":
              set({ variant: state.variant === "simple" ? "advanced" : "simple" });
              break;
            case "implementer":
              set({ implementer: state.implementer === "self" ? "builder" : "self" });
              break;
            default:
              break; // no such row
          }
        },
      );
    }
  }

  /** Autocomplete of commands and files for the active session. */
  async loadCompletions(): Promise<void> {
    const tab = this.currentTab;
    if (tab?.agent !== undefined) {
      const { commands } = await this.client.connection(tab.node).call<{ commands: { name: string; description?: string }[] }>(tab.agent.id, { type: "get_commands" });
      const local = [
        { name: "new", description: "New session (Ctrl+T)" },
        { name: "open", description: "Open a session (Ctrl+O)" },
        { name: "model", description: "Choose the model (Ctrl+L)" },
        { name: "quit", description: "Quit (agents keep running)" },
      ];
      this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([...local, ...commands], tab.cwd));
    } else {
      // no session to complete for
    }
  }

  get markdownTheme() {
    return getMarkdownTheme();
  }

  get ui(): TUI {
    return this.tui;
  }
}

export function initClientTheme(name: string | undefined): void {
  initTheme(name, false);
}
