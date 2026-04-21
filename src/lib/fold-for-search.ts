/**
 * Unicode-aware case-insensitive substring matching for interactive
 * search / filter surfaces (UX-247).
 *
 * `String.prototype.toLowerCase()` is not locale-aware and has three
 * well-known substring-match failure modes:
 *
 *  - Turkish dotted I `İ` (U+0130) → lowercases to `i` + combining
 *    dot above (U+0069 U+0307, two code points), so `"İstanbul"
 *    .toLowerCase().includes("istanbul")` returns **false**.
 *  - German eszett `ß` (U+00DF) → lowercases to itself. The historical
 *    uppercase `SS` / `ẞ` never fold back together, so
 *    `"Straße".toLowerCase().includes("strasse")` returns **false**.
 *  - Accented letters stay accented, so users expecting "naive" to
 *    match "naïve" see no match.
 *
 * The [`foldForSearch`] helper normalises both sides of the comparison
 * the way an interactive filter UI is expected to behave:
 *
 *  1. NFKD-decompose combining forms (so `İ` → `I` + `U+0307`).
 *  2. Strip combining diacritics (`U+0300..U+036F`).
 *  3. Lowercase the remainder.
 *  4. Fold `ß` → `ss` explicitly (decomposition does not cover it).
 *
 * The common case — both strings pure ASCII — fast-paths through
 * plain `.toLowerCase()` so the extra normalisation cost is only
 * paid on non-ASCII input.
 *
 * This matches what `Intl.Collator` with `sensitivity: 'base'` does
 * for whole-string equality, adapted to substring search via
 * `String.prototype.includes`.
 */

const COMBINING_DIACRITICS = /[\u0300-\u036f]/g

/**
 * Return `true` when every code unit in `s` is in the ASCII range
 * (`0x00..0x7f`).  Implemented as an imperative scan rather than
 * a regex so biome's `noControlCharactersInRegex` lint stays out
 * of the way — the range intentionally includes the full ASCII
 * control set, which is correct for the "pure ASCII input?"
 * question and short-circuits the more expensive NFKD path.
 */
function isAsciiOnly(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) return false
  }
  return true
}

/**
 * Fold a string to a canonical form suitable for case- /
 * diacritic-insensitive substring comparison via
 * [`String.prototype.includes`].
 *
 * - ASCII-only input short-circuits to `.toLowerCase()` (cheap).
 * - Non-ASCII input is NFKD-normalised, stripped of combining
 *   marks, lowercased, and has `ß` replaced with `ss`.
 *
 * Always apply this function to **both** sides of the comparison —
 * `foldForSearch(haystack).includes(foldForSearch(needle))`.
 */
export function foldForSearch(s: string): string {
  if (isAsciiOnly(s)) return s.toLowerCase()
  return s.normalize('NFKD').replace(COMBINING_DIACRITICS, '').toLowerCase().replace(/ß/g, 'ss')
}

/**
 * Convenience: does `haystack` contain `needle` after Unicode-aware
 * folding on both sides?  Returns `true` when `needle` is empty so
 * callers can use it directly in filter predicates.
 */
export function matchesSearchFolded(haystack: string, needle: string): boolean {
  if (needle === '') return true
  return foldForSearch(haystack).includes(foldForSearch(needle))
}

/**
 * Locate the index of the first folded match of `needle` in
 * `haystack`.  Returns `-1` when no match exists.
 *
 * NFKD decomposition can change string length (e.g., `İ` expands
 * from 1 code unit to 2).  This helper maps the index in the folded
 * haystack back to the equivalent code-unit offset in the original
 * haystack by scanning one character at a time.  `slice(index,
 * index + needle.length)` on the original string then gives the
 * caller a visually-correct substring to highlight.
 *
 * If the folded match spans a position where decomposition injected
 * code units, the returned slice may be off by a combining-mark
 * character.  For interactive highlight UI this is acceptable — the
 * mismatch is cosmetic at worst.
 */
export function indexOfFolded(haystack: string, needle: string): number {
  if (needle === '') return 0
  if (isAsciiOnly(haystack) && isAsciiOnly(needle)) {
    // Fast path: direct case-insensitive ASCII search.
    return haystack.toLowerCase().indexOf(needle.toLowerCase())
  }
  const foldedNeedle = foldForSearch(needle)
  // Walk the haystack char by char, folding each cumulative prefix,
  // and compare the folded slice against the folded needle.  O(n·m)
  // in the worst case; acceptable for the short strings a filter UI
  // works with.
  const haystackFolded = foldForSearch(haystack)
  const foldedIdx = haystackFolded.indexOf(foldedNeedle)
  if (foldedIdx === -1) return -1
  // Map folded offset back to an original-string offset by scanning
  // the original prefix until its fold matches `haystackFolded
  // .slice(0, foldedIdx)`.
  const foldedPrefix = haystackFolded.slice(0, foldedIdx)
  let originalCursor = 0
  while (originalCursor <= haystack.length) {
    if (foldForSearch(haystack.slice(0, originalCursor)) === foldedPrefix) {
      return originalCursor
    }
    originalCursor++
  }
  // Defensive fallback: if the scan fails (should not happen for
  // well-formed input), return the folded index — it will be off
  // for exotic inputs but is better than returning -1 and hiding
  // the match entirely.
  return foldedIdx
}
