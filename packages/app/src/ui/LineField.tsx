// The app's single-line input, the TUI's LineField's twin (plan polish-3 B): one line, no padding,
// the platform's own cursor and arrows. While it has the focus, a value from outside (another client)
// does not overwrite what is typed. In a list it is a row: ↑/↓ leave it for the rows around it
// (web-events: data-list-row).

import { useEffect, useRef, useState } from "react";
import { TextInput } from "react-native";
import { fontOf, useTheme } from "../theme/theme.tsx";

export function LineField(props: {
  label: string;
  value: string;
  placeholder?: string;
  /** Drawn as bullets (secrets). */
  secure?: boolean;
  autoFocus?: boolean;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  onBlur?: () => void;
  onEscape?: () => void;
}) {
  const theme = useTheme();
  const [draft, setDraft] = useState(props.value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setDraft(props.value);
    } else {
      // typing here: the field's own text stands
    }
  }, [props.value]);

  return (
    <TextInput
      accessibilityLabel={props.label}
      // react-native-web turns dataSet into data-* attributes; native ignores it
      {...({ dataSet: { listRow: "field" } } as object)}
      value={draft}
      placeholder={props.placeholder}
      placeholderTextColor={theme.colors.dim}
      secureTextEntry={props.secure === true}
      autoFocus={props.autoFocus === true}
      autoCapitalize="none"
      autoCorrect={false}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        props.onBlur?.();
      }}
      onChangeText={(text) => {
        setDraft(text);
        props.onChange(text);
      }}
      onSubmitEditing={() => props.onSubmit?.(draft)}
      onKeyPress={(event) => (event.nativeEvent.key === "Escape" ? props.onEscape?.() : undefined)}
      style={[fontOf(theme.chrome), { flex: 1, color: theme.colors.text, padding: 0, margin: 0, borderBottomWidth: 1, borderColor: theme.colors.borderMuted, outlineStyle: "none" as never }]}
    />
  );
}
