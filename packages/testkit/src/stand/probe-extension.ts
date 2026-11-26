// A pi extension of the test stand that exercises client UIs from inside an agent: `/probe-component`
// opens a ctx.ui.custom() component (its size in cells and the typed text show in it, pasted text
// between bars, Enter finishes with the text, a click with its cell), and reports the result as a
// notification. The provider `probe-sso` logs in like an OAuth provider: a choice of method, a sign-in
// link whose callback is on 127.0.0.1, a field for the code or the redirect address (`good` in it
// signs in); each run's link has its own `state`.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The callback port of probe-sso's sign-in link. */
export const PROBE_SSO_PORT = 53_917;

export default function probeExtension(pi: ExtensionAPI): void {
  let runs = 0;
  pi.registerProvider("probe-sso", {
    baseUrl: "http://127.0.0.1:9",
    api: "openai-completions",
    models: [{ id: "probe-model", name: "Probe model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }],
    oauth: {
      name: "Probe SSO",
      async login(callbacks) {
        runs += 1;
        const method = await callbacks.onSelect({ message: "Choose the probe's login method:", options: [{ id: "browser", label: "Browser" }, { id: "code", label: "Code" }] });
        const redirect = encodeURIComponent(`http://127.0.0.1:${PROBE_SSO_PORT}/callback`);
        callbacks.onAuth({ url: `https://sso.example/authorize?client_id=probe&redirect_uri=${redirect}&method=${method}&state=run${runs}`, instructions: "Complete the probe's sign-in in your browser." });
        const answer = await callbacks.onPrompt({ message: "Paste the code or the redirect URL:" });
        if (answer.includes("good")) {
          return { access: "probe-access", refresh: "probe-refresh", expires: Date.now() + 3_600_000 };
        } else {
          throw new Error(`probe-sso: not a good code (${answer})`);
        }
      },
      async refreshToken(credentials) {
        return credentials;
      },
      getApiKey(credentials) {
        return credentials.access;
      },
    },
  });
  pi.registerCommand("probe-component", {
    description: "Opens a test component (testkit)",
    handler: async (args, ctx) => {
      const overlay = args.trim() === "overlay";
      const result = await ctx.ui.custom<string>(
        (tui, _theme, _keybindings, done) => {
          let typed = "";
          return {
            invalidate() {},
            render(width: number) {
              return [`probe (${width}x${tui.terminal.rows}): ${typed}`, "Enter finishes", "\x1b[31mclick\x1b[0m here"];
            },
            handleInput(data: string) {
              if (data === "\r") {
                done(typed);
              } else {
                typed += data.replace(/\x1b\[20[01]~/g, "|");
                tui.requestRender();
              }
            },
            handleMouse(event: { type: string; x: number; y: number }) {
              if (event.type === "click") {
                done(`click ${event.x},${event.y}`);
              } else {
                // moves and presses: nothing
              }
              return { handled: true };
            },
          };
        },
        { overlay },
      );
      ctx.ui.notify(result === undefined ? "probe: no client can show components" : `probe result: ${result}`, "info");
    },
  });

}
