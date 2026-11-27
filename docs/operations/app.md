# The app

The app (`packages/app`, Expo and React Native) is the second client of harness, next to the TUI.
It draws the same workbench (`packages/client/src/workbench/`): the same tabs and items with the
same glyphs, the same zones, interactions in the editor's place, the same `/commands` and keys.
What differs is how a platform does things (pointer, touch, a browser's title and address).

Its web build ships in the bundle (`share/harness/app-web`, `HARNESS_APP_WEB`). iOS and Android
builds are not published yet.

## Opening it

- **On this machine**: `harness web-app` opens the app in a window of the bundled browser, on
  this user's hub (the running one, or one inside the process). The window's address carries a
  one-time token in its fragment; closing the window ends the command.
- **Over the network**: a hub with network access ([hub.md](hub.md)) serves the web build on its
  address. `/hub`, add device (or `harness hub device add`) makes a one-time code, a link with the
  code in its fragment (`#pair=…`) and the link's QR code. Opening the link (within ten minutes,
  once) pairs this browser — its token an HttpOnly cookie the page never sees — and removes the code
  from the address; on a phone the page offers to hand the link to the installed app instead. The
  pairing form scans the QR code with the camera, takes the link pasted, or the code typed (in the
  phone apps with the hub's address).

## The strips and the panel, by keyboard and pointer

The same in the TUI and the app:

- The strip on the left has three blocks, without titles: the hubs (this machine's first —
  `inprocess` in the window that holds it — then other machines' ones, `+ add` to pair a hub; one
  glyph each: `⊘` offline, `◆` a session waits for you, `●` something works), the chosen hub's
  sessions (`+ new` last) and the active session's items (`session` first in its mode's color,
  then its tasks and subagents). Choosing a hub shows its sessions and opens its last active one; new sessions start
  there and the panel's HARNESS rows act on it.
- `Ctrl/Alt+S` takes the keyboard into the strip (over the screen when it is too narrow for it): one
  cursor walks all three blocks with `↑`/`↓`, `Enter` (or `Space`) opens, `Esc` goes back to the
  editor; on a session `Delete` closes its tab. A click opens a row, the middle button closes a
  tab, the pointer lights a row up.
- `Ctrl/Alt+N` (or `+ new`) chooses the new session's folder in the chat zone, by typing alone: the
  folders of recent sessions (newest first) under `folder ⇒`, which browses the hub's folders.
  Typing filters, `↑`/`↓` choose, `→` opens a folder, `←` goes up, `/` opens the best match (`har/cr/`
  walks down), `~` or `/` first browse from the home or the root, `Enter` starts the session there,
  `Esc` cancels; a leading dot shows hidden folders. A session without a message is the window's
  alone and leaves nothing when closed; its first message makes it one of your tabs everywhere.
- `harness` reopens the window as it was (no tabs: the folder choice); `harness <dir>` (`.` for
  here) opens a new session in it.
- `Ctrl+\` opens the harness panel on the right: MODE (madness, simple — switches that keep the
  panel open; new sessions start with the last choice), SESSION (its name — a field that takes
  typing as soon as it is selected and names the session as you type, no Enter; the implementer —
  `self` or a subagent profile in turn, for this session only) and HARNESS (update, dependencies,
  subagents, logs, restart hub — actions that close it). `↑`/`↓`, `Space`/`Enter` apply, `Esc` or
  `Ctrl+\` close (a name being typed applies); a click applies a row.
- Lists in the editor's place (`Ctrl/Alt+L` models, sessions, `/tree`, `/settings`) name each key in
  their hint line; the model list has Favorites (pi's `enabledModels`) and All, `Tab` switches.
- A window shows a session (its transcript and the message field) or the choice of a new session's
  folder, never a field without a session: closing the last tab, or starting without tabs, opens
  the choice; `Esc` there goes back to a session if there is one.
- Every dialog in the field's place — a question, an edit to approve, a login, a secret, a list,
  `/hub`, an extension's component — has one frame: a line in the theme's border color with its
  title above, one below, nothing on the sides. Completion of `/commands` and `@files` shows above
  the field, which keeps the keyboard, under one such line naming it.
- The cursor of the message field keeps `ui.scrollOff.vertical` lines (2) above and below it, of a
  single-line field `ui.scrollOff.horizontal` characters (10) on either side, while the text goes
  on; at the text's ends it comes to the edge.

## Files, voice, logs

- A file an agent sends (`send_file`) shows with its comment and a Download button; it comes from
  the session's hub.
- `+` next to the editor picks files (and dropping them on the window does the same): they go to
  the session's hub (`~/.harness/hub/attachments/<session>/`) and into the message as `@path`.
- `●` records a voice message; the session's hub transcribes it with its user's OpenAI login
  (`gpt-4o-transcribe`; `/login` there first) and the text goes into the message.
- The panel (`Ctrl+\`) has the logs of the hub you came in through.

## The session's terminal

Ctrl/Alt+/ shows a terminal over the main area: a shell (the hub user's `$SHELL`) in the session's
directory on the session's hub, the same one the TUI shows for that session (`terminal_open`).
Its first show starts it; hidden, it runs on, and showing it again brings its screen as it is now.
While it is shown every key is the shell's but its way out, Ctrl/Alt+/ (the panel's, the tabs'
and the rest go to the shell); pasting goes to it. When the shell exits, Enter starts another. On a phone the status line's
`terminal` button shows it, with a strip of keys (↑ ↓ ⏎ Esc Tab Ctrl+C) and a field for typing.

## What the browser adds

- The page title and icon show `◆ N` while N sessions wait for you.
- The address names the active session and its item (`#/<hub>/<session>[/<item>]`):
  bookmarks and back/forward move between them.
- Files dropped on the window or pasted (images) go to the session's hub
  (`~/.harness/hub/attachments/<session>/`) and into the message as `@path`; the draft naming them
  lasts across restarts and devices.
- Notifications (off by default, `/settings`) when a session starts waiting or finishes and the
  window is not in front.
- The strip's width changes by dragging its edge (`ui.web.panes`); tabs reorder by dragging
  (for every client of yours), close with the middle button, and have a context menu (right
  click; a long press on touch): close, stop the run, copy the id. Items have one too (stop a
  task, copy the id); hovering a row shows its hub, directory and state.
- Changes show as removed and added lines, side by side on a wide window; images enlarge on a
  press.

## Settings

`/settings` in the app has the theme (shared with the TUI), the fonts of its two zones —
`ui.font.chat` (transcript and editor) and `ui.font.chrome` (strips, lists, footer, dialogs), each
JetBrains Mono, Iosevka Term, Terminus or the system's monospace font with a size — and the
notifications. They live in your settings on the hub you came in through
([settings.md](settings.md)), so every app of yours looks the same.

## On a phone

Phones type into extensions' terminal components (`ctx.ui.custom()`) through a strip of keys and
a field; their mouse is a tap.
