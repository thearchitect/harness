// What iOS and Android add to the shared screen (plan 10.1, native details): files go out through
// the system's share sheet and come in from the photo library or the document picker; voice is
// recorded with the microphone; `harness://<hub>/<session>[/<item>]` links open a session. No
// page title, drag and drop or pasted files: attention shows in the strips' glyphs.

import { AudioModule, RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync } from "expo-audio";
import * as DocumentPicker from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import * as Linking from "expo-linking";
import * as Sharing from "expo-sharing";
import { Alert } from "react-native";
import { windowState, type ViewStateStore } from "#client/workbench/view-state.ts";

/** The window's state (view-state.ts): a file of the app's documents, this device's own. */
export function viewStore(): ViewStateStore {
  const file = new File(Paths.document, "window-state.json");
  return {
    load: async () => (file.exists ? windowState(JSON.parse(await file.text())) : undefined),
    save: async (state) => {
      if (!file.exists) {
        file.create();
      } else {
        // written over
      }
      await file.write(JSON.stringify(state));
    },
  };
}

export function showAttention(_waiting: number, _colors: { waiting: string; idle: string }): void {
  // the strips' glyphs carry it
}

/** System notifications are push notifications on iOS and Android: the README's TODO (plan A27). */
export const NOTIFICATIONS_SUPPORTED = false;

export async function requestNotifications(): Promise<boolean> {
  return false;
}

export function notifyOperator(_title: string, _body: string): void {
  // no notifications while the app is in the background yet
}

/** A file from the session's node: written to the app's cache, offered through the share sheet (save, send, open). */
export function saveFile(name: string, base64: string): void {
  const file = new File(Paths.cache, name.replace(/[/\\]/g, "_"));
  if (file.exists) {
    file.delete();
  } else {
    // a new file
  }
  file.create();
  file.write(base64, { encoding: "base64" });
  void Sharing.shareAsync(file.uri, { dialogTitle: name });
}

async function readAsset(uri: string, name: string): Promise<{ name: string; base64: string }> {
  return { name, base64: await new File(uri).base64() };
}

/** Photos from the library or documents from the picker, as the user chooses. */
export function pickFiles(): Promise<{ name: string; base64: string }[]> {
  return new Promise((resolve, reject) => {
    const photos = async (): Promise<void> => {
      const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images", "videos"], allowsMultipleSelection: true, quality: 1 });
      resolve(picked.canceled ? [] : await Promise.all(picked.assets.map((asset, index) => readAsset(asset.uri, asset.fileName ?? `photo-${index + 1}.${asset.mimeType?.split("/")[1] ?? "jpg"}`))));
    };
    const documents = async (): Promise<void> => {
      const picked = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
      resolve(picked.canceled ? [] : await Promise.all(picked.assets.map((asset) => readAsset(asset.uri, asset.name))));
    };
    Alert.alert("Attach", undefined, [
      { text: "Photos", onPress: () => void photos().catch(reject) },
      { text: "Files", onPress: () => void documents().catch(reject) },
      { text: "Cancel", style: "cancel", onPress: () => resolve([]) },
    ]);
  });
}

export const VOICE_SUPPORTED = true;

/** Records the microphone (m4a); the returned stop gives the recording. */
export async function recordVoice(): Promise<() => Promise<{ base64: string; mime: string }>> {
  const permission = await requestRecordingPermissionsAsync();
  if (!permission.granted) {
    throw new Error("the microphone is not allowed (the system's settings)");
  } else {
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    const recorder = new AudioModule.AudioRecorder(RecordingPresets.HIGH_QUALITY);
    await recorder.prepareToRecordAsync();
    recorder.record();
    return async () => {
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false });
      if (recorder.uri === null) {
        throw new Error("nothing was recorded");
      } else {
        return { base64: await new File(recorder.uri).base64(), mime: "audio/mp4" };
      }
    };
  }
}

/** The session the last `harness://` link named. */
let linked: { node: string; sessionId: string; item?: string } | undefined;

function parseLink(url: string | null): { node: string; sessionId: string; item?: string } | undefined {
  const parsed = url !== null ? Linking.parse(url) : undefined;
  const parts = [parsed?.hostname, ...(parsed?.path ?? "").split("/")].filter((part): part is string => part !== undefined && part !== null && part !== "");
  return parts.length >= 2 ? { node: parts[0] ?? "", sessionId: parts[1] ?? "", ...(parts[2] !== undefined ? { item: parts[2] } : {}) } : undefined;
}

export function addressedSession(): { node: string; sessionId: string; item?: string } | undefined {
  return linked;
}

export function addressSession(_node: string, _sessionId: string, _item?: string): void {
  // no address bar
}

/** A `harness://` link opened the app (or reached it while open): the listener opens its session. */
export function onAddressChange(listener: () => void): () => void {
  void Linking.getInitialURL().then((url) => {
    linked = parseLink(url);
    listener();
  });
  const subscription = Linking.addEventListener("url", ({ url }) => {
    linked = parseLink(url);
    listener();
  });
  return () => subscription.remove();
}

export function onFilesPasted(_listener: (files: { name: string; base64: string }[]) => void): () => void {
  return () => undefined; // the system's paste gives text only
}

export function onFilesDropped(_element: unknown, _listener: (files: { name: string; base64: string }[]) => void): () => void {
  return () => undefined;
}
