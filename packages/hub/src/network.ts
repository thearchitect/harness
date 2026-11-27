// The hub's network access for the user's devices: its HTTP endpoint (endpoints/ws.ts) run as the
// settings say — the user's `hub.network` (the /hub dialog), or the service's configuration, which
// then wins and cannot be changed from a client. The hub never terminates TLS: an address off
// loopback is allowed only with `proxy` (only a TLS proxy reaches the port); otherwise the endpoint
// does not start and the status says why.

import type { NetworkSettings } from "#protocol/hub.ts";
import type { HubAuth } from "./auth.ts";
import { parseListen } from "./config.ts";
import { listenWs, type NetworkEndpoint } from "./endpoints/ws.ts";
import { appWebDir, serveStatic } from "./endpoints/static.ts";
import type { Hub } from "./hub.ts";

export const NETWORK_DEFAULTS: NetworkSettings = { enabled: false, listen: "127.0.0.1:8790", proxy: false };

/** The `hub.network` setting as stored, completed with the defaults. */
export function networkOf(stored: unknown): NetworkSettings {
  const value = typeof stored === "object" && stored !== null ? (stored as Partial<NetworkSettings>) : {};
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : NETWORK_DEFAULTS.enabled,
    listen: typeof value.listen === "string" ? value.listen : NETWORK_DEFAULTS.listen,
    proxy: typeof value.proxy === "boolean" ? value.proxy : NETWORK_DEFAULTS.proxy,
    ...(typeof value.url === "string" && value.url !== "" ? { url: value.url } : {}),
  };
}

function loopback(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/** Why these settings cannot run; undefined when they can. */
export function networkProblem(settings: NetworkSettings): string | undefined {
  let host: string;
  try {
    host = parseListen(settings.listen).host;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (!loopback(host) && !settings.proxy) {
    return `${settings.listen} is off loopback: the hub has no TLS of its own; put a TLS proxy in front and turn proxy on, or listen on 127.0.0.1`;
  } else {
    return undefined;
  }
}

/** The pairing link a device opens (the code in the fragment: never in a request line or a proxy's log). */
export function pairingLink(url: string, code: string): string {
  return `${url.replace(/\/$/, "")}/#pair=${code}`;
}

/** A link's QR code for clients to draw: `size`×`size` modules, row by row, "1" dark. */
export async function qrModules(text: string): Promise<{ size: number; modules: string }> {
  const { create } = await import("qrcode");
  const { modules } = create(text, { errorCorrectionLevel: "M" });
  return { size: modules.size, modules: [...modules.data].map((dark) => (dark !== 0 ? "1" : "0")).join("") };
}

export class HubNetwork {
  private readonly hub: Hub;
  private readonly auth: HubAuth;
  /** The service's configuration, when it sets the network access. */
  private readonly fixed: NetworkSettings | undefined;
  private server: NetworkEndpoint | undefined;
  private running: Omit<NetworkSettings, "url"> | undefined;
  private problem: string | undefined;
  /** Applying in turn: a change waits for the one before it. */
  private applying: Promise<void> = Promise.resolve();

  constructor(hub: Hub, auth: HubAuth, fixed: NetworkSettings | undefined) {
    this.hub = hub;
    this.auth = auth;
    this.fixed = fixed;
  }

  settings(): NetworkSettings & { source: "settings" | "service" } {
    return this.fixed !== undefined ? { ...this.fixed, source: "service" } : { ...networkOf(this.hub.settings.read()["hub.network"]), source: "settings" };
  }

  status(): { running: boolean; problem?: string } {
    return { running: this.server !== undefined, ...(this.problem !== undefined ? { problem: this.problem } : {}) };
  }

  /** Where the endpoint listens now (a port 0 in the settings gets a free one). */
  address(): { host: string; port: number } | undefined {
    const address = this.server?.address();
    return address !== undefined ? { host: address.address, port: address.port } : undefined;
  }

  /** Brings the endpoint in line with the settings: started, stopped or restarted on a new address. */
  apply(): Promise<void> {
    this.applying = this.applying.then(() => this.reconcile());
    return this.applying;
  }

  private async reconcile(): Promise<void> {
    // the endpoint depends on where it listens and how; the address for links is only read
    const { source: _source, url: _url, ...wanted } = this.settings();
    const same = this.running !== undefined && JSON.stringify(this.running) === JSON.stringify(wanted);
    if (same || (!wanted.enabled && this.server === undefined)) {
      return; // as it should be
    } else {
      await this.stop();
      const problem = wanted.enabled ? networkProblem(wanted) : undefined;
      if (!wanted.enabled) {
        this.problem = undefined;
      } else if (problem !== undefined) {
        this.problem = problem;
        this.hub.telemetry.log({ event: "network_problem", problem });
      } else {
        const web = appWebDir();
        try {
          this.server = await listenWs(this.hub, this.auth, { ...parseListen(wanted.listen), proxy: wanted.proxy, ...(web !== undefined ? { http: serveStatic(web) } : {}) });
          this.running = wanted;
          this.problem = undefined;
          this.hub.telemetry.log({ event: "network_started", listen: wanted.listen, proxy: wanted.proxy });
        } catch (error) {
          this.problem = `cannot listen on ${wanted.listen}: ${error instanceof Error ? error.message : String(error)}`;
          this.hub.telemetry.log({ event: "network_problem", problem: this.problem });
        }
      }
      this.hub.devicesChanged();
    }
  }

  private async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.running = undefined;
    if (server !== undefined) {
      await server.close();
      this.hub.telemetry.log({ event: "network_stopped" });
    } else {
      // not running
    }
  }

  async close(): Promise<void> {
    this.applying = this.applying.then(() => this.stop());
    await this.applying;
  }
}
