// A provider's login step in the editor's place, the TUI's twin (plan polish-3 C): the step's text
// without padding (the sign-in link selectable whole, pressable), then its rows
// (client/workbench/login.ts): open in browser, copy, a choice's options, the field (LineField).
// Keys on web: ↑/↓ move and leave the field, Enter applies, typing goes to the field, ← on a row goes
// back, Esc cancels; phones: the Back button.

import * as Clipboard from "expo-clipboard";
import { useEffect, useRef, useState, type ComponentRef } from "react";
import { Linking, View } from "react-native";
import { loginHints, loginInitialRow, loginRows } from "#client/workbench/login.ts";
import type { InteractionRequest, LoginAnswer } from "#protocol/interactions.ts";
import { LineField } from "./LineField.tsx";
import { Button, ListRow, T } from "./primitives.tsx";
import { focusList, useListKeys, useStepKeys } from "./web-events";

export function Login({ request, answer, notify }: { request: Extract<InteractionRequest, { kind: "login" }>; answer: (value: LoginAnswer) => void; notify: (message: string) => void }) {
  const payload = request.payload;
  const rows = loginRows(payload);
  const [value, setValue] = useState("");
  const ref = useRef<ComponentRef<typeof View>>(null);
  const label = `login ${request.id}`;
  useListKeys(ref, () => answer({ cancelled: true }));
  useStepKeys(ref, () => answer({ back: true }));
  useEffect(() => {
    focusList(label);
  }, [request.id]);

  const initial = loginInitialRow(rows);
  return (
    <View ref={ref} accessibilityLabel={label} style={{ gap: 2 }}>
      <T color="accent" bold>
        {payload.title}
      </T>
      {payload.url !== undefined ? (
        <T color="accent" selectable>
          {payload.url}
        </T>
      ) : null}
      {payload.instructions !== undefined ? <T color="warning">{payload.instructions}</T> : null}
      {payload.deviceCode !== undefined ? (
        <T color="warning" selectable>{`${payload.deviceCode.uri} · code ${payload.deviceCode.code}`}</T>
      ) : null}
      {payload.progress.map((line, index) => (
        <T key={index} color="muted">
          {line}
        </T>
      ))}
      {payload.prompt !== undefined ? <T>{payload.prompt.message}</T> : null}
      {rows.map((row, index) => {
        switch (row.kind) {
          case "open":
            return (
              <ListRow key={index} label={row.label} selected={index === initial} onPress={() => void Linking.openURL(row.url)}>
                <T>{row.label}</T>
              </ListRow>
            );
          case "copy":
            return (
              <ListRow key={index} label={row.label} selected={index === initial} onPress={() => void Clipboard.setStringAsync(row.text).then(() => notify(`copied: ${row.label.replace(/^copy /, "")}`))}>
                <T>{row.label}</T>
              </ListRow>
            );
          case "option":
            return (
              <ListRow key={index} label={row.label} selected={index === initial} onPress={() => answer({ option: row.id })}>
                <T>{row.label}</T>
                {row.description !== undefined ? <T color="muted">{` ${row.description}`}</T> : null}
              </ListRow>
            );
          case "field":
            return (
              <View key={index} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <T>{">"}</T>
                <LineField
                  label="login field"
                  value={value}
                  secure={row.secret}
                  {...(row.placeholder !== undefined ? { placeholder: row.placeholder } : {})}
                  onChange={setValue}
                  onSubmit={(text) => (text.trim() !== "" ? answer({ value: text }) : undefined)}
                  onEscape={() => answer({ cancelled: true })}
                />
              </View>
            );
          default:
            throw new Error(`unknown login row: ${JSON.stringify(row satisfies never)}`);
        }
      })}
      <View style={{ flexDirection: "row", gap: 6 }}>
        <Button label="Back" onPress={() => answer({ back: true })} />
        <Button label="Cancel" onPress={() => answer({ cancelled: true })} />
      </View>
      <T color="dim">{loginHints(rows).map((hint) => `${hint.key} ${hint.does}`).join(" · ")}</T>
    </View>
  );
}
