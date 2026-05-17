/**
 * SnippetHighlight — render a FTS5 `snippet()` string with `<mark>` boundaries
 * as React nodes (no `dangerouslySetInnerHTML`).
 *
 * PEND-50 Phase 1. The backend emits snippets shaped like
 *
 *   "kicked off the <mark>alpha</mark> review …"
 *
 * by calling `snippet(fts_blocks, 1, '<mark>', '</mark>', '…', 32)`. Those
 * literal `<mark>` / `</mark>` substrings are the *only* markup the parser
 * recognises — any other `<` or `&` in the snippet is rendered as text,
 * which React escapes on its own. This keeps the snippet renderer free of
 * `dangerouslySetInnerHTML` and gives us a zero-XSS-surface highlighter
 * regardless of the source content.
 *
 * The parser is exported separately (`parseSnippet`) so unit tests can hit
 * it without the React chrome, and so the `<mark>` rendering can be
 * threaded through alternate consumers (PEND-55's offset path will sit
 * alongside this one).
 *
 * Edge cases (locked in by PEND-50):
 *
 * - `null` / empty snippet → returns an empty fragment (caller should
 *   render a sensible fallback such as the page title).
 * - Unpaired `<mark>` or `</mark>` (theoretically impossible from FTS5 but
 *   defended against) → the trailing run renders as a plain text span; the
 *   parser never throws.
 * - Multiple `<mark>` pairs → each emits its own `<mark>` element.
 * - Source content containing literal `<` or `&` (e.g. `a < b`) → rendered
 *   verbatim through React, which escapes both characters.
 */

import type React from 'react'

/** A parsed snippet fragment. `marked` = wrap in `<mark>`. */
export interface SnippetFragment {
  text: string
  marked: boolean
}

const OPEN = '<mark>'
const CLOSE = '</mark>'

/**
 * Split a FTS5 `snippet()` string into alternating text / marked fragments.
 *
 * Pure function — no React, no DOM. Returns an empty array for `null` or
 * an empty string so callers can branch on `length === 0` to render a
 * fallback (e.g. the page title) without an extra null check.
 */
export function parseSnippet(snippet: string | null | undefined): SnippetFragment[] {
  if (!snippet) return []

  const fragments: SnippetFragment[] = []
  let cursor = 0

  while (cursor < snippet.length) {
    const openIdx = snippet.indexOf(OPEN, cursor)
    if (openIdx === -1) {
      // No more open tags — emit the rest as plain text.
      fragments.push({ text: snippet.slice(cursor), marked: false })
      break
    }

    // Emit the text before the open tag (may be empty).
    if (openIdx > cursor) {
      fragments.push({ text: snippet.slice(cursor, openIdx), marked: false })
    }

    const contentStart = openIdx + OPEN.length
    const closeIdx = snippet.indexOf(CLOSE, contentStart)
    if (closeIdx === -1) {
      // Unpaired `<mark>` — defensive fallthrough. Render the rest of the
      // string (including the dangling open tag itself, as literal text)
      // so the caller never sees a thrown exception.
      fragments.push({ text: snippet.slice(openIdx), marked: false })
      break
    }

    fragments.push({ text: snippet.slice(contentStart, closeIdx), marked: true })
    cursor = closeIdx + CLOSE.length
  }

  // Drop empty leading / trailing runs but keep empty marked runs (they
  // can legitimately exist if FTS5 marks an empty span, though it
  // shouldn't in practice).
  return fragments.filter((f, i) => {
    if (f.marked) return true
    if (f.text.length > 0) return true
    return i !== 0 && i !== fragments.length - 1
  })
}

export interface SnippetHighlightProps {
  /** The FTS5 `snippet()` string, or `null` when the row has no content match. */
  snippet: string | null | undefined
  /** Optional className applied to the wrapping span (default: none). */
  className?: string
}

/**
 * Render a snippet string as alternating `<span>` / `<mark>` React nodes.
 * The marked spans carry the `.search-result-mark` class declared in
 * `src/index.css` (PEND-50 Phase 1).
 */
export function SnippetHighlight({
  snippet,
  className,
}: SnippetHighlightProps): React.ReactElement {
  const fragments = parseSnippet(snippet)
  return (
    <span className={className}>
      {fragments.map((fragment, idx) => {
        const key = `${idx}-${fragment.marked ? 'm' : 't'}`
        if (fragment.marked) {
          return (
            <mark key={key} className="search-result-mark">
              {fragment.text}
            </mark>
          )
        }
        return <span key={key}>{fragment.text}</span>
      })}
    </span>
  )
}
