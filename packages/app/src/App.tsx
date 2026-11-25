// The app: pairs with a hub (or takes the local token of `harness web-app`), connects, and draws the
// workbench — the same model, zones and actions as the TUI — in the user's theme and fonts.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWindowDimensions, View } from "react-native";
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
import { loadFonts } from "./theme/fonts";
import { charWidth, DEFAULT_THEME, ThemeContext, zoneOf, type Colors, type Theme } from "./theme/theme.tsx";
import type { Completion } from "./ui/EditorZone.tsx";
import { Pairing } from "./ui/Pairing.tsx";
import { T } from "./ui/primitives.tsx";
import { Shell } from "./ui/Shell.tsx";

type Connected = { client: ClientModel; workbench: Workbench; endpoint: Endpoint };

async function connect(endpoint: Endpoint): Promise<Connected> {
  const client = new ClientModel();
  await client.addEndpoint(async () => NodeConnection.open(await wsTransport(endpoint.url), "app", endpoint.token), { home: true });
  const workbench = new Workbench(client, { cwd: "~", themes: () => [] });
  return { client, workbench, endpoint };
}

/** The user's theme and fonts from the home node: theme_get for the colors, ui.font.* for the zones. */
function useUserTheme(connected: Connected | undefined, version: number): Theme {
  const [colors, setColors] = useState<Colors>(DEFAULT_THEME.colors);
  const [name, setName] = useState(DEFAULT_THEME.name);
  const settings = connected?.client.settings ?? {};
  const wanted = typeof settings["ui.theme"] === "string" ? String(settings["ui.theme"]) : undefined;
  useEffect(() => {
    const home = connected?.client.home;
    if (connected !== undefined && home !== undefined) {
      void connected.client
        .connection(home)
        .request("theme_get", wanted !== undefined ? { name: wanted } : {})
        .then((theme) => {
          setColors({ ...DEFAULT_THEME.colors, ...theme.colors } as Colors);
          setName(theme.name);
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

export function App() {
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
    void readEndpoint().then((found) => setEndpoint(found));
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
        .call<{ items: { value: string; label: string; description?: string }[] }>(tab.agent.id, { type: "harness_complete", kind: "file", prefix: fileQuery })
        .then(({ items }) => setFiles(items.map((item) => ({ value: item.value, label: item.label, description: item.description }))))
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
      setEditorText(editorText.replace(/@(\S*)$/, `@${completion.value} `));
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
    <Pairing error={error} onPair={(token, url) => void saveDevice(token, url).then(setEndpoint)} />
  ) : screen === undefined || connected === undefined ? (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.pageBg }}>
      <T color={error !== undefined ? "error" : "muted"}>{error ?? "connecting…"}</T>
    </View>
  ) : (
    <Shell screen={screen} workbench={connected.workbench} editorText={editorText} onEditorText={setEditorText} onSubmit={submit} completions={completions} onComplete={complete} onLoadOlder={loadOlder} />
  );
  return <ThemeContext.Provider value={theme}>{body}</ThemeContext.Provider>;
}
