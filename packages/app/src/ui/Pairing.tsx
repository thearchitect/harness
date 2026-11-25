// Pairing this device with a hub (plan A28): the one-time code `harness hub device add` printed
// (its link or QR code fills it in by itself), and on iOS and Android the hub's address.

import { useState } from "react";
import { TextInput, View } from "react-native";
import { ASKS_FOR_URL } from "../connect/endpoint";
import { fontOf, useTheme } from "../theme/theme.tsx";
import { Button, Frame, T } from "./primitives.tsx";

export function Pairing({ error, onPair }: { error: string | undefined; onPair: (code: string, url: string) => void }) {
  const theme = useTheme();
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const input = [fontOf(theme.chrome), { color: theme.colors.text, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 2, padding: 4 }];
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.pageBg, padding: 16 }}>
      <Frame title="Pair this device with your hub" tone="accent" style={{ width: 460, maxWidth: "100%" }}>
        <T color="muted">On the hub: harness hub device add {"<user>"} --name {"<device>"}. Open its link, or enter its code here (once, within ten minutes).</T>
        {ASKS_FOR_URL ? <TextInput accessibilityLabel="Hub address" value={url} onChangeText={setUrl} placeholder="https://hub.example" placeholderTextColor={theme.colors.dim} autoCapitalize="none" style={input} /> : null}
        <TextInput accessibilityLabel="Pairing code" value={code} onChangeText={setCode} placeholder="XXXXX-XXXXX-XXXXX" placeholderTextColor={theme.colors.dim} autoCapitalize="characters" style={input} />
        {error !== undefined ? <T color="error">{error}</T> : null}
        <Button label="Pair" tone="success" disabled={code === "" || (ASKS_FOR_URL && url === "")} onPress={() => onPair(code.trim(), url.trim())} />
      </Frame>
    </View>
  );
}
