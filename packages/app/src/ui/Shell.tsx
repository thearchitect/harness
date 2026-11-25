// The multi-session screen (plan 10.5), drawn from the workbench's screen: the strip on the left in
// three blocks (the nodes, the chosen node's sessions, the active session's items), the main area
// beside it (its zones top to bottom: main, above the editor, the editor, status, footer), the
// panel over the right edge. A narrow screen hides the strip behind a button that shows it over.

import * as Clipboard from "expo-clipboard";
import { useEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import { PanResponder, Platform, Pressable, TextInput, View } from "react-native";
import type { AgentModel } from "#client/model/agent-model.ts";
import type { Item, NodeRow, PanelId, PanelItem, Screen, StatusLine, Tab, Workbench } from "#client/workbench/workbench.ts";
import { MODE_COLOR_HEX } from "#protocol/modes.ts";
import { fontOf, useTheme, type Token } from "../theme/theme.tsx";
import { EditorZoneView, type Completion } from "./EditorZone.tsx";
import { NewSessionView } from "./NewSession.tsx";
import { Button, GlyphMark, ListRow, T } from "./primitives.tsx";
import { Transcript } from "./Transcript.tsx";
import { focusList, focusMessage, useListKeys } from "./web-events";

/** The strip: the nodes block as tall as its rows, then the sessions (two thirds) and the items (a third), divided by rules. */
function Strip({ screen, workbench, onMenu }: { screen: Screen; workbench: Workbench; onMenu: (menu: Menu) => void }) {
  const theme = useTheme();
  const rule = { borderTopWidth: 1, borderColor: theme.colors.borderMuted };
  return (
    <View style={{ flex: 1 }}>
      <NodesStrip nodes={screen.nodes} chosen={screen.node} onChoose={(node) => void workbench.chooseNode(node)} onAdd={() => workbench.addNode()} />
      <View style={[rule, { flex: 2, minHeight: 0 }]}>
        <Tabs screen={screen} workbench={workbench} onMenu={onMenu} />
      </View>
      <View style={[rule, { flex: 1, minHeight: 0 }]}>
        {screen.newSession === undefined ? <Items screen={screen} workbench={workbench} onMenu={onMenu} /> : null}
      </View>
    </View>
  );
}

/** The nodes block: one glyph each (⊘ offline, ◆ a session waits, ● something works), `+ add` last. */
export function NodesStrip({ nodes, chosen, onChoose, onAdd }: { nodes: NodeRow[]; chosen: string | undefined; onChoose: (node: string) => void; onAdd?: () => void }) {
  const ref = useRef<ComponentRef<typeof View>>(null);
  useListKeys(ref);
  return (
    <View ref={ref} accessibilityRole="list" accessibilityLabel="nodes" style={{ paddingVertical: 4 }}>
      {nodes.map((node) => (
        <ListRow key={node.name} label={`node ${node.label}`} selected={node.name === chosen} onPress={() => onChoose(node.name)} events={{ title: node.name }}>
          {node.glyph !== "" ? <GlyphMark glyph={node.glyph} /> : <T> </T>}
          <T lines={1} style={{ flexShrink: 1 }}>
            {node.label}
          </T>
        </ListRow>
      ))}
      {onAdd !== undefined ? (
        <ListRow label="Add a hub" onPress={onAdd}>
          <T color="muted" lines={1}>
            + add
          </T>
        </ListRow>
      ) : null}
    </View>
  );
}

function Tabs({ screen, workbench, onMenu }: { screen: Screen; workbench: Workbench; onMenu: (menu: Menu) => void }) {
  const menuOf = (index: number, x: number, y: number): void => {
    const tab = screen.tabs[index];
    onMenu({
      x,
      y,
      items: [
        ...(tab !== undefined ? [{ label: "Close", run: () => void workbench.closeTab(tab.index) }] : []),
        ...(tab?.agent !== undefined && tab.glyph === "●" ? [{ label: "Stop the run", run: () => void workbench.act(`tabs.goto.${index + 1}`).then(() => workbench.act("run.abort")) }] : []),
        ...(tab !== undefined ? [{ label: "Copy the session id", run: () => void Clipboard.setStringAsync(tab.sessionId) }] : []),
      ],
    });
  };
  const at = (index: number): number => screen.tabs[index]?.index ?? index;
  return (
    <TabsStrip
      tabs={screen.tabs}
      active={screen.active}
      placing={screen.newSession !== undefined}
      onGoto={(index) => void workbench.act(`tabs.goto.${index + 1}`)}
      onNew={() => void workbench.act("tabs.new")}
      onMenu={menuOf}
      onMove={(from, to) => void workbench.moveTab(at(from), at(to))}
      onClose={(index) => void workbench.closeTab(at(index))}
    />
  );
}

/** A context menu: where the pointer (or the long press) was, the row's actions. */
export type Menu = { x: number; y: number; items: { label: string; run: () => void }[] };

function MenuView({ menu, onClose }: { menu: Menu; onClose: () => void }) {
  const theme = useTheme();
  return (
    <View style={{ position: "absolute", inset: 0, zIndex: 10 } as never}>
      <Pressable accessibilityLabel="Close the menu" onPress={onClose} style={{ position: "absolute", inset: 0 } as never} />
      <View accessibilityRole="menu" style={{ position: "absolute", left: menu.x, top: menu.y, minWidth: 180, backgroundColor: theme.colors.cardBg, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 2, paddingVertical: 2 }}>
        {menu.items.map((item) => (
          <ListRow
            key={item.label}
            label={item.label}
            onPress={() => {
              onClose();
              item.run();
            }}
          >
            <T>{item.label}</T>
          </ListRow>
        ))}
      </View>
    </View>
  );
}

/** The sessions block: one row per open session of the chosen node, the glyph first; `+ new` last. */
export function TabsStrip({
  tabs,
  active,
  placing = false,
  onGoto,
  onNew,
  onMenu,
  onMove,
  onClose,
}: {
  tabs: Tab[];
  active: number;
  /** A new session is being placed: its row stands for it. */
  placing?: boolean;
  onGoto: (index: number) => void;
  onNew: () => void;
  onMenu?: (index: number, x: number, y: number) => void;
  onMove?: (from: number, to: number) => void;
  onClose?: (index: number) => void;
}) {
  const ref = useRef<ComponentRef<typeof View>>(null);
  useListKeys(ref);
  return (
    <View ref={ref} accessibilityRole="tablist" accessibilityLabel="sessions" style={{ paddingVertical: 4 }}>
      {tabs.map((tab: Tab, index) => {
        return (
          <View key={`${tab.node}/${tab.sessionId}`}>
            <ListRow
              label={`${tab.title}${tab.unavailable !== undefined ? ` (${tab.unavailable})` : ""}`}
              selected={index === active}
              onPress={() => onGoto(index)}
              events={{
                title: `${tab.node}:${tab.cwd}${tab.unavailable !== undefined ? ` — ${tab.unavailable}` : ""}`,
                ...(onMenu !== undefined ? { onContextMenu: (x: number, y: number) => onMenu(index, x, y) } : {}),
                ...(onClose !== undefined ? { onMiddleClick: () => onClose(index) } : {}),
                ...(onMove !== undefined ? { drag: { index, onDrop: (from: number) => onMove(from, index) } } : {}),
              }}
            >
              <GlyphMark glyph={tab.glyph} />
              <T lines={1} style={{ color: MODE_COLOR_HEX[tab.mode], flexShrink: 1 }}>
                {tab.title}
              </T>
            </ListRow>
          </View>
        );
      })}
      <ListRow label="New session" selected={placing} onPress={onNew}>
        <T color={placing ? "accent" : "muted"} lines={1}>
          {placing ? "› new session" : "+ new"}
        </T>
      </ListRow>
    </View>
  );
}

function Items({ screen, workbench, onMenu }: { screen: Screen; workbench: Workbench; onMenu: (menu: Menu) => void }) {
  const tab = screen.tab;
  const menuOf = (item: Item, x: number, y: number): void => {
    const task = item.kind === "task" ? screen.agent?.state.tasks.find((candidate) => candidate.id === item.id) : undefined;
    onMenu({
      x,
      y,
      items: [
        ...(task !== undefined && task.endedAt === undefined ? [{ label: "Stop", run: () => void workbench.stopTask(task.id) }] : []),
        { label: "Copy the id", run: () => void Clipboard.setStringAsync(item.id) },
      ],
    });
  };
  return <ItemsStrip items={screen.items} selected={screen.selected} onSelect={(id) => (tab !== undefined ? workbench.select(tab, id) : undefined)} onMenu={menuOf} />;
}

/** The items block: `session` first (its mode's color), then its tasks and subagents on the same level; nested ones indented. */
export function ItemsStrip({ items, selected, onSelect, onMenu }: { items: Item[]; selected: string | undefined; onSelect: (id: string) => void; onMenu?: (item: Item, x: number, y: number) => void }) {
  const ref = useRef<ComponentRef<typeof View>>(null);
  useListKeys(ref);
  return (
    <View ref={ref} accessibilityRole="list" accessibilityLabel="session items" style={{ paddingVertical: 4 }}>
      {items.map((item: Item) => (
        <ListRow
          key={item.id}
          label={item.label}
          indent={item.depth}
          selected={item.id === selected}
          onPress={() => onSelect(item.id)}
          events={{ title: `${item.label} — ${item.detail}`, ...(onMenu !== undefined ? { onContextMenu: (x: number, y: number) => onMenu(item, x, y) } : {}) }}
        >
          <GlyphMark glyph={item.glyph} />
          <T lines={1} style={{ flexShrink: 1 }}>
            {item.label}
          </T>
          <T color="dim" lines={1} style={{ marginLeft: "auto" as never, paddingLeft: 6 }}>
            {item.detail}
          </T>
        </ListRow>
      ))}
    </View>
  );
}

/** A panel row's value on the right: a toggle's switch, a value, an action's hint. */
function PanelValue({ item }: { item: PanelItem }) {
  switch (item.kind) {
    case "toggle":
      return item.on ? <T color={item.tone}>●━━  on</T> : <T color="dim">━━○ off</T>;
    case "value":
      return <T color="muted">{item.value}</T>;
    case "text":
      return <T color="muted">{item.value !== "" ? item.value : item.placeholder}</T>;
    case "action":
      return <T color="dim">{item.hint}</T>;
    default:
      throw new Error(`unknown panel item: ${JSON.stringify(item satisfies never)}`);
  }
}

/**
 * The panel's text field (the session's name): typing applies as it goes (Workbench.editSessionName),
 * leaving it applies at once; ↑/↓ move on to the next rows as on every row.
 */
function PanelField({ item, workbench }: { item: Extract<PanelItem, { kind: "text" }>; workbench: Workbench }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 2 }}>
      <T style={{ marginRight: 8 }}>{item.label}</T>
      <TextInput
        accessibilityLabel={`session ${item.label}`}
        value={item.value}
        placeholder={item.placeholder}
        placeholderTextColor={theme.colors.dim}
        onChangeText={(text) => workbench.editSessionName(text)}
        onBlur={() => void workbench.commitSessionName()}
        onKeyPress={(event) => (event.nativeEvent.key === "Escape" ? workbench.closeOverlay("panel") : undefined)}
        style={[fontOf(theme.chrome), { flex: 1, color: theme.colors.text, borderBottomWidth: 1, borderColor: theme.colors.borderMuted, paddingVertical: 2 }]}
      />
    </View>
  );
}

/**
 * The harness panel (Ctrl+\), as the TUI draws it: the same sections and rows (Workbench.panel), the
 * accent border on the left. The keyboard comes in on its first row: ↑/↓, Space or Enter apply, Esc
 * closes; a click applies a row, the pointer lights it. A toggle keeps it open, an action closes it.
 */
function Panel({ workbench }: { workbench: Workbench }) {
  const theme = useTheme();
  const ref = useRef<ComponentRef<typeof View>>(null);
  const close = useMemo(() => () => workbench.closeOverlay("panel"), [workbench]);
  useListKeys(ref, close);
  useEffect(() => {
    focusList("harness panel");
    return () => focusMessage();
  }, []);
  const apply = (id: PanelId): void => void workbench.applyPanel(id).catch((error: unknown) => workbench.notify("error", error instanceof Error ? error.message : String(error)));
  return (
    <View
      ref={ref}
      accessibilityRole="menu"
      accessibilityLabel="harness panel"
      style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: "25%" as never, minWidth: 240, backgroundColor: theme.colors.pageBg, borderLeftWidth: 1, borderColor: theme.colors.borderAccent, paddingVertical: 6 }}
    >
      <T color="accent" bold style={{ paddingHorizontal: 8, paddingBottom: 6 }}>
        harness
      </T>
      <View style={{ flex: 1 }}>
        {workbench.panel().map((section) => (
          <View key={section.title} style={{ paddingBottom: 8 }}>
            <T color="muted" style={{ paddingHorizontal: 8 }}>
              {section.title.toUpperCase()}
            </T>
            {section.items.map((item) =>
              item.kind === "text" ? (
                <PanelField key={item.id} item={item} workbench={workbench} />
              ) : (
                <ListRow key={item.id} label={item.label} onPress={() => apply(item.id)}>
                  <T lines={1} style={{ flexShrink: 1 }}>
                    {item.label}
                  </T>
                  <View style={{ marginLeft: "auto" as never, paddingLeft: 8 }}>
                    <PanelValue item={item} />
                  </View>
                </ListRow>
              ),
            )}
          </View>
        ))}
      </View>
      <T color="dim" style={{ paddingHorizontal: 8 }}>
        ↑↓ select · space apply
      </T>
      <T color="dim" style={{ paddingHorizontal: 8 }}>
        esc close
      </T>
    </View>
  );
}

const STATUS_TONE: Record<StatusLine["level"], Token> = { info: "muted", warning: "warning", error: "error", working: "accent" };

function Footer({ screen }: { screen: Screen }) {
  const session = screen.zones.footer.agent?.session;
  const parts = [
    screen.zones.footer.node,
    session?.cwd,
    session?.model !== undefined ? `${session.model.provider}/${session.model.id}` : undefined,
    session?.thinkingLevel,
    session?.usage.contextPercent !== undefined ? `${Math.round(session.usage.contextPercent)}%` : undefined,
    session !== undefined ? `$${session.usage.costUsd.toFixed(3)}` : undefined,
  ].filter((part): part is string => part !== undefined && part !== "");
  return (
    <T color="dim" lines={1} style={{ paddingHorizontal: 6 }}>
      {parts.join(" · ")}
    </T>
  );
}

/** What the device does with files and the microphone (the platform's: browser.ts / browser.web.ts). */
export type DeviceActions = {
  download(path: string, name: string): void;
  attach(): void;
  /** Starts or stops recording a message; undefined where there is no microphone. */
  voice: (() => void) | undefined;
  recording: boolean;
};

function Main({ screen, workbench, onLoadOlder, device }: { screen: Screen; workbench: Workbench; onLoadOlder: (agent: AgentModel) => void; device: DeviceActions }) {
  const main = screen.zones.main;
  const agent = screen.agent;
  switch (main.kind) {
    case "transcript":
      return agent !== undefined ? (
        <Transcript
          key={`${screen.tab?.node ?? ""}/${screen.tab?.sessionId ?? ""}`}
          agent={agent}
          expanded={screen.toolsExpanded}
          anchor={screen.view?.scroll}
          onAnchor={(scroll) => (screen.tab !== undefined ? workbench.updateView(screen.tab, { scroll }) : undefined)}
          onLoadOlder={() => onLoadOlder(agent)}
          onDownload={device.download}
        />
      ) : (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 8 }}>
          <T color="muted">No session here.</T>
          <View style={{ flexDirection: "row", gap: 6 }}>
            <Button label="New session" kbd="Ctrl+T" onPress={() => void workbench.act("tabs.new")} />
            <Button label="Open a session" kbd="Ctrl+O" onPress={() => void workbench.act("tabs.open")} />
          </View>
        </View>
      );
    case "task":
      return (
        <View style={{ flex: 1, padding: 8, gap: 4 }}>
          <T bold>{main.task?.command ?? main.taskId}</T>
          <T color="dim">{`${main.task?.state ?? ""}${main.task?.exitCode !== undefined ? ` · exit ${main.task.exitCode}` : ""} · the editor writes to its input`}</T>
          <View style={{ flexDirection: "row", gap: 6 }}>
            <Button label="Stop" tone="error" disabled={main.task?.endedAt !== undefined} onPress={() => void workbench.stopTask(main.taskId)} />
          </View>
          <View style={{ flex: 1, overflow: "scroll" as never }}>
            <T zone="chat" color="toolOutput" selectable>
              {main.output}
            </T>
          </View>
        </View>
      );
    case "subagent":
      return main.agent !== undefined ? (
        <Transcript agent={main.agent} expanded={screen.toolsExpanded} onLoadOlder={() => (main.agent !== undefined ? onLoadOlder(main.agent) : undefined)} onDownload={device.download} />
      ) : (
        <View style={{ flex: 1, padding: 8, gap: 4 }}>
          <T bold>{`${main.subagent?.profile ?? "subagent"} ${main.id}`}</T>
          <T color="dim">{`${main.subagent?.state ?? ""} · ${main.subagent?.engine ?? ""}${main.subagent?.model !== undefined ? ` · ${main.subagent.model}` : ""} · the editor steers it while it runs`}</T>
          {(main.subagent?.steps ?? []).map((step, index) => (
            <T key={index} color="muted" lines={1}>{`› ${step}`}</T>
          ))}
          <T zone="chat" selectable>
            {main.subagent?.text ?? ""}
          </T>
        </View>
      );
    case "newSession":
      return <NewSessionView choice={main.choice} />;
    default:
      throw new Error(`unknown main zone: ${JSON.stringify(main satisfies never)}`);
  }
}

/** `ui.web.panes`: the strip's width in pixels. */
export type Panes = { left: number };

const DEFAULT_PANES: Panes = { left: 154 };

function clampPane(width: number): number {
  return Math.max(100, Math.min(364, Math.round(width)));
}

function panesOf(setting: unknown): Panes {
  const value = (typeof setting === "object" && setting !== null ? setting : {}) as Partial<Panes>;
  return {
    left: typeof value.left === "number" ? clampPane(value.left) : DEFAULT_PANES.left,
  };
}

/** A strip's edge: dragging it changes the strip's width; the width is kept when the drag ends. */
function Resizer({ label, onResize }: { label: string; onResize: (delta: number) => void }) {
  const theme = useTheme();
  const [hover, setHover] = useState(false);
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderRelease: (_event, gesture) => onResize(gesture.dx),
        onPanResponderTerminate: (_event, gesture) => onResize(gesture.dx),
      }),
    [onResize],
  );
  return (
    <View
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      style={{ width: 4, marginHorizontal: -2, zIndex: 1, cursor: "col-resize" as never, backgroundColor: hover ? theme.colors.accent : "transparent" }}
      {...responder.panHandlers}
    />
  );
}

export function Shell(props: {
  screen: Screen;
  workbench: Workbench;
  editorText: string;
  onEditorText: (text: string) => void;
  onSubmit: () => void;
  completions: Completion[];
  onComplete: (completion: Completion) => void;
  onLoadOlder: (agent: AgentModel) => void;
  device: DeviceActions;
  /** `ui.web.panes` of the user's settings: the strips' widths. */
  panes: unknown;
  onPanes: (panes: Panes) => void;
}) {
  const theme = useTheme();
  const { screen, workbench } = props;
  const overlays = screen.zones.overlays;
  const column = { borderColor: theme.colors.borderMuted, backgroundColor: theme.colors.pageBg };
  const panes = panesOf(props.panes);
  const [menu, setMenu] = useState<Menu | undefined>(undefined);
  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: theme.colors.pageBg }}>
      {screen.strips.left || overlays.includes("tabs") ? (
        <View style={[column, { width: panes.left, borderRightWidth: 1 }, overlays.includes("tabs") ? { position: "absolute", zIndex: 2, top: 0, bottom: 0, left: 0 } : null]}>
          <Strip screen={screen} workbench={workbench} onMenu={setMenu} />
        </View>
      ) : null}
      {screen.strips.left && !overlays.includes("tabs") ? <Resizer label="Resize the strip" onResize={(delta) => props.onPanes({ ...panes, left: clampPane(panes.left + delta) })} /> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        {!screen.strips.left ? (
          <View style={{ flexDirection: "row", paddingHorizontal: 6, paddingVertical: 2 }}>
            <Button label="Sessions" onPress={() => void workbench.act("strip.tabs")} />
          </View>
        ) : null}
        <Main screen={screen} workbench={workbench} onLoadOlder={props.onLoadOlder} device={props.device} />
        <View style={{ paddingHorizontal: 8, paddingBottom: 4, gap: 2 }}>
          <EditorZoneView
            zone={screen.zones.editor}
            aboveEditor={screen.zones.aboveEditor}
            text={props.editorText}
            onText={props.onEditorText}
            onSubmit={props.onSubmit}
            completions={props.completions}
            onComplete={props.onComplete}
            onAnswer={(id, value) => void workbench.answer(id, value)}
            onClosePicker={() => workbench.closePicker()}
            onPickerScope={() => workbench.nextPickerScope()}
            device={props.device}
            placeholder={
              Platform.OS === "web"
                ? screen.tab === undefined
                  ? "Ctrl+T starts a session"
                  : "Message (Ctrl+Enter sends; a leading ! asks for BUILD)"
                : screen.tab === undefined
                  ? "Sessions → + new starts a session"
                  : "Message (⏎ sends; a leading ! asks for BUILD)"
            }
          />
          {screen.zones.status.map((line, index) => (
            <T key={index} color={STATUS_TONE[line.level]} lines={1}>
              {line.text}
            </T>
          ))}
          <Footer screen={screen} />
        </View>
      </View>
      {overlays.includes("panel") ? <Panel workbench={workbench} /> : null}
      {menu !== undefined ? <MenuView menu={menu} onClose={() => setMenu(undefined)} /> : null}
    </View>
  );
}
