// Where the app connects on iOS and Android: the hub it was paired with (its address and the
// device token the pairing code was exchanged for), kept in the system's secure storage.

import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { pairingBody, redeemPairing } from "./pairing.ts";

export type Endpoint = { url: string; token?: string; local: boolean };

/** What the app starts with: the stored endpoint, or nothing yet (pairing). */
export type Arrival = { kind: "endpoint"; endpoint: Endpoint } | { kind: "pair"; code: string; hub: string } | { kind: "none" };

const KEY = "harness.device";

export async function readEndpoint(): Promise<Arrival> {
  const stored = await SecureStore.getItemAsync(KEY);
  if (stored === null) {
    return { kind: "none" };
  } else {
    const { url, token } = JSON.parse(stored) as { url: string; token: string };
    return { kind: "endpoint", endpoint: { url, token, local: false } };
  }
}

/** Native apps ask for the hub's address with the code (a link or a QR code brings both). */
export const ASKS_FOR_URL = true;

/** The device's name in the hub's list (renamed there at will). */
function deviceName(): string {
  return Platform.OS === "ios" ? "iPhone" : Platform.OS === "android" ? "Android phone" : "device";
}

export async function saveDevice(code: string, url: string): Promise<Endpoint> {
  const base = url.replace(/^http/, "ws").replace(/\/$/, "");
  const { token } = await redeemPairing(base, pairingBody(code, deviceName(), false));
  if (token === undefined) {
    throw new Error("the hub sent no token");
  } else {
    await SecureStore.setItemAsync(KEY, JSON.stringify({ url: base, token }));
    return { url: base, token, local: false };
  }
}

export async function forgetDevice(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}

/** A phone app never hands a link to itself. */
export function onPhone(): boolean {
  return false;
}
