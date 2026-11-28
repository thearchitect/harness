# Testing harness

`nix develop --command nix flake check` builds the bundle and runs everything: the type check,
unit tests (`packages/**/*.test.ts`), scenarios (`tests/**/*.test.ts`), the bundle's smoke tests,
the gallery and the VM tests of the NixOS module and the Fly image. While working,
`nix/check.sh [files…]` or `harness-test` run the same from the checkout.

## Scenarios

A scenario is a stand, its clients and named steps (`packages/testkit/src/scenario/scenario.ts`):

```ts
export const scenario = defineScenario({
  name: "tui basics",
  clients: { tui: { kind: "tui" } },
  steps: [{ name: "a message gets its answer", async run({ stand, clients: { tui } }) { … } }],
});
runScenario(scenario);
```

The stand (`stand/stand.ts`) is a hub in a temporary home with agents on a scripted model
(`stand.script([{ text }, { toolCalls }])`), optionally extra models (`stand.models([...])`) and a
`ManualClock`. Drivers act by the keymap's action ids (`tui.act("model.select")`), type text and
keys, and expose the client's `Workbench` screen — the verdict is always the screen's meaning
(zones, glyphs, text), never pixels. Steps wait for events; a step that hangs fails after 45 s
with a report.

## Reports and screens

`.test-reports/<run>/<scenario>/` (latest: `.test-reports/latest`) holds every client's protocol;
on a failure also `report.md`, the agents' logs, the sessions, each client's model state and the
screens (text, ANSI, PNG) at the failing step and the last step that passed.
`harness-test … --shots all` captures every step.

## The product

The TUI driver runs the window `harness` puts together (`packages/cli/src/window.ts`); only the
terminal, clipboard, browser and view store are the test's. The product driver
(`drivers/product.ts`) goes further: the bundle's real `bin/harness` in a pseudo-terminal on a
stand's home (`createStandHome()`: the scripted model, no user configuration), its hub held by the
window, keys sent as a terminal sends them (legacy bytes, or the kitty protocol with `kitty:
true`), the screen read back through a headless xterm; `tui.web()` turns on the hub's network on a
loopback port, pairs a browser by a one-time link and opens the web app the hub serves.

`tests/smoke/golden-path.test.ts` walks the golden path on both clients and one hub: sessions
answer, new sessions in each client, a tab closes, a draft is the hub's, the session's terminal is
one screen, the window quits and starts again with live sessions, the log ties one request
through window, hub and agent, and holds no error. It runs with `HARNESS_BUNDLE` (nix/check.nix
sets it); `HARNESS_KEEP_HOMES=1` keeps the stands' homes (logs, sessions) for a look.

## A stand by hand

```
harness-test up tests/scenarios/tui.test.ts [--until "<step>"]   # prints an id
harness-test status|step|state <id> tui|shot|logs|down <id>
harness-test do <id> tui action panel.toggle | type "text" | key "\r"

HARNESS_BUNDLE=$(nix build --print-out-paths) harness-test up --product [--web] [--kitty]
harness-test script <id> '[{"text":"an answer"}]'
harness-test do <id> tui|web action tabs.new | type "text" | key ctrl+enter
harness-test state|shot|logs|down <id>
```

Checks by hand go through these, never through a terminal multiplexer or ad-hoc runs.

## The gallery

`harness-test gallery [filter] [--compare <dir>]` draws every fixture (`fixtures/fixtures.ts`:
interactions, tabs with every glyph, items) with the TUI's components into
`.test-reports/<run>/gallery/index.html`; with `--compare` it lists what changed for review. It
fails only when a fixture cannot be drawn.
