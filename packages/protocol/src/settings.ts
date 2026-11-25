// A setting's revision: a hash of its value as JSON. A client changes a setting from the value it
// has (settings_set ifRevision); the node refuses with `conflict` when another client changed it
// meanwhile, and the client applies its change to the current value again.

/** FNV-1a (32 bits) of the value's JSON; `undefined` (no value) has its own revision. */
export function settingRevision(value: unknown): string {
  const text = value === undefined ? "\u0000undefined" : JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
