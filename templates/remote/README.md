# Remote harness

A [harness](https://github.com/thearchitect/harness) agent on a Fly.io
machine, used through a Telegram bot: every whitelisted user works in their
own home under their own uid; every topic of the private chat with the bot is
one pi session. Created with `nix flake init -t github:thearchitect/harness#remote`.

- `remote.yaml` — the bot, the users (whitelist), limits, initial pi settings
- `.cage/` — secrets ([cage](https://github.com/themakers/cage)): the bot token
  and webhook secret for the machine, the users' API keys, the deploy token
- `fly.toml` — one machine with a volume; it sleeps when idle and a webhook
  wakes it
- `bootstrap.sh` — creates the Fly app, volume, machine secret, deploy token
- `deploy.sh` — builds the image (`nix build .#image`) and deploys it
- `.github/workflows/deploy.yml` — deploys every push to master

## Setup

Inside `nix develop` (flyctl, skopeo, cage):

1. **Bot.** Create it with @BotFather; in its Mini App turn on *Threaded
   Mode* (topics in private chats) and let users create topics.
2. **Configuration.** Edit `remote.yaml` (app URL, users with their numeric
   Telegram ids and SSH public keys) and `fly.toml` (`app`, region).
3. **Secrets.** Edit `.cage/cage.yaml` (keys), then:
   ```bash
   cage keygen -comment fly-machine ops:fly-machine-identity   # → recipients.fly-machine
   cage keygen -comment actions-ci ops:ci-cage-identity        # → recipients.actions-ci
   cage set -stdin telegram.env TELEGRAM_BOT_TOKEN < token.txt && rm token.txt
   cage set -gen random:alnum:48 telegram.env TELEGRAM_WEBHOOK_SECRET
   cage set -stdin alice:llm.env DEEPSEEK_API_KEY < key.txt && rm key.txt
   ```
4. **Fly.** `flyctl auth login`, then `./bootstrap.sh`.
5. **Repository and CI.** Commit, push to a private repository, and give CI
   its identity without printing it:
   ```bash
   cage dump -o ci.key ops:ci-cage-identity && gh secret set CAGE_SSH_IDENTITY < ci.key; rm ci.key
   ```
6. **Deploy.** `cage run @root - ./deploy.sh` (or push).
7. **Users.** Each user writes to the bot; the ⚙️ Account topic shows their
   server SSH key (👤 Key). Add it as their `server-<name>` recipient,
   `cage encrypt`, commit: their API keys reach their sessions from then on.
   They can also keep secrets of their own (🔐 Secrets) and log in to OAuth
   providers (🔑 Login) from Telegram.

## Using it

- Write a task in a new topic (or in All): pick the directory with one tap,
  the agent plans. The pinned card switches the next message to 🔨 Build;
  `!` before a message builds too; 🔨 Build under a plan implements it.
- Write while the agent works to steer it; ⏹ stops it.
- Write/edit confirmations come as buttons; a text instead of a button
  rejects with that text as the reason.
