// A pi extension of the test stand that exercises client UIs from inside an agent: `/probe-component`
// opens a ctx.ui.custom() component (its size in cells and the typed text show in it, pasted text
// between bars, Enter finishes with the text, a click with its cell), and reports the result as a
// notification.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function probeExtension(pi: ExtensionAPI): void {
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
