// The keyboard on iOS and Android: hardware keyboards (iPad, Android) map to the same actions in the
// native builds (stage 11); touch reaches every action through buttons and rows meanwhile.

import type { ActionId } from "#client/input/actions.ts";
import type { Capture, ModeInputs } from "#client/input/modes.ts";
import type { KeyModes } from "#client/terminal-keys.ts";

export function listenKeys(_act: (action: ActionId) => void, _inputs: () => Omit<ModeInputs, "strip">): () => void {
  return () => undefined;
}

/** Bridged components take keys on the web only (a phone types through their key strip). */
export function listenComponentKeys(_send: (bytes: string) => void, _owner: Capture, _bracketed?: () => boolean, _modes?: () => KeyModes): () => void {
  return () => undefined;
}
