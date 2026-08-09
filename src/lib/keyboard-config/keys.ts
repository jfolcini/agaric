/**
 * Key-token canonicalisation shared by the matcher and the Settings-tab
 * validator (#3308 finding 2).
 *
 * `normalizeKey` used to live privately in `match.ts`, which meant
 * `validateBindingInput` had no way to ask "can the matcher ever fire on
 * this key token?". It could only reject empty / modifier-only input, so a
 * user typing `Ctrl + Shift + Esc` or `Cmd + Return` saved an override
 * that `matchesShortcutBinding` compares literally against
 * `KeyboardEvent.key` (`esc` never equals `escape`, `return` is not a key at
 * all) — and because `getShortcutKeys` prefers the override over the catalog
 * default, the action silently lost its working shortcut.
 *
 * Both concerns now read from this module so the accepted set is derived
 * from what the matcher genuinely handles rather than guessed at.
 */

/**
 * Normalize a raw key token (from a binding string or `KeyboardEvent.key`)
 * to a canonical form so arrow symbols, arrow names, and Space all compare
 * equal regardless of which representation appeared on either side.
 */
export function normalizeKey(raw: string): string {
  // Special-case `' '` BEFORE trimming so the literal space character from
  // `KeyboardEvent.key` (which is `' '` for the spacebar) normalises to the
  // same canonical value as the textual binding `Space`. Trimming would
  // otherwise collapse it to the empty string.
  const lower = raw.toLowerCase()
  if (lower === ' ' || lower === 'space' || lower === 'spacebar') return 'space'
  // Strip internal whitespace so the catalog's spelled-out key names
  // (`Arrow Up`, `Page Up`) compare equal to the corresponding
  // `KeyboardEvent.key` values (`ArrowUp`, `PageUp`) — real event keys
  // never contain spaces (the spacebar is handled above).
  const k = lower.trim().replace(/\s+/g, '')
  if (k === '') return ''
  if (k === '←' || k === 'arrowleft' || k === 'left') return 'arrowleft'
  if (k === '→' || k === 'arrowright' || k === 'right') return 'arrowright'
  if (k === '↑' || k === 'arrowup' || k === 'up') return 'arrowup'
  if (k === '↓' || k === 'arrowdown' || k === 'down') return 'arrowdown'
  return k
}

/**
 * Canonical (post-`normalizeKey`) multi-character key tokens the matcher can
 * ever compare equal to a real `KeyboardEvent.key`.
 *
 * Every entry here is the lowercased `KeyboardEvent.key` value the browser
 * reports, because `normalizeKey` lowercases and strips whitespace and then
 * compares literally. The arrow entries also cover the glyphs (`←→↑↓`) and
 * the bare names (`Left`, `Up`, …) — `normalizeKey` folds those into
 * `arrowleft`/`arrowup`/… — and `space` covers `Space`/`Spacebar`/`' '`.
 *
 * Deliberately NOT included: modifier names (a chord's modifiers are parsed
 * off before the key token is examined) and lock/rare keys the app has no
 * bindings for.
 */
const NAMED_KEY_TOKENS: ReadonlySet<string> = new Set([
  'escape',
  'enter',
  'tab',
  'backspace',
  'delete',
  'insert',
  'home',
  'end',
  'pageup',
  'pagedown',
  'space',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
])

/** `F1`–`F24` (canonicalised to lowercase by `normalizeKey`). */
const FUNCTION_KEY = /^f([1-9]|1\d|2[0-4])$/

/**
 * True when `matchesShortcutBinding` could ever fire on this key token —
 * i.e. some real `KeyboardEvent.key` normalises to the same canonical value.
 *
 * Accepted:
 * - any single printable character (`e`, `?`, `+`, `-`, `/`, `.`, `0`, `@`…),
 * - `F1`–`F24`,
 * - the named keys in {@link NAMED_KEY_TOKENS}, in every spelling
 *   `normalizeKey` folds (`Arrow Up`, `ArrowUp`, `↑`, `Up`, `Space`, …).
 *
 * Rejected: anything else — abbreviations the matcher compares literally and
 * therefore can never match (`Esc`, `Ctl`, `Return`, `Click`).
 */
export function isMatchableKeyToken(raw: string): boolean {
  const canonical = normalizeKey(raw)
  if (canonical === '') return false
  if (NAMED_KEY_TOKENS.has(canonical)) return true
  if (FUNCTION_KEY.test(canonical)) return true
  // Spread so astral-plane characters (emoji) count as one, not two.
  return [...canonical].length === 1
}
