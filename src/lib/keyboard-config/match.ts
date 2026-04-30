/**
 * Keyboard event ↔ binding matcher (MAINT-127). Normalises arrow glyphs,
 * Space, and Shift-produced punctuation so a `KeyboardEvent` matches the
 * binding string regardless of the layout quirks the user is typing on.
 */

import { getShortcutKeys } from './storage'

/**
 * Normalize a raw key token (from a binding string or `KeyboardEvent.key`)
 * to a canonical form so arrow symbols, arrow names, and Space all compare
 * equal regardless of which representation appeared on either side.
 */
function normalizeKey(raw: string): string {
  // Special-case `' '` BEFORE trimming so the literal space character from
  // `KeyboardEvent.key` (which is `' '` for the spacebar) normalises to the
  // same canonical value as the textual binding `Space`. Trimming would
  // otherwise collapse it to the empty string.
  const lower = raw.toLowerCase()
  if (lower === ' ' || lower === 'space' || lower === 'spacebar') return 'space'
  const k = lower.trim()
  if (k === '') return ''
  if (k === '←' || k === 'arrowleft' || k === 'left') return 'arrowleft'
  if (k === '→' || k === 'arrowright' || k === 'right') return 'arrowright'
  if (k === '↑' || k === 'arrowup' || k === 'up') return 'arrowup'
  if (k === '↓' || k === 'arrowdown' || k === 'down') return 'arrowdown'
  return k
}

/**
 * True when the canonical key name is a single Shift-produced punctuation
 * symbol on US-ANSI layout that this app actually binds to: `+`, `?`, `@`,
 * `=`. These are the exact glyphs that `Shift+<key>` produces (`Shift+= →
 * +`, `Shift+/ → ?`, `Shift+2 → @`). For bindings like `graphZoomIn = '+'`,
 * we want the shortcut to fire whether the user types `+` (Shift+= on US)
 * or `=` (the unshifted key) — the matcher treats Shift as don't-care when
 * the binding key is in this set.
 *
 * Deliberately narrow: we do NOT relax Shift for other symbols (`[`, `]`,
 * `;`, `'`, etc.) even though they're technically non-alphanumeric, because
 * (a) none of the app's default bindings use them, (b) a user rebinding to
 * one of those gets the expected strict Shift matching, and (c) the broader
 * `![a-z0-9]` relaxation makes the matcher unpredictable for layouts where
 * Shift+<key> produces a different glyph than the listed symbol.
 */
function isSymbolKey(canonical: string): boolean {
  if (canonical.length !== 1) return false
  return /[+?@=]/.test(canonical)
}

/**
 * Parse a shortcut binding string and check if a KeyboardEvent matches it.
 * Handles Ctrl/Cmd + Shift + single key combinations.
 *
 * Supports ` / ` separated alternatives — e.g. `+ / =` matches either `+` or `=`.
 * Arrow-key glyphs (`←`, `→`, `↑`, `↓`) in the binding match the corresponding
 * `ArrowLeft`/`ArrowRight`/`ArrowUp`/`ArrowDown` `KeyboardEvent.key` values.
 * For punctuation symbols that normally require Shift on a US layout (e.g. `+`,
 * `?`, `@`) the Shift requirement is relaxed so the event matches regardless of
 * the event's shiftKey state — users can rebind without knowing the physical
 * modifier combo their layout uses.
 */
export function matchesShortcutBinding(
  e: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'key'>,
  shortcutId: string,
): boolean {
  const binding = getShortcutKeys(shortcutId)
  if (!binding) return false
  const alternatives = binding.split(' / ')
  return alternatives.some((alt) => matchesSingleBinding(e, alt))
}

function matchesSingleBinding(
  e: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'key'>,
  binding: string,
): boolean {
  // Split on ` + ` (space-plus-space) so bindings whose KEY is literally
  // `+` (e.g. `+` alone or `Ctrl + +`) round-trip correctly. Existing
  // bindings already use the spaced form (`Ctrl + F`, `Ctrl + Shift + D`),
  // so this is backward compatible.
  const parts = binding.split(' + ').map((p) => p.trim().toLowerCase())
  const needsCtrl = parts.includes('ctrl')
  const needsShift = parts.includes('shift')
  const needsAlt = parts.includes('alt')
  const rawKey =
    parts.filter((p) => p !== 'ctrl' && p !== 'shift' && p !== 'alt' && p !== 'meta')[0] ?? ''
  const normalizedKey = normalizeKey(rawKey)
  const normalizedEventKey = normalizeKey(e.key)
  // Relax shift check for symbol punctuation keys — on many layouts
  // the same physical key produces different glyphs with/without shift
  // (US: `Shift+=` → `+`; `Shift+/` → `?`). Ignoring shift for symbols
  // makes these shortcuts work regardless of how the user types them.
  const matchShift = needsShift ? e.shiftKey : isSymbolKey(normalizedKey) ? true : !e.shiftKey
  return (
    (e.ctrlKey || e.metaKey) === needsCtrl &&
    matchShift &&
    e.altKey === needsAlt &&
    normalizedEventKey === normalizedKey
  )
}
