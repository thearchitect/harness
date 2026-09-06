# thearchitect.pi

Personal workflow, safety, and UI extension for
[Pi](https://github.com/earendil-works/pi).

## Features

### Per-message PLAN and BUILD modes

PLAN is the default for every new interactive submission. Prefix an idle
submission with `!` to select BUILD; the prefix is removed before the message
is sent to the model. Steering and follow-up messages retain the active mode
of the current agent run.

The extension provides:

- mode-colored editor borders and working messages;
- trusted per-turn mode selectors appended during preflight;
- stable system-prompt assembly so switching modes does not invalidate the
  provider prompt cache;
- completion/interruption banners with cycle duration and USD cost.

### File mutation gates

Calls to the built-in `write` and `edit` tools are intercepted:

- PLAN permits mutations only inside the OS temporary directory or the
  session workspace;
- BUILD asks for UI confirmation before mutations outside those locations;
- non-interactive mutations that require confirmation are blocked;
- `/madness` or `Ctrl+\` toggles a full bypass for the current session.

The status line below the editor shows whether mutation gates are active.

### UI integration

- `write` calls always render their complete content while other tool rows
  retain normal collapse behavior.
- `ask_user` calls always allow free-form answers and optional extra context.
- Pending questions and mutation confirmations emit the `herdr:blocked`
  event for Herdr integration.
- Thinking blocks are kept visible across restarts.

### Process defaults

Unless already set by the caller, the extension configures:

- `PI_ASK_USER_DISPLAY_MODE=inline`
- `PI_MCP_ADAPTER_DISABLE_AUTH_CACHE=1`
- `PI_CACHE_RETENTION=long`

It also ensures `showThinking: true` in Pi's global `settings.json`.

### Static configuration

The `CONFIG` object at the top of `index.ts` is the single source of truth for
personal defaults — change it there, never in the logic below.

- `providers.*.modelOverrides` raises the active model's `contextWindow`
  beyond Pi's default, mirroring the semantics of a `models.json` override.
  Currently `openai-codex/gpt-6-astra` and `openai-codex/gpt-5.6-sol` are
  lifted to 872000 tokens so long sessions compact later. Overrides are
  applied at session start, on every model switch, and before each agent run.

## Requirements

- Pi `>=0.85.0`
- Node.js `>=22.19.0`

Pi loads the TypeScript entry point directly through `jiti`; no build step is
required.

## Installation

Use exactly one installation method.

### Pi Git package

```bash
pi install git:git@github.com:thearchitect/thearchitect.pi.git
```

### Auto-discovered checkout

Clone or add the repository as a submodule at:

```text
~/.pi/agent/extensions/thearchitect.pi
```

Pi discovers the package through `package.json` and its `pi.extensions`
manifest. Run `/reload` after changing the source.

## Development

Validate the package contents:

```bash
npm run check
```

There are no runtime npm dependencies. Pi provides the declared peer modules
to extensions through its loader.

## Security

Pi extensions execute with the permissions of the Pi process. This extension
can modify files after applying the mode gates described above, and madness
mode deliberately bypasses those gates.

## License

[MIT](LICENSE)
