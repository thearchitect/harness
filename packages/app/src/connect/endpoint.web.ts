// Where the app connects on web: the server that served it — a hub (its /client endpoint, with the
// device token this browser was paired with) or `harness web-app` on this machine (a one-time token
// in the address's fragment). A pairing link (`#pair=<code>`, the hub's QR code) carries a one-time
// code, exchanged at the hub (POST /pair) for this browser's device token.

import { redeemPairing } from "./pairing.ts";

export type Endpoint = { url: string; token: string; local: boolean };

const DEVICE_KEY = "harness.device";
const LOCAL_KEY = "harness.local";

function origin(): string {
  return `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`;
}

/**
 * The endpoint to use, after taking a token or a pairing code from the address (which then leaves
 * the address). A failed pairing throws with the hub's reason.
 */
export async function readEndpoint(): Promise<Endpoint | undefined> {
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
  } else if (pair !== null) {
    await saveDevice(pair, window.location.origin);
  } else {
    // a token stored before, or none
  }
  const sessionToken = window.sessionStorage.getItem(LOCAL_KEY);
  const device = window.localStorage.getItem(DEVICE_KEY);
  return sessionToken !== null ? { url: origin(), token: sessionToken, local: true } : device !== null ? { url: origin(), token: device, local: false } : undefined;
}

/** On web the hub is the server the page came from: only the code is asked. */
export const ASKS_FOR_URL = false;

/** Pairs this browser with a code (the hub is the page's server). */
export async function saveDevice(code: string, _url: string): Promise<Endpoint> {
  const { token } = await redeemPairing(window.location.origin, code);
  window.localStorage.setItem(DEVICE_KEY, token);
  return { url: origin(), token, local: false };
}

export async function forgetDevice(): Promise<void> {
  window.localStorage.removeItem(DEVICE_KEY);
  window.sessionStorage.removeItem(LOCAL_KEY);
}
