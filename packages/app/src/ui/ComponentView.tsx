// An extension's component, drawn in the agent, shown here as a remote terminal (plan polish-2 L):
// its ANSI lines in the chrome zone's monospace font with their colors and links, its size in cells
// sent to the agent as the space changes. While it is open every key is its own, as in the TUI
// (except the workbench's: tabs, the panel), pasted text arrives as bracketed paste, a click or a
// tap goes to the cell it hit. On a phone a strip of keys (↑ ↓ ⏎ Esc Tab) and a field for typing
// stand under it.

import { useEffect, useState } from "react";
import { Linking, Platform, Pressable, Text, TextInput, View, type GestureResponderEvent, type LayoutChangeEvent } from "react-native";
import { parseAnsiLine, type AnsiStyle } from "#client/ansi.ts";
import type { Workbench } from "#client/workbench/workbench.ts";
import type { BridgedComponent } from "#protocol/hap.ts";
import { charWidth, fontOf, lineHeight, useTheme } from "../theme/theme.tsx";
import { listenComponentKeys } from "../keyboard";
import { Button, T } from "./primitives.tsx";

export function spanStyle(style: AnsiStyle, colors: { text: string; pageBg: string }): object {
  const fg = style.inverse === true ? (style.bg ?? colors.pageBg) : (style.fg ?? colors.text);
  const bg = style.inverse === true ? (style.fg ?? colors.text) : style.bg;
  return {
    color: fg,
    ...(bg !== undefined ? { backgroundColor: bg } : {}),
    ...(style.bold === true ? { fontWeight: "bold" } : {}),
    ...(style.italic === true ? { fontStyle: "italic" } : {}),
    ...(style.underline === true || style.link !== undefined ? { textDecorationLine: "underline" } : {}),
    ...(style.dim === true ? { opacity: 0.6 } : {}),
  };
}

/** The keys go to the component while it is open (keyboard.web.ts); the workbench keeps its own. */
function useComponentKeys(workbench: Workbench, componentId: string): void {
  useEffect(() => listenComponentKeys((bytes) => void workbench.componentInput(componentId, bytes)), [workbench, componentId]);
}

export function ComponentView({ component, workbench, rows }: { component: BridgedComponent; workbench: Workbench; rows?: number }) {
  const theme = useTheme();
  const zone = theme.chrome;
  const cell = { width: charWidth(zone), height: lineHeight(zone) };
  const [size, setSize] = useState<{ columns: number; rows: number } | undefined>(undefined);
  useComponentKeys(workbench, component.componentId);
  useEffect(() => {
    if (size !== undefined) {
      void workbench.componentResize(component.componentId, size.columns, size.rows);
    } else {
      // not measured yet
    }
  }, [size?.columns, size?.rows, component.componentId]);

  const onLayout = (event: LayoutChangeEvent): void => {
    const { width, height } = event.nativeEvent.layout;
    const next = { columns: Math.max(20, Math.floor((width - 8) / cell.width)), rows: rows ?? Math.max(8, Math.floor(height / cell.height)) };
    if (next.columns !== size?.columns || next.rows !== size.rows) {
      setSize(next);
    } else {
      // the same size
    }
  };
  const click = (line: number) => (event: GestureResponderEvent) => {
    // the press's place in the line: React Native's locationX, the browser's offsetX
    const native = event.nativeEvent as { locationX?: number; offsetX?: number };
    const at = Number.isFinite(native.locationX) ? (native.locationX ?? 0) : Number.isFinite(native.offsetX) ? (native.offsetX ?? 0) : 0;
    const x = Math.max(0, Math.floor(at / cell.width));
    void workbench.componentMouse(component.componentId, { type: "click", button: "left", x, y: line });
  };
  const key = (bytes: string) => () => void workbench.componentInput(component.componentId, bytes);

  return (
    <View accessibilityLabel="extension component" style={{ gap: 4 }}>
      <T color="dim">extension</T>
      <View onLayout={onLayout} style={{ paddingHorizontal: 4 }}>
        {component.lines.map((raw, index) => {
          const line = parseAnsiLine(raw);
          return (
            <Pressable key={index} onPress={click(index)}>
              <Text style={[fontOf(zone), { color: theme.colors.text }]} numberOfLines={1}>
                {line.spans.map((span, spanIndex) => (
                  <Text
                    key={spanIndex}
                    style={spanStyle(span.style, theme.colors)}
                    {...(span.style.link !== undefined ? { onPress: () => void Linking.openURL(span.style.link ?? "") } : {})}
                  >
                    {span.text}
                  </Text>
                ))}
                {line.cursor !== undefined ? <Text style={{ backgroundColor: theme.colors.accent }}> </Text> : null}
                {line.spans.length === 0 && line.cursor === undefined ? " " : null}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {Platform.OS !== "web" ? (
        <View style={{ flexDirection: "row", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
          <Button label="↑" onPress={key("\x1b[A")} />
          <Button label="↓" onPress={key("\x1b[B")} />
          <Button label="⏎" onPress={key("\r")} />
          <Button label="Esc" onPress={key("\x1b")} />
          <Button label="Tab" onPress={key("\t")} />
          <TextInput
            accessibilityLabel="type to the extension"
            placeholder="type"
            placeholderTextColor={theme.colors.dim}
            value=""
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={(text) => (text !== "" ? void workbench.componentInput(component.componentId, text) : undefined)}
            onKeyPress={(event) => (event.nativeEvent.key === "Backspace" ? void workbench.componentInput(component.componentId, "\x7f") : undefined)}
            onSubmitEditing={key("\r")}
            style={[fontOf(zone), { flex: 1, minWidth: 80, color: theme.colors.text, borderBottomWidth: 1, borderColor: theme.colors.borderMuted }]}
          />
        </View>
      ) : null}
    </View>
  );
}
