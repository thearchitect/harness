// iOS and Android have no page title, address or drag and drop: attention shows in the app's own
// strips; links open sessions through `harness://` deep links and files come through the share
// sheet and the file picker in the native builds (stage 11).

export function showAttention(_waiting: number): void {
  // the strips' glyphs carry it
}

export function addressedSession(): { node: string; sessionId: string } | undefined {
  return undefined;
}

export function addressSession(_node: string, _sessionId: string): void {
  // no address bar
}

export function onAddressChange(_listener: () => void): () => void {
  return () => undefined;
}

export function onFilesDropped(_element: unknown, _listener: (files: { name: string; base64: string }[]) => void): () => void {
  return () => undefined;
}
