// An extension's component (ctx.ui.custom) runs in the agent and shows in the TUI in the editor's
// place (or over the screen): keys reach it, it redraws, Enter finishes it with the typed result.
// A client that cannot draw components (raw) makes custom() resolve undefined at once.

import assert from "node:assert/strict";
import { defineScenario, runScenario } from "#testkit/scenario/scenario.ts";

export const scenario = defineScenario({
  name: "component bridge",
  clients: { tui: { kind: "tui" } },
  steps: [
    {
      name: "a component opens in the editor's place and takes keys",
      async run({ clients: { tui } }) {
        await tui.type("/probe-component");
        await tui.submit();
        await tui.waitForText((screen) => screen.includes("probe ("));
        assert.equal(tui.screen().zones.editor.kind, "component");
        assert.equal(tui.screen().input, "component");
        await tui.type("abc");
        await tui.waitForText((screen) => /probe \(\d+\): abc/.test(screen));
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
      name: "custom() resolves undefined at once",
      async run({ stand, clients: { raw } }) {
        const { agent } = await raw.api.request("agent_start", { cwd: stand.project });
        const model = await raw.client.follow(raw.node, agent.id);
        await raw.api.call(agent.id, { type: "harness_prompt", text: "/probe-component" });
        await new Promise<void>((resolve) => {
          const check = (): void => {
            if (model.notices.some((notice) => notice.message === "probe: no client can show components")) {
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
