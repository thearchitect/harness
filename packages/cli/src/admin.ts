// `harness hub device …` (the devices paired with the user's hub) and `harness remote …` (the
// client's connections to other machines' hubs). Secrets are printed once, never stored in clear.

import { parseArgs } from "node:util";
import { HubAuth, PAIRING_TTL_MS } from "#hub/auth.ts";
import { readHubConfig } from "#hub/config.ts";
import { readRemotes, writeRemotes } from "./remotes.ts";

function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

function usage(text: string): never {
  throw new Error(`usage: ${text}`);
}

async function readHidden(prompt: string): Promise<string> {
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

/** The link that pairs a device: the hub's web app with the code in its fragment (never in a request line). */
export function pairingLink(url: string, code: string): string {
  return `${url.replace(/^ws/, "http").replace(/\/$/, "")}/#pair=${encodeURIComponent(code)}`;
}

/** A pairing code exchanged at the hub (POST /pair) for this device's token. */
export async function redeemPairing(url: string, code: string): Promise<{ device: string; token: string }> {
  const response = await fetch(`${url.replace(/^ws/, "http").replace(/\/$/, "")}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json()) as { device: string; token: string } | { error: { message: string } };
  if ("error" in body) {
    throw new Error(body.error.message);
  } else {
    return body;
  }
}

async function qrTerminal(text: string): Promise<string> {
  const { toString } = await import("qrcode");
  return toString(text, { type: "terminal", small: true });
}

export async function hubAdmin(home: string, args: string[]): Promise<void> {
  const auth = new HubAuth(home);
  const [subject, verb, ...rest] = args;
  const { values } = parseArgs({ args: rest, allowPositionals: true, options: { name: { type: "string" }, url: { type: "string" } } });
  switch (`${subject ?? ""} ${verb ?? ""}`) {
    case "device add": {
      const device = values.name ?? usage("harness hub device add --name <device> [--url <hub address>]");
      const code = auth.addPairing(device, Date.now());
      const url = values.url ?? readHubConfig(home, "default").hub?.url;
      print(`device ${device}: its pairing code, once and for ${PAIRING_TTL_MS / 60_000} minutes:\n  ${code}`);
      print("on a terminal: harness remote add <name> <hub url>, then enter the code");
      if (url !== undefined) {
        // the app: this link (or its QR code) pairs the device and opens the hub
        const link = pairingLink(url, code);
        print(`in the app or a browser: ${link}`);
        print(await qrTerminal(link));
      } else {
        print("in the app: enter the code (or give --url <hub address> for a pairing link and QR code)");
      }
      break;
    }
    case "device revoke":
      auth.revokeDevice(values.name ?? usage("harness hub device revoke --name <device>"));
      print("revoked");
      break;
    case "device list":
      for (const device of auth.devices()) {
        print(`${device.name}\t${new Date(device.created).toISOString()}`);
      }
      break;
    default:
      usage("harness hub device add|revoke|list");
  }
}

export async function remoteAdmin(home: string, args: string[]): Promise<void> {
  const [verb, name, url] = args;
  const remotes = readRemotes(home);
  switch (verb) {
    case "add": {
      if (name === undefined || url === undefined || !/^wss?:\/\//.test(url)) {
        usage("harness remote add <name> <ws(s)://hub>");
      } else {
        const code = process.env.HARNESS_PAIRING_CODE ?? (await readHidden(`pairing code for ${name} (harness hub device add): `));
        if (code === "") {
          throw new Error("no pairing code given");
        } else {
          const { device, token } = await redeemPairing(url, code);
          writeRemotes(home, [...remotes.filter((remote) => remote.name !== name), { name, url, token }]);
          print(`remote ${name} added as device ${device}`);
        }
      }
      break;
    }
    case "remove":
      writeRemotes(home, remotes.filter((remote) => remote.name !== name));
      print(`remote ${name ?? ""} removed`);
      break;
    case "list":
      for (const remote of remotes) {
        print(`${remote.name}\t${remote.url}`);
      }
      break;
    default:
      usage("harness remote add|remove|list");
  }
}
