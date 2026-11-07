---
name: cage
description: Secrets kept with cage (`.cage/`, `cage run`, `cage set`, encrypted .env files and keys). Load before inspecting, creating, changing or using secrets, or wiring them into a deployment.
---

# cage

`cage` (bundled with harness) keeps secrets as age-encrypted files in a
project's `.cage/` and runs commands with them without exposing values.

1. Run `cage skill` and follow it: the commands to inspect, set, generate,
   move and use secrets without ever seeing their values.
2. For servers, systemd services, NixOS or deployments, also run
   `cage skill infra`.

The rule above everything else: a secret value never enters your context,
the chat or a tool output — no `cat` of plaintext secrets, no values in
command lines, no `cage run -no-mask` or `cage dump -o /dev/stdout`.
