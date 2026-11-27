// The camera reading a QR code (expo-camera: iOS, Android and the browser): its text goes to
// `onText` as soon as one is in sight. The camera is asked for first; refused, it says so.

import { CameraView, useCameraPermissions } from "expo-camera";
import { useRef } from "react";
import { View } from "react-native";
import { Button, T } from "./primitives.tsx";

export function QrScanner({ onText, onClose }: { onText: (text: string) => void; onClose: () => void }) {
  const [permission, ask] = useCameraPermissions();
  const last = useRef<string | undefined>(undefined);
  return permission === null ? (
    <T color="muted">asking for the camera…</T>
  ) : !permission.granted ? (
    <View style={{ gap: 8 }}>
      <T color="muted">{permission.canAskAgain ? "The camera reads the QR code of /hub, add device." : "The camera is not allowed for harness: allow it in the system's settings, or type the code."}</T>
      {permission.canAskAgain ? <Button label="Allow the camera" tone="accent" onPress={() => void ask()} /> : null}
      <Button label="Back" onPress={onClose} />
    </View>
  ) : (
    <View style={{ gap: 8 }}>
      <CameraView
        accessibilityLabel="QR code scanner"
        style={{ width: "100%", aspectRatio: 1 }}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => {
          // the same code is seen many times a second: once is enough
          if (data !== last.current) {
            last.current = data;
            onText(data);
          } else {
            // seen already
          }
        }}
      />
      <Button label="Back" onPress={onClose} />
    </View>
  );
}
