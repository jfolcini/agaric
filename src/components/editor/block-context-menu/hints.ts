/**
 * BlockContextMenu — state-aware label + shortcut-hint helpers.
 *
 * Extracted from `BlockContextMenu.tsx` (pure functions, no React state) so the
 * menu shell stays focused on rendering. Leaf module: depends only on the
 * shortcut catalog and the platform modifier glyph, never back on the menu.
 */

import { getShortcutKeys } from '@/lib/keyboard-config'
import { modKey } from '@/lib/platform'

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
    default: {
      return t('contextMenu.setPriority1')
    }
  }
}

// ── Shortcut-hint helpers ─────────────────────────────────────────────
//
// #1728 — the trailing shortcut hints used to be hardcoded literal strings
// ("Ctrl+Shift+→", "Ctrl+Enter", …). That ignored two real sources of truth:
//  1. The user's rebinds — every other shortcut surface (command palette,
//     bubble menu, slash menu, sidebar…) reads the live binding via
//     `getShortcutKeys(id)`, but this menu showed stale defaults forever.
//  2. The platform modifier glyph — macOS users expect `⌘`, not `Ctrl`
//     (`modKey()` already drives `KbdChord` everywhere else).
//
// We now source every rebindable hint from the catalog by id and render it in
// the menu's existing compact form: platform mod glyph for `Ctrl`, arrow
// glyphs for the spelled-out "Arrow X" tokens, `+`-joined with no spaces. The
// positional, documentation-only chords (delete/merge on Backspace, gated on
// cursor position) are sourced the same way and keep their "(when empty)" /
// "(at start)" condition suffix.

const ARROW_GLYPHS: Record<string, string> = {
  'Arrow Right': '→',
  'Arrow Left': '←',
  'Arrow Up': '↑',
  'Arrow Down': '↓',
}

/**
 * Format a catalog `keys` string ("Ctrl + Shift + Arrow Up") into the menu's
 * compact hint form ("Ctrl+Shift+↑", or "⌘+Shift+↑" on macOS). `Ctrl` maps to
 * the platform modifier; spelled-out arrows map to glyphs; tokens join with a
 * bare `+`. ` / ` alternatives are preserved as `/`.
 */
export function formatHintKeys(keys: string): string {
  if (!keys) return ''
  const mod = modKey()
  return keys
    .split(' / ')
    .map((alt) =>
      alt
        .split('+')
        .map((tok) => tok.trim())
        .filter((tok) => tok.length > 0)
        .map((tok) => (tok === 'Ctrl' ? mod : (ARROW_GLYPHS[tok] ?? tok)))
        .join('+'),
    )
    .join('/')
}

/** Compact hint for a single rebindable catalog shortcut id. */
export function shortcutHint(id: string): string {
  return formatHintKeys(getShortcutKeys(id))
}

/**
 * #1728 — the "Set priority" row cycles through three INDEPENDENT catalog
 * bindings (`priority1`/`priority2`/`priority3`, default `Ctrl+Shift+1..3`).
 * Render the modifier-prefixed first binding fully, then append the trailing
 * key of the other two as a `/`-alternation ("Ctrl+Shift+1/2/3"), sourced from
 * the catalog so a rebind/platform glyph is reflected. Falls back to whatever
 * each id resolves to if a binding is missing/customised away.
 */
export function priorityHint(): string {
  const full = shortcutHint('priority1')
  const tail = (id: string): string => {
    const tokens = formatHintKeys(getShortcutKeys(id)).split('+')
    return tokens.at(-1) ?? ''
  }
  const alts = [tail('priority2'), tail('priority3')].filter((tok) => tok.length > 0)
  return alts.length > 0 ? `${full}/${alts.join('/')}` : full
}
