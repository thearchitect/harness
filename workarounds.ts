/**
 * harness - temporary workarounds for upstream gaps.
 *
 * Every mechanism here compensates for something pi or another extension does
 * not (yet) provide. Each one is meant to be deleted, not maintained, once its
 * upstream owner catches up. Rules:
 *
 * 1. One exported function per workaround, called from index.ts at call sites
 *    marked `// WORKAROUND Wn`. It registers nothing itself and shares no
 *    state with index.ts.
 * 2. Owner's slot only. A workaround writes only through public extension
 *    points, into the key its owner would write, and never returns
 *    `systemPrompt`. When the owner is fixed it overwrites the same key, so a
 *    stale workaround is redundant, not harmful.
 * 3. pi internals only through a loader that logs once and skips the
 *    workaround on failure; the session keeps working.
 * 4. Each block documents: Problem / Workaround / Internals used / Remove when
 *    (exact check) / Upstream issue.
 * 5. Removing a workaround = deleting its block and its marked call sites in
 *    index.ts. IDs are never reused.
 *
 * Verified against pi-coding-agent 1.4.0 and pi-magic-context 0.49.20.
 * Removed: W1 (<mcp_servers> lost behind magic-context) - MC ≥ 0.49 writes
 * its block into systemPromptOptions.sections and no longer forces
 * systemPrompt.
 */

import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

const LOG_PREFIX = "[harness workarounds]";

/* ============================================================================
 * W2 - thinking blocks hidden permanently by a stray Ctrl+T
 *
 * Problem: Ctrl+T (app.thinking.toggle) persists hideThinkingBlock=true into
 *   the global settings, so one accidental keypress hides thinking blocks on
 *   every later startup.
 *
 * Workaround: index.ts calls ensureThinkingBlocksVisible at extension load
 *   and on every session_start. It sets
 *   hideThinkingBlock back to false through the public SettingsManager
 *   (per-key locked merge, so other settings are untouched). No-op when
 *   already visible.
 *
 * Internals used: none.
 *
 * Remove when: toggleThinkingBlockVisibility in pi's
 *   dist/modes/interactive/interactive-mode.js no longer calls
 *   settingsManager.setHideThinkingBlock, or pi offers a session-only toggle.
 *
 * Upstream issue: not filed.
 * ========================================================================== */
export async function ensureThinkingBlocksVisible(): Promise<void> {
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
