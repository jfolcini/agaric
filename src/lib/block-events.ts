/**
 * Block event constants and helpers.
 *
 * The typed `BLOCK_EVENTS` name map is defined in the leaf module
 * `block-event-names` so a typo becomes a compile error instead of a silent
 * bug. Producers dispatch a per-block command with `dispatchBlockCommand`
 * (`src/stores/block-command-bus.ts`, #1250).
 */

// ── Event name constants ────────────────────────────────────────────────

// The constants live in the leaf module `block-event-names` so the command bus
// can import the type without forming a cycle with this module (#1250).
// Re-exported here so existing `import { BLOCK_EVENTS } from '@/lib/block-events'`
// call sites keep working unchanged.
export { BLOCK_EVENTS } from '@/lib/block-event-names'

// ── Shared navigation callback type ─────────────────────────────────────

/** Callback signature for cross-page navigation. */
export type NavigateToPageFn = (pageId: string, title?: string, blockId?: string) => void
