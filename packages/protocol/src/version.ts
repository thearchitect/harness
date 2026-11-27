// Version of the harness protocols (HAP, the hub protocol). Peers exchange it
// in their handshakes; equal versions are compatible, any difference is `version_mismatch`.

export const PROTOCOL_VERSION = 1;

export function compatibleProtocol(theirs: number): boolean {
  return theirs === PROTOCOL_VERSION;
}
