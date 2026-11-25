// iOS and Android have no page title, address or drag and drop: attention shows in the app's own
// strips; links open sessions through `harness://` deep links and files come through the share
// sheet and the file picker in the native builds (stage 11).

export function showAttention(_waiting: number): void {
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

/** Files to the device: the share sheet in the native builds (stage 11). */
export function saveFile(_name: string, _base64: string): void {
  throw new Error("saving files on this device comes with the native builds");
}

/** The document and photo pickers come with the native builds (stage 11). */
export function pickFiles(): Promise<{ name: string; base64: string }[]> {
  return Promise.reject(new Error("picking files on this device comes with the native builds"));
}

export const VOICE_SUPPORTED = false;

export function recordVoice(): Promise<() => Promise<{ base64: string; mime: string }>> {
  return Promise.reject(new Error("voice input on this device comes with the native builds"));
}

export function addressedSession(): { node: string; sessionId: string; item?: string } | undefined {
  return undefined;
}

export function addressSession(_node: string, _sessionId: string, _item?: string): void {
  // no address bar
}

export function onAddressChange(_listener: () => void): () => void {
  return () => undefined;
}

export function onFilesPasted(_listener: (files: { name: string; base64: string }[]) => void): () => void {
  return () => undefined; // the system's paste gives text only
}

export function onFilesDropped(_element: unknown, _listener: (files: { name: string; base64: string }[]) => void): () => void {
  return () => undefined;
}
