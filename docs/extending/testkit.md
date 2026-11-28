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
keys, and expose the client's `Workbench` screen — a scenario's verdict is the screen's meaning
(zones, glyphs, text); how the screens look is the screens' suite (below). Steps wait for events;
a step that hangs fails after 45 s with a report.

## Reports and screens

After every step the run checks what no scenario may leave behind: a TUI whose active session
shows its editor without a live agent, and `error` records in the log the step did not provoke on
purpose (a step names those in `errors: [/…/]`). Either fails the step.

`.test-reports/<run>/<scenario>/` (latest: `.test-reports/latest`) holds every client's protocol;
on a failure also `report.md`, the log of every source merged by time (`log.txt`: one request's
records in the window, the hub and the agent side by side), the agents' logs, the sessions, each
client's model state and the screens (text, ANSI, PNG) at the failing step and the last step that
passed.
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

`tests/smoke/upgrade.test.ts` walks the way up from an older version: a home the product wrote,
folded back into the flat layout of before (`ui.tabs` on node `default`, the window's state of
version 1 with a draft, the old event log), is moved by the bundle's `harness` on start, and the
session goes on with its draft in both clients, with no error in the log.

## Screens and their baselines

`tests/smoke/screens.test.ts` brings the product (the bundle's TUI and the web app its hub
serves) to the same screens in both clients — a session with a tool and an answer, choosing a new
session's folder, the model list, the panel, the session's terminal — at three terminal sizes
(80×24, 120×40, 200×60) and three windows (phone, tablet, desktop), in the dark and the light
theme, and compares each with its reviewed baseline (`tests/fixtures/screens/<theme>/`,
`capture/screens.ts`): a TUI screen as its cell grid (text and style runs), a page by its pixels
(a small tolerance); values that change from run to run (temporary paths, ids, times, costs) are
placeholders first. Every screen is also checked by the rules of layout: closed frames and no
leaked `undefined` in the TUI; nothing wider than the window and text readable against its
background (WCAG AA) on a page. A rule broken that is not in `known-issues.json` fails; a known
issue is a finding reviewed and waiting for its fix.

The run's sheet — `.test-reports/<run>/screens/<theme>/index.html` and `sheet.png`, the TUI's
and the web's screens side by side, the changed ones outlined — is for looking at: a change to a
UI is looked at there before its commit. `HARNESS_UPDATE_SCREENS=1` accepts what the run shows as
the new baselines (and its broken rules as known issues): only after looking at them.

## The gallery

`harness-test gallery [filter] [--compare <dir>]` draws every fixture (`fixtures/fixtures.ts`:
interactions, tabs with every glyph, items) with the TUI's components into
`.test-reports/<run>/gallery/index.html`; with `--compare` it lists what changed for review. It
fails only when a fixture cannot be drawn.
