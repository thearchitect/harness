/**
 * harness - temporary workarounds for upstream gaps.
 *
 * Every mechanism here compensates for something pi or another extension does
 * not (yet) provide. Each one is meant to be deleted, not maintained, once its
 * upstream owner catches up. Rules:
 *
 * 1. Self-contained. A workaround registers its own handlers from
 *    installWorkarounds() (or, if it must be, is a named export used at exactly
 *    one call site in index.ts, marked `// WORKAROUND Wn`). No shared state
 *    with index.ts.
 * 2. Owner's slot only. A workaround writes only through public extension
 *    points, into the key its owner would write, and never returns
 *    `systemPrompt`. When the owner is fixed it overwrites the same key, so a
 *    stale workaround is redundant, not harmful.
 * 3. pi internals only through a loader that logs once and skips the
 *    workaround on failure; the session keeps working.
 * 4. Each block documents: Problem / Workaround / Internals used / Remove when
 *    (exact check) / Upstream issue.
 * 5. Removing a workaround = deleting its block (+ its line in
 *    installWorkarounds()). IDs are never reused.
 *
 * scripts/check-workarounds.sh runs the removal checks.
 *
 * Verified against pi-coding-agent 1.4.0 and pi-magic-context 0.49.20.
 * Removed: W1 (<mcp_servers> lost behind magic-context) - MC ≥ 0.49 writes
 * its block into systemPromptOptions.sections and no longer forces
 * systemPrompt.
 */

import { getAgentDir, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LOG_PREFIX = "[harness workarounds]";

/** Registers all workarounds. Call once at extension load. */
export function installWorkarounds(pi: ExtensionAPI): void {
  installThinkingBlocksVisible(pi); // W2
}

/* ============================================================================
 * W2 - thinking blocks hidden permanently by a stray Ctrl+T
 *
 * Problem: Ctrl+T (app.thinking.toggle) persists hideThinkingBlock=true into
 *   the global settings, so one accidental keypress hides thinking blocks on
 *   every later startup.
 *
 * Workaround: at extension load and on every session_start, set
 *   hideThinkingBlock back to false through the public SettingsManager
 *   (per-key locked merge, so other settings are untouched). No-op when
 *   already visible.
 *
 * Internals used: none.
 *
 * Remove when: the toggle stops persisting to settings.json, or pi offers a
 *   setting to keep it session-only. Check: grep -n -i
 *   "hideThinkingBlock|thinking.toggle" in docs/settings.md,
 *   docs/keybindings.md, CHANGELOG.md (scripts/check-workarounds.sh, check W2).
 *
 * Upstream issue: not filed.
 * ========================================================================== */
async function ensureThinkingBlocksVisible(): Promise<void> {
  try {
    const settings = SettingsManager.create(process.cwd(), getAgentDir(), { projectTrusted: false });
    if (settings.getHideThinkingBlock()) {
      settings.setHideThinkingBlock(false);
      await settings.flush();
    } else {
      // already visible: nothing to restore
    }
  } catch (error) {
    console.warn(`${LOG_PREFIX} W2 failed:`, error);
  }
}

function installThinkingBlocksVisible(pi: ExtensionAPI): void {
  void ensureThinkingBlocksVisible();
  pi.on("session_start", () => ensureThinkingBlocksVisible());
}
