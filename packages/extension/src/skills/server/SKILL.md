---
name: server
description: Working on a shared harness server (a node of the Fly image). Load before installing a tool, when a command is missing, or when a tool needs credentials (tokens, logins, keys).
---

# The server

You run on a shared server as your user's own Unix account. There is no root:
no `sudo`, no `apt`, no `nix`. Your home (`~`) persists across restarts and
deploys; everything outside it is reset on every deploy.

## Installed

git, gh, glab, cage, curl, jq, ripgrep, file, zip/unzip, xz;
go, rustc/cargo (clippy, rustfmt), zig, gcc, make, pkg-config;
python3 (with pydicom, numpy, pillow), uv, node;
ffmpeg, ImageMagick (`magick`), exiftool, dcmtk (`dcmdump`, `dcmj2pnm`, …);
mise.

## Installing more

Everything goes into `~`, already on `PATH`, and survives deploys:

- `mise use -g <tool>@<version>` — most CLIs and runtimes (`mise use -g node@24`,
  `mise use -g terraform@latest`); `mise exec <tool>@<version> -- <cmd>` for a
  one-off. Prebuilt binaries run (the image has a dynamic loader for them).
- `uv tool install <package>` — Python CLIs; `uv run --with <pkg> python …`
  for one-off scripts.
- `npm install -g <package>` — Node CLIs (prefix `~/.local`).
- `cargo install <crate>`, `go install <module>@latest`.
- A single binary: put it in `~/.local/bin`.

## Credentials

- Your user's secrets of the deployment (its cage env) are environment
  variables of this process. `gh` reads `GH_TOKEN`, `glab` `GITLAB_TOKEN` and
  `GITLAB_HOST`; `gh auth setup-git` makes git over https use it.
- A secret the user gives you in this session: `ask_secret` (only when the user
  tells you to ask).
- To keep a credential across sessions: `cd ~ && cage set -stdin harness.env NAME < file`
  (or from a pipe). Never print a value, never pass one in argv. This process
  does not see variables stored after it started: run the tool through cage
  (`cd ~ && cage run @harness - gh …`). More on cage: the `cage` skill.
- git over SSH: make a key in `~/.ssh` (`ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519`)
  and give the user its public part to add where it is needed.

## Files and the user

- Files the user hands you (pasted, dropped, picked) arrive in
  `~/.harness/hub/attachments/<session>/`; their paths are in the message as `@path`.
- Send results with `send_file` (one file; zip several files or a folder first).
