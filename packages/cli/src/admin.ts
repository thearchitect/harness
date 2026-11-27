// The command line of the hub and of a client's hubs:
//   harness hub device add|list|rename|revoke   the devices paired with this machine's hub
//   harness hub network [on|off] [--listen h:p] [--proxy|--no-proxy] [--url U]   its network access
//   harness connect <ssh://[user@]host[:port] | https://hub/#pair=<code> | https://hub>   another hub
//   harness remote list|remove <name>           the hubs this client connects to
// The hub's commands go to the running hub (they act at once: a revoked device is disconnected);
// secrets are printed once, never stored in clear.

import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { HubConnection } from "#client/connection.ts";
import { PAIRING_TTL_MS } from "#hub/auth.ts";
import { socketAlive, socketPath } from "#hub/endpoints/unix.ts";
import { sshTransport, unixTransport } from "#hub/endpoints/transports.ts";
import type { HubStatus } from "#protocol/hub.ts";
import { addRemote, readRemotes, writeRemotes } from "./remotes.ts";

function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

function usage(text: string): never {
  throw new Error(`usage: ${text}`);
}

async function readLine(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
    if (String(chunk).includes("\n")) {
      break;
    } else {
      // keep reading the line
    }
  }
  return Buffer.concat(chunks).toString("utf8").split("\n")[0]?.trim() ?? "";
}

/** A pairing code exchanged at the hub (POST /pair) for this device's token; `name`: this device's. */
export async function redeemPairing(url: string, code: string, name?: string): Promise<{ device: string; token: string }> {
  const response = await fetch(`${url.replace(/^ws/, "http").replace(/\/$/, "")}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, ...(name !== undefined ? { name } : {}) }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json()) as { device: string; token: string } | { error: { message: string } };
  if ("error" in body) {
    throw new Error(body.error.message);
  } else {
    return body;
  }
}

/** A QR code in the terminal: two modules per character (half blocks). */
export async function qrTerminal(text: string): Promise<string> {
  const { toString } = await import("qrcode");
  return toString(text, { type: "terminal", small: true });
}

/** The running hub of this machine, for its commands. */
async function localHub(home: string): Promise<HubConnection> {
  const path = socketPath(home, "default");
  if (!(await socketAlive(path))) {
    throw new Error(`no hub runs for ${process.env.USER ?? "this user"}@${hostname()} (start the service, or open harness)`);
  } else {
    return await HubConnection.open(await unixTransport(path), "cli");
  }
}

function printStatus(status: HubStatus): void {
  const { network } = status;
  const state = !network.enabled ? "off" : network.running ? "on" : `not running: ${network.problem ?? "starting"}`;
  print(`network: ${state} — listen ${network.listen}${network.proxy ? " behind a proxy" : ""}${network.url !== undefined ? `, ${network.url}` : ""}${network.source === "service" ? " (set by the service)" : ""}`);
  for (const device of status.devices) {
    const seen = device.lastSeen !== undefined ? `last ${new Date(device.lastSeen).toISOString()}${device.address !== undefined ? ` from ${device.address}` : ""}` : "never connected";
    print(`device ${device.name}\tpaired ${new Date(device.created).toISOString()}\t${device.connected ? "connected" : seen}`);
  }
}

export async function hubAdmin(home: string, args: string[]): Promise<void> {
  const [subject, verb, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    allowPositionals: false,
    options: { name: { type: "string" }, to: { type: "string" }, listen: { type: "string" }, proxy: { type: "boolean" }, "no-proxy": { type: "boolean" }, url: { type: "string" } },
  });
  const hub = await localHub(home);
  try {
    switch (`${subject ?? ""} ${verb ?? ""}`.trim()) {
      case "device add": {
        const pairing = await hub.request("device_pair", values.name !== undefined ? { name: values.name } : {});
        print(`a pairing code, once and for ${PAIRING_TTL_MS / 60_000} minutes:\n  ${pairing.code}`);
        if (pairing.link !== undefined) {
          // a browser, the app's camera, or `harness connect <link>` on another machine
          print(`the link (open it, scan it, or harness connect it): ${pairing.link}`);
          print(await qrTerminal(pairing.link));
        } else {
          print("the hub has no address for links yet: harness hub network --url <its address>; meanwhile harness connect <its address> and type the code");
        }
        break;
      }
      case "device list":
        printStatus(await hub.request("hub_status", {}));
        break;
      case "device rename":
        await hub.request("device_rename", { name: values.name ?? usage("harness hub device rename --name <device> --to <name>"), to: values.to ?? usage("harness hub device rename --name <device> --to <name>") });
        print("renamed");
        break;
      case "device revoke":
        await hub.request("device_revoke", { name: values.name ?? usage("harness hub device revoke --name <device>") });
        print("revoked: its connections are closed");
        break;
      case "network":
      case "network on":
      case "network off": {
        const change = {
          ...(verb === "on" ? { enabled: true } : verb === "off" ? { enabled: false } : {}),
          ...(values.listen !== undefined ? { listen: values.listen } : {}),
          ...(values.proxy === true ? { proxy: true } : values["no-proxy"] === true ? { proxy: false } : {}),
          ...(values.url !== undefined ? { url: values.url } : {}),
        };
        printStatus(Object.keys(change).length > 0 ? await hub.request("hub_network_set", change) : await hub.request("hub_status", {}));
        break;
      }
      default:
        usage("harness hub device add|list|rename|revoke, harness hub network [on|off] [--listen h:p] [--proxy|--no-proxy] [--url U]");
    }
  } finally {
    hub.close();
  }
}

/**
 * `harness connect <address>`: another machine's hub, kept in remotes.json.
 * - ssh://[user@]host[:port]: run in a terminal (ssh may ask once for a host key or a passphrase);
 *   the hub there must be running; `--command`: the harness there when it is not on ssh's PATH;
 * - https://hub/#pair=<code> (a pairing link), or https://hub and the code typed: this device is
 *   paired and keeps its token.
 */
export async function connect(home: string, args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { name: { type: "string" }, command: { type: "string" } } });
  const address = positionals[0] ?? usage("harness connect <ssh://[user@]host[:port] | https://hub/#pair=<code> | https://hub> [--name N] [--command C]");
  const url = new URL(address);
  if (url.protocol === "ssh:") {
    const ssh = `${url.username !== "" ? `${decodeURIComponent(url.username)}@` : ""}${url.hostname}${url.port !== "" ? `:${url.port}` : ""}`;
    const target = { ssh, ...(values.command !== undefined ? { command: values.command } : {}) };
    const connection = await HubConnection.open(await sshTransport(target, true), "cli");
    const name = values.name ?? url.hostname;
    connection.close();
    addRemote(home, { name, ...target });
    print(`hub ${name} added: ${ssh} over SSH (harness ${connection.welcome?.harness ?? "?"} there)`);
  } else if (url.protocol === "https:" || url.protocol === "http:") {
    const fragment = new URLSearchParams(url.hash.slice(1));
    const code = fragment.get("pair") ?? process.env.HARNESS_PAIRING_CODE ?? (await readLine(`pairing code for ${url.host} (/hub, add device): `));
    if (code === "") {
      throw new Error("no pairing code given");
    } else {
      const base = `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}`;
      const { device, token } = await redeemPairing(base, code, hostname());
      const name = values.name ?? url.hostname;
      addRemote(home, { name, url: base, token });
      print(`hub ${name} added: this device is ${device} there`);
    }
  } else {
    usage("harness connect <ssh://[user@]host[:port] | https://hub/#pair=<code> | https://hub>");
  }
}

export async function remoteAdmin(home: string, args: string[]): Promise<void> {
  const [verb, name] = args;
  const remotes = readRemotes(home);
  switch (verb) {
    case "remove":
      writeRemotes(home, remotes.filter((remote) => remote.name !== name));
      print(`remote ${name ?? ""} removed`);
      break;
    case "list":
      for (const remote of remotes) {
        print(`${remote.name}\t${"ssh" in remote ? `ssh://${remote.ssh}` : remote.url}`);
      }
      break;
    default:
      usage("harness remote list|remove <name> (harness connect adds one)");
  }
}
