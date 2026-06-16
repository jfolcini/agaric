/**
 * Block event name constants — the single source of truth for the typed names
 * exchanged between producers (toolbar / inline controls / roving editor) and
 * the focus-keyed block command bus / BlockTree.
 *
 * Kept in a leaf module (it imports nothing from `block-events` or
 * `block-command-bus`) so the bus can reference the `BLOCK_EVENTS` *type* and
 * `block-events` can use the *value* without forming an import cycle (#1250).
 * `block-events.ts` re-exports `BLOCK_EVENTS` so existing
 * `import { BLOCK_EVENTS } from './block-events'` call sites keep working.
 */
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
