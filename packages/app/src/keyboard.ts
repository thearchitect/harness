// The keyboard on iOS and Android: hardware keyboards (iPad, Android) map to the same actions in the
// native builds (stage 11); touch reaches every action through buttons and rows meanwhile.

import type { ActionId } from "#client/keymap.ts";

export function listenKeys(_act: (action: ActionId) => void): () => void {
  return () => undefined;
}

/** Bridged components take keys on the web only (a phone types through their key strip). */
export function listenComponentKeys(_send: (bytes: string) => void, _keep?: (action: ActionId) => boolean, _bracketed?: () => boolean): () => void {
  return () => undefined;
}
