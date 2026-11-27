// Who may reach the hub over the network: the user's devices (a token per device, stored as a
// sha-256 hash, shown once) and the one-time codes that pair new ones. The hub is single-user: a
// paired device is that user. Files under ~/.harness/hub/, written atomically, readable only by
// their owner.
//
// A code lasts PAIRING_TTL_MS and pairs once. Guessing is bounded twice: an address gets
// FAILURES_PER_ADDRESS wrong codes per PAIRING_TTL_MS, and after FAILURES_PER_CODE wrong codes in
// all while codes are open every open code is withdrawn (the operator makes a new one).

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessError } from "#protocol/errors.ts";
import type { DeviceInfo, PairingInfo } from "#protocol/hub.ts";

export type HubDevice = { name: string; tokenHash: string; created: number; lastSeen?: number; address?: string };

/** A code made for a device: its hash, when it expires, the device's name (or the one it pairs with), and when used, by which device. */
type HubPairing = { id: string; codeHash: string; expires: number; name?: string; used?: string };

type HubData = { devices: HubDevice[]; pairings: HubPairing[] };

/** How long a pairing code lasts. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;
/** Wrong codes an address may send per PAIRING_TTL_MS. */
export const FAILURES_PER_ADDRESS = 5;
/** Wrong codes in all, while codes are open, before every open code is withdrawn. */
export const FAILURES_PER_CODE = 5;

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

/** A device's name as shown: printable, 1 to 64 characters, trimmed. */
export function deviceName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > 64 || /\p{Cc}/u.test(trimmed)) {
    throw new HarnessError("invalid_record", `device name ${JSON.stringify(name)}: 1 to 64 printable characters`);
  } else {
    return trimmed;
  }
}

export class HubAuth {
  private readonly dir: string;
  /** Wrong codes per address, with when the first of them came. */
  private readonly failures = new Map<string, { count: number; since: number }>();
  /** Wrong codes in all since the open codes were made. */
  private failuresWhileOpen = 0;

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

  devices(): DeviceInfo[] {
    return this.read("devices").map(({ name, created, lastSeen, address }) => ({ name, created, ...(lastSeen !== undefined ? { lastSeen } : {}), ...(address !== undefined ? { address } : {}) }));
  }

  /** The codes still open, and the ones used, until they would have expired. */
  pairings(now: number): PairingInfo[] {
    return this.read("pairings")
      .filter((pairing) => pairing.expires > now)
      .map(({ id, expires, name, used }) => ({ id, expires, ...(name !== undefined ? { name } : {}), ...(used !== undefined ? { used } : {}) }));
  }

  /** A device; the token is returned once and only its hash is kept. A name taken already gets a number. */
  addDevice(name: string, now: number): { device: string; token: string } {
    const wanted = deviceName(name);
    const devices = this.read("devices");
    const taken = new Set(devices.map((device) => device.name));
    let unique = wanted;
    for (let n = 2; taken.has(unique); n += 1) {
      unique = `${wanted} ${n}`;
    }
    const token = newSecret();
    this.write("devices", [...devices, { name: unique, tokenHash: hashSecret(token), created: now }]);
    return { device: unique, token };
  }

  renameDevice(name: string, to: string): void {
    const devices = this.read("devices");
    const next = deviceName(to);
    if (!devices.some((device) => device.name === name)) {
      throw new HarnessError("not_found", `no device ${name}`);
    } else if (next !== name && devices.some((device) => device.name === next)) {
      throw new HarnessError("conflict", `a device is named ${next} already`);
    } else {
      this.write("devices", devices.map((device) => (device.name === name ? { ...device, name: next } : device)));
    }
  }

  revokeDevice(name: string): void {
    const devices = this.read("devices");
    if (!devices.some((device) => device.name === name)) {
      throw new HarnessError("not_found", `no device ${name}`);
    } else {
      this.write("devices", devices.filter((device) => device.name !== name));
    }
  }

  /**
   * A code for a new device, to exchange for its token (`redeemPairing`) within PAIRING_TTL_MS;
   * `name`: the device's, or the one it gives when it pairs.
   */
  addPairing(name: string | undefined, now: number): { id: string; code: string; expires: number } {
    const named = name !== undefined ? deviceName(name) : undefined;
    const code = newPairingCode();
    const pairing: HubPairing = { id: randomUUID(), codeHash: hashSecret(normalCode(code)), expires: now + PAIRING_TTL_MS, ...(named !== undefined ? { name: named } : {}) };
    if (!this.read("pairings").some((open) => open.expires > now && open.used === undefined)) {
      this.failuresWhileOpen = 0;
    } else {
      // more codes open: the count of wrong ones goes on
    }
    this.write("pairings", [...this.read("pairings").filter((open) => open.expires > now), pairing]);
    return { id: pairing.id, code, expires: pairing.expires };
  }

  /**
   * Exchanges a pairing code for a new device's token, once. `address`: where the code came from
   * (wrong codes are counted by it); `name`: the device's own name when the code has none.
   */
  redeemPairing(code: string, now: number, address: string, name?: string): { device: string; token: string; pairing: string } {
    const failure = this.failures.get(address);
    const fresh = failure !== undefined && now - failure.since < PAIRING_TTL_MS ? failure : { count: 0, since: now };
    const hash = hashSecret(normalCode(code));
    const pairings = this.read("pairings");
    const found = pairings.find((pairing) => sameHash(pairing.codeHash, hash) && pairing.used === undefined);
    if (fresh.count >= FAILURES_PER_ADDRESS) {
      throw new HarnessError("unauthorized", "too many wrong pairing codes from this address: try again later");
    } else if (found === undefined || found.expires <= now) {
      this.failures.set(address, { count: fresh.count + 1, since: fresh.since });
      this.failuresWhileOpen += 1;
      if (this.failuresWhileOpen >= FAILURES_PER_CODE) {
        this.write("pairings", pairings.filter((pairing) => pairing.used !== undefined && pairing.expires > now));
        this.failuresWhileOpen = 0;
      } else {
        // the open codes stay
      }
      throw new HarnessError("unauthorized", found === undefined ? "unknown pairing code: ask for a new one (/hub, add device)" : "the pairing code expired: ask for a new one (/hub, add device)");
    } else {
      const added = this.addDevice(found.name ?? name ?? "device", now);
      this.write("pairings", this.read("pairings").map((pairing) => (pairing.id === found.id ? { ...pairing, used: added.device } : pairing)));
      return { ...added, pairing: found.id };
    }
  }

  /** The device a token belongs to; its last connection is noted (when, from where). */
  deviceOfToken(token: string, now: number, address: string): string {
    const hash = hashSecret(token);
    const devices = this.read("devices");
    const device = devices.find((candidate) => sameHash(candidate.tokenHash, hash));
    if (device === undefined) {
      throw new HarnessError("unauthorized", "unknown device token: this device was revoked or never paired; pair it again");
    } else {
      this.write("devices", devices.map((candidate) => (candidate === device ? { ...candidate, lastSeen: now, address } : candidate)));
      return device.name;
    }
  }
}
