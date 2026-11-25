// Where the app connects on iOS and Android: the hub it was paired with (its address and the
// device token the pairing code was exchanged for), kept in the system's secure storage.

import * as SecureStore from "expo-secure-store";
import { redeemPairing } from "./pairing.ts";

export type Endpoint = { url: string; token: string; local: boolean };

const KEY = "harness.device";

export async function readEndpoint(): Promise<Endpoint | undefined> {
  const stored = await SecureStore.getItemAsync(KEY);
  if (stored === null) {
    return undefined;
  } else {
    const { url, token } = JSON.parse(stored) as { url: string; token: string };
    return { url, token, local: false };
  }
}

/** Native apps ask for the hub's address with the code. */
export const ASKS_FOR_URL = true;

export async function saveDevice(code: string, url: string): Promise<Endpoint> {
  const base = url.replace(/^http/, "ws").replace(/\/$/, "");
  const { token } = await redeemPairing(base, code);
  await SecureStore.setItemAsync(KEY, JSON.stringify({ url: base, token }));
  return { url: base, token, local: false };
}

export async function forgetDevice(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}
