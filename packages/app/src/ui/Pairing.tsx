// Pairing this device with a hub (plan A28): the token `harness hub device add` printed (or its QR
// code's link, which fills it in), and on iOS and Android the hub's address.

import { useState } from "react";
import { TextInput, View } from "react-native";
import { ASKS_FOR_URL } from "../connect/endpoint";
import { fontOf, useTheme } from "../theme/theme.tsx";
import { Button, Frame, T } from "./primitives.tsx";

export function Pairing({ error, onPair }: { error: string | undefined; onPair: (token: string, url: string) => void }) {
  const theme = useTheme();
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const input = [fontOf(theme.chrome), { color: theme.colors.text, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 2, padding: 4 }];
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.pageBg, padding: 16 }}>
      <Frame title="Pair this device with your hub" tone="accent" style={{ width: 460, maxWidth: "100%" }}>
        <T color="muted">On the hub: harness hub device add {"<user>"} --name {"<device>"}. Open its link, or paste its token here.</T>
        {ASKS_FOR_URL ? <TextInput accessibilityLabel="Hub address" value={url} onChangeText={setUrl} placeholder="https://hub.example" placeholderTextColor={theme.colors.dim} autoCapitalize="none" style={input} /> : null}
        <TextInput accessibilityLabel="Device token" value={token} onChangeText={setToken} placeholder="device token" placeholderTextColor={theme.colors.dim} autoCapitalize="none" secureTextEntry style={input} />
        {error !== undefined ? <T color="error">{error}</T> : null}
        <Button label="Pair" tone="success" disabled={token === "" || (ASKS_FOR_URL && url === "")} onPress={() => onPair(token.trim(), url.trim())} />
      </Frame>
    </View>
  );
}
