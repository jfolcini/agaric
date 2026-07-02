/**
 * Block event constants and helpers.
 *
 * The typed `BLOCK_EVENTS` name map is defined in the leaf module
 * `block-event-names` so a typo becomes a compile error instead of a silent
 * bug.
 */

import { dispatchBlockCommand } from './block-command-bus'
import type { BLOCK_EVENTS } from './block-event-names'

// ── Event name constants ────────────────────────────────────────────────

// The constants live in the leaf module `block-event-names` so the command bus
// can import the type without forming a cycle with this module (#1250).
// Re-exported here so existing `import { BLOCK_EVENTS } from './block-events'`
// call sites keep working unchanged.
export { BLOCK_EVENTS } from './block-event-names'

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Dispatch a per-block command from a producer (toolbar / inline controls /
 * roving editor).
 *
 * #1250 — the canonical delivery path is the focus-keyed block command bus
 * (`dispatchBlockCommand`): it routes the command DIRECTLY to the single
 * BlockTree whose page store owns the global `focusedBlockId`, instead of every
 * mounted tree subscribing to `document` and re-checking ownership. This is a
 * thin alias kept so the many existing `dispatchBlockEvent(...)` call sites stay
 * unchanged. (#2222 — the legacy `document` CustomEvent broadcast and its
 * `onBlockEvent` listener helper were removed: no production code ever listened
 * at the document level, so the broadcast was dead.)
 */
export function dispatchBlockEvent(name: keyof typeof BLOCK_EVENTS, detail?: unknown): void {
  dispatchBlockCommand(name, detail)
}

// ── Shared navigation callback type ─────────────────────────────────────

/** Callback signature for cross-page navigation. */
export type NavigateToPageFn = (pageId: string, title?: string, blockId?: string) => void
