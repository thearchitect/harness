// The multi-session screen (plan 10.5), drawn from the workbench's screen: tabs on the left, the
// active session's items on the right, the main area between (its zones top to bottom: main, above
// the editor, the editor, status, footer), overlays over the right strip. Narrow screens hide the
// strips behind buttons that show them as overlays.

import { useMemo, useState } from "react";
import { PanResponder, View } from "react-native";
import type { AgentModel } from "#client/model/agent-model.ts";
import type { Item, Screen, StatusLine, Tab, Workbench } from "#client/workbench/workbench.ts";
import { MODE_COLOR_HEX } from "#protocol/modes.ts";
import { useTheme, type Token } from "../theme/theme.tsx";
import { EditorZoneView, type Completion } from "./EditorZone.tsx";
import { Button, GlyphMark, ListRow, T } from "./primitives.tsx";
import { Transcript } from "./Transcript.tsx";

function Tabs({ screen, workbench }: { screen: Screen; workbench: Workbench }) {
  return <TabsStrip tabs={screen.tabs} active={screen.active} onGoto={(index) => void workbench.act(`tabs.goto.${index + 1}`)} onNew={() => void workbench.act("tabs.new")} />;
}

/** The left strip: one row per open session, the glyph first; node headers when sessions come from several nodes. */
export function TabsStrip({ tabs, active, onGoto, onNew }: { tabs: Tab[]; active: number; onGoto: (index: number) => void; onNew: () => void }) {
  const nodes = new Set(tabs.map((tab) => tab.node));
  let lastNode: string | undefined;
  return (
    <View accessibilityRole="tablist" accessibilityLabel="sessions" style={{ paddingVertical: 4 }}>
      <T color="muted" style={{ paddingHorizontal: 6 }}>
        sessions
      </T>
      {tabs.map((tab: Tab, index) => {
        const header = nodes.size > 1 && tab.node !== lastNode ? tab.node : undefined;
        lastNode = tab.node;
        return (
          <View key={`${tab.node}/${tab.sessionId}`}>
            {header !== undefined ? (
              <T color="dim" style={{ paddingHorizontal: 6, paddingTop: 4 }}>
                {header}
              </T>
            ) : null}
            <ListRow label={`${tab.title}${tab.unavailable !== undefined ? ` (${tab.unavailable})` : ""}`} selected={index === active} onPress={() => onGoto(index)}>
              <GlyphMark glyph={tab.glyph} />
              <T lines={1} style={{ color: MODE_COLOR_HEX[tab.mode], flexShrink: 1 }}>
                {tab.title}
              </T>
            </ListRow>
          </View>
        );
      })}
      <ListRow label="New session" onPress={onNew}>
        <T color="muted">+ new</T>
      </ListRow>
    </View>
  );
}

function Items({ screen, workbench }: { screen: Screen; workbench: Workbench }) {
  const tab = screen.tab;
  return <ItemsStrip items={screen.items} selected={screen.selected} onSelect={(id) => (tab !== undefined ? workbench.select(tab, id) : undefined)} />;
}

/** The right strip: the session first, then its tasks and subagents on the same level; nested ones indented. */
export function ItemsStrip({ items, selected, onSelect }: { items: Item[]; selected: string | undefined; onSelect: (id: string) => void }) {
  return (
    <View accessibilityRole="list" accessibilityLabel="session items" style={{ paddingVertical: 4 }}>
      {items.map((item: Item) => (
        <ListRow key={item.id} label={item.label} indent={item.depth} selected={item.id === selected} onPress={() => onSelect(item.id)}>
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

function Panel({ screen, workbench }: { screen: Screen; workbench: Workbench }) {
  const theme = useTheme();
  const state = screen.agent?.state;
  return (
    <View accessibilityLabel="harness panel" style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 320, backgroundColor: theme.colors.cardBg, borderLeftWidth: 1, borderColor: theme.colors.border, padding: 6, gap: 4 }}>
      <T color="accent" bold>
        harness
      </T>
      {state !== undefined
        ? workbench.panelRows(state).map((row) => (
            <ListRow key={row.value} label={row.label} onPress={() => void workbench.choosePanel(row.value)}>
              <T lines={1}>{row.label}</T>
              <T color="dim" lines={1} style={{ marginLeft: 8, flexShrink: 1 }}>
                {row.description}
              </T>
            </ListRow>
          ))
        : null}
      <Button label="Close" kbd="Ctrl+\" onPress={() => workbench.toggleOverlay("panel")} />
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

function Main({ screen, workbench, onLoadOlder }: { screen: Screen; workbench: Workbench; onLoadOlder: (agent: AgentModel) => void }) {
  const main = screen.zones.main;
  const agent = screen.agent;
  switch (main.kind) {
    case "transcript":
      return agent !== undefined ? (
        <Transcript agent={agent} expanded={screen.toolsExpanded} onLoadOlder={() => onLoadOlder(agent)} />
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
        <Transcript agent={main.agent} expanded={screen.toolsExpanded} onLoadOlder={() => (main.agent !== undefined ? onLoadOlder(main.agent) : undefined)} />
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
    default:
      throw new Error(`unknown main zone: ${JSON.stringify(main satisfies never)}`);
  }
}

export type Panes = { left: number; right: number };

const DEFAULT_PANES: Panes = { left: 220, right: 260 };

function clampPane(width: number): number {
  return Math.max(140, Math.min(520, Math.round(width)));
}

function panesOf(setting: unknown): Panes {
  const value = (typeof setting === "object" && setting !== null ? setting : {}) as Partial<Panes>;
  return {
    left: typeof value.left === "number" ? clampPane(value.left) : DEFAULT_PANES.left,
    right: typeof value.right === "number" ? clampPane(value.right) : DEFAULT_PANES.right,
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
  /** `ui.web.panes` of the user's settings: the strips' widths. */
  panes: unknown;
  onPanes: (panes: Panes) => void;
}) {
  const theme = useTheme();
  const { screen, workbench } = props;
  const overlays = screen.zones.overlays;
  const column = { borderColor: theme.colors.borderMuted, backgroundColor: theme.colors.pageBg };
  const panes = panesOf(props.panes);
  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: theme.colors.pageBg }}>
      {screen.strips.left || overlays.includes("tabs") ? (
        <View style={[column, { width: panes.left, borderRightWidth: 1 }, overlays.includes("tabs") ? { position: "absolute", zIndex: 2, top: 0, bottom: 0, left: 0 } : null]}>
          <Tabs screen={screen} workbench={workbench} />
        </View>
      ) : null}
      {screen.strips.left && !overlays.includes("tabs") ? <Resizer label="Resize the sessions strip" onResize={(delta) => props.onPanes({ ...panes, left: clampPane(panes.left + delta) })} /> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        {!screen.strips.left || !screen.strips.right ? (
          <View style={{ flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 6, paddingVertical: 2 }}>
            {!screen.strips.left ? <Button label="Sessions" onPress={() => void workbench.act("strip.tabs")} /> : <View />}
            {!screen.strips.right ? <Button label="Items" onPress={() => void workbench.act("strip.items")} /> : <View />}
          </View>
        ) : null}
        <Main screen={screen} workbench={workbench} onLoadOlder={props.onLoadOlder} />
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
            placeholder={screen.tab === undefined ? "Ctrl+T starts a session" : "Message (Ctrl+Enter sends; a leading ! asks for BUILD)"}
          />
          {screen.zones.status.map((line, index) => (
            <T key={index} color={STATUS_TONE[line.level]} lines={1}>
              {line.text}
            </T>
          ))}
          <Footer screen={screen} />
        </View>
      </View>
      {screen.strips.right && !overlays.includes("items") ? <Resizer label="Resize the items strip" onResize={(delta) => props.onPanes({ ...panes, right: clampPane(panes.right - delta) })} /> : null}
      {screen.strips.right || overlays.includes("items") ? (
        <View style={[column, { width: panes.right, borderLeftWidth: 1 }, overlays.includes("items") ? { position: "absolute", zIndex: 2, top: 0, bottom: 0, right: 0 } : null]}>
          <Items screen={screen} workbench={workbench} />
        </View>
      ) : null}
      {overlays.includes("panel") ? <Panel screen={screen} workbench={workbench} /> : null}
    </View>
  );
}
