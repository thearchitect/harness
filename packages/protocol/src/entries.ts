// Which entries of a session's current branch a client gets, one rule for the agent (harness_snapshot,
// harness_entries_before) and the hub reading a session without one (session_read): the newest
// `limit` before a cursor (the end without one), oldest first, and the cursor of the entries before
// them (absent at the beginning). The same ids either way, so what a client loaded from the file
// carries on when the session's agent starts.

export type EntriesPage<T> = { entries: T[]; cursor?: string };

/** The page of `branch` ending before `cursor` (at the end without one); undefined: the cursor is not on the branch. */
export function branchPage<T extends { id: string }>(branch: readonly T[], cursor: string | undefined, limit: number): EntriesPage<T> | undefined {
  const end = cursor === undefined ? branch.length : branch.findIndex((entry) => entry.id === cursor);
  if (end === -1) {
    return undefined;
  } else {
    const from = Math.max(0, end - limit);
    const before = from > 0 ? branch[from]?.id : undefined;
    return { entries: branch.slice(from, end), ...(before !== undefined ? { cursor: before } : {}) };
  }
}
