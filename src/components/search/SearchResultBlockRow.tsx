/**
 * SearchResultBlockRow — single result row inside a page-grouped result
 * listbox (PEND-50 Phase 1).
 *
 * Renders the matched block's snippet (with `<mark>` highlights via
 * `SnippetHighlight`) or, when the row has no content snippet (page-name-
 * only hit), the block content verbatim. Each row is the `role="option"`
 * `<li>` itself — the click handler sits on the `<li>` so axe's
 * "nested-interactive" rule stays satisfied (an `<option>` cannot wrap
 * a focusable `<button>`). Keyboard activation flows through the
 * parent listbox's `aria-activedescendant` model: ArrowUp/Down move
 * the roving focus, Enter/Space calls `onSelect` (wired in
 * `SearchPanel.tsx`).
 *
 * No `dangerouslySetInnerHTML` — the snippet is parsed into React nodes by
 * `SnippetHighlight`.
 */

import type React from 'react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import type { MatchOffset, SearchBlockRow as SearchBlockRowT } from '@/lib/bindings'
import { cn } from '@/lib/utils'
import { SnippetHighlight } from './SnippetHighlight'

export interface SearchResultBlockRowProps {
  row: SearchBlockRowT
  isFocused: boolean
  onClick: () => void
  /** Whether the row is currently waiting on a navigation IPC. */
  loading?: boolean
  /** DOM id used by the parent listbox `aria-activedescendant`. */
  id?: string
}

/**
 * PEND-55 — split `content` into alternating plain spans and `<mark>`
 * highlight runs from a list of UTF-16 offset pairs. NO
 * `dangerouslySetInnerHTML`; React renders each fragment as its own
 * node so axe + react-dom escape every span.
 *
 * Out-of-range / overlapping / inverted offsets are skipped defensively
 * — the backend caps the offset count and sorts in match order, but a
 * malformed payload (e.g. from an older bundle) must never throw.
 */
function renderOffsetHighlights(content: string, offsets: ReadonlyArray<MatchOffset>) {
  const len = content.length
  const out: React.ReactNode[] = []
  let cursor = 0
  for (let i = 0; i < offsets.length; i++) {
    const o = offsets[i]
    if (!o) continue
    const start = Math.max(0, Math.min(len, o.start))
    const end = Math.max(start, Math.min(len, o.end))
    if (end <= cursor || start === end) continue
    if (start > cursor) {
      out.push(<span key={`p${cursor}`}>{content.slice(cursor, start)}</span>)
    }
    out.push(
      <mark key={`m${start}`} className="rounded-sm bg-yellow-200/70 dark:bg-yellow-500/30">
        {content.slice(start, end)}
      </mark>,
    )
    cursor = end
  }
  if (cursor < len) {
    out.push(<span key={`p${cursor}`}>{content.slice(cursor)}</span>)
  }
  return out
}

export function SearchResultBlockRow({
  row,
  isFocused,
  onClick,
  loading,
  id,
}: SearchResultBlockRowProps): React.ReactElement {
  const { t } = useTranslation()
  const hasOffsets =
    row.match_offsets != null && row.match_offsets.length > 0 && row.content != null
  const hasSnippet = !hasOffsets && row.snippet != null && row.snippet.length > 0
  const fallback = row.content && row.content.length > 0 ? row.content : t('common.empty')
  // PEND-55 — derive the offset-driven React nodes once per row.
  // Inputs change only when the row identity / offsets change.
  const offsetNodes = useMemo(() => {
    if (!hasOffsets || row.content == null) return null
    return renderOffsetHighlights(row.content, row.match_offsets ?? [])
  }, [hasOffsets, row.content, row.match_offsets])

  function handleClick() {
    if (loading) return
    onClick()
  }

  return (
    <li
      id={id}
      // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: `<li role="option">` is the canonical WAI-ARIA pattern for listbox options inside a `<ul role="listbox">` — biome's rule misclassifies it as non-interactive.
      role="option"
      aria-selected={isFocused}
      aria-disabled={loading ? true : undefined}
      tabIndex={-1}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (loading) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      className={cn(
        'list-none flex items-center gap-2 rounded-md px-3 py-1.5 text-sm cursor-pointer',
        'hover:bg-accent/30 active:bg-accent/40 transition-colors',
        isFocused && 'bg-accent',
        loading && 'opacity-60 cursor-progress',
      )}
      data-testid={`search-result-row-${row.id}`}
    >
      <span className="flex-1 text-sm line-clamp-2">
        {hasOffsets ? (
          offsetNodes
        ) : hasSnippet ? (
          <SnippetHighlight snippet={row.snippet} />
        ) : (
          fallback
        )}
      </span>
      {loading && <Spinner className="shrink-0 text-muted-foreground" />}
      {(row.block_type === 'tag' || row.block_type === 'page') && (
        <Badge tone="secondary">{row.block_type}</Badge>
      )}
    </li>
  )
}
