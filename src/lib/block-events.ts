/**
 * Block event constants and helpers.
 *
 * All custom DOM events exchanged between FormattingToolbar and BlockTree
 * are defined here so a typo becomes a compile error instead of a silent bug.
 */

// ── Event name constants ────────────────────────────────────────────────

export const BLOCK_EVENTS = {
  OPEN_DATE_PICKER: 'open-date-picker',
  OPEN_DUE_DATE_PICKER: 'open-due-date-picker',
  OPEN_SCHEDULED_DATE_PICKER: 'open-scheduled-date-picker',
  TOGGLE_TODO_STATE: 'toggle-todo-state',
  OPEN_BLOCK_PROPERTIES: 'open-block-properties',
  DISCARD_BLOCK_EDIT: 'discard-block-edit',
  CYCLE_PRIORITY: 'cycle-priority',
  SET_PRIORITY_1: 'set-priority-1',
  SET_PRIORITY_2: 'set-priority-2',
  SET_PRIORITY_3: 'set-priority-3',
  INSERT_ORDERED_LIST: 'insert-ordered-list',
  INSERT_DIVIDER: 'insert-divider',
  INSERT_CALLOUT: 'insert-callout',
} as const

// ── Helpers ─────────────────────────────────────────────────────────────

/** Dispatch a block event on `document`. */
export function dispatchBlockEvent(name: keyof typeof BLOCK_EVENTS, detail?: unknown): void {
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
