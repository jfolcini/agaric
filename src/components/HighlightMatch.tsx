/**
 * HighlightMatch — highlights the first occurrence of a filter string
 * within a text string using a <mark> element.
 *
 * Extracted from PageBrowser for reuse in any search/filter context.
 */

import type React from 'react'

export function HighlightMatch({
  text,
  filterText,
}: {
  text: string
  filterText: string
}): React.ReactElement {
  if (!filterText) return <>{text}</>
  const idx = text.toLowerCase().indexOf(filterText.toLowerCase())
  if (idx === -1) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-highlight rounded-sm">{text.slice(idx, idx + filterText.length)}</mark>
      {text.slice(idx + filterText.length)}
    </>
  )
}
