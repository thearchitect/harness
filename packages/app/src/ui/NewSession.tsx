// Choosing where a new session starts, as the TUI draws it (client/workbench/new-session.ts): the
// title, the filter, then `folder ⇒` or `· this folder` and the folders, `›` on the ones that hold
// folders. With a keyboard nothing needs focus: typing filters, ↑/↓ choose, → opens, ← goes up,
// Enter starts the session, Esc cancels. A tap or click chooses a row; a tap on `›` opens it; the
// ← button goes up. On a phone the filter is a visible field (the system keyboard opens on a tap).

import { useEffect } from "react";
import { Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import type { NewSession, NewSessionKey } from "#client/workbench/new-session.ts";
import { fontOf, useTheme } from "../theme/theme.tsx";
import { Button, ListRow, T } from "./primitives.tsx";

const KEYS: Record<string, NewSessionKey> = {
  ArrowUp: "up",
  ArrowDown: "down",
  PageUp: "pageUp",
  PageDown: "pageDown",
  Home: "home",
  End: "end",
  ArrowRight: "right",
  ArrowLeft: "left",
  Enter: "enter",
  Escape: "escape",
  Backspace: "backspace",
};

/** The browser's keys go to the choice while it is shown (no field to focus). */
function useKeys(choice: NewSession): void {
  useEffect(() => {
    if (Platform.OS !== "web") {
      return undefined; // a phone types into the filter field
    } else {
      const onKey = (event: KeyboardEvent): void => {
        const key = KEYS[event.key] ?? (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey ? { char: event.key } : undefined);
        if (key !== undefined) {
          event.preventDefault();
          event.stopPropagation();
          void choice.key(key);
        } else {
          // a key of the workbench (Ctrl+…)
        }
      };
      window.addEventListener("keydown", onKey, true);
      return () => window.removeEventListener("keydown", onKey, true);
    }
  }, [choice]);
}

export function NewSessionView({ choice }: { choice: NewSession }) {
  const theme = useTheme();
  useKeys(choice);
  const rows = choice.rows();
  return (
    <View accessibilityRole="list" accessibilityLabel="new session folder" style={{ flex: 1, padding: 8, gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {choice.mode === "browse" ? <Button label="←" onPress={() => void choice.key("left")} /> : null}
        <T color="accent" bold>
          {choice.title()}
        </T>
      </View>
      {Platform.OS === "web" ? (
        <T color={choice.filter !== "" ? "text" : "dim"}>{choice.filter !== "" ? `filter ${choice.filter}▏` : "type to filter"}</T>
      ) : (
        <TextInput
          accessibilityLabel="filter folders"
          value={choice.filter}
          placeholder="filter"
          placeholderTextColor={theme.colors.dim}
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={(text) => {
            choice.filter = text;
            void choice.key("home");
          }}
          style={[fontOf(theme.chrome), { color: theme.colors.text, borderBottomWidth: 1, borderColor: theme.colors.borderMuted, padding: 2 }]}
        />
      )}
      <ScrollView style={{ flex: 1 }}>
        {rows.map((row, index) => {
          const label = row.kind === "browse" ? "folder ⇒" : row.kind === "here" ? "· this folder" : row.label;
          return (
            <ListRow key={`${row.kind}:${row.kind === "dir" ? row.path : ""}`} label={label} selected={index === choice.selected} onPress={() => void choice.choose(index)}>
              <T color={row.kind === "dir" ? "text" : "accent"} lines={1} style={{ flexShrink: 1 }}>
                {label}
              </T>
              {row.kind === "dir" && row.hasChildren ? (
                <Pressable accessibilityLabel={`open ${row.label}`} onPress={() => void choice.open(index)} style={{ paddingHorizontal: 6 }}>
                  <T color="muted">›</T>
                </Pressable>
              ) : null}
              {row.kind === "dir" && row.age !== undefined ? (
                <T color="dim" style={{ marginLeft: "auto" as never, paddingLeft: 8 }}>
                  {row.age}
                </T>
              ) : null}
            </ListRow>
          );
        })}
        {choice.loading() ? <T color="dim">loading…</T> : null}
      </ScrollView>
    </View>
  );
}
