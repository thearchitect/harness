// The /hub dialog in the editor's place, the TUI's twin (client/workbench/hub-dialog.ts): the hub's
// network access and devices, adding a device — its QR code (drawn in views), its link whole and
// selectable without padding, copy and a new code. Keys on web: ↑/↓ move, Enter applies, typing
// goes into a field, ← on a row goes back, Esc closes; phones: the Back and Close buttons.

import { useCallback, useEffect, useRef, type ComponentRef } from "react";
import { View } from "react-native";
import type { HubDialog } from "#client/workbench/hub-dialog.ts";
import { useTheme } from "../theme/theme.tsx";
import { LineField } from "./LineField.tsx";
import { Button, ListRow, T } from "./primitives.tsx";
import { focusList, useDialogEscape, useListKeys, useStepKeys } from "./web-events";

/** A color's relative brightness (0–255) from its hex form. */
function brightness(color: string): number {
  const hex = color.replace(/^#/, "");
  const channel = (at: number): number => Number.parseInt(hex.slice(at, at + 2), 16) || 0;
  return 0.299 * channel(0) + 0.587 * channel(2) + 0.114 * channel(4);
}

/**
 * A QR code as a grid of views, a quiet zone of two around: dark modules on light ones, as scanners
 * read them — the theme's text and page colors, the darker of the two for the modules.
 */
export function QrCode({ qr, module = 4 }: { qr: { size: number; modules: string }; module?: number }) {
  const theme = useTheme();
  const { text, pageBg } = theme.colors;
  const [dark, light] = brightness(text) < brightness(pageBg) ? [text, pageBg] : [pageBg, text];
  const rows = Array.from({ length: qr.size }, (_, y) => qr.modules.slice(y * qr.size, (y + 1) * qr.size));
  return (
    <View accessibilityLabel="pairing QR code" style={{ alignSelf: "flex-start", backgroundColor: light, padding: module * 2 }}>
      {rows.map((row, y) => (
        <View key={y} style={{ flexDirection: "row" }}>
          {[...row].map((bit, x) => (
            <View key={x} style={{ width: module, height: module, backgroundColor: bit === "1" ? dark : light }} />
          ))}
        </View>
      ))}
    </View>
  );
}

export function HubDialogBlock({ dialog }: { dialog: HubDialog }) {
  const ref = useRef<ComponentRef<typeof View>>(null);
  const label = `hub ${dialog.hub}`;
  useListKeys(ref, () => dialog.close());
  useStepKeys(ref, () => dialog.back());
  useDialogEscape(useCallback(() => dialog.close(), [dialog]));
  useEffect(() => {
    focusList(label);
  }, [dialog.screen.kind]);

  const screen = dialog.screen;
  const state = dialog.pairingState();
  const rows = dialog.rows();
  const firstDevice = rows.findIndex((row) => row.kind === "device");
  return (
    <View ref={ref} accessibilityLabel={label} style={{ gap: 2 }}>
      <T color="accent" bold>
        {dialog.title()}
      </T>
      {screen.kind === "pairing" ? (
        state?.kind === "open" ? (
          <View style={{ gap: 4 }}>
            {screen.pairing.qr !== undefined ? <QrCode qr={screen.pairing.qr} /> : null}
            {screen.pairing.link !== undefined ? (
              <T color="accent" selectable>
                {screen.pairing.link}
              </T>
            ) : (
              <T color="warning">no link: the hub has no address for links yet (main screen, address for links)</T>
            )}
            <T selectable>{`code ${screen.pairing.code}`}</T>
            <T color="muted">{`valid until ${state.until}, once`}</T>
          </View>
        ) : state?.kind === "used" ? (
          <T color="success">{`used: ${state.device}`}</T>
        ) : (
          <T color="warning">expired: make a new code</T>
        )
      ) : dialog.status === undefined && dialog.error === undefined ? (
        <T color="muted">reading the hub…</T>
      ) : null}
      {rows.map((row, index) => {
        const heading = index === firstDevice ? <T key={`h${index}`} color="muted">devices</T> : null;
        const select = (): void => {
          dialog.selected = index;
          void dialog.enter();
        };
        switch (row.kind) {
          case "field":
            return (
              <View key={`${screen.kind}:${row.id}`}>
                {heading}
                <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                  <T color="muted">{`${row.label}:`}</T>
                  {row.locked ? (
                    <T>{row.value !== "" ? row.value : "—"}</T>
                  ) : (
                    <LineField
                      label={row.label}
                      value={row.value}
                      onChange={(text) => {
                        dialog.selected = index;
                        dialog.type(text);
                      }}
                      onSubmit={() => {
                        dialog.selected = index;
                        void dialog.enter();
                      }}
                      onEscape={() => dialog.close()}
                    />
                  )}
                </View>
              </View>
            );
          case "network":
            return (
              <ListRow key="network" label={row.label} selected={index === dialog.selected} onPress={select}>
                <T color={row.on ? "success" : "text"}>{row.label}</T>
              </ListRow>
            );
          case "toggle":
            return (
              <ListRow key={row.id} label={row.label} selected={index === dialog.selected} onPress={select}>
                <T>{`${row.label}: `}</T>
                <T color={row.on ? "success" : "muted"}>{row.on ? "on" : "off"}</T>
              </ListRow>
            );
          case "device":
            return (
              <View key={`device ${row.name}`}>
                {heading}
                <ListRow label={`device ${row.name}`} selected={index === dialog.selected} onPress={select}>
                  <T color={row.connected ? "success" : "text"}>{`${row.connected ? "● " : ""}${row.name}`}</T>
                  <T color="muted">{` ${row.detail}`}</T>
                </ListRow>
              </View>
            );
          case "action":
            return (
              <ListRow key={row.id} label={row.label} selected={index === dialog.selected} onPress={select}>
                <T color={row.id === "revoke" ? "error" : "text"}>{row.label}</T>
              </ListRow>
            );
          default:
            throw new Error(`unknown row: ${JSON.stringify(row satisfies never)}`);
        }
      })}
      {dialog.error !== undefined ? <T color="error">{dialog.error}</T> : null}
      <View style={{ flexDirection: "row", gap: 6 }}>
        {screen.kind !== "main" ? <Button label="Back" onPress={() => dialog.back()} /> : null}
        <Button label="Close" onPress={() => dialog.close()} />
      </View>
      <T color="dim">{dialog.hint()}</T>
    </View>
  );
}
