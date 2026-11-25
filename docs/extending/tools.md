# Tools and extensions

A tool is registered as pi documents it ([`pi.registerTool`](../../pi/coding-agent/docs/extensions.md#piregistertooldefinition),
[custom tools](../../pi/coding-agent/docs/extensions.md#custom-tools)). In harness three things
differ, because the tool runs in an agent and is drawn by clients elsewhere.

## Ask the operator through interactions

Inside harness's extension, a tool asks the operator through the host's `interactions.ask(kind,
payload, { signal, toolCallId })` (`packages/extension/src/host.ts`), never through
`ctx.ui.custom()`. The kinds and their payloads and answers are in
`packages/protocol/src/interactions.ts`:

| Kind | For |
|---|---|
| `gate` | approval of a file change (Allow / Reject with a comment / Stop) |
| `secret` | a secret value that never reaches the model |
| `questions` | `ask_user`'s call (the parameters of the bundled `pi-ask-user` package, whose tool it is); the answer is the tool's result: the TUI runs pi-ask-user's own prompt, the app builds the same result (`packages/client/src/ask-user.ts`) |
| `choice` | one of a few options (the Claude limit dialog) |
| `display` | showing a file to the operator |
| `pi-dialog` | pi's `select`/`confirm`/`input`/`editor` of foreign extensions |

Every client draws them its own way; the first answer closes them everywhere. Pass the tool
call's `signal` so an aborted run closes the interaction.

Foreign extensions that call `ctx.ui.custom()` keep working in terminal clients through the
component bridge; other clients get `undefined` ([pi-mapping.md](../pi-mapping.md#apis)).

## Draw from the record only

`renderCall` and `renderResult` (and entry and message renderers) run in the client, which may
attach long after the call. Draw from the arguments, the result, its `details` and the entry data;
put what the drawing needs into `details` (the gate's comment travels this way). harness's own
renderers live in `packages/extension/src/presentation/`, without side effects at import.

## Changes go through the gate

A tool that changes files asks `authorize(ctx, { tool, toolCallId, paths, lines })`
(`packages/extension/src/core/authorize.ts`): PLAN refuses changes outside the session
workspace, BUILD asks the operator with a `gate` interaction, SIMPLE allows the working
directory, madness allows all. `write` and `edit` are gated by the extension itself; `lsp_refactor`
asks once for its whole plan.

## Where an extension lives

- In the bundle: added to `packages/extension/src/` (harness's own) or as a pi package in
  `nix/npm/package.json` and the manifest's `piExtensions` (`nix/package.nix`).
- For one user: `~/.harness/extensions/`, picked up by pi's discovery at the next agent start
  ([extension locations](../../pi/coding-agent/docs/extensions.md#extension-locations)).
