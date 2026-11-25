// The harness TUI: the full-screen workbench over a ClientModel. Three columns — the tabs of open
// sessions, the active session's main area (its zones: main, above the editor, the editor or what
// takes its place, status, footer), the session's items — all drawn from `Workbench.screen()`;
// keys map to the shared keymap's actions, which the Workbench performs. The TUI keeps no screen
// state of its own beyond its widgets (the editor's text, scroll positions).

import { getMarkdownTheme, type SettingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  HStack,
  Input,
  isKeyRelease,
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
import { modeOfText } from "#protocol/modes.ts";
import { modeColor } from "#extension/presentation/modes.ts";
import { GateDialog, selectListTheme } from "#extension/presentation/tui/gate.ts";
import { QuestionsDialog } from "#extension/presentation/tui/questions.ts";
import { SecretDialog } from "#extension/presentation/tui/secret.ts";
import { choiceDialog, piDialog } from "#extension/presentation/tui/dialogs.ts";
import { ItemsColumn, Lines, TabsColumn, VRule, Workspace } from "./columns.ts";
import { Footer } from "./footer.ts";
import type { Renderers } from "./presentation.ts";
import { HarnessPanel, PANEL_MIN_WIDTH, PANEL_WIDTH } from "./panel.ts";
import { PickerView } from "./picker.ts";
import { RemoteAutocompleteProvider } from "./remote-complete.ts";
import { TranscriptView, type TranscriptOptions } from "./transcript.ts";
import { getTheme, mermaidTransformer, piKeybindings, themeController, type ThemeController } from "./pi-internals.ts";

// the strips: narrow, the transcript has the width
const LEFT_WIDTH = 18;
const RIGHT_WIDTH = 21;

export type AppOptions = {
  client: ClientModel;
  workbench: Workbench;
  renderers: Renderers;
  /** Where new sessions start. */
  cwd: string;
  /** pi's settings of this user (~/.harness/settings.json): theme, output pad, images, thinking blocks. */
  settings: SettingsManager;
  onQuit(): void;
  /** The terminal (a virtual one in tests); the process's by default. */
  terminal?: Terminal;
};

/**
 * pi's keybindings with harness's keys: the editor's (Ctrl+Enter sends, Enter starts a new line) and
 * the app's, so the hints pi's components show name harness's keys. pi's defaults that harness gives
 * other work (Ctrl+T, Alt+↑, Ctrl+G) are unbound.
 */
export function installKeybindings(): void {
  const keys = (action: keyof typeof ACTIONS): string[] => [...ACTIONS[action].keys];
  setKeybindings(
    piKeybindings({
      "tui.input.submit": keys("editor.submit"),
      "tui.input.newLine": keys("editor.newline"),
      "app.interrupt": keys("run.abort"),
      "app.exit": keys("app.quit"),
      "app.thinking.cycle": keys("thinking.cycle"),
      "app.model.select": keys("model.select"),
      "app.model.cycleForward": keys("model.cycle"),
      "app.tools.expand": keys("tools.expand"),
      "app.thinking.toggle": [],
      "app.message.dequeue": [],
      "app.message.followUp": [],
      "app.editor.external": [],
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
  private readonly settings: SettingsManager;
  private readonly theme: ThemeController;
  private readonly cwd: string;
  private readonly onQuit: () => void;
  private readonly tabsColumn: TabsColumn;
  private readonly itemsColumn: ItemsColumn;
  private readonly transcript: TranscriptView;
  private readonly transcriptScroll: ScrollView;
  private loadingOlder = false;
  private prefillApplied: string | undefined;
  private themeApplied: string | undefined;
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
    this.settings = options.settings;
    this.client = options.client;
    this.workbench = options.workbench;
    this.renderers = options.renderers;
    this.cwd = options.cwd;
    this.onQuit = options.onQuit;
    this.tui = new TuiAltScreen(options.terminal ?? new ProcessTerminal(), true, undefined, { mouse: true });
    // the theme as pi applies it (before any component draws): the user's UI theme or pi's setting,
    // the system theme from the terminal's colors (asked at start), light/dark switches followed
    this.themeApplied = this.uiTheme();
    this.theme = themeController(this.tui, {
      settings: () => this.settings,
      theme: this.themeApplied,
      onError: (message) => this.workbench.notify("error", `theme: ${message}`),
      // as in pi: components draw in the theme of the moment, so a redraw is enough
      onChanged: () => {
        this.tui.invalidate();
        this.tui.requestRender();
      },
    });
    const theme = (): Theme => getTheme();
    const failed = (error: unknown): void => this.workbench.notify("error", error instanceof Error ? error.message : String(error));
    this.tabsColumn = new TabsColumn(theme, {
      open: (index) => {
        this.leaveStrip();
        void (index < this.workbench.tabs().length ? this.act(`tabs.goto.${index + 1}`) : this.act("tabs.new")).catch(failed);
      },
      close: (index) => {
        if (index < this.workbench.tabs().length) {
          void this.workbench.closeTab(index).catch(failed);
        } else {
          // "+ new" is not a tab
        }
      },
      leave: () => this.leaveStrip(),
    });
    this.itemsColumn = new ItemsColumn(theme, {
      open: (index) => {
        const tab = this.workbench.activeTab();
        const item = this.itemsColumn.itemAt(index);
        this.leaveStrip();
        if (tab !== undefined && item !== undefined) {
          this.workbench.select(tab, item.id);
        } else {
          // no session, or the row went away
        }
      },
      leave: () => this.leaveStrip(),
    });
    this.transcript = new TranscriptView(this.tui, theme, this.renderers, this.cwd, this.transcriptOptions());
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
    const rule = (): VRule => new VRule(theme, () => this.tui.terminal.rows);
    const left = (viewport: { width: number }): boolean => viewport.width >= LEFT_STRIP_MIN;
    const right = (viewport: { width: number }): boolean => viewport.width >= RIGHT_STRIP_MIN;
    this.tui.setLayoutRoot(
      new Workspace(
        [
          { component: new ScrollView(this.tabsColumn), basis: LEFT_WIDTH, visible: left },
          { component: rule(), basis: 1, visible: left },
          { component: main, basis: 0, grow: 1 },
          { component: rule(), basis: 1, visible: right },
          { component: new ScrollView(this.itemsColumn), basis: RIGHT_WIDTH, visible: right },
        ],
        // the pointer over anything else: no strip row lit
        () => [this.tabsColumn.clearHover(), this.itemsColumn.clearHover()].includes(true),
      ),
    );
    this.tui.addInputListener((data) => this.onKey(data));
    this.client.onChange(() => this.refresh());
  }

  async start(): Promise<void> {
    this.tui.start();
    this.theme.applyFromSettings();
    this.tui.setFocus(this.editor);
    await this.workbench.ensureAgent(this.workbench.activeTab());
    await this.workbench.activate(this.workbench.active);
    this.refresh();
  }

  stop(): void {
    this.theme.dispose();
    this.setProgramStatus({ state: "clear" });
    this.tui.stop();
  }

  /** The mode the editor's border shows, from the text as it is now (each draw: typing `!` recolors it). */
  private editorMode(): ReturnType<typeof modeOfText>["mode"] {
    return this.workbench.editorMode(this.editor.getText());
  }

  /** Redraws from the workbench's screen. */
  private refresh(): void {
    const theme = getTheme();
    const previous = this.screen?.agent;
    const screen = this.workbench.screen(this.tui.terminal.columns, { mode: this.editorMode() });
    this.screen = screen;
    this.followTheme();
    if (screen.prefill !== undefined && screen.prefill.key !== this.prefillApplied) {
      this.prefillApplied = screen.prefill.key;
      this.editor.setText(screen.prefill.text);
    } else {
      // the editor has it already
    }
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
        this.loadOlderAtTop(screen);
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

  /**
   * Scrolled to the top of what is loaded: the older entries come next, and the view stays on the
   * line it showed (the first item it had, now further down).
   */
  /** The load of older entries under way, if any (drivers wait for it). */
  olderLoad: Promise<void> | undefined;

  /** Whether the whole transcript fits on the screen (then its top is on the screen too). */
  private transcriptFits(): boolean {
    const height = this.transcriptScroll.viewportHeight;
    return height > 0 && this.transcript.render(this.transcriptScroll.getContentWidth(this.tui.terminal.columns)).length <= height;
  }

  private loadOlderAtTop(screen: Screen): void {
    const agent = screen.agent;
    const tab = screen.tab;
    const first = agent?.items[0]?.key;
    if (this.loadingOlder || agent === undefined || tab?.agent === undefined || agent.cursor === undefined || first === undefined) {
      return; // loading, nothing older, or nothing shown
    } else if (this.transcriptScroll.scrollTop > 0 || (this.transcriptScroll.isFollowingEnd && !this.transcriptFits())) {
      return; // not at the top (a transcript shorter than the screen is at its top while it follows the end)
    } else {
      this.loadingOlder = true;
      this.olderLoad = this.client
        .loadOlder(tab.node, tab.agent.id)
        .then(() => {
          this.transcript.show(agent);
          const line = this.transcript.lineOf(first, this.transcriptScroll.getContentWidth(this.tui.terminal.columns));
          if (line !== undefined) {
            this.transcriptScroll.scrollTo(line, { disableFollow: true });
          } else {
            // the item is gone (the session changed meanwhile)
          }
          this.tui.requestRender();
        })
        .catch((error: unknown) => this.workbench.notify("error", `older entries: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => {
          this.loadingOlder = false;
          this.olderLoad = undefined;
        });
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
            : `picker:${zone.picker.id}:${zone.picker.scope ?? 0}`;
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
          const view = new PickerView(zone.picker, getTheme, { scope: () => this.workbench.nextPickerScope(), cancel: () => this.workbench.closePicker() });
          this.editorComponent = view;
          this.editorZone.addChild(view);
          this.tui.setFocus(view);
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
        const panel = new HarnessPanel({
          tui: this.tui,
          theme: getTheme,
          sections: () => this.workbench.panel(),
          apply: (id) => void this.workbench.applyPanel(id).catch((error: unknown) => this.workbench.notify("error", error instanceof Error ? error.message : String(error))),
          close: () => this.workbench.closeOverlay("panel"),
          closeKeys: ACTIONS["panel.toggle"].keys,
        });
        const handle = this.tui.showOverlay(panel, { width: PANEL_WIDTH, minWidth: PANEL_MIN_WIDTH, anchor: "top-right" });
        this.tui.setFocus(panel);
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
    } else if (await this.workbench.clientCommand(trimmed, () => this.onQuit())) {
      this.editor.setText("");
    } else {
      this.editor.addToHistory(text);
      this.editor.setText("");
      const { mode, text: message } = modeOfText(text, this.screen?.agent?.state.variant ?? "advanced");
      await this.workbench.prompt(message, mode);
    }
  }

  /** `ui.theme` of the user's settings changed (here or in another client): redraw in it. */
  private followTheme(): void {
    const name = this.uiTheme();
    if (name !== undefined && name !== this.themeApplied) {
      this.themeApplied = name;
      this.theme.setThemeSetting(name);
      // custom entries keep the colors they were made with: made again
      this.transcript.rebuild();
    } else {
      // the same theme
    }
  }

  /** `ui.theme` of the user's settings (shared by the user's clients); undefined: pi's own setting. */
  private uiTheme(): string | undefined {
    const name = this.client.settings["ui.theme"];
    return typeof name === "string" && name !== "" ? name : undefined;
  }

  /** What pi's interactive mode gives its transcript components, from pi's settings. */
  private transcriptOptions(): TranscriptOptions {
    const settings = (): SettingsManager => this.settings;
    const mermaid = mermaidTransformer(settings);
    return {
      markdownTheme: () => ({ ...getMarkdownTheme(), codeBlockIndent: this.settings.getCodeBlockIndent() }),
      outputPad: () => this.settings.getOutputPad(),
      transformers: () => [mermaid, ...this.renderers.markdownTransformers],
      tools: () => ({ showImages: this.settings.getShowImages(), imageWidthCells: this.settings.getImageWidthCells(), outputPad: this.settings.getOutputPad() }),
      hideThinking: () => this.settings.getHideThinkingBlock(),
    };
  }

  /** The editor's text (for tests and drivers). */
  editorText(): string {
    return this.editor.getText();
  }

  private onKey(data: string): { consume: boolean } | undefined {
    if (isKeyRelease(data)) {
      // the terminal reports releases too (the kitty protocol): only presses act; pi-tui drops the
      // releases before the focused component itself
      return undefined;
    } else {
      // a press or a repeat
    }
    // keys and the wheel scroll the transcript: at its top, the older entries come next
    setImmediate(() => (this.screen !== undefined && this.screen.zones.main.kind === "transcript" ? this.loadOlderAtTop(this.screen) : undefined));
    const action = actionOf(data);
    const input = this.screen?.input ?? "editor";
    const inStrip = this.stripFocus !== undefined && (this.stripFocus === "tabs" ? this.tabsColumn : this.itemsColumn).focused;
    const inPanel = this.overlayHandles.has("panel");
    if ((inStrip || inPanel) && (action === undefined || action === "run.abort" || action === "editor.submit" || action === "editor.newline")) {
      return undefined; // the strip's or the panel's own keys: arrows, Enter, Space, Delete, Esc
    } else if (matchesKey(data, "ctrl+c" as never)) {
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
    } else if (action === "strip.tabs" || action === "strip.items") {
      const side = action === "strip.tabs" ? "tabs" : "items";
      if (this.stripFocus === side) {
        this.leaveStrip();
      } else {
        this.enterStrip(side);
      }
    } else {
      await this.workbench.act(action);
      if (action === "tabs.new" || action === "tabs.open" || action.startsWith("tabs.")) {
        await this.loadCompletions().catch(() => undefined);
      } else {
        // the same session
      }
    }
  }

  /** The strip the keyboard is in (Alt+←/→), if any. */
  private stripFocus: "tabs" | "items" | undefined;

  /** The keyboard into a strip; a strip hidden on a narrow screen comes over it first. */
  private enterStrip(side: "tabs" | "items"): void {
    this.leaveStrip();
    const strip = side === "tabs" ? this.tabsColumn : this.itemsColumn;
    const hidden = this.screen !== undefined && !(side === "tabs" ? this.screen.strips.left : this.screen.strips.right);
    if (hidden && !(this.screen?.zones.overlays.includes(side) ?? false)) {
      this.workbench.toggleOverlay(side);
    } else {
      // shown already
    }
    this.stripFocus = side;
    strip.enter();
    this.tui.setFocus(strip);
    this.tui.requestRender();
  }

  /** The keyboard back to the editor zone; an overlaid strip goes away. */
  private leaveStrip(): void {
    const side = this.stripFocus;
    if (side !== undefined) {
      this.stripFocus = undefined;
      if (this.screen?.zones.overlays.includes(side) === true) {
        this.workbench.toggleOverlay(side);
      } else {
        // the strip stays in its column
      }
      this.tui.setFocus(this.editorComponent ?? this.editor);
      this.tui.requestRender();
    } else {
      // the keyboard is not in a strip
    }
  }

  /** Autocomplete of commands and files for the active session. */
  async loadCompletions(): Promise<void> {
    const tab = this.workbench.activeTab();
    if (tab?.agent !== undefined) {
      const commands = await this.workbench.commands();
      const agentId = tab.agent.id;
      // a session on this machine: pi's provider reads its directory; another machine's: its node does
      this.editor.setAutocompleteProvider(
        tab.node === this.client.home
          ? new CombinedAutocompleteProvider(commands, tab.cwd)
          : new RemoteAutocompleteProvider(commands, async (prefix) =>
              (await this.client.connection(tab.node).call<{ items: string[] }>(agentId, { type: "harness_complete", kind: "file", prefix }).catch(() => ({ items: [] }))).items,
            ),
      );
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

/** The themes the TUI can draw: pi's own and the user's (`~/.harness/themes/*.json`). */
export function clientThemes(home: string): string[] {
  const own = existsSync(join(home, "themes")) ? readdirSync(join(home, "themes")).filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -".json".length)) : [];
  return ["dark", "light", ...own.sort()];
}
