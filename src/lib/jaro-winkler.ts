/**
 * Jaro-Winkler similarity (PEND-51).
 *
 * Pure-frontend fuzzy scorer used by the Cmd+K palette to rescore the
 * FTS5 candidate set with edit-distance tolerance. The FTS5 trigram
 * tokenizer matches substrings exactly — a typo like `alfa` (transposed
 * / missing letter) won't match `Alpha`. Palettes feel telepathic
 * specifically because they forgive typos; this is the additive rescore
 * the plan calls out under "Fuzzy ranking on top of FTS".
 *
 * Algorithm (Winkler 1990 — full reference: Winkler, W. E. "String
 * Comparator Metrics and Enhanced Decision Rules in the Fellegi-Sunter
 * Model of Record Linkage." 1990):
 *
 *   1. Jaro similarity `j` from matches / transpositions.
 *   2. Winkler boost: add `prefixScale * commonPrefix * (1 - j)` where
 *      `commonPrefix` is the number of leading characters that match
 *      (max 4) and `prefixScale = 0.1`.
 *
 * Hand-rolled (no new dependency) per the plan's locked-in decisions:
 * "hand-roll Jaro-Winkler (~40 LOC) if `js-levenshtein` not in deps."
 *
 * Inputs are lower-cased so the scorer is case-insensitive — the FTS5
 * candidate set is already case-insensitive (trigram tokenizer is
 * `case_sensitive 0`), and palette ranking should not flip on
 * capitalisation of the user's typed query.
 *
 * Returns a similarity score in `[0, 1]`. Identical strings return `1`;
 * disjoint strings return `0`. Empty inputs (either side) return `0`.
 */

/** Maximum prefix length boosted by the Winkler enhancement. */
const WINKLER_PREFIX_MAX = 4
/** Winkler scaling factor — 0.1 is the canonical value. */
const WINKLER_PREFIX_SCALE = 0.1

/**
 * Jaro similarity — fraction of matching characters within a sliding
 * window, less half the transposition count. Pure function, no allocation
 * beyond two `Uint8Array` mark buffers (Jaro's standard implementation).
 */
function jaro(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0
  if (a === b) return 1

  // Match window: floor(max(|a|, |b|) / 2) - 1, clamped at 0.
  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1)

  const aMatched = new Uint8Array(a.length)
  const bMatched = new Uint8Array(b.length)

  let matches = 0
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchWindow)
    const end = Math.min(b.length, i + matchWindow + 1)
    for (let j = start; j < end; j++) {
      if (bMatched[j]) continue
      if (a[i] !== b[j]) continue
      aMatched[i] = 1
      bMatched[j] = 1
      matches++
      break
    }
  }
  if (matches === 0) return 0

  // Transpositions: count mismatched-but-matched character pairs in
  // visit order. Divide by 2 (canonical Jaro definition).
  let transpositions = 0
  let k = 0
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue
    while (!bMatched[k]) k++
    if (a[i] !== b[k]) transpositions++
    k++
  }
  const t = transpositions / 2

  const m = matches
  return (m / a.length + m / b.length + (m - t) / m) / 3
}

/**
 * Jaro-Winkler similarity. Boosts the Jaro score for strings sharing a
 * common prefix (up to `WINKLER_PREFIX_MAX` characters).
 *
 * Both inputs are lowered to ASCII case before comparison — palette
 * ranking is case-insensitive (matches the FTS5 candidate set).
 */
export function jaroWinkler(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0
  const aLow = a.toLowerCase()
  const bLow = b.toLowerCase()
  if (aLow === bLow) return 1
  const j = jaro(aLow, bLow)
  // Common prefix length capped at WINKLER_PREFIX_MAX.
  let p = 0
  const maxP = Math.min(WINKLER_PREFIX_MAX, aLow.length, bLow.length)
  while (p < maxP && aLow[p] === bLow[p]) p++
  return j + p * WINKLER_PREFIX_SCALE * (1 - j)
}

/**
 * Blend an FTS-derived rank score with a fuzzy similarity score per the
 * PEND-51 plan: `0.7 * fts + 0.3 * fuzzy`.
 *
 * `ftsScore` is expected to be a normalised, **higher-is-better** score
 * in `[0, 1]`. Callers should derive it from the FTS5 cursor rank via
 * `1 / (1 + position_in_results)` or similar — the trigram rank values
 * themselves are not bounded and would dominate the blend.
 */
export function blendFtsFuzzy(ftsScore: number, fuzzyScore: number): number {
  return 0.7 * ftsScore + 0.3 * fuzzyScore
}
