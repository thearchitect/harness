// The editor's zone (plan A25): the editor, or in its place an interaction or a list to choose from.
// Above it, on the editor's width: the queue and the completions of `/commands` and `@files`.

import { useState, type ReactNode } from "react";
import { Pressable, TextInput, View, type TextInputKeyPressEvent } from "react-native";
import { pickerHints, type EditorZone as Zone, type KeyHint, type Picker, type Zones } from "#client/workbench/workbench.ts";
import type { BridgedComponent } from "#protocol/hap.ts";
import { MODE_COLOR_HEX } from "#protocol/modes.ts";
import { fontOf, useTheme } from "../theme/theme.tsx";
import { InteractionBlock } from "./Interactions.tsx";
import { HubDialogBlock } from "./HubDialog.tsx";
import type { DeviceActions } from "./Shell.tsx";
import { Button, Frame, ListRow, T } from "./primitives.tsx";

export type Completion = { value: string; label: string; description?: string };

/** A key press; on web it carries the modifiers. */
type KeyEvent = TextInputKeyPressEvent & { nativeEvent: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean } };

/** A hint line as the TUI draws it: each key dim, what it does muted. */
export function HintLine({ hints }: { hints: KeyHint[] }) {
  return (
    <T lines={1}>
      {hints.map((hint, index) => (
        <T key={hint.key}>
          {index > 0 ? <T color="dim"> · </T> : null}
          <T color="dim">{hint.key}</T>
          <T color="muted">{` ${hint.does}`}</T>
        </T>
      ))}
    </T>
  );
}

/**
 * A list in the editor's place, as the TUI shows it: the scopes (Favorites | All) switched with Tab
 * or a click, the filter field, ↑/↓ moving the selection, Enter choosing, Esc cancelling, the hint line.
 */
function PickerBlock({ picker, onClose, onScope }: { picker: Picker; onClose: () => void; onScope: () => void }) {
  const theme = useTheme();
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(Math.max(0, picker.items.findIndex((item) => item.value === picker.initial)));
  const words = filter.toLowerCase().split(/\s+/).filter((word) => word !== "");
  const matching = picker.items.filter((item) => words.every((word) => `${item.label} ${item.description ?? ""}`.toLowerCase().includes(word)));
  // a list that takes typed values offers the text itself first
  const typed = filter.trim();
  const items = picker.custom !== undefined && typed !== "" && !matching.some((item) => item.value === typed) ? [{ value: typed, label: typed, description: picker.custom }, ...matching] : matching;
  const index = Math.min(selected, Math.max(0, items.length - 1));
  const scopes = picker.scopes !== undefined && picker.scopes.length > 1 ? picker.scopes : undefined;
  const onKeyPress = (event: KeyEvent): void => {
    const key = event.nativeEvent.key;
    if (key === "Escape") {
      onClose();
    } else if (key === "Tab" && scopes !== undefined) {
      event.preventDefault();
      setSelected(0);
      onScope();
    } else if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      setSelected(items.length === 0 ? 0 : (index + (key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
    } else {
      // typing filters
    }
  };
  return (
    <Frame title={picker.title} tone="accent">
      {scopes !== undefined ? (
        <View accessibilityRole="tablist" style={{ flexDirection: "row", gap: 4 }}>
          <T color="muted">Scope:</T>
          {scopes.map((scope, scopeIndex) => (
            <Pressable key={scope.title} accessibilityRole="tab" accessibilityState={{ selected: scopeIndex === (picker.scope ?? 0) }} onPress={() => (scopeIndex === (picker.scope ?? 0) ? undefined : onScope())}>
              <T color={scopeIndex === (picker.scope ?? 0) ? "accent" : "muted"}>{scope.title}</T>
            </Pressable>
          ))}
        </View>
      ) : null}
      <TextInput
        accessibilityLabel={`Filter ${picker.title}`}
        autoFocus
        value={filter}
        onChangeText={(text) => {
          setFilter(text);
          setSelected(0);
        }}
        onSubmitEditing={() => (items[index] !== undefined ? void picker.choose(items[index].value) : undefined)}
        onKeyPress={onKeyPress}
        placeholder={picker.custom !== undefined ? `filter, or type ${picker.custom}` : "filter"}
        placeholderTextColor={theme.colors.dim}
        style={[fontOf(theme.chrome), { color: theme.colors.text, borderBottomWidth: 1, borderColor: theme.colors.borderMuted, padding: 2 }]}
      />
      <View accessibilityRole="list" style={{ maxHeight: 320, overflow: "scroll" as never }}>
        {items.slice(0, 200).map((item, itemIndex) => (
          <ListRow key={item.value} label={item.label} selected={itemIndex === index} onPress={() => void picker.choose(item.value)}>
            <T lines={1} style={{ flexShrink: 1 }}>
              {item.label}
            </T>
            {item.description !== undefined ? (
              <T color="dim" lines={1} style={{ marginLeft: 12, flexShrink: 2 }}>
                {item.description}
              </T>
            ) : null}
          </ListRow>
        ))}
      </View>
      <HintLine hints={pickerHints(picker)} />
    </Frame>
  );
}

function Editor(props: {
  text: string;
  onText: (text: string) => void;
  onSubmit: () => void;
  mode: keyof typeof MODE_COLOR_HEX;
  completions: Completion[];
  onComplete: (completion: Completion) => void;
  placeholder: string;
  device: DeviceActions;
}) {
  const theme = useTheme();
  const onKeyPress = (event: KeyEvent): void => {
    const key = event.nativeEvent;
    if (key.key === "Enter" && (key.ctrlKey === true || key.metaKey === true || key.altKey === true)) {
      event.preventDefault();
      props.onSubmit();
    } else if (key.key === "Tab" && props.completions[0] !== undefined) {
      event.preventDefault();
      props.onComplete(props.completions[0]);
    } else {
      // typing
    }
  };
  return (
    <View style={{ gap: 2 }}>
      {props.completions.length > 0 ? (
        <View accessibilityRole="list" accessibilityLabel="completions" style={{ borderWidth: 1, borderColor: theme.colors.borderMuted, maxHeight: 200, overflow: "scroll" as never }}>
          {props.completions.slice(0, 50).map((completion) => (
            <ListRow key={completion.value} label={completion.label} onPress={() => props.onComplete(completion)}>
              <T lines={1}>{completion.label}</T>
              {completion.description !== undefined ? (
                <T color="dim" lines={1} style={{ marginLeft: 12, flexShrink: 1 }}>
                  {completion.description}
                </T>
              ) : null}
            </ListRow>
          ))}
        </View>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 6, borderWidth: 1, borderRadius: 2, borderColor: MODE_COLOR_HEX[props.mode], paddingVertical: 4 }}>
        <TextInput
          accessibilityLabel="Message"
          testID="message"
          autoFocus
          multiline
          value={props.text}
          onChangeText={props.onText}
          onKeyPress={onKeyPress}
          placeholder={props.placeholder}
          placeholderTextColor={theme.colors.dim}
          style={[fontOf(theme.chat), { flex: 1, color: theme.colors.text, minHeight: 40, maxHeight: 240, outlineStyle: "none" as never }]}
        />
        <Pressable accessibilityRole="button" accessibilityLabel="Attach files" onPress={props.device.attach} style={{ paddingHorizontal: 4 }}>
          <T color="muted">+</T>
        </Pressable>
        {props.device.voice !== undefined ? (
          <Pressable accessibilityRole="button" accessibilityLabel={props.device.recording ? "Stop recording" : "Record a voice message"} onPress={props.device.voice} style={{ paddingHorizontal: 4 }}>
            <T color={props.device.recording ? "error" : "muted"}>{props.device.recording ? "■" : "●"}</T>
          </Pressable>
        ) : null}
        <Pressable accessibilityRole="button" accessibilityLabel="Send" onPress={props.onSubmit} style={{ paddingHorizontal: 6 }}>
          <T color="accent">⏎</T>
        </Pressable>
      </View>
    </View>
  );
}

export function EditorZoneView(props: {
  zone: Zone;
  aboveEditor: Zones["aboveEditor"];
  text: string;
  onText: (text: string) => void;
  onSubmit: () => void;
  completions: Completion[];
  onComplete: (completion: Completion) => void;
  onAnswer: (interactionId: string, value: unknown) => void;
  /** A short word in the status line (copied, …). */
  onNotify: (message: string) => void;
  onClosePicker: () => void;
  onPickerScope: () => void;
  /** An extension's component in the editor's place (ComponentView). */
  component: (component: BridgedComponent) => ReactNode;
  placeholder: string;
  device: DeviceActions;
}) {
  const zone = props.zone;
  return (
    <View style={{ gap: 4 }}>
      {props.aboveEditor.queue.map((queued, index) => (
        <T key={index} color="dim" lines={1}>{`${queued.kind === "steer" ? "steer" : "next"} › ${queued.text}`}</T>
      ))}
      {props.aboveEditor.widgets.map((line, index) => (
        <T key={`w${index}`} color="muted" lines={1}>
          {line}
        </T>
      ))}
      {(() => {
        switch (zone.kind) {
          case "editor":
            return <Editor text={props.text} onText={props.onText} onSubmit={props.onSubmit} mode={zone.mode} completions={props.completions} onComplete={props.onComplete} placeholder={props.placeholder} device={props.device} />;
          case "interaction":
            return <InteractionBlock request={zone.request} from={zone.from} answer={(value) => props.onAnswer(zone.request.id, value)} notify={props.onNotify} />;
          case "picker":
            return <PickerBlock key={zone.picker.id} picker={zone.picker} onClose={props.onClosePicker} onScope={props.onPickerScope} />;
          case "hint":
            return (
              <T color="dim" lines={1}>
                {zone.hints.map((hint) => `${hint.key} ${hint.does}`).join(" · ")}
              </T>
            );
          case "component":
            return props.component(zone.component);
          case "hub":
            return <HubDialogBlock dialog={zone.dialog} />;
          default:
            throw new Error(`unknown editor zone: ${JSON.stringify(zone satisfies never)}`);
        }
      })()}
    </View>
  );
}
