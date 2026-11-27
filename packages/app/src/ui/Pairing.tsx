// Pairing this device with a hub: a pairing link or its QR code (the camera reads it, on every
// platform), or the one-time code typed (on iOS and Android with the hub's address). A phone's
// browser that opened a link may hand it to the installed app instead.

import { useState } from "react";
import { Linking, View } from "react-native";
import { ASKS_FOR_URL } from "../connect/endpoint";
import { appPairingLink, parsePairingLink } from "../connect/pairing.ts";
import { useTheme } from "../theme/theme.tsx";
import { LineField } from "./LineField.tsx";
import { Button, Frame, T } from "./primitives.tsx";
import { QrScanner } from "./QrScanner.tsx";

export function Pairing({ error, offered, onPair }: { error: string | undefined; offered?: { code: string; hub: string }; onPair: (code: string, url: string) => void }) {
  const theme = useTheme();
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const [scanning, setScanning] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const ready = code !== "" && (!ASKS_FOR_URL || url !== "");
  // a whole link pasted into a field brings the hub and the code at once
  const take = (text: string, fallback: (text: string) => void): void => {
    const link = parsePairingLink(text);
    if (link !== undefined) {
      onPair(link.code, link.hub);
    } else {
      fallback(text);
    }
  };
  const pair = (): void => {
    if (ASKS_FOR_URL && !/^(https?|wss?):\/\/[^/\s]+/.test(url.trim())) {
      setProblem("the hub's address, like https://hub.example");
    } else {
      setProblem(undefined);
      onPair(code.trim(), url.trim());
    }
  };
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.pageBg, padding: 16 }}>
      <Frame title="Pair this device with your hub" tone="accent" style={{ width: 460, maxWidth: "100%" }}>
        {offered !== undefined ? (
          <View style={{ gap: 8 }}>
            <T color="muted">This link pairs a device with the hub. With the harness app on this phone, let the app take it; or pair this browser.</T>
            <Button label="Open in the app" tone="accent" onPress={() => void Linking.openURL(appPairingLink(offered.hub, offered.code))} />
            <Button label="Pair this browser" tone="success" onPress={() => onPair(offered.code, offered.hub)} />
          </View>
        ) : scanning ? (
          <QrScanner
            onText={(text) => {
              const link = parsePairingLink(text);
              if (link !== undefined) {
                setScanning(false);
                onPair(link.code, link.hub);
              } else {
                setProblem("that QR code is not a pairing link");
              }
            }}
            onClose={() => setScanning(false)}
          />
        ) : (
          <View style={{ gap: 8 }}>
            <T color="muted">In harness: /hub, add device. Scan its QR code, open or paste its link, or type its code (once, within ten minutes).</T>
            <Button label="Scan the QR code" tone="accent" onPress={() => setScanning(true)} />
            {ASKS_FOR_URL ? <LineField label="Hub address" value={url} placeholder="https://hub.example" onChange={(text) => take(text, setUrl)} /> : null}
            <LineField label="Pairing code" value={code} placeholder="XXXXX-XXXXX-XXXXX or the link" onChange={(text) => take(text, setCode)} onSubmit={() => (ready ? pair() : undefined)} />
            <Button label="Pair" tone="success" disabled={!ready} onPress={pair} />
          </View>
        )}
        {problem !== undefined ? <T color="warning">{problem}</T> : error !== undefined ? <T color="error">{error}</T> : null}
      </Frame>
    </View>
  );
}
