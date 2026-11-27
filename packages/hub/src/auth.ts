// Who may reach the hub over the network: the user's devices (a token per device, stored as a
// sha-256 hash, shown once) and the one-time codes that pair new ones. The hub is single-user: a
// paired device is that user. Files under ~/.harness/hub/, written atomically, readable only by
// their owner.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessError } from "#protocol/errors.ts";

export type HubDevice = { name: string; tokenHash: string; created: number };

/** A device not paired yet: its one-time code (hashed) and when the code expires. */
export type HubPairing = { device: string; codeHash: string; expires: number };

type HubData = { devices: HubDevice[]; pairings: HubPairing[] };

/** How long a pairing code lasts. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;

/** Crockford's base32 without I, L, O, U: a code read from a screen and typed on a phone. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A pairing code: 15 characters in three groups (75 bits), once and for ten minutes. */
export function newPairingCode(): string {
  const bytes = randomBytes(15);
  const chars = [...bytes].map((byte) => CODE_ALPHABET[byte % 32] ?? "0").join("");
  return `${chars.slice(0, 5)}-${chars.slice(5, 10)}-${chars.slice(10, 15)}`;
}

/** A code as typed: case, spaces and dashes do not matter. */
function normalCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

/** A new secret: 256 bits, URL-safe. */
export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function checkName(name: string): void {
  if (!NAME.test(name)) {
    throw new HarnessError("invalid_record", `device name ${JSON.stringify(name)}: use a-z, 0-9, ".", "_", "-" (up to 64)`);
  } else {
    // a valid name
  }
}

export class HubAuth {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "hub");
  }

  private read<K extends keyof HubData>(key: K): HubData[K] {
    try {
      return JSON.parse(readFileSync(join(this.dir, `${key}.json`), "utf8")) as HubData[K];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [] as HubData[K];
      } else {
        throw error;
      }
    }
  }

  private write<K extends keyof HubData>(key: K, value: HubData[K]): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, `${key}.json`);
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  }

  devices(): HubDevice[] {
    return this.read("devices");
  }

  /** A device; the token is returned once and only its hash is kept. Pairing a name again replaces it. */
  addDevice(name: string): { device: HubDevice; token: string } {
    checkName(name);
    const token = newSecret();
    const device = { name, tokenHash: hashSecret(token), created: Date.now() };
    this.write("devices", [...this.devices().filter((candidate) => candidate.name !== name), device]);
    return { device, token };
  }

  revokeDevice(name: string): void {
    this.write("devices", this.devices().filter((device) => device.name !== name));
  }

  /**
   * A device to pair: a one-time code that the device exchanges for its token (`redeemPairing`)
   * within PAIRING_TTL_MS. Pairing again before then replaces the code.
   */
  addPairing(device: string, now: number): string {
    checkName(device);
    const code = newPairingCode();
    const kept = this.read("pairings").filter((pairing) => pairing.expires > now && pairing.device !== device);
    this.write("pairings", [...kept, { device, codeHash: hashSecret(normalCode(code)), expires: now + PAIRING_TTL_MS }]);
    return code;
  }

  /** Exchanges a pairing code for the device's token, once: the code is gone afterwards. */
  redeemPairing(code: string, now: number): { device: string; token: string } {
    const hash = hashSecret(normalCode(code));
    const pairings = this.read("pairings");
    const found = pairings.find((pairing) => sameHash(pairing.codeHash, hash));
    this.write("pairings", pairings.filter((pairing) => pairing !== found && pairing.expires > now));
    if (found === undefined) {
      throw new HarnessError("unauthorized", "unknown pairing code: ask for a new one (harness hub device add)");
    } else if (found.expires <= now) {
      throw new HarnessError("unauthorized", "the pairing code expired: ask for a new one (harness hub device add)");
    } else {
      const { token } = this.addDevice(found.device);
      return { device: found.device, token };
    }
  }

  /** The device a token belongs to. */
  deviceOfToken(token: string): string {
    const hash = hashSecret(token);
    const device = this.devices().find((candidate) => sameHash(candidate.tokenHash, hash));
    if (device === undefined) {
      throw new HarnessError("unauthorized", "unknown device token: pair this device again");
    } else {
      return device.name;
    }
  }
}
