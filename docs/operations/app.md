# The app

The app (`packages/app`, Expo and React Native) is the second client of harness, next to the TUI.
It draws the same workbench (`packages/client/src/workbench/`): the same tabs and items with the
same glyphs, the same zones, interactions in the editor's place, the same `/commands` and keys.
What differs is how a platform does things (pointer, touch, a browser's title and address).

Its web build ships in the bundle (`share/harness/app-web`, `HARNESS_APP_WEB`). iOS and Android
builds are not published yet.

## Opening it

- **On this machine**: `harness web-app` opens the app in a window of the bundled browser, on
  this user's node (the running one, or one inside the process). The window's address carries a
  one-time token in its fragment; closing the window ends the command.
- **Through a hub**: a hub serves the web build on its address. Pair a browser with
  `harness hub device add <user> --name <device> --url <hub address>`: it prints a one-time code,
  a link with the code in its fragment (`#pair=…`) and the link's QR code; opening the link (within
  ten minutes, once) exchanges the code for this browser's device token and removes it from the
  address. Without `--url`, enter the code into the pairing form.
  `hub.url` in the hub's `nodes/<name>.json` sets the address once.

## The strips and the panel, by keyboard and pointer

The same in the TUI and the app:

- `Alt+←` / `Alt+→` take the keyboard into the sessions strip / the session's items (a strip
  hidden on a narrow screen comes over it): `↑`/`↓` move, `Enter` (or `Space`) opens, `Esc` goes
  back to the editor; on a tab `Delete` closes it. A click opens a row, the middle button closes a
  tab, the pointer lights a row up.
- `Ctrl+\` opens the harness panel on the right: MODE (madness, simple — switches that keep the
  panel open; new sessions start with the last choice), SESSION (its name — a field that takes
  typing as soon as it is selected and names the session as you type, no Enter; the implementer —
  `self` or a subagent profile in turn, for this session only) and HARNESS (update, dependencies,
  subagents, logs, restart node — actions that close it). `↑`/`↓`, `Space`/`Enter` apply, `Esc` or
  `Ctrl+\` close (a name being typed applies); a click applies a row.
- Lists in the editor's place (`Ctrl+L` models, sessions, `/tree`, `/settings`) name each key in
  their hint line; the model list has Favorites (pi's `enabledModels`) and All, `Tab` switches.

## Files, voice, logs

- A file an agent sends (`send_file`) shows with its comment and a Download button; it comes from
  the session's node.
- `+` next to the editor picks files (and dropping them on the window does the same): they go to
  the session's node (`~/.harness/uploads/`) and into the message as `@path`.
- `●` records a voice message; the session's node transcribes it with its user's OpenAI login
  (`gpt-4o-transcribe`; `/login` there first) and the text goes into the message.
- The panel (`Ctrl+\`) has the logs of the node you came in through: its own user sees them, and
  on a hub its admins.

## What the browser adds

- The page title and icon show `◆ N` while N sessions wait for you.
- The address names the active session and its item (`#/<node>/<session>[/<item>]`):
  bookmarks and back/forward move between them.
- Files dropped on the window or pasted (images) go to the session's node
  (`~/.harness/uploads/`) and into the message as `@path`.
- Notifications (off by default, `/settings`) when a session starts waiting or finishes and the
  window is not in front.
- The strips' widths change by dragging their edges (`ui.web.panes`); tabs reorder by dragging
  (for every client of yours), close with the middle button, and have a context menu (right
  click; a long press on touch): close, stop the run, copy the id. Items have one too (stop a
  task, copy the id); hovering a row shows its node, directory and state.
- Changes show as removed and added lines, side by side on a wide window; images enlarge on a
  press.

## Settings

`/settings` in the app has the theme (shared with the TUI), the fonts of its two zones —
`ui.font.chat` (transcript and editor) and `ui.font.chrome` (strips, lists, footer, dialogs), each
JetBrains Mono, Iosevka Term, Terminus or the system's monospace font with a size — and the
notifications. They live in your settings on the node or hub you came in through
([settings.md](settings.md)), so every app of yours looks the same.

## What it cannot show

Dialogs that extensions draw as terminal components (`ctx.ui.custom()`) exist only in terminals:
the app says so in the editor's place; answer them in the TUI.
