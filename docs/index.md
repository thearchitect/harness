# harness documentation

harness is a multi-session coding agent platform on pi: nodes run agents (pi sessions with the
harness extension), a hub connects nodes and devices, the TUI (`harness`) and the app are clients
of one protocol. These documents describe what harness adds or changes; for pi's own contracts
they link to pi's documents of the version in this bundle (`../pi/coding-agent/docs/`), read with
the translations in [pi-mapping.md](pi-mapping.md).

## Which document for which task

| Task | Read |
|---|---|
| Understand the parts, processes and boundaries | [architecture.md](architecture.md) |
| Read a pi document correctly in harness (paths, commands, replaced APIs) | [pi-mapping.md](pi-mapping.md) |
| Write a tool or an extension that works with every client | [extending/tools.md](extending/tools.md) |
| Add a skill | [extending/skills.md](extending/skills.md) |
| Add a subagent profile, understand the engines | [extending/subagents.md](extending/subagents.md) |
| Add or change a theme | [extending/themes.md](extending/themes.md) |
| Name a model without its version | [extending/models.md](extending/models.md) |
| Test a change, look at the screens, drive a stand | [extending/testkit.md](extending/testkit.md) |
| Talk to an agent (records, snapshot and stream) | [protocol/hap.md](protocol/hap.md), [reference](protocol/reference/hap.md) |
| Talk to a node or a hub | [protocol/node.md](protocol/node.md), [protocol/hub.md](protocol/hub.md), [reference](protocol/reference/node.md) |
| Run nodes and a hub, pair devices | [operations/nodes.md](operations/nodes.md) |
| NixOS | [operations/nixos.md](operations/nixos.md) |
| Fly.io | [operations/fly.md](operations/fly.md) |
| Settings and files in `~/.harness` | [operations/settings.md](operations/settings.md) |

## Sources

The sources ship next to these documents (`../src/`): `packages/<name>/src/`, each package with
its own responsibility ([architecture.md](architecture.md#packages)). The pi packages' type
declarations (`../pi/<package>/dist/*.d.ts`) are the contract of the pi API.
