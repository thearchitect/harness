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

## What the browser adds

- The page title and icon show `◆ N` while N sessions wait for you.
- The address names the active session (`#/<node>/<session>`): bookmarks and back/forward move
  between sessions.
- Files dropped on the window go to the session's node (`~/.harness/uploads/`) and into the
  message as `@path`.
- Notifications (off by default, `/settings`) when a session starts waiting and the window is not
  in front.
- The strips' widths change by dragging their edges (`ui.web.panes`).

## Settings

`/settings` in the app has the theme (shared with the TUI), the fonts of its two zones —
`ui.font.chat` (transcript and editor) and `ui.font.chrome` (strips, lists, footer, dialogs), each
JetBrains Mono, Iosevka Term, Terminus or the system's monospace font with a size — and the
notifications. They live in your settings on the node or hub you came in through
([settings.md](settings.md)), so every app of yours looks the same.

## What it cannot show

Dialogs that extensions draw as terminal components (`ctx.ui.custom()`) exist only in terminals:
the app says so in the editor's place; answer them in the TUI.
