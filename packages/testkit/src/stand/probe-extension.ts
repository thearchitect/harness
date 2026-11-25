// A pi extension of the test stand that exercises client UIs from inside an agent: `/probe-component`
// opens a ctx.ui.custom() component (typed text shows in it, Enter finishes with it), and reports
// the result — or that no client could show it — as a notification.

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
              return [`probe (${width}): ${typed}`, "Enter finishes"];
            },
            handleInput(data: string) {
              if (data === "\r") {
                done(typed);
              } else {
                typed += data;
                tui.requestRender();
              }
            },
          };
        },
        { overlay },
      );
      ctx.ui.notify(result === undefined ? "probe: no client can show components" : `probe result: ${result}`, "info");
    },
  });
}
