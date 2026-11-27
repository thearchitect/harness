// An extension's component (ctx.ui.custom) runs in the agent and shows in the TUI in the editor's
// place (or over the screen): keys reach it, it redraws, it knows the terminal's size, a click
// reaches the cell it hit, Enter finishes it with the typed result. Extensions see `ctx.mode`
// "tui". With no client that can draw components (raw), the component waits and the status line
// says so.

import assert from "node:assert/strict";
import { defineScenario, runScenario } from "#testkit/scenario/scenario.ts";

export const scenario = defineScenario({
  name: "component bridge",
  stand: { mcpProbe: true },
  clients: { tui: { kind: "tui" } },
  steps: [
    {
      name: "/mcp opens pi's MCP manager in the editor's place (extensions see mode tui); Esc closes it",
      async run({ clients: { tui } }) {
        await tui.type("/mcp");
        await tui.submit();
        await tui.waitForText((screen) => screen.includes("probe") && tui.screen().zones.editor.kind === "component", 30_000);
        await tui.press("\x1b");
        await tui.waitForText(() => tui.screen().zones.editor.kind === "editor");
      },
    },
    {
      name: "a component opens in the editor's place and takes keys",
      async run({ clients: { tui } }) {
        await tui.type("/probe-component");
        await tui.submit();
        await tui.waitForText((screen) => screen.includes("probe ("));
        assert.equal(tui.screen().zones.editor.kind, "component");
        assert.equal(tui.screen().input, "component");
        await tui.type("abc");
        await tui.waitForText((screen) => /probe \(\d+x40\): abc/.test(screen), 15_000);
      },
    },
    {
      name: "Enter finishes it with the result",
      async run({ clients: { tui } }) {
        await tui.press("\r");
        await tui.waitForText((screen) => screen.includes("probe result: abc"));
        assert.equal(tui.screen().zones.editor.kind, "editor");
      },
    },
    {
      name: "a click reaches the component at the cell it hit",
      async run({ clients: { tui } }) {
        await tui.type("/probe-component");
        await tui.submit();
        const screen = await tui.waitForText((text) => text.includes("click here"));
        const lines = screen.split("\n");
        const y = lines.findIndex((line) => line.includes("click here"));
        const x = (lines[y] ?? "").indexOf("click here");
        // SGR mouse: press and release of the left button at (x, y), 1-based
        await tui.press(`\x1b[<0;${x + 3};${y + 1}M`);
        await tui.press(`\x1b[<0;${x + 3};${y + 1}m`);
        await tui.waitForText((text) => /probe result: click \d+,2/.test(text));
      },
    },
    {
      name: "an overlay component lies over the screen",
      async run({ clients: { tui } }) {
        await tui.type("/probe-component overlay");
        await tui.submit();
        await tui.waitForText((screen) => screen.includes("probe ("));
        assert.ok(tui.screen().zones.componentOverlay !== undefined);
        await tui.type("x");
        await tui.press("\r");
        await tui.waitForText((screen) => screen.includes("probe result: x"));
        assert.equal(tui.screen().zones.componentOverlay, undefined);
      },
    },
  ],
});

runScenario(scenario);

export const rawScenario = defineScenario({
  name: "component bridge without a terminal client",
  clients: { raw: { kind: "raw" } },
  steps: [
    {
      name: "the component waits for a client that can show it, and says so",
      async run({ stand, clients: { raw } }) {
        const { agent } = await raw.api.request("agent_start", { cwd: stand.project });
        const model = await raw.client.follow(raw.hub, agent.id);
        await raw.api.call(agent.id, { type: "harness_prompt", text: "/probe-component" });
        await new Promise<void>((resolve) => {
          const check = (): void => {
            if (Object.values(model.status).some((text) => /waits for a client that can show it/.test(text))) {
              resolve();
            } else {
              // not yet
            }
          };
          model.onChange(check);
          check();
        });
      },
    },
  ],
});

runScenario(rawScenario);
