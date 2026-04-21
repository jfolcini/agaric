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
import { indexOfFolded } from '@/lib/fold-for-search'

export function HighlightMatch({
  text,
  filterText,
}: {
  text: string
  filterText: string
}): React.ReactElement {
  if (!filterText) return <>{text}</>
  const idx = indexOfFolded(text, filterText)
  if (idx === -1) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-highlight rounded-sm">{text.slice(idx, idx + filterText.length)}</mark>
      {text.slice(idx + filterText.length)}
    </>
  )
}
