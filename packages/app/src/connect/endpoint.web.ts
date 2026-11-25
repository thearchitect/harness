// Where the app connects on web: the server that served it — a hub (its /client endpoint, with the
// device token this browser was paired with) or `harness web-app` on this machine (a one-time token
// in the address's fragment). A pairing link (`#pair=<token>`, the hub's QR code) stores the token.

export type Endpoint = { url: string; token: string; local: boolean };

const DEVICE_KEY = "harness.device";
const LOCAL_KEY = "harness.local";

function origin(): string {
  return `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`;
}

/** The endpoint to use, after taking a token from the address (which then leaves the address). */
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
    window.localStorage.setItem(DEVICE_KEY, pair);
  } else {
    // a token stored before, or none
  }
  const sessionToken = window.sessionStorage.getItem(LOCAL_KEY);
  const device = window.localStorage.getItem(DEVICE_KEY);
  return sessionToken !== null ? { url: origin(), token: sessionToken, local: true } : device !== null ? { url: origin(), token: device, local: false } : undefined;
}

/** On web the hub is the server the page came from: only the token is asked. */
export const ASKS_FOR_URL = false;

export async function saveDevice(token: string, _url: string): Promise<Endpoint> {
  window.localStorage.setItem(DEVICE_KEY, token);
  return { url: origin(), token, local: false };
}

export async function forgetDevice(): Promise<void> {
  window.localStorage.removeItem(DEVICE_KEY);
  window.sessionStorage.removeItem(LOCAL_KEY);
}
