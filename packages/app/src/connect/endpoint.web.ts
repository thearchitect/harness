// Where the app connects on web: the server that served it — a hub (its /ws endpoint; a paired
// browser's token is an HttpOnly cookie the browser sends by itself and this page never sees) or
// `harness web-app` on this machine (a one-time token in the address's fragment). A pairing link
// (`#pair=<code>`, the hub's QR code) carries a one-time code, exchanged at the hub (POST /pair)
// for this browser's cookie; the code leaves the address at once.

import { pairingBody, redeemPairing } from "./pairing.ts";

/** `token`: a window token of `harness web-app`; a hub's page has none (its cookie stands for it). */
export type Endpoint = { url: string; token?: string; local: boolean };

/** What the address brought: an endpoint to connect to, or a pairing link to pair with first. */
export type Arrival = { kind: "endpoint"; endpoint: Endpoint } | { kind: "pair"; code: string; hub: string };

const LOCAL_KEY = "harness.local";

function origin(): string {
  return `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`;
}

/** The address's token or pairing code (both leave the address), else the hub that served the page. */
export async function readEndpoint(): Promise<Arrival> {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const local = fragment.get("token");
  const pair = fragment.get("pair");
  if (local !== null || pair !== null) {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  } else {
    // nothing in the address
  }
  if (local !== null) {
    window.sessionStorage.setItem(LOCAL_KEY, local);
  } else {
    // a window token stored before, or a hub's page
  }
  const sessionToken = window.sessionStorage.getItem(LOCAL_KEY);
  if (sessionToken !== null) {
    return { kind: "endpoint", endpoint: { url: origin(), token: sessionToken, local: true } };
  } else if (pair !== null) {
    return { kind: "pair", code: pair, hub: window.location.origin };
  } else {
    return { kind: "endpoint", endpoint: { url: origin(), local: false } };
  }
}

/** On web the hub is the server the page came from: only the code is asked. */
export const ASKS_FOR_URL = false;

/** The browser's name for its device: its system and browser, as the hub's device list shows them. */
function browserName(): string {
  const agent = navigator.userAgent;
  const system = /iPhone|iPad/.test(agent) ? "iOS" : /Android/.test(agent) ? "Android" : /Mac OS X/.test(agent) ? "macOS" : /Windows/.test(agent) ? "Windows" : /Linux/.test(agent) ? "Linux" : "a computer";
  const browser = /Edg\//.test(agent) ? "Edge" : /Firefox\//.test(agent) ? "Firefox" : /Chrome\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : "a browser";
  return `${browser} on ${system}`;
}

/** Pairs this browser with a code: the hub keeps its token in an HttpOnly cookie. */
export async function saveDevice(code: string, _url: string): Promise<Endpoint> {
  await redeemPairing(window.location.origin, pairingBody(code, browserName(), true));
  return { url: origin(), local: false };
}

/** Unpairs this browser: the hub revokes its device and clears its cookie. */
export async function forgetDevice(): Promise<void> {
  window.sessionStorage.removeItem(LOCAL_KEY);
  await fetch("/unpair", { method: "POST" }).catch(() => undefined);
}

/** Whether this browser runs on a phone (a pairing link there may rather open the app). */
export function onPhone(): boolean {
  return /iPhone|iPad|Android/.test(navigator.userAgent);
}
