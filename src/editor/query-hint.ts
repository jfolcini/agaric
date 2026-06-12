/**
 * Pure logic for the inline `{{query …}}` syntax-hint affordance (#907).
 *
 * ## Why a passive ghost-text hint and NOT a TipTap Suggestion popup
 *
 * The first attempt (#215a) wired a `@tiptap/suggestion` plugin with a space
 * trigger. That broke block-saving for a structural reason that has nothing
 * to do with the space trigger specifically:
 *
 *   `useBlockKeyboard` (src/editor/use-block-keyboard.ts) gates Enter on
 *   `isSuggestionPopupVisible()` — it queries the DOM for a visible
 *   `.suggestion-popup` element and, when one exists, *defers Enter to the
 *   Suggestion plugin* so the popup can select an item. The Suggestion
 *   plugin's `SuggestionList` then consumes Enter. Result: Enter selects a
 *   hint instead of saving the block, the block never flushes, and
 *   `query-blocks.spec.ts` goes red.
 *
 * Therefore ANY affordance that renders a `.suggestion-popup` (or registers a
 * ProseMirror keymap that claims Enter) will eat Enter. The fix is to render
 * the hint as a **ghost-text decoration widget** — never a `.suggestion-popup`
 * — and to claim *only* the Tab key, and only when a hint is active. Enter is
 * never inspected by this plugin, so it always propagates to the block-save
 * flow. This module holds the framework-free logic so it can be unit-tested
 * without TipTap / jsdom; the thin TipTap shell lives in
 * `extensions/query-hint.ts`.
 *
 * Vocabulary is sourced exclusively from `lib/query-utils.ts` so the hint can
 * never offer a key/operator the parser rejects.
 */

import {
  QUERY_KEYS,
  QUERY_OPERATORS,
  QUERY_PROPERTY_KEYS,
  QUERY_TYPE_VALUES,
} from '../lib/query-utils'

/** A computed hint: the suffix to append on Tab + a human label for display. */
export interface QueryHint {
  /**
   * The text that completing the hint (Tab) appends at the cursor. For a key
   * completion of `ta` this is `g:` (so `{{query ta|` → `{{query tag:|`); for
   * an operator hint after `property:context` it is `=`.
   */
  completion: string
  /** Full token being suggested, for display as ghost text (e.g. `tag:`). */
  display: string
}

/**
 * The slice of editor state this logic needs. Keeping it minimal (just the
 * block's plain text + the cursor offset within that text) makes the function
 * trivially unit-testable and independent of ProseMirror coordinate math.
 */
export interface QueryHintContext {
  /** Plain text of the current block / paragraph. */
  text: string
  /** Caret offset within `text` (collapsed selection). */
  caret: number
}

/** Opening / closing query delimiters. */
const OPEN = '{{query'
const CLOSE = '}}'

/**
 * Is the caret positioned inside the *expression* portion of a `{{query …}}`
 * token (after `{{query ` and before the closing `}}`)? Returns the expression
 * substring and the caret's offset within it, or `null` when the caret is
 * outside any query token.
 */
export function queryExprAtCaret(
  ctx: QueryHintContext,
): { expr: string; exprCaret: number; exprStart: number } | null {
  const { text, caret } = ctx
  // Find the nearest `{{query` opening at or before the caret.
  const openIdx = text.lastIndexOf(OPEN, caret)
  if (openIdx < 0) return null

  // The expression starts after `{{query` and a single following space.
  // `{{query}}` with no space (or `{{querysomething`) is not an expression we
  // hint inside.
  const afterOpen = openIdx + OPEN.length
  if (text[afterOpen] !== ' ') return null
  const exprStart = afterOpen + 1

  // The caret must be at or past the start of the expression body.
  if (caret < exprStart) return null

  // If a closing `}}` appears between the opening and the caret, the caret is
  // past this token — don't hint.
  const closeIdx = text.indexOf(CLOSE, afterOpen)
  if (closeIdx >= 0 && caret > closeIdx) return null

  // Expression body runs to the close (if any) or end of text.
  const exprEnd = closeIdx >= 0 ? closeIdx : text.length
  const expr = text.slice(exprStart, exprEnd)
  return { expr, exprCaret: caret - exprStart, exprStart }
}

/**
 * Longest item in `candidates` that `partial` is a strict, case-sensitive
 * prefix of (and shorter than). Returns the *remaining* suffix to append, or
 * `null` when nothing matches or `partial` already equals a candidate.
 */
function bestPrefixCompletion(
  partial: string,
  candidates: readonly string[],
): { completion: string; display: string } | null {
  if (partial === '') return null
  // Prefer the shortest candidate that extends `partial`, so `t` → `tag`
  // rather than jumping straight past it; deterministic via the source order.
  for (const cand of candidates) {
    if (cand.length > partial.length && cand.startsWith(partial)) {
      return { completion: cand.slice(partial.length), display: cand }
    }
  }
  return null
}

/**
 * Compute the inline hint for the current caret position, or `null` when no
 * hint should show. The rules deliberately fire only where a key/operator is
 * genuinely expected — never on every space:
 *
 *   1. Caret must be inside a `{{query …}}` expression body.
 *   2. The "current word" is the run of non-space chars ending at the caret.
 *   3. If the word contains no `:` yet → suggest a KEY completion
 *      (`tag`, `property`, `type`, …) and append the `:` separator.
 *   4. If the word is `property:<keyPartial>` with no operator yet → suggest a
 *      well-known property KEY completion (`todo_state`, …); if the key is
 *      complete and no operator typed → suggest the default `=` operator.
 *   5. If the word is `type:<valuePartial>` → suggest a TYPE value
 *      (`tag`/`property`/`backlinks`).
 *
 * Whitespace before the caret (just typed a space) yields `null` — no hint —
 * which is exactly why this never blocks the space key.
 */
export function computeQueryHint(ctx: QueryHintContext): QueryHint | null {
  const inside = queryExprAtCaret(ctx)
  if (!inside) return null
  const { expr, exprCaret } = inside

  // Current word = non-space run ending at the caret within the expression.
  const before = expr.slice(0, exprCaret)
  const wordMatch = before.match(/(\S+)$/)
  if (!wordMatch) return null // caret right after a space / at expr start → no hint
  const word = wordMatch[1] as string

  const colonIdx = word.indexOf(':')
  if (colonIdx < 0) {
    // No colon yet → completing a key prefix.
    const hit = bestPrefixCompletion(word, QUERY_KEYS)
    if (!hit) return null
    // Append the `:` separator so Tab lands you ready to type a value.
    return { completion: `${hit.completion}:`, display: `${hit.display}:` }
  }

  const prefix = word.slice(0, colonIdx)
  const rest = word.slice(colonIdx + 1)

  if (prefix === 'property') {
    // Already has an operator? Then we're typing a value — no hint.
    if (QUERY_OPERATORS.some((op) => rest.includes(op))) return null
    // Completing the property key segment.
    const keyHit = bestPrefixCompletion(rest, QUERY_PROPERTY_KEYS)
    if (keyHit) return { completion: keyHit.completion, display: keyHit.display }
    // Key looks complete (non-empty, no further completion) → offer `=`.
    if (rest.length > 0) {
      return { completion: '=', display: `${rest}=` }
    }
    return null
  }

  if (prefix === 'type') {
    const typeHit = bestPrefixCompletion(rest, QUERY_TYPE_VALUES)
    if (typeHit) return { completion: typeHit.completion, display: typeHit.display }
    return null
  }

  // tag:/expr:/key:/value:/target: — the value is free-form; nothing to hint.
  return null
}
