// The app's primitives on React Native: text in a zone's font and a token's color, the one glyph of
// a row, real buttons with their key, frames of 1px token borders, the braille spinner. Dense, no
// shadows, no gradients, radius at most 2.

import { useEffect, useRef, useState, type ComponentRef, type ReactNode } from "react";
import { useRowEvents, type RowEvents } from "./web-events";
import { Pressable, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import type { Glyph } from "#client/workbench/workbench.ts";
import { fontOf, useTheme, type Token } from "../theme/theme.tsx";

export type Zone = "chrome" | "chat";

export function T(props: {
  children: ReactNode;
  zone?: Zone;
  color?: Token;
  bold?: boolean;
  italic?: boolean;
  lines?: number;
  selectable?: boolean;
  style?: StyleProp<TextStyle>;
}) {
  const theme = useTheme();
  return (
    <Text
      numberOfLines={props.lines}
      selectable={props.selectable}
      style={[
        fontOf(theme[props.zone ?? "chrome"]),
        { color: theme.colors[props.color ?? "text"], fontWeight: props.bold === true ? "bold" : "normal", fontStyle: props.italic === true ? "italic" : "normal" },
        props.style,
      ]}
    >
      {props.children}
    </Text>
  );
}

const GLYPH_COLOR: Record<Glyph, Token> = { "⊘": "dim", "◆": "warning", "✗": "error", "●": "accent", "✓": "success", " ": "dim" };

/** The one glyph a row carries, always first (plan 10.5). */
export function GlyphMark({ glyph }: { glyph: Glyph }) {
  return (
    <T color={GLYPH_COLOR[glyph]} style={{ width: "2ch" as never }}>
      {glyph === "●" ? <Spinner /> : glyph}
    </T>
  );
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((current) => (current + 1) % FRAMES.length), 80);
    return () => clearInterval(timer);
  }, []);
  return <>{FRAMES[frame]}</>;
}

export function Kbd({ children }: { children: string }) {
  const theme = useTheme();
  return (
    <T color="dim" style={{ borderWidth: 1, borderColor: theme.colors.borderMuted, borderRadius: 2, paddingHorizontal: 3 }}>
      {children}
    </T>
  );
}

export function Button(props: { label: string; kbd?: string; onPress: () => void; tone?: Token; disabled?: boolean; label2?: string }) {
  const theme = useTheme();
  const [hover, setHover] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      onHoverIn={() => setHover(true)}
      onHoverOut={() => setHover(false)}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        borderWidth: 1,
        borderRadius: 2,
        borderColor: theme.colors[props.tone ?? "border"],
        backgroundColor: hover ? theme.colors.selectedBg : "transparent",
        paddingHorizontal: 8,
        paddingVertical: 2,
        minHeight: 24,
        opacity: props.disabled === true ? 0.5 : 1,
      }}
    >
      <T color={props.tone ?? "text"}>{props.label}</T>
      {props.kbd !== undefined ? <Kbd>{props.kbd}</Kbd> : null}
    </Pressable>
  );
}

/** A group: a 1px border in a token's color, with a title. */
export function Frame(props: { title?: string; tone?: Token; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const theme = useTheme();
  return (
    <View style={[{ borderWidth: 1, borderRadius: 2, borderColor: theme.colors[props.tone ?? "borderMuted"], padding: 6, gap: 4 }, props.style]}>
      {props.title !== undefined ? (
        <T color={props.tone ?? "muted"} bold>
          {props.title}
        </T>
      ) : null}
      {props.children}
    </View>
  );
}

export function Rule() {
  const theme = useTheme();
  return <View style={{ height: 1, backgroundColor: theme.colors.borderMuted }} />;
}

/** A row of a list: a hover background, the selected one in selectedBg. */
export function ListRow(props: { selected?: boolean; onPress?: () => void; children: ReactNode; label: string; indent?: number; events?: RowEvents }) {
  const theme = useTheme();
  const [hover, setHover] = useState(false);
  const ref = useRef<ComponentRef<typeof Pressable>>(null);
  useRowEvents(ref, props.events ?? {});
  const menu = props.events?.onContextMenu;
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ selected: props.selected === true }}
      onPress={props.onPress}
      onLongPress={menu !== undefined ? (event) => menu(event.nativeEvent.pageX, event.nativeEvent.pageY) : undefined}
      onHoverIn={() => setHover(true)}
      onHoverOut={() => setHover(false)}
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 6,
        paddingLeft: 6 + (props.indent ?? 0) * 12,
        minHeight: 22,
        backgroundColor: props.selected === true ? theme.colors.selectedBg : hover ? theme.colors.toolPendingBg : "transparent",
      }}
    >
      {props.children}
    </Pressable>
  );
}
