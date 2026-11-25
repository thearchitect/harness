// The harness TUI: the full-screen workbench over a ClientModel. Three columns — the tabs of open
// sessions, the active session's main area (its zones: main, above the editor, the editor or what
// takes its place, status, footer), the session's items — all drawn from `Workbench.screen()`;
// keys map to the shared keymap's actions, which the Workbench performs. The TUI keeps no screen
// state of its own beyond its widgets (the editor's text, scroll positions).

import { getMarkdownTheme, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  HStack,
  Input,
  KeybindingsManager,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  SelectList,
  setKeybindings,
  Text,
  TUI_KEYBINDINGS,
  truncateToWidth,
  TuiAltScreen,
  VStack,
  type Component,
  type OverlayHandle,
  type Terminal,
  type TUI,
} from "@earendil-works/pi-tui";
import type { ClientModel } from "#client/model/client-model.ts";
import { ACTIONS, TAB_GOTO_KEYS, type ActionId } from "#client/keymap.ts";
import { LEFT_STRIP_MIN, RIGHT_STRIP_MIN, type EditorZone, type OverlayKind, type Screen, type StatusLine, type Workbench } from "#client/workbench/workbench.ts";
import type { InteractionRequest } from "#protocol/interactions.ts";
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

export type AppOptions = {
  client: ClientModel;
  workbench: Workbench;
  renderers: Renderers;
  /** Where new sessions start. */
  cwd: string;
  onQuit(): void;
  /** The terminal (a virtual one in tests); the process's by default. */
  terminal?: Terminal;
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

export function actionOf(data: string): ActionId | undefined {
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

function statusColor(theme: Theme, line: StatusLine, mode: Screen["zones"]["editor"]): string {
  switch (line.level) {
    case "error":
      return theme.fg("error", ` ${line.text}`);
    case "warning":
      return theme.fg("warning", ` ${line.text}`);
    case "info":
      return theme.fg("dim", ` ${line.text}`);
    case "working":
      return modeColor(mode.kind === "editor" ? mode.mode : "plan", theme.getColorMode(), ` ⠿ ${line.text}`);
    default:
      throw new Error(`unknown status level: ${String(line.level satisfies never)}`);
  }
}

/** The search box above the editor: every change searches again; Enter steps to older matches. */
class SearchBox extends Input {
  private readonly changed: (query: string) => void;

  constructor(changed: (query: string) => void, step: () => void) {
    super();
    this.changed = changed;
    this.onSubmit = () => step();
  }

  override handleInput(data: string): void {
    const before = this.getValue();
    super.handleInput(data);
    if (this.getValue() !== before) {
      this.changed(this.getValue());
    } else {
      // a cursor move
    }
  }
}

/** A component of an extension drawn in the agent: its latest lines, keys and width go back to it. */
class BridgedView implements Component {
  focused = false;
  private width = 0;
  private readonly lines: () => readonly string[];
  private readonly input: (data: string) => void;
  private readonly resize: (width: number) => void;

  constructor(lines: () => readonly string[], input: (data: string) => void, resize: (width: number) => void) {
    this.lines = lines;
    this.input = input;
    this.resize = resize;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (width !== this.width) {
      this.width = width;
      this.resize(width);
    } else {
      // drawn at this width already
    }
    return this.lines().map((line) => truncateToWidth(line, width));
  }

  handleInput(data: string): void {
    this.input(data);
  }
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
  private readonly transcriptScroll: ScrollView;
  private readonly taskOutput = new Lines();
  private readonly mainArea = new Container();
  private readonly aboveEditor = new Container();
  private readonly aboveLines = new Lines();
  private readonly searchBox: SearchBox;
  private readonly editorZone = new Container();
  private readonly status = new Lines();
  private readonly footer: Footer;
  private readonly editor: Editor;
  /** What the editor zone shows now: the editor, an interaction or a picker (by id). */
  private editorShown = "editor";
  private editorComponent: Component | undefined;
  private readonly overlayHandles = new Map<OverlayKind, OverlayHandle>();
  private searchShownAt: string | undefined;
  private componentOverlay: { id: string; handle: OverlayHandle } | undefined;
  private screen: Screen | undefined;
  private quitArmed = false;
  private programStatus = "";

  constructor(options: AppOptions) {
    installKeybindings();
    this.client = options.client;
    this.workbench = options.workbench;
    this.renderers = options.renderers;
    this.cwd = options.cwd;
    this.onQuit = options.onQuit;
    this.tui = new TuiAltScreen(options.terminal ?? new ProcessTerminal(), true, undefined, { mouse: true });
    const theme = (): Theme => getTheme();
    this.tabsColumn = new TabsColumn(theme);
    this.itemsColumn = new ItemsColumn(theme);
    this.transcript = new TranscriptView(this.tui, theme, this.renderers, this.cwd);
    this.footer = new Footer(theme);
    this.editor = new Editor(this.tui, { borderColor: (text) => modeColor(this.editorMode(), getTheme().getColorMode(), text), selectList: selectListTheme(getTheme()) }, { paddingX: 1 });
    this.searchBox = new SearchBox(
      (query) => this.workbench.setSearch(query),
      () => this.workbench.stepSearch(-1),
    );
    this.mainArea.addChild(this.transcript);
    this.aboveEditor.addChild(this.aboveLines);
    this.editorZone.addChild(this.editor);

    this.transcriptScroll = new ScrollView(this.mainArea, { follow: "end", primary: true });
    const main = new VStack([
      { component: this.transcriptScroll, basis: 0, grow: 1, minSize: 3 },
      { component: this.aboveEditor, basis: "auto" },
      { component: this.editorZone, basis: "auto", shrink: 1, minSize: 3 },
      { component: this.status, basis: "auto" },
      { component: this.footer, basis: "auto" },
    ]);
    this.tui.setLayoutRoot(
      new HStack(
        [
          { component: new ScrollView(this.tabsColumn), basis: LEFT_WIDTH, visible: (viewport) => viewport.width >= LEFT_STRIP_MIN },
          { component: main, basis: 0, grow: 1 },
          { component: new ScrollView(this.itemsColumn), basis: RIGHT_WIDTH, visible: (viewport) => viewport.width >= RIGHT_STRIP_MIN },
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
    this.setProgramStatus({ state: "clear" });
    this.tui.stop();
  }

  /** The mode the editor's border shows: the run's while it runs, else what the text asks for. */
  private editorMode(): ReturnType<typeof modeOfText>["mode"] {
    const zone = this.screen?.zones.editor;
    return zone?.kind === "editor" ? zone.mode : "plan";
  }

  /** Redraws from the workbench's screen. */
  private refresh(): void {
    const theme = getTheme();
    const variant = this.screen?.agent?.state.variant ?? "advanced";
    const previous = this.screen?.agent;
    const screen = this.workbench.screen(this.tui.terminal.columns, { mode: modeOfText(this.editor.getText(), variant).mode });
    this.screen = screen;
    const tab = screen.tab;
    if (tab !== undefined && (tab.glyph === "✓" || tab.glyph === "✗")) {
      // the user is looking at it: what it finished is seen
      void this.workbench.markSeen(tab).catch(() => undefined);
    } else {
      // nothing unseen in the active tab
    }
    if (screen.agent !== previous) {
      this.editor.setText("");
    } else {
      // the same session
    }

    this.tabsColumn.tabs = screen.tabs;
    this.tabsColumn.active = screen.active;
    this.itemsColumn.mode = screen.agent?.state.mode ?? tab?.mode ?? "plan";
    this.itemsColumn.items = screen.items;
    this.itemsColumn.selected = screen.selected;
    this.footer.model = screen.zones.footer.agent;
    this.footer.node = screen.zones.footer.node;

    this.drawMain(screen);
    this.drawAboveEditor(screen);
    this.drawEditorZone(screen.zones.editor);
    this.status.lines = screen.zones.status.map((line) => statusColor(theme, line, screen.zones.editor));
    this.drawOverlays(screen);
    this.updateProgramStatus(screen);
    this.tui.requestRender();
  }

  private drawMain(screen: Screen): void {
    const main = screen.zones.main;
    switch (main.kind) {
      case "transcript": {
        this.swapMain(this.transcript);
        if (this.transcript.expanded !== screen.toolsExpanded) {
          this.transcript.expanded = screen.toolsExpanded;
          this.transcript.rebuild();
        } else {
          // the same expansion
        }
        this.transcript.show(screen.agent);
        this.scrollToMatch(screen);
        break;
      }
      case "task": {
        this.swapMain(this.taskOutput);
        const theme = getTheme();
        const task = main.task;
        this.taskOutput.lines = [
          theme.bold(` ${task?.command ?? main.taskId}`),
          theme.fg("dim", ` ${task?.state ?? ""}${task?.exitCode !== undefined ? ` · exit ${task.exitCode}` : ""} · Alt+↑ back`),
          "",
          ...main.output.split("\n"),
        ];
        break;
      }
      case "subagent": {
        if (main.agent !== undefined) {
          // a harness subagent: its own session, steered from the editor
          this.swapMain(this.transcript);
          this.transcript.show(main.agent);
        } else {
          // a claude subagent (or one whose agent is gone): its steps and latest text
          this.swapMain(this.taskOutput);
          const theme = getTheme();
          const subagent = main.subagent;
          this.taskOutput.lines = [
            theme.bold(` ${subagent?.profile ?? "subagent"} ${main.id}`),
            theme.fg("dim", ` ${subagent?.state ?? ""} · ${subagent?.engine ?? ""}${subagent?.model !== undefined ? ` · ${subagent.model}` : ""} · the editor steers it while it runs · Alt+↑ back`),
            "",
            ...(subagent?.steps ?? []).map((step) => theme.fg("muted", ` › ${step}`)),
            "",
            ...(subagent?.text ?? "").split("\n"),
          ];
        }
        break;
      }
      default:
        throw new Error(`unknown main zone: ${JSON.stringify(main satisfies never)}`);
    }
  }

  private swapMain(component: Component): void {
    if (this.mainArea.children[0] !== component) {
      this.mainArea.clear();
      this.mainArea.addChild(component);
    } else {
      // shown already
    }
  }

  /** The current search match scrolled into view, once per match. */
  private scrollToMatch(screen: Screen): void {
    const search = screen.zones.aboveEditor.search;
    const key = search?.matches[search.index];
    if (key !== undefined && key !== this.searchShownAt) {
      this.searchShownAt = key;
      const line = this.transcript.lineOf(key, this.transcriptScroll.getContentWidth(this.tui.terminal.columns));
      if (line !== undefined) {
        this.transcriptScroll.scrollTo(line, { disableFollow: true });
      } else {
        // not drawn (older than the snapshot)
      }
    } else if (search === undefined) {
      this.searchShownAt = undefined;
    } else {
      // the same match
    }
  }

  private drawAboveEditor(screen: Screen): void {
    const theme = getTheme();
    const above = screen.zones.aboveEditor;
    this.aboveLines.lines = [
      ...above.queue.map((entry) => theme.fg("dim", ` ⤷ ${entry.kind === "steer" ? "steer" : "next"}: ${entry.text}`)),
      ...above.widgets,
      ...(above.search !== undefined
        ? [theme.fg("dim", ` search: ${above.search.matches.length === 0 ? "no match" : `${above.search.index + 1}/${above.search.matches.length}`} · Enter older · Esc close`)]
        : []),
    ];
    const searching = above.search !== undefined;
    const shown = this.aboveEditor.children.includes(this.searchBox);
    if (searching && !shown) {
      this.searchBox.setValue(above.search?.query ?? "");
      this.aboveEditor.addChild(this.searchBox);
      this.tui.setFocus(this.searchBox);
    } else if (!searching && shown) {
      this.aboveEditor.removeChild(this.searchBox);
      this.tui.setFocus(this.editorComponent ?? this.editor);
    } else {
      // no change
    }
  }

  /** The editor, or the interaction or picker in its place. */
  private drawEditorZone(zone: EditorZone): void {
    const id =
      zone.kind === "editor"
        ? "editor"
        : zone.kind === "interaction"
          ? `interaction:${zone.request.id}`
          : zone.kind === "component"
            ? `component:${zone.component.componentId}`
            : `picker:${zone.picker.id}`;
    if (id === this.editorShown) {
      return;
    } else {
      this.editorShown = id;
      this.editorZone.clear();
      switch (zone.kind) {
        case "editor":
          this.editorComponent = undefined;
          this.editorZone.addChild(this.editor);
          this.tui.setFocus(this.editor);
          break;
        case "interaction": {
          this.editorComponent = this.interactionView(zone.request);
          if (zone.from !== undefined) {
            this.editorZone.addChild(new Text(getTheme().fg("warning", ` subagent ${zone.from} asks:`), 0, 0));
          } else {
            // the session itself asks
          }
          this.editorZone.addChild(this.editorComponent);
          this.tui.setFocus(this.editorComponent);
          break;
        }
        case "component": {
          const componentId = zone.component.componentId;
          this.editorComponent = this.bridgedView(componentId);
          this.editorZone.addChild(this.editorComponent);
          this.tui.setFocus(this.editorComponent);
          break;
        }
        case "picker": {
          const theme = getTheme();
          const picker = zone.picker;
          const list = new SelectList(picker.items, Math.min(15, Math.max(1, picker.items.length)), selectListTheme(theme));
          list.onSelect = (item) => void picker.choose(item.value);
          list.onCancel = () => this.workbench.closePicker();
          const frame = new Container();
          frame.addChild(new Text(theme.fg("accent", theme.bold(` ${picker.title}`)), 0, 0));
          frame.addChild(list);
          frame.addChild(new Text(theme.fg("dim", " ↑/↓ · type to filter · Enter · Esc"), 0, 0));
          this.editorComponent = list;
          this.editorZone.addChild(frame);
          this.tui.setFocus(list);
          break;
        }
        default:
          throw new Error(`unknown editor zone: ${JSON.stringify(zone satisfies never)}`);
      }
    }
  }

  private interactionView(request: InteractionRequest): Component {
    const theme = getTheme();
    const answer = (value: unknown): void => void this.workbench.answer(request.id, value);
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

  private bridgedView(componentId: string): BridgedView {
    return new BridgedView(
      () => this.screen?.agent?.components.find((component) => component.componentId === componentId)?.lines ?? [],
      (data) => void this.workbench.componentInput(componentId, data),
      (width) => void this.workbench.componentResize(componentId, width),
    );
  }

  /** Overlays: the harness panel and the hidden strips, over the right or left edge. */
  private drawOverlays(screen: Screen): void {
    const component = screen.zones.componentOverlay;
    if (component?.componentId !== this.componentOverlay?.id) {
      this.componentOverlay?.handle.hide();
      this.componentOverlay = undefined;
      if (component !== undefined) {
        const view = this.bridgedView(component.componentId);
        this.componentOverlay = { id: component.componentId, handle: this.tui.showOverlay(view, { width: "80%", anchor: "center" }) };
        this.tui.setFocus(view);
      } else {
        this.tui.setFocus(this.editorComponent ?? this.editor);
      }
    } else {
      // the same component overlay, or none
    }
    const wanted = new Set(screen.zones.overlays);
    for (const [kind, handle] of this.overlayHandles) {
      if (!wanted.has(kind)) {
        handle.hide();
        this.overlayHandles.delete(kind);
        this.tui.setFocus(this.editorComponent ?? this.editor);
      } else {
        // still open
      }
    }
    for (const kind of wanted) {
      if (!this.overlayHandles.has(kind)) {
        this.overlayHandles.set(kind, this.showOverlay(kind, screen));
      } else {
        // open already
      }
    }
  }

  private showOverlay(kind: OverlayKind, screen: Screen): OverlayHandle {
    const theme = getTheme();
    switch (kind) {
      case "panel": {
        const state = screen.agent?.state;
        const rows = state !== undefined ? this.workbench.panelRows(state) : [];
        const list = new SelectList(rows, Math.max(1, rows.length), selectListTheme(theme));
        list.onSelect = (row) => {
          this.workbench.toggleOverlay("panel");
          void this.workbench.choosePanel(row.value as never).catch((error: unknown) => this.workbench.notify("error", error instanceof Error ? error.message : String(error)));
        };
        list.onCancel = () => this.workbench.toggleOverlay("panel");
        const frame = new Container();
        frame.addChild(new Text(theme.fg("accent", theme.bold(" harness")), 0, 0));
        frame.addChild(rows.length > 0 ? list : new Text(theme.fg("dim", " no session"), 0, 0));
        const handle = this.tui.showOverlay(frame, { width: RIGHT_WIDTH + 10, anchor: "top-right" });
        this.tui.setFocus(list);
        return handle;
      }
      case "tabs":
        return this.tui.showOverlay(this.tabsColumn, { width: LEFT_WIDTH, anchor: "top-left", nonCapturing: true });
      case "items":
        return this.tui.showOverlay(this.itemsColumn, { width: RIGHT_WIDTH, anchor: "top-right", nonCapturing: true });
      default:
        throw new Error(`unknown overlay: ${String(kind satisfies never)}`);
    }
  }

  /** The terminal's program status (OSC 7501): blocked while any session waits for the operator. */
  private updateProgramStatus(screen: Screen): void {
    const waiting = screen.tabs.some((tab) => tab.glyph === "◆");
    const running = screen.tabs.some((tab) => tab.glyph === "●");
    const status = waiting ? "blocked" : running ? "working" : "idle";
    if (status !== this.programStatus) {
      this.programStatus = status;
      this.setProgramStatus(waiting ? { state: "blocked", app: "harness", kind: "permission", message: "waiting for the operator" } : { state: status, app: "harness" });
    } else {
      // unchanged
    }
  }

  private setProgramStatus(status: Parameters<Terminal["setProgramStatus"]>[0]): void {
    try {
      this.tui.terminal.setProgramStatus(status);
    } catch {
      // a terminal without program status
    }
  }

  private async submit(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === "") {
      return;
    } else if (await this.clientCommand(trimmed)) {
      this.editor.setText("");
    } else {
      this.editor.addToHistory(text);
      this.editor.setText("");
      const { mode, text: message } = modeOfText(text, this.screen?.agent?.state.variant ?? "advanced");
      await this.workbench.prompt(message, mode);
    }
  }

  /** Commands of the client itself (the agent's own commands go to the agent as text). */
  private async clientCommand(text: string): Promise<boolean> {
    const [command] = text.split(/\s+/);
    switch (command) {
      case "/new":
        await this.workbench.act("tabs.new");
        return true;
      case "/open":
      case "/resume":
        await this.workbench.act("tabs.open");
        return true;
      case "/quit":
      case "/exit":
        this.onQuit();
        return true;
      case "/model":
        await this.workbench.act("model.select");
        return true;
      default:
        return false;
    }
  }

  private onKey(data: string): { consume: boolean } | undefined {
    const action = actionOf(data);
    const input = this.screen?.input ?? "editor";
    if (matchesKey(data, "ctrl+c" as never)) {
      if (this.editor.getText() !== "" && input === "editor") {
        this.editor.setText("");
        this.quitArmed = false;
      } else if (this.quitArmed) {
        this.onQuit();
      } else {
        this.quitArmed = true;
        this.workbench.notify("info", "Ctrl+C again to quit (agents keep running on their node)");
      }
      return { consume: true };
    } else if (action === "editor.submit" && (input === "editor" || input === "subagent" || input === "task")) {
      // the app submits: pi-tui's editor takes Alt+Enter for a new line
      const text = this.editor.getExpandedText();
      this.editor.setText("");
      void this.submit(text);
      return { consume: true };
    } else if (action === undefined || action === "editor.submit" || action === "editor.newline") {
      return undefined;
    } else if (input === "component") {
      return undefined; // every key belongs to the extension's component
    } else if (action === "run.abort") {
      if (input === "dialog" || input === "picker") {
        return undefined; // Esc belongs to the dialog or the list
      } else {
        void this.act(action);
        return { consume: true };
      }
    } else if (action === "thinking.cycle" && input === "dialog") {
      return undefined; // Shift+Tab moves inside a dialog
    } else {
      void this.act(action);
      return { consume: true };
    }
  }

  async act(action: ActionId): Promise<void> {
    if (action === "app.quit") {
      this.onQuit();
    } else {
      await this.workbench.act(action);
      if (action === "tabs.new" || action === "tabs.open" || action.startsWith("tabs.")) {
        await this.loadCompletions().catch(() => undefined);
      } else {
        // the same session
      }
    }
  }

  /** Autocomplete of commands and files for the active session. */
  async loadCompletions(): Promise<void> {
    const tab = this.workbench.activeTab();
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
