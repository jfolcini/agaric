/**
 * Palette input-mode parsing — pure functions that map the raw input
 * string to a palette mode and its stripped query. Extracted from
 * CommandPalette.tsx (#751) so the prefix vocabulary is unit-testable
 * in isolation from the React body.
 *
 * Prefix vocabulary (PEND-61 / PEND-67 Phase 3):
 *   - `[[…`  → page-link autocomplete (a sub-mode of `'search'`)
 *   - `>`    → commands mode
 *   - `#`    → tags mode (block_type=tag search)
 *   - `?`    → help mode (keyboard-shortcut catalog)
 */

import type { PaletteMode } from '@/stores/useCommandPaletteStore'

/** True when the input is in `[[page]]` autocomplete mode. */
export function isPageLinkMode(input: string): boolean {
  return input.startsWith('[[') && input.length > 2
}

/** Extract the page-title query inside `[[…` — never returns the leading `[[`. */
export function pageLinkQuery(input: string): string {
  // Strip the trailing `]]` if the user typed it (Notion's UX); else
  // just the leading `[[`.
  const stripped = input.replace(/\]\]\s*$/, '')
  return stripped.slice(2)
}

/** True when the input is in commands mode (leading `>` prefix). */
export function isCommandsModeInput(input: string): boolean {
  return input.startsWith('>')
}

/** Extract the commands-mode filter query after the `>` prefix. */
export function commandsModeQuery(input: string): string {
  return input.slice(1).trimStart()
}

/** PEND-67 Phase 3 — `#` prefix enters tags mode (block_type=tag search). */
export function isTagsModeInput(input: string): boolean {
  return input.startsWith('#')
}

/** Extract the tags-mode filter query after the `#` prefix. */
export function tagsModeQuery(input: string): string {
  return input.slice(1).trimStart()
}

/** PEND-67 Phase 3 — `?` prefix enters help mode (shortcut catalog). */
export function isHelpModeInput(input: string): boolean {
  return input.startsWith('?')
}

/** Extract the help-mode filter query after the `?` prefix. */
export function helpModeQuery(input: string): string {
  return input.slice(1).trimStart()
}

/**
 * PEND-67 Phase 3 — map a prefix-bearing search-mode query to the
 * target mode + stripped query. Pulled out of `PaletteBody`'s
 * useEffect so the body stays under oxlint's eslint/complexity
 * budget as more prefixes are added.
 */
export function routePrefixToMode(query: string): { next: PaletteMode; q: string } | null {
  // Both the mode detection AND the prefix strip must run on the trimmed
  // input: the extraction helpers `slice(1)` the first char, so feeding them
  // the RAW query strips a leading whitespace char instead of the prefix and
  // leaves the prefix in the mode query (`'  >set'` → `'>set'`). (#1554)
  const trimmed = query.trimStart()
  if (isCommandsModeInput(trimmed)) return { next: 'commands', q: commandsModeQuery(trimmed) }
  if (isTagsModeInput(trimmed)) return { next: 'tags', q: tagsModeQuery(trimmed) }
  if (isHelpModeInput(trimmed)) return { next: 'help', q: helpModeQuery(trimmed) }
  return null
}
