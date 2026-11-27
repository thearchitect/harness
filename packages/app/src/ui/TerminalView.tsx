// The session's terminal over the main area, the TUI's twin (plan polish-3 F): a frame in the accent
// border color, the title naming the directory and the key that hides it (Ctrl/Alt+/), the hub's shell
// as the client's terminal model draws it (ANSI lines in the chrome zone's monospace font). Its size
// in cells follows the frame. While it is shown every key is the shell's (keyboard.web.ts) but the
// way out (Ctrl/Alt+/); pasted text arrives bracketed when the program asks for
// it. On a phone a strip of keys (↑ ↓ ⏎ Esc Tab Ctrl+C) and a field for typing stand under it.

import { useEffect, useLayoutEffect, useReducer, useState } from "react";
import { Platform, Text, TextInput, View, type LayoutChangeEvent } from "react-native";
import { parseAnsiLine } from "#client/ansi.ts";
import type { TerminalModel } from "#client/model/terminal-model.ts";
import type { ClientModel } from "#client/model/client-model.ts";
import { charWidth, fontOf, lineHeight, useTheme } from "../theme/theme.tsx";
import { listenComponentKeys } from "../keyboard";
import { spanStyle } from "./ComponentView.tsx";
import { Button, T } from "./primitives.tsx";

/** Under the frame on a phone, as in ComponentView. */
const PHONE_KEYS: [string, string][] = [
  ["↑", "\x1b[A"],
  ["↓", "\x1b[B"],
  ["⏎", "\r"],
  ["Esc", "\x1b"],
  ["Tab", "\t"],
  ["Ctrl+C", "\x03"],
];

export function TerminalView({ terminal, client, onHide }: { terminal: TerminalModel; client: ClientModel; onHide: () => void }) {
  const theme = useTheme();
  const zone = theme.chrome;
  const cell = { width: charWidth(zone), height: lineHeight(zone) };
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  const [size, setSize] = useState<{ cols: number; rows: number } | undefined>(undefined);
  useEffect(() => client.onChange(redraw), [client]);
  // the keys are the shell's from the moment it shows (before the paint: no key slips past it); Enter after it exited starts another
  useLayoutEffect(
    () =>
      listenComponentKeys(
        (bytes) => (terminal.state === "exited" && bytes === "\r" ? void terminal.open(terminal.cols, terminal.rows) : terminal.input(bytes)),
        "terminal",
        () => terminal.bracketedPaste,
      ),
    [terminal],
  );
  useEffect(() => {
    if (size === undefined) {
      return; // not measured yet
    } else if (terminal.state === "closed") {
      void terminal.open(size.cols, size.rows);
    } else {
      terminal.resize(size.cols, size.rows);
    }
  }, [terminal, size?.cols, size?.rows]);
  const onLayout = (event: LayoutChangeEvent): void => {
    const { width, height } = event.nativeEvent.layout;
    const next = { cols: Math.max(20, Math.floor((width - 4) / cell.width)), rows: Math.max(4, Math.floor(height / cell.height)) };
    if (next.cols !== size?.cols || next.rows !== size.rows) {
      setSize(next);
    } else {
      // the same size
    }
  };

  const view = terminal.view();
  const key = (bytes: string) => () => terminal.input(bytes);
  return (
    <View accessibilityLabel="terminal" style={{ flex: 1, borderWidth: 1, borderColor: theme.colors.borderAccent, backgroundColor: theme.colors.pageBg }}>
      <T color="borderAccent" lines={1}>{` terminal · ${terminal.cwd} · ${Platform.OS === "web" ? "Ctrl/Alt+/ hide" : "terminal hides"} `}</T>
      <View onLayout={onLayout} style={{ flex: 1, paddingHorizontal: 2, overflow: "hidden" }}>
        {view.lines.map((raw, index) => {
          const line = parseAnsiLine(raw);
          const cursor = view.cursor?.y === index ? view.cursor.x : undefined;
          return (
            <Text key={index} style={[fontOf(zone), { color: theme.colors.text }]} numberOfLines={1}>
              {line.spans.map((span, spanIndex) => (
                <Text key={spanIndex} style={spanStyle(span.style, theme.colors)}>
                  {span.text}
                </Text>
              ))}
              {cursor !== undefined ? <Text style={{ position: "absolute", left: cursor * cell.width, width: cell.width, backgroundColor: theme.colors.accent, opacity: 0.6 }}> </Text> : null}
            </Text>
          );
        })}
        {terminal.state === "exited" ? <T color="warning">{`[exited ${terminal.exitCode ?? "?"}] · Enter restarts`}</T> : null}
      </View>
      {Platform.OS !== "web" ? (
        <View style={{ flexDirection: "row", gap: 4, flexWrap: "wrap", alignItems: "center", padding: 4 }}>
          <Button label="hide" onPress={onHide} />
          {PHONE_KEYS.map(([label, bytes]) => (
            <Button key={label} label={label} onPress={terminal.state === "exited" && bytes === "\r" ? () => void terminal.open(terminal.cols, terminal.rows) : key(bytes)} />
          ))}
          <TextInput
            accessibilityLabel="type to the terminal"
            placeholder="type"
            placeholderTextColor={theme.colors.dim}
            value=""
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={(text) => (text !== "" ? terminal.input(text) : undefined)}
            onKeyPress={(event) => (event.nativeEvent.key === "Backspace" ? terminal.input("\x7f") : undefined)}
            onSubmitEditing={key("\r")}
            style={[fontOf(zone), { flex: 1, minWidth: 80, color: theme.colors.text, borderBottomWidth: 1, borderColor: theme.colors.borderMuted }]}
          />
        </View>
      ) : null}
    </View>
  );
}
