/**
 * PEND-54 — Caret-anchored autocomplete detection.
 *
 * Given the current query string and the caret position (column
 * offset, 0-indexed, end-exclusive — i.e. `input.selectionStart` from
 * a textbox), return whether an autocomplete popover should be open
 * and what the user has typed so far inside the active prefix.
 *
 * Cases (mirroring the plan's "Autocomplete inside the input"
 * section):
 *   - `tag:#urg|` (caret at `|`) → `{active: 'tag', query: 'urg'}`
 *   - `tag:#|`                   → `{active: 'tag', query: ''}`
 *   - `path:Journal/|`           → `{active: 'pathInclude', query: 'Journal/'}`
 *   - `not-path:Archive/|`       → `{active: 'pathExclude', query: 'Archive/'}`
 *   - `tag:#urgent |…|` (after the space) → `null`
 *   - caret inside `"…"` quoted phrase → `null`
 *   - caret in free text → `null`
 *
 * The implementation operates on the *active token slice* (everything
 * after the last whitespace before the caret). This makes the rule
 * robust to multi-token queries — autocomplete only fires for the
 * token the user is currently editing.
 */

export type AutocompleteAnchor =
  | { active: 'tag'; query: string; anchor: number }
  | { active: 'pathInclude'; query: string; anchor: number }
  | { active: 'pathExclude'; query: string; anchor: number }
  | null

/**
 * Detect the active autocomplete context for the caret.
 *
 * `caret` is the column offset (0-based, end-exclusive) — same shape
 * as `HTMLInputElement.selectionStart`. Values outside `[0,
 * input.length]` are clamped.
 *
 * `anchor` in the return is the column where the *value* portion
 * starts (i.e. just after the prefix). Callers position their popover
 * relative to that column.
 */
export function detectAutocompleteAnchor(input: string, caret: number): AutocompleteAnchor {
  const c = Math.max(0, Math.min(caret, input.length))

  // If caret is inside an unclosed quoted phrase, never auto-complete.
  if (isInsideQuote(input, c)) return null

  // Find the start of the current whitespace-delimited token.
  let start = c
  while (start > 0) {
    const ch = input[start - 1]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') break
    start--
  }
  const slice = input.slice(start, c)

  // tag:#…
  if (slice.startsWith('tag:#')) {
    return {
      active: 'tag',
      query: slice.slice('tag:#'.length),
      anchor: start + 'tag:#'.length,
    }
  }
  // tag: alone (no hash) — accept but treat the value as the query.
  if (slice.startsWith('tag:') && !slice.includes('#') && slice !== 'tag:') {
    return {
      active: 'tag',
      query: slice.slice('tag:'.length),
      anchor: start + 'tag:'.length,
    }
  }
  if (slice === 'tag:#' || slice === 'tag:') {
    return { active: 'tag', query: '', anchor: start + slice.length }
  }
  // not-path: must be checked before path: (longer prefix wins).
  if (slice.startsWith('not-path:')) {
    return {
      active: 'pathExclude',
      query: slice.slice('not-path:'.length),
      anchor: start + 'not-path:'.length,
    }
  }
  if (slice.startsWith('path:')) {
    return {
      active: 'pathInclude',
      query: slice.slice('path:'.length),
      anchor: start + 'path:'.length,
    }
  }
  return null
}

/**
 * Returns true if `caret` falls inside an unclosed `"…"` phrase.
 *
 * Walk through the input counting unmatched `"` characters. If the
 * count is odd at `caret`, we're inside a phrase.
 */
function isInsideQuote(input: string, caret: number): boolean {
  let quoted = false
  for (let i = 0; i < caret; i++) {
    if (input[i] === '"') quoted = !quoted
  }
  return quoted
}

/**
 * Replace the active autocomplete slice with `replacement`.
 *
 * Returns `{nextValue, nextCaret}` — the new input string and the
 * column the caller should set the caret to. The replacement is
 * inserted in place of the token-relative value portion; a trailing
 * space is appended so the user can immediately type the next token.
 */
export function applyAutocompleteReplacement(
  input: string,
  caret: number,
  anchor: AutocompleteAnchor,
  replacement: string,
): { nextValue: string; nextCaret: number } {
  if (anchor == null) return { nextValue: input, nextCaret: caret }
  const c = Math.max(0, Math.min(caret, input.length))
  const before = input.slice(0, anchor.anchor)
  const after = input.slice(c)
  const insert = replacement + (after.startsWith(' ') ? '' : ' ')
  return {
    nextValue: before + insert + after,
    nextCaret: before.length + insert.length,
  }
}
