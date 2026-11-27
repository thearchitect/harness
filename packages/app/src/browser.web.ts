// What a browser adds to the shared screen (plan 10.1, web details): the page's title and icon carry
// the number of sessions that wait for the operator; the address names the active session
// (`#/<hub>/<session>`) so it can be bookmarked and back/forward move between sessions; files
// dropped on the editor go to the session's machine and into the message as `@path`.

import { windowState, type ViewStateStore } from "#client/workbench/view-state.ts";
import type { LogStore } from "#client/model/client-log.ts";
import { maskSecrets } from "#protocol/log.ts";

/** The browser's IndexedDB of the log: one store of records, by time. */
function logDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("harness-log", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("records", { autoIncrement: true }).createIndex("at", "at");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB would not open"));
  });
}

/** The app's own log (client-log.ts): this browser's IndexedDB, days past the retention removed. */
export function logStore(): LogStore {
  const database = typeof indexedDB !== "undefined" ? logDatabase().catch(() => undefined) : Promise.resolve(undefined);
  return {
    append: async (records) => {
      const db = await database;
      if (db !== undefined) {
        const store = db.transaction("records", "readwrite").objectStore("records");
        for (const record of records) {
          store.add(maskSecrets(record));
        }
      } else {
        // no IndexedDB here (a private window): the hub keeps the log
      }
    },
    sweep: async (days) => {
      const db = await database;
      if (db !== undefined) {
        const oldest = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
        db.transaction("records", "readwrite").objectStore("records").index("at").openCursor(IDBKeyRange.upperBound(oldest, true)).onsuccess = function () {
          const cursor = this.result;
          if (cursor !== null) {
            cursor.delete();
            cursor.continue();
          } else {
            // swept
          }
        };
      } else {
        // nothing kept here
      }
    },
  };
}

/** The window's state (view-state.ts): this browser's localStorage. */
export function viewStore(): ViewStateStore {
  const key = "harness.window-state";
  return {
    load: async () => {
      const stored = localStorage.getItem(key);
      return stored !== null ? windowState(JSON.parse(stored)) : undefined;
    },
    save: async (state) => localStorage.setItem(key, JSON.stringify(state)),
  };
}

/** `◆ 2 · harness` while two sessions wait; the icon carries the same glyph in the theme's color. */
export function showAttention(waiting: number, colors: { waiting: string; idle: string }): void {
  document.title = waiting > 0 ? `◆ ${waiting} · harness` : "harness";
  const glyph = waiting > 0 ? "◆" : "›";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><text x="8" y="13" font-size="14" text-anchor="middle" fill="${waiting > 0 ? colors.waiting : colors.idle}">${glyph}</text></svg>`;
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
    // one notification per kind: a newer one replaces the older
    const shown = new Notification(title, { body, tag: title });
    shown.onclick = () => window.focus();
  } else {
    // in front, or not allowed
  }
}

/** The session the address names, if any. */
export function addressedSession(): { node: string; sessionId: string; item?: string } | undefined {
  const match = /^#\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/.exec(window.location.hash);
  return match !== null
    ? { node: decodeURIComponent(match[1] ?? ""), sessionId: decodeURIComponent(match[2] ?? ""), ...(match[3] !== undefined ? { item: decodeURIComponent(match[3]) } : {}) }
    : undefined;
}

/** The address follows the active session and its item; a change is a history step (back returns to the previous one). */
export function addressSession(node: string, sessionId: string, item?: string): void {
  const hash = `#/${encodeURIComponent(node)}/${encodeURIComponent(sessionId)}${item !== undefined && item !== "session" ? `/${encodeURIComponent(item)}` : ""}`;
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

/** A file from the session's hub, saved by the browser. */
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

/** Images and files pasted anywhere in the page (text pastes stay the field's). */
export function onFilesPasted(listener: (files: { name: string; base64: string }[]) => void): () => void {
  const paste = (event: ClipboardEvent): void => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.length > 0) {
      event.preventDefault();
      void Promise.all(files.map(async (file, index) => ({ name: file.name !== "" && file.name !== "image.png" ? file.name : `pasted-${index + 1}.${file.type.split("/")[1] ?? "bin"}`, base64: await base64Of(file) }))).then(listener);
    } else {
      // text: the field takes it
    }
  };
  document.addEventListener("paste", paste);
  return () => document.removeEventListener("paste", paste);
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
