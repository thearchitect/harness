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

## A stand by hand

```
harness-test up tests/scenarios/tui.test.ts [--until "<step>"]   # prints an id
harness-test status|step|state <id> tui|shot|logs|down <id>
harness-test do <id> tui action panel.toggle | type "text" | key "\r"
```

## The gallery

`harness-test gallery [filter] [--compare <dir>]` draws every fixture (`fixtures/fixtures.ts`:
interactions, tabs with every glyph, items) with the TUI's components into
`.test-reports/<run>/gallery/index.html`; with `--compare` it lists what changed for review. It
fails only when a fixture cannot be drawn.
