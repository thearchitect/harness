// The app: pairs with a hub (or takes the local token of `harness web-app`), connects, and draws the
// workbench — the same model, zones and actions as the TUI — in the user's theme and fonts.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, useWindowDimensions, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { NodeConnection } from "#client/connection.ts";
import type { AgentModel } from "#client/model/agent-model.ts";
import { ClientModel } from "#client/model/client-model.ts";
import { Workbench, type Screen } from "#client/workbench/workbench.ts";
import { wsTransport } from "#client/ws-transport.ts";
import type { ActionId } from "#client/keymap.ts";
import { modeOfText } from "#protocol/modes.ts";
// platform modules (`*.web.ts` next to the native one) are imported without an extension: Metro picks the file
import { forgetDevice, readEndpoint, saveDevice, type Endpoint } from "./connect/endpoint";
import { listenKeys } from "./keyboard";
import {
  addressedSession,
  addressSession,
  notifyOperator,
  NOTIFICATIONS_SUPPORTED,
  onAddressChange,
  onFilesDropped,
  onFilesPasted,
  pickFiles,
  recordVoice,
  requestNotifications,
  saveFile,
  showAttention,
  VOICE_SUPPORTED,
} from "./browser";
import { appSettings } from "./settings.ts";
import { loadFonts } from "./theme/fonts";
import { charWidth, DEFAULT_THEME, ThemeContext, zoneOf, type Colors, type Theme } from "./theme/theme.tsx";
import type { Completion } from "./ui/EditorZone.tsx";
import { Gallery } from "./ui/Gallery.tsx";
import { Pairing } from "./ui/Pairing.tsx";
import { T } from "./ui/primitives.tsx";
import { Shell, type DeviceActions } from "./ui/Shell.tsx";

/** `themeNames`: the themes the home node has (theme_get), for /settings. */
type Connected = { client: ClientModel; workbench: Workbench; endpoint: Endpoint; themeNames: string[] };

async function connect(endpoint: Endpoint): Promise<Connected> {
  const client = new ClientModel();
  await client.addEndpoint(async () => NodeConnection.open(await wsTransport(endpoint.url), "app", endpoint.token), { home: true });
  const themeNames: string[] = [];
  // no directory of its own: new sessions ask for one on their node
  const workbench: Workbench = new Workbench(client, {
    themes: () => themeNames,
    uiSettings: () => appSettings(client, workbench, { supported: NOTIFICATIONS_SUPPORTED, request: requestNotifications }),
    // an exported session comes to this device
    offerFile: (node, path) =>
      void client
        .connection(node)
        .request("files_get", { path })
        .then((file) => saveFile(path.split("/").at(-1) ?? "file", file.base64))
        .catch((reason: unknown) => workbench.notify("error", `download: ${reason instanceof Error ? reason.message : String(reason)}`)),
  });
  return { client, workbench, endpoint, themeNames };
}

/** The user's theme and fonts from the home node: theme_get for the colors, ui.font.* for the zones. */
function useUserTheme(connected: Connected | undefined, version: number): Theme {
  const [colors, setColors] = useState<Colors>(DEFAULT_THEME.colors);
  const [name, setName] = useState(DEFAULT_THEME.name);
  const settings = connected?.client.settings ?? {};
  const wanted = typeof settings["ui.theme"] === "string" ? String(settings["ui.theme"]) : undefined;
  useEffect(() => {
    if (connected !== undefined) {
      void connected.client
        .homeRequest("theme_get", wanted !== undefined ? { name: wanted } : {})
        .then((theme) => {
          setColors({ ...DEFAULT_THEME.colors, ...theme.colors } as Colors);
          setName(theme.name);
          connected.themeNames.splice(0, connected.themeNames.length, ...theme.names);
        })
        .catch(() => undefined);
    } else {
      // not connected: the fallback theme
    }
  }, [connected, wanted]);
  return useMemo(
    () => ({ name, colors, chrome: zoneOf(settings["ui.font.chrome"], DEFAULT_THEME.chrome), chat: zoneOf(settings["ui.font.chat"], DEFAULT_THEME.chat) }),
    [name, colors, settings["ui.font.chrome"], settings["ui.font.chat"], version],
  );
}

/** The gallery route (web): `/gallery?fixture=<name>`. */
function galleryFixture(): string | undefined {
  const location = (globalThis as { location?: { pathname: string; search: string } }).location;
  return location?.pathname === "/gallery" ? (new URLSearchParams(location.search).get("fixture") ?? "") : undefined;
}

export function App() {
  const fixture = galleryFixture();
  return fixture !== undefined ? <GalleryApp fixture={fixture} /> : <WorkbenchApp />;
}

function GalleryApp({ fixture }: { fixture: string }) {
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => {
    void loadFonts().finally(() => setFontsReady(true));
  }, []);
  return <ThemeContext.Provider value={DEFAULT_THEME}>{fontsReady ? <Gallery fixture={fixture} /> : <View />}</ThemeContext.Provider>;
}

function WorkbenchApp() {
  const [fontsReady, setFontsReady] = useState(false);
  const [endpoint, setEndpoint] = useState<Endpoint | undefined | null>(null);
  const [connected, setConnected] = useState<Connected | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [version, setVersion] = useState(0);
  const [editorText, setEditorText] = useState("");
  const [commands, setCommands] = useState<Completion[]>([]);
  const [files, setFiles] = useState<Completion[]>([]);
  const { width } = useWindowDimensions();
  const theme = useUserTheme(connected, version);
  const prefillSeen = useRef<string | undefined>(undefined);

  useEffect(() => {
    void loadFonts().finally(() => setFontsReady(true));
    void readEndpoint()
      .then((found) => setEndpoint(found))
      .catch((reason: unknown) => {
        // a pairing link whose code failed: say why and ask for a code
        setError(reason instanceof Error ? reason.message : String(reason));
        setEndpoint(undefined);
      });
  }, []);

  useEffect(() => {
    if (endpoint === null || endpoint === undefined) {
      return;
    } else {
      let disposed = false;
      let current: Connected | undefined;
      connect(endpoint)
        .then((made) => {
          if (disposed) {
            made.client.dispose();
          } else {
            current = made;
            setConnected(made);
            setError(undefined);
            // redraw at most once a frame
            let pending = false;
            made.client.onChange(() => {
              if (!pending) {
                pending = true;
                requestAnimationFrame(() => {
                  pending = false;
                  setVersion((value) => value + 1);
                });
              } else {
                // a redraw is coming
              }
            });
            void made.workbench.activate(0);
          }
        })
        .catch((reason: unknown) => {
          const message = reason instanceof Error ? reason.message : String(reason);
          setError(message);
          if (/unauthorized|unknown|revoked|token/i.test(message) && !endpoint.local) {
            void forgetDevice().then(() => setEndpoint(undefined));
          } else {
            // the hub is unreachable: the client keeps trying once connected; here, say so
          }
        });
      return () => {
        disposed = true;
        current?.client.dispose();
      };
    }
  }, [endpoint]);

  // the editor's mode follows its text (a leading "!" asks for BUILD) in the active session's variant
  const variant = useRef<"advanced" | "simple">("advanced");
  const screen: Screen | undefined = useMemo(() => {
    if (connected === undefined) {
      return undefined;
    } else {
      const drawn = connected.workbench.screen(Math.floor(width / charWidth(theme.chrome)), { mode: modeOfText(editorText, variant.current).mode });
      variant.current = drawn.agent?.state.variant ?? "advanced";
      return drawn;
    }
  }, [connected, version, width, editorText, theme.chrome]);

  // what this screen shows, by meaning: test drivers compare it with the TUI's (plan 16.4)
  useEffect(() => {
    const target = globalThis as unknown as { __harnessScreen?: () => unknown };
    target.__harnessScreen = () => ({
      tabs: (screen?.tabs ?? []).map((tab) => ({ title: tab.title, glyph: tab.glyph, node: tab.node })),
      active: screen?.active ?? 0,
      items: (screen?.items ?? []).map((item) => ({ label: item.label, glyph: item.glyph, kind: item.kind })),
      editor: screen?.zones.editor.kind ?? "none",
      overlays: screen?.zones.overlays ?? [],
      status: (screen?.zones.status ?? []).map((line) => line.text),
    });
  }, [screen]);

  // attention: the sessions that wait for the operator
  const waiting = screen?.tabs.filter((tab) => tab.glyph === "◆").length ?? 0;
  useEffect(() => showAttention(waiting, { waiting: theme.colors.warning, idle: theme.colors.dim }), [waiting, theme.colors.warning, theme.colors.dim]);
  // a system notification when one more session starts waiting (if the user turned them on)
  const waited = useRef(0);
  useEffect(() => {
    if (waiting > waited.current && connected?.client.settings["ui.web.notifications"] === true) {
      const titles = screen?.tabs.filter((tab) => tab.glyph === "◆").map((tab) => tab.title) ?? [];
      notifyOperator("harness: waiting for you", titles.join(", "));
    } else {
      // no new waiting session, or notifications are off
    }
    waited.current = waiting;
  }, [waiting]);
  // and when a session finishes (✓ or ✗, not looked at yet)
  const finishedTitles = screen?.tabs.filter((tab) => tab.glyph === "✓" || tab.glyph === "✗").map((tab) => `${tab.glyph} ${tab.title}`) ?? [];
  const finished = useRef(0);
  useEffect(() => {
    if (finishedTitles.length > finished.current && connected?.client.settings["ui.web.notifications"] === true) {
      notifyOperator("harness: finished", finishedTitles.join(", "));
    } else {
      // nothing new finished, or notifications are off
    }
    finished.current = finishedTitles.length;
  }, [finishedTitles.length]);

  // the address names the active session; an address (a bookmark, back/forward) opens its session
  const activeTab = screen?.tab;
  const selectedItem = screen?.selected;
  useEffect(() => {
    if (activeTab !== undefined) {
      addressSession(activeTab.node, activeTab.sessionId, selectedItem);
    } else {
      // no session to name
    }
  }, [activeTab?.node, activeTab?.sessionId, selectedItem]);
  useEffect(() => {
    if (connected === undefined) {
      return;
    } else {
      const open = (): void => {
        const wanted = addressedSession();
        const index = wanted !== undefined ? connected.workbench.tabs().findIndex((tab) => tab.node === wanted.node && tab.sessionId === wanted.sessionId) : -1;
        if (wanted === undefined) {
          // the address names no session
        } else if (index >= 0) {
          void connected.workbench.act(`tabs.goto.${index + 1}`).then(() => {
            const tab = connected.workbench.activeTab();
            if (tab !== undefined) {
              connected.workbench.select(tab, wanted.item ?? "session");
            } else {
              // the tab went away meanwhile
            }
          });
        } else {
          void connected.client
            .sessions(wanted.node)
            .then((sessions) => sessions.find((session) => session.id === wanted.sessionId))
            .then((session) => (session !== undefined ? connected.workbench.openSession(wanted.node, session) : connected.workbench.notify("warning", `no session ${wanted.sessionId} on ${wanted.node}`)))
            .catch((reason: unknown) => connected.workbench.notify("error", String(reason)));
        }
      };
      open();
      return onAddressChange(open);
    }
  }, [connected]);

  // files handed to the session (dropped on the window, picked) go to its node and into the message as @path
  const upload = useCallback(
    (files: { name: string; base64: string }[]): void => {
      const tab = connected?.workbench.activeTab();
      if (connected === undefined || tab === undefined) {
        connected?.workbench.notify("warning", "open a session to hand it files");
      } else {
        void Promise.all(files.map((file) => connected.client.connection(tab.node).request("files_upload", { name: file.name, base64: file.base64 })))
          .then((stored) => setEditorText((text) => `${text}${text === "" || text.endsWith(" ") ? "" : " "}${stored.map((file) => `@${file.path}`).join(" ")} `))
          .catch((reason: unknown) => connected.workbench.notify("error", `upload: ${String(reason)}`));
      }
    },
    [connected],
  );
  useEffect(() => (connected !== undefined ? onFilesDropped(globalThis.document?.body, upload) : undefined), [connected, upload]);
  useEffect(() => (connected !== undefined ? onFilesPasted(upload) : undefined), [connected, upload]);

  // a voice message: recorded here, transcribed on the session's node, inserted into the message
  const [stopRecording, setStopRecording] = useState<(() => Promise<{ base64: string; mime: string }>) | undefined>(undefined);
  const voice = (): void => {
    const tab = connected?.workbench.activeTab();
    if (connected === undefined || tab === undefined) {
      connected?.workbench.notify("warning", "open a session to talk to");
    } else if (stopRecording === undefined) {
      recordVoice()
        .then((stop) => setStopRecording(() => stop))
        .catch((reason: unknown) => connected.workbench.notify("error", `microphone: ${String(reason)}`));
    } else {
      setStopRecording(undefined);
      connected.workbench.notify("info", "transcribing…");
      void stopRecording()
        .then((audio) => connected.client.connection(tab.node).request("transcribe", audio))
        .then(({ text }) => setEditorText((current) => `${current}${current === "" || current.endsWith(" ") ? "" : " "}${text}`))
        .catch((reason: unknown) => connected.workbench.notify("error", `voice: ${reason instanceof Error ? reason.message : String(reason)}`));
    }
  };

  const device: DeviceActions = {
    download: (path, name) => {
      const tab = connected?.workbench.activeTab();
      if (connected !== undefined && tab !== undefined) {
        void connected.client
          .connection(tab.node)
          .request("files_get", { path })
          .then((file) => saveFile(name, file.base64))
          .catch((reason: unknown) => connected.workbench.notify("error", `download: ${reason instanceof Error ? reason.message : String(reason)}`));
      } else {
        // no session: no node to fetch from
      }
    },
    attach: () => {
      void pickFiles()
        .then(upload)
        .catch((reason: unknown) => connected?.workbench.notify("error", String(reason)));
    },
    voice: VOICE_SUPPORTED ? voice : undefined,
    recording: stopRecording !== undefined,
  };

  // the agent's (or a branch's) text for the editor, once per key
  useEffect(() => {
    if (screen?.prefill !== undefined && screen.prefill.key !== prefillSeen.current) {
      prefillSeen.current = screen.prefill.key;
      setEditorText(screen.prefill.text);
    } else {
      // nothing new for the editor
    }
  }, [screen?.prefill?.key]);

  // the commands of the active session, for completions
  const activeAgent = screen?.tab?.agent?.id;
  useEffect(() => {
    if (connected !== undefined) {
      void connected.workbench
        .commands()
        .then((list) => setCommands(list.map((command) => ({ value: `/${command.name} `, label: `/${command.name}`, description: command.description }))))
        .catch(() => undefined);
    } else {
      // not connected
    }
  }, [connected, activeAgent]);

  // @file completions from the session's machine
  const fileQuery = /(?:^|\s)@(\S*)$/.exec(editorText)?.[1];
  useEffect(() => {
    const tab = connected?.workbench.activeTab();
    if (connected !== undefined && tab?.agent !== undefined && fileQuery !== undefined) {
      void connected.client
        .connection(tab.node)
        .call<{ items: string[] }>(tab.agent.id, { type: "harness_complete", kind: "file", prefix: fileQuery })
        .then(({ items }) => setFiles(items.map((path) => ({ value: path, label: path }))))
        .catch(() => setFiles([]));
    } else {
      setFiles([]);
    }
  }, [connected, fileQuery]);

  const completions: Completion[] =
    /^\/\S*$/.test(editorText) ? commands.filter((command) => command.label.startsWith(editorText)) : fileQuery !== undefined ? files : [];

  const complete = (completion: Completion): void => {
    if (editorText.startsWith("/")) {
      setEditorText(completion.value);
    } else {
      // a directory stays open for its entries; a file ends the mention
      setEditorText(editorText.replace(/@(\S*)$/, `@${completion.value}${completion.value.endsWith("/") ? "" : " "}`));
    }
  };

  const act = useCallback(
    (action: ActionId): void => {
      if (connected === undefined) {
        return;
      } else if (action === "run.abort" && screen?.input === "dialog") {
        return; // Esc belongs to the dialog
      } else {
        void connected.workbench.act(action);
      }
    },
    [connected, screen?.input],
  );
  useEffect(() => listenKeys(act), [act]);

  const submit = (): void => {
    const text = editorText;
    if (connected === undefined || text.trim() === "") {
      return;
    } else {
      setEditorText("");
      void (async () => {
        if (!(await connected.workbench.clientCommand(text, () => undefined))) {
          const variant = screen?.agent?.state.variant ?? "advanced";
          const { mode, text: message } = modeOfText(text, variant);
          await connected.workbench.prompt(message, mode);
        } else {
          // the client ran it
        }
      })();
    }
  };

  const loadOlder = (agent: AgentModel): void => {
    const tab = connected?.workbench.activeTab();
    if (connected !== undefined && tab !== undefined) {
      void connected.client.loadOlder(tab.node, agent.agentId);
    } else {
      // nothing to load into
    }
  };

  const body = !fontsReady || endpoint === null ? (
    <View style={{ flex: 1, backgroundColor: theme.colors.pageBg }} />
  ) : endpoint === undefined ? (
    <Pairing
      error={error}
      onPair={(code, url) =>
        void saveDevice(code, url)
          .then(setEndpoint)
          .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      }
    />
  ) : screen === undefined || connected === undefined ? (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.pageBg }}>
      <T color={error !== undefined ? "error" : "muted"}>{error ?? "connecting…"}</T>
    </View>
  ) : (
    <Shell screen={screen} workbench={connected.workbench} editorText={editorText} onEditorText={setEditorText} onSubmit={submit} completions={completions} onComplete={complete} onLoadOlder={loadOlder} device={device} panes={connected.client.settings["ui.web.panes"]} onPanes={(panes) => void connected.client.setting("ui.web.panes", panes)} />
  );
  // the system's bars and keyboard never cover the screen (native; on web the insets are zero)
  return (
    <SafeAreaProvider>
      <ThemeContext.Provider value={theme}>
        <SafeAreaView edges={["top", "bottom", "left", "right"]} style={{ flex: 1, backgroundColor: theme.colors.pageBg }}>
          <KeyboardAvoidingView behavior={Platform.OS === "web" ? undefined : "padding"} style={{ flex: 1 }}>
            {body}
          </KeyboardAvoidingView>
        </SafeAreaView>
      </ThemeContext.Provider>
    </SafeAreaProvider>
  );
}
