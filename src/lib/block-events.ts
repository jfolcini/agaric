/**
 * Block event constants and helpers.
 *
 * All custom DOM events exchanged between FormattingToolbar and BlockTree
 * are defined here so a typo becomes a compile error instead of a silent bug.
 */

import { dispatchBlockCommand } from './block-command-bus'
import { BLOCK_EVENTS } from './block-event-names'

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
 * #1250 — the canonical delivery path is now the focus-keyed block command bus
 * (`dispatchBlockCommand`): it routes the command DIRECTLY to the single
 * BlockTree whose page store owns the global `focusedBlockId`, instead of every
 * mounted tree subscribing to `document` and re-checking ownership. (The bus
 * imports only the `BLOCK_EVENTS` *type* from this module, so the static import
 * here introduces no runtime cycle.) The legacy `document` CustomEvent is ALSO
 * dispatched so any non-BlockTree / external `onBlockEvent(document, …)`
 * consumer keeps working; no BlockTree listens at the document level anymore,
 * so this no longer fans out per mounted tree.
 */
export function dispatchBlockEvent(name: keyof typeof BLOCK_EVENTS, detail?: unknown): void {
  // Focus-keyed direct dispatch (the per-block command path).
  dispatchBlockCommand(name, detail)
  // Legacy document broadcast — preserved for external / non-BlockTree
  // consumers and the typed-name contract; carries no per-tree fan-out.
  document.dispatchEvent(new CustomEvent(BLOCK_EVENTS[name], { detail }))
}

/**
 * Add a listener for a block event and return a cleanup function that
 * removes it.
 */
export function onBlockEvent(
  target: EventTarget,
  name: keyof typeof BLOCK_EVENTS,
  handler: (e: Event) => void,
): () => void {
  const eventName = BLOCK_EVENTS[name]
  target.addEventListener(eventName, handler)
  return () => target.removeEventListener(eventName, handler)
}

// ── Shared navigation callback type ─────────────────────────────────────

/** Callback signature for cross-page navigation. */
export type NavigateToPageFn = (pageId: string, title?: string, blockId?: string) => void
