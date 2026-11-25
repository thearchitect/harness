// `harness hub user|device|node …` (administration of the hub's users, devices and nodes) and
// `harness remote …` (the client's connections). Secrets are printed once, never stored in clear.

import { parseArgs } from "node:util";
import { HubAuth } from "#node/auth.ts";
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

export function hubAdmin(home: string, args: string[]): void {
  const auth = new HubAuth(home);
  const [subject, verb, ...rest] = args;
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { admin: { type: "boolean" }, name: { type: "string" }, users: { type: "string" } } });
  switch (`${subject ?? ""} ${verb ?? ""}`) {
    case "user add":
      auth.addUser(positionals[0] ?? usage("harness hub user add <name> [--admin]"), values.admin === true);
      print(`user ${positionals[0]} added`);
      break;
    case "user remove":
      auth.removeUser(positionals[0] ?? usage("harness hub user remove <name>"));
      print(`user ${positionals[0]} removed with their devices`);
      break;
    case "user list":
      for (const user of auth.users()) {
        print(`${user.name}${user.admin ? " (admin)" : ""}`);
      }
      break;
    case "device add": {
      const user = positionals[0] ?? usage("harness hub device add <user> --name <device>");
      const { token } = auth.addDevice(user, values.name ?? usage("harness hub device add <user> --name <device>"));
      print(`device ${values.name} of ${user}; its token (shown once):\n${token}\non the device: harness remote add <name> <hub url>, then paste the token`);
      break;
    }
    case "device revoke":
      auth.revokeDevice(positionals[0] ?? usage("harness hub device revoke <user> --name <device>"), values.name ?? usage("harness hub device revoke <user> --name <device>"));
      print("revoked");
      break;
    case "device list":
      for (const device of auth.devices()) {
        print(`${device.user}\t${device.name}\t${new Date(device.created).toISOString()}`);
      }
      break;
    case "node add": {
      const name = positionals[0] ?? usage("harness hub node add <name> --users a,b");
      const users = (values.users ?? "").split(",").filter((user) => user !== "");
      const { key } = auth.addNode(name, users);
      print(`node ${name} for ${users.join(", ")}; its key (shown once):\n${key}\non the node: put it in ~/.harness/nodes/<node>.json as hubs[].key`);
      break;
    }
    case "node revoke":
      auth.revokeNode(positionals[0] ?? usage("harness hub node revoke <name>"));
      print("revoked");
      break;
    case "node list":
      for (const node of auth.nodes()) {
        print(`${node.name}\t${node.users.join(",")}`);
      }
      break;
    default:
      usage("harness hub user add|remove|list, device add|revoke|list, node add|revoke|list");
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
        const token = process.env.HARNESS_TOKEN ?? (await readHidden(`device token for ${name}: `));
        if (token === "") {
          throw new Error("no token given");
        } else {
          writeRemotes(home, [...remotes.filter((remote) => remote.name !== name), { name, url, token }]);
          print(`remote ${name} added`);
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
