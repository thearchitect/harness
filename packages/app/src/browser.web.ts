// What a browser adds to the shared screen (plan 10.1, web details): the page's title and icon carry
// the number of sessions that wait for the operator; the address names the active session
// (`#/<node>/<session>`) so it can be bookmarked and back/forward move between sessions; files
// dropped on the editor go to the session's machine and into the message as `@path`.

/** `◆ 2 · harness` while two sessions wait; the icon carries the same glyph. */
export function showAttention(waiting: number): void {
  document.title = waiting > 0 ? `◆ ${waiting} · harness` : "harness";
  const glyph = waiting > 0 ? "◆" : "›";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><text x="8" y="13" font-size="14" text-anchor="middle" fill="${waiting > 0 ? "orange" : "gray"}">${glyph}</text></svg>`;
  let link = document.querySelector<HTMLLinkElement>("link[rel=icon]");
  if (link === null) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  } else {
    // the page's icon
  }
  link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export const NOTIFICATIONS_SUPPORTED = typeof Notification !== "undefined";

export async function requestNotifications(): Promise<boolean> {
  return NOTIFICATIONS_SUPPORTED && (Notification.permission === "granted" || (await Notification.requestPermission()) === "granted");
}

/** A system notification while this window is not in front; clicking it brings the window back. */
export function notifyOperator(title: string, body: string): void {
  if (NOTIFICATIONS_SUPPORTED && Notification.permission === "granted" && document.visibilityState !== "visible") {
    const shown = new Notification(title, { body, tag: "harness-waiting" });
    shown.onclick = () => window.focus();
  } else {
    // in front, or not allowed
  }
}

/** The session the address names, if any. */
export function addressedSession(): { node: string; sessionId: string } | undefined {
  const match = /^#\/([^/]+)\/([^/]+)$/.exec(window.location.hash);
  return match !== null ? { node: decodeURIComponent(match[1] ?? ""), sessionId: decodeURIComponent(match[2] ?? "") } : undefined;
}

/** The address follows the active session; a new one is a history step (back returns to the previous session). */
export function addressSession(node: string, sessionId: string): void {
  const hash = `#/${encodeURIComponent(node)}/${encodeURIComponent(sessionId)}`;
  if (window.location.hash !== hash) {
    window.history.pushState(null, "", hash);
  } else {
    // already there
  }
}

export function onAddressChange(listener: () => void): () => void {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
}

async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/** A file from the session's node, saved by the browser. */
export function saveFile(name: string, base64: string): void {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes]));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Files the user picks (the system's file chooser), as base64 with their names. */
export function pickFiles(): Promise<{ name: string; base64: string }[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = () => void Promise.all([...(input.files ?? [])].map(async (file) => ({ name: file.name, base64: await base64Of(file) }))).then(resolve);
    input.click();
  });
}

export const VOICE_SUPPORTED = typeof MediaRecorder !== "undefined" && navigator.mediaDevices !== undefined;

/** Starts recording the microphone; the returned stop gives the recording. */
export async function recordVoice(): Promise<() => Promise<{ base64: string; mime: string }>> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => chunks.push(event.data);
  recorder.start();
  return () =>
    new Promise((resolve) => {
      recorder.onstop = () => {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        const blob = new Blob(chunks, { type: recorder.mimeType });
        void base64Of(blob).then((base64) => resolve({ base64, mime: recorder.mimeType }));
      };
      recorder.stop();
    });
}

/** Files dropped on `element`, as base64 with their names. */
export function onFilesDropped(element: unknown, listener: (files: { name: string; base64: string }[]) => void): () => void {
  const target = element as HTMLElement | null;
  if (target === null || typeof target.addEventListener !== "function") {
    return () => undefined;
  } else {
    const over = (event: DragEvent): void => {
      if (event.dataTransfer?.types.includes("Files") === true) {
        event.preventDefault();
      } else {
        // not files
      }
    };
    const drop = (event: DragEvent): void => {
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length > 0) {
        event.preventDefault();
        void Promise.all(files.map(async (file) => ({ name: file.name, base64: await base64Of(file) }))).then(listener);
      } else {
        // a drop of text: the field takes it
      }
    };
    target.addEventListener("dragover", over);
    target.addEventListener("drop", drop);
    return () => {
      target.removeEventListener("dragover", over);
      target.removeEventListener("drop", drop);
    };
  }
}
