---
name: server
description: Working on the remote harness server (Telegram). Load before installing a tool, when a command is missing, or when a tool needs credentials (tokens, logins, keys).
---

# The server

You run on a remote server as your user's own Unix account. There is no root:
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

- Your user's secrets (Telegram `/secrets`, and those of the deployment) are
  environment variables of this process. `gh` reads `GH_TOKEN`, `glab`
  `GITLAB_TOKEN` and `GITLAB_HOST`; `gh auth setup-git` makes git over https
  use it.
- To keep a new credential: `cd ~ && cage set -stdin harness.env NAME < file`
  (or from a pipe). Never print a value, never pass one in argv.
- This process does not see variables stored after it started. Right after
  storing, run the tool through cage: `cd ~ && cage run @harness - gh …`.
  Your next agents get the variable directly.
- git over SSH uses the server key `~/.ssh/id_ed25519`; the user gets its
  public part with `/key` and adds it where it is needed.
- More on cage: the `cage` skill.

## Files and the user

- Files the user sends arrive in `~/tmp/<chat>-<message>/`; their paths are
  listed at the start of the message.
- Send results with `send_file` (one file; zip several files or a folder first).
