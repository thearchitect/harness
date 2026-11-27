// The /hub dialog, the same model in every UI: a hub's network access and its paired devices, and
// adding a device (a name, then a one-time code with its link and QR code, and whether it was used
// or expired). ↑/↓ choose a row, Enter acts on it, ← goes back a screen, Esc closes. Rows that take
// text (the address, the link's address, a device's new name, the new device's name) are fields:
// typing goes into them, Enter applies.

import type { HubStatus } from "#protocol/hub.ts";

/** A pairing made here: its code, its link (when the hub knows its address) and its QR code. */
export type DialogPairing = { id: string; code: string; expires: number; link?: string; qr?: { size: number; modules: string } };

export type HubDialogRow =
  | { kind: "network"; label: string; on: boolean; locked: boolean }
  | { kind: "field"; id: "listen" | "url" | "rename" | "name"; label: string; value: string; locked: boolean }
  | { kind: "toggle"; id: "proxy"; label: string; on: boolean; locked: boolean }
  | { kind: "device"; name: string; detail: string; connected: boolean }
  | { kind: "action"; id: "add" | "copy" | "again" | "revoke" | "keep"; label: string };

export type HubDialogScreen = { kind: "main" } | { kind: "device"; name: string } | { kind: "add" } | { kind: "pairing"; pairing: DialogPairing };

export type HubDialogDeps = {
  status(): Promise<HubStatus>;
  network(change: { enabled?: boolean; listen?: string; proxy?: boolean; url?: string }): Promise<HubStatus>;
  pair(name: string | undefined): Promise<DialogPairing>;
  rename(name: string, to: string): Promise<HubStatus>;
  revoke(name: string): Promise<HubStatus>;
  copy(text: string): void;
  now(): number;
  changed(): void;
  notify(message: string): void;
  close(): void;
};

function since(now: number, at: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : minutes < 48 * 60 ? `${Math.floor(minutes / 60)} h ago` : `${Math.floor(minutes / 1440)} days ago`;
}

function clock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export class HubDialog {
  readonly hub: string;
  private readonly deps: HubDialogDeps;
  status: HubStatus | undefined;
  screen: HubDialogScreen = { kind: "main" };
  selected = 0;
  /** What the selected field holds while it is typed (applied with Enter). */
  draft: string | undefined;
  error: string | undefined;

  constructor(hub: string, deps: HubDialogDeps) {
    this.hub = hub;
    this.deps = deps;
    void this.refresh();
  }

  async refresh(): Promise<void> {
    await this.run(async () => {
      this.status = await this.deps.status();
    });
  }

  /** The hub's status changed (a device paired or connected, the network started). */
  update(status: HubStatus): void {
    this.status = status;
    this.selected = Math.min(this.selected, Math.max(0, this.rows().length - 1));
  }

  title(): string {
    switch (this.screen.kind) {
      case "main":
        return `hub ${this.hub}`;
      case "device":
        return `device ${this.screen.name}`;
      case "add":
      case "pairing":
        return "add device";
      default:
        throw new Error(`unknown screen: ${JSON.stringify(this.screen satisfies never)}`);
    }
  }

  hint(): string {
    return this.screen.kind === "main" ? "↑↓ select · enter apply · esc close" : "↑↓ select · enter apply · ← back · esc close";
  }

  rows(): HubDialogRow[] {
    const status = this.status;
    const screen = this.screen;
    if (status === undefined) {
      return [];
    } else {
      switch (screen.kind) {
        case "main": {
          const { network } = status;
          const locked = network.source === "service";
          const state = !network.enabled ? "off" : network.running ? "on" : `off: ${network.problem ?? "starting"}`;
          const now = this.deps.now();
          return [
            { kind: "network", label: `network ${state}${locked ? " (set by the service)" : ""}`, on: network.enabled, locked },
            { kind: "field", id: "listen", label: "listen", value: network.listen, locked },
            { kind: "toggle", id: "proxy", label: "behind a TLS proxy", on: network.proxy, locked },
            { kind: "field", id: "url", label: "address for links", value: network.url ?? "", locked },
            ...status.devices.map(
              (device): HubDialogRow => ({
                kind: "device",
                name: device.name,
                connected: device.connected,
                detail: device.connected ? `connected${device.address !== undefined ? ` from ${device.address}` : ""}` : device.lastSeen !== undefined ? `seen ${since(now, device.lastSeen)}${device.address !== undefined ? ` from ${device.address}` : ""}` : `paired ${since(now, device.created)}, never connected`,
              }),
            ),
            { kind: "action", id: "add", label: "+ add device" },
          ];
        }
        case "device":
          return [
            { kind: "field", id: "rename", label: "name", value: screen.name, locked: false },
            { kind: "action", id: "revoke", label: "revoke: it is disconnected and cannot come back without pairing again" },
          ];
        case "add":
          return [{ kind: "field", id: "name", label: "name (empty: the device's own)", value: "", locked: false }];
        case "pairing":
          return [
            ...(screen.pairing.link !== undefined ? [{ kind: "action" as const, id: "copy" as const, label: "copy link" }] : []),
            { kind: "action", id: "again", label: "new code" },
          ];
        default:
          throw new Error(`unknown screen: ${JSON.stringify(screen satisfies never)}`);
      }
    }
  }

  /** The state of the code shown: open until when, used by whom, or expired. */
  pairingState(): { kind: "open"; until: string } | { kind: "used"; device: string } | { kind: "expired" } | undefined {
    const screen = this.screen;
    if (screen.kind !== "pairing") {
      return undefined;
    } else {
      const known = this.status?.pairings.find((pairing) => pairing.id === screen.pairing.id);
      return known?.used !== undefined ? { kind: "used", device: known.used } : this.deps.now() >= screen.pairing.expires ? { kind: "expired" } : { kind: "open", until: clock(screen.pairing.expires) };
    }
  }

  /** The text a field shows: its draft while typed, else its value. */
  fieldText(row: HubDialogRow & { kind: "field" }): string {
    const selected = this.rows()[this.selected];
    return this.draft !== undefined && selected?.kind === "field" && selected.id === row.id ? this.draft : row.value;
  }

  move(delta: number): void {
    const count = this.rows().length;
    this.selected = count === 0 ? 0 : (this.selected + delta + count) % count;
    this.draft = undefined;
    this.deps.changed();
  }

  /** Typing on a field row: what it holds now. */
  type(text: string): void {
    const row = this.rows()[this.selected];
    if (row?.kind === "field" && !row.locked) {
      this.draft = text;
      this.deps.changed();
    } else {
      // not a field: typing does nothing here
    }
  }

  async enter(): Promise<void> {
    const row = this.rows()[this.selected];
    const screen = this.screen;
    if (row === undefined) {
      return; // nothing to act on yet
    } else {
      switch (row.kind) {
        case "network":
          await this.unlocked(row.locked, () => this.deps.network({ enabled: !row.on }));
          break;
        case "toggle":
          await this.unlocked(row.locked, () => this.deps.network({ proxy: !row.on }));
          break;
        case "field":
          await this.applyField(row);
          break;
        case "device":
          this.go({ kind: "device", name: row.name });
          break;
        case "action":
          if (row.id === "add") {
            this.go({ kind: "add" });
          } else if (row.id === "copy" && screen.kind === "pairing" && screen.pairing.link !== undefined) {
            this.deps.copy(screen.pairing.link);
            this.deps.notify("the link is copied");
          } else if (row.id === "again") {
            await this.pair(undefined);
          } else if (row.id === "revoke" && screen.kind === "device") {
            const name = screen.name;
            await this.run(async () => {
              this.status = await this.deps.revoke(name);
              this.go({ kind: "main" });
            });
          } else {
            // an action of another screen
          }
          break;
        default:
          throw new Error(`unknown row: ${JSON.stringify(row satisfies never)}`);
      }
    }
  }

  private async applyField(row: HubDialogRow & { kind: "field" }): Promise<void> {
    const value = (this.draft ?? row.value).trim();
    const screen = this.screen;
    this.draft = undefined;
    switch (row.id) {
      case "listen":
        await this.unlocked(row.locked, () => this.deps.network({ listen: value }));
        break;
      case "url":
        await this.unlocked(row.locked, () => this.deps.network({ url: value }));
        break;
      case "rename":
        if (screen.kind === "device" && value !== "" && value !== screen.name) {
          await this.run(async () => {
            this.status = await this.deps.rename(screen.name, value);
            this.screen = { kind: "device", name: value };
          });
        } else {
          // unchanged
        }
        break;
      case "name":
        await this.pair(value !== "" ? value : undefined);
        break;
      default:
        throw new Error(`unknown field: ${JSON.stringify(row.id satisfies never)}`);
    }
  }

  private async pair(name: string | undefined): Promise<void> {
    await this.run(async () => {
      const pairing = await this.deps.pair(name);
      this.status = await this.deps.status();
      this.go({ kind: "pairing", pairing });
    });
  }

  private async unlocked(locked: boolean, change: () => Promise<HubStatus>): Promise<void> {
    if (locked) {
      this.deps.notify("the service's configuration sets the network access: change it there");
    } else {
      await this.run(async () => {
        this.status = await change();
      });
    }
  }

  /** ←: the screen before; from the main screen nothing (Esc closes). */
  back(): void {
    switch (this.screen.kind) {
      case "main":
        break; // the first screen
      case "device":
      case "add":
        this.go({ kind: "main" });
        break;
      case "pairing":
        this.go({ kind: "add" });
        break;
      default:
        throw new Error(`unknown screen: ${JSON.stringify(this.screen satisfies never)}`);
    }
  }

  close(): void {
    this.deps.close();
  }

  private go(screen: HubDialogScreen): void {
    this.screen = screen;
    this.selected = 0;
    this.draft = undefined;
    this.deps.changed();
  }

  private async run(work: () => Promise<void>): Promise<void> {
    try {
      await work();
      this.error = undefined;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.deps.changed();
  }
}
