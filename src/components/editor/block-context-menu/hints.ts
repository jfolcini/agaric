/**
 * BlockContextMenu — state-aware label + shortcut-hint helpers.
 *
 * Extracted from `BlockContextMenu.tsx` (pure functions, no React state) so the
 * menu shell stays focused on rendering. Leaf module: depends only on the
 * shortcut catalog, never back on the menu.
 */

import { getShortcutKeys } from '@/lib/keyboard-config'

// ── State-aware label helpers ─────────────────────────────────────────

export function getTodoLabel(
  todoState: string | null | undefined,
  t: (key: string) => string,
): string {
  switch (todoState) {
    case 'TODO': {
      return t('contextMenu.todoToDoing')
    }
    case 'DOING': {
      return t('contextMenu.doingToDone')
    }
    case 'DONE': {
      return t('contextMenu.doneToCancelled')
    }
    case 'CANCELLED': {
      return t('contextMenu.cancelledToClear')
    }
    case null:
    case undefined:
    default: {
      return t('contextMenu.setTodo')
    }
  }
}

export function getPriorityLabel(
  priority: string | null | undefined,
  t: (key: string) => string,
): string {
  switch (priority) {
    case '1': {
      return t('contextMenu.priority1To2')
    }
    case '2': {
      return t('contextMenu.priority2To3')
    }
    case '3': {
      return t('contextMenu.priority3ToClear')
    }
    case null:
    case undefined:
    default: {
      return t('contextMenu.setPriority1')
    }
  }
}

// ── Shortcut-hint helpers ─────────────────────────────────────────────

/**
 * #1728 — a menu row's shortcut, read live from the catalog by id so a rebind
 * shows, in the catalog's `Ctrl + K` format that `Kbd` draws.
 *
 * Not inlined: `keyboard-config-rebindable-drift.test.ts` counts a literal
 * `getShortcutKeys('id')` as the binding being consumed, and a hint only shows
 * it (`deleteBlock`'s is not rebindable).
 */
export function shortcutHint(id: string): string {
  return getShortcutKeys(id)
}

/**
 * #1728 — the "Set priority" row cycles through three independent catalog
 * bindings (`priority1`/`priority2`/`priority3`, default `Ctrl+Shift+1..3`).
 * The first binding in full, then the last key of the other two as
 * alternatives (`Ctrl + Shift + 1 / 2 / 3`), read from the catalog so a rebind
 * shows.
 */
export function priorityHint(): string {
  const tail = (id: string): string => shortcutHint(id).split(' + ').at(-1) ?? ''
  const alts = [tail('priority2'), tail('priority3')].filter((tok) => tok.length > 0)
  return [shortcutHint('priority1'), ...alts].join(' / ')
}
