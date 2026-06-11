/**
 * HighlightMatch — highlights the first occurrence of a filter string
 * within a text string using a <mark> element.
 *
 * Extracted from PageBrowser for reuse in any search/filter context.
 * Uses Unicode-aware folding (UX-247) so the highlight triggers for
 * Turkish (`İstanbul` ↔ `istanbul`), German (`Straße` ↔ `strasse`),
 * and accented (`café` ↔ `cafe`) mismatches that plain
 * `.toLowerCase()` would miss.
 */

import type React from 'react'

import { findFoldedMatch } from '@/lib/fold-for-search'

export function HighlightMatch({
  text,
  filterText,
}: {
  text: string
  filterText: string
}): React.ReactElement {
  if (!filterText) return <>{text}</>
  // PAGES-FOLD-MARK: use the original-span length the fold produced,
  // not `filterText.length`. When the fold changes character length
  // (e.g. ß → ss in `Straße` matched against `strasse`) the two are
  // not equal, and using `filterText.length` mis-bounds the `<mark>`.
  const match = findFoldedMatch(text, filterText)
  if (match === null) return <>{text}</>
  const { start, length } = match
  return (
    <>
      {text.slice(0, start)}
      <mark className="bg-highlight rounded-sm">{text.slice(start, start + length)}</mark>
      {text.slice(start + length)}
    </>
  )
}
