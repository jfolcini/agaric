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
 * Thin wrapper around [`findFoldedMatch`] for callers that only need
 * the start offset.  Use `findFoldedMatch` when you also need the
 * length of the matched span in the original string — slicing the
 * original with `needle.length` is incorrect when the fold changes
 * character length (e.g., `ß` → `ss`, `ﬁ` → `fi`).
 */
export function indexOfFolded(haystack: string, needle: string): number {
  const match = findFoldedMatch(haystack, needle)
  return match === null ? -1 : match.start
}

/**
 * Locate the first folded match of `needle` in `haystack`, returning
 * both the start offset AND the length of the original-string slice
 * that produced the folded match.  Returns `null` when no match exists.
 *
 * This is the highlight-correctness counterpart to [`indexOfFolded`].
 * When the fold changes character length, using `needle.length` to
 * slice the original overshoots or undershoots the visual match:
 *
 *  - "Straße" with needle "rasse": folded haystack is "strasse", folded
 *    needle is "rasse" (length 5). The original substring covering the
 *    match is "raße" — only 4 code units, not 5. Highlighting
 *    `slice(start, start + 5)` would extend one character past the
 *    visual match (PAGES-FOLD-MARK).
 *  - "İstanbul" with needle "istanbul": folded "istanbul" is 8 code
 *    units, but `İ` is a single code unit in the original. The original
 *    span is 8 code units (İ + 7 ASCII), so for this case needle-length
 *    happens to coincide with original-span length — but in general
 *    NFKD decomposition can inject code units (combining marks) that
 *    `findFoldedMatch` handles by walking original code units one at
 *    a time and accumulating their folded output.
 *
 * Walks haystack one code **point** at a time, accumulating the fold of
 * each code point onto a running buffer.  Per-code-point folding is
 * safe because NFKD decomposes individual code points independently
 * and combining-mark stripping never re-introduces context across
 * characters.  Walking code *units* instead would split surrogate
 * pairs: a supplementary-plane compatibility character such as 𝐀
 * (U+1D400) NFKD-folds to "a" as a whole code point, but its two lone
 * surrogate halves fold to themselves — desyncing the running buffer
 * from the whole-string fold and corrupting the span math.  O(n) on
 * the haystack length.
 */
export function findFoldedMatch(
  haystack: string,
  needle: string,
): { start: number; length: number } | null {
  if (needle === '') return { start: 0, length: 0 }
  if (isAsciiOnly(haystack) && isAsciiOnly(needle)) {
    // Fast path: ASCII folds 1:1, so original-span length == needle.length.
    const idx = haystack.toLowerCase().indexOf(needle.toLowerCase())
    return idx === -1 ? null : { start: idx, length: needle.length }
  }
  const foldedNeedle = foldForSearch(needle)
  const haystackFolded = foldForSearch(haystack)
  const foldedIdx = haystackFolded.indexOf(foldedNeedle)
  if (foldedIdx === -1) return null
  const foldedEnd = foldedIdx + foldedNeedle.length
  let originalCursor = 0
  let foldedSoFar = ''
  let start: number | null = null
  while (true) {
    if (start === null && foldedSoFar.length >= foldedIdx) {
      start = originalCursor
    }
    if (start !== null && foldedSoFar.length >= foldedEnd) {
      // Greedily absorb trailing code points that fold to nothing (e.g.
      // standalone combining marks) — they visually attach to the last
      // matched base character so they belong inside the highlight span.
      if (originalCursor < haystack.length) {
        const next = String.fromCodePoint(haystack.codePointAt(originalCursor) as number)
        if (foldForSearch(next) === '') {
          originalCursor += next.length
          continue
        }
      }
      return { start, length: originalCursor - start }
    }
    if (originalCursor >= haystack.length) break
    // Step by full code point — `charAt` would split surrogate pairs and
    // fold each lone half to itself, desyncing from the whole-string fold.
    const ch = String.fromCodePoint(haystack.codePointAt(originalCursor) as number)
    foldedSoFar += foldForSearch(ch)
    originalCursor += ch.length
  }
  // Defensive fallback: should not happen for well-formed input.
  return null
}
