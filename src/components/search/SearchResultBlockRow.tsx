/**
 * SearchResultBlockRow — single result row inside a page-grouped result
 * Listbox (Phase 1).
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
import { memo, useMemo } from 'react'
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
  /**
   * Absolute-positioning style supplied by the per-group
   * virtualizer (`position:absolute; transform:translateY(start)`). Unset
   * for the non-virtualized callers (tests) where the row flows normally.
   */
  style?: React.CSSProperties
  /**
   * The virtualizer's `measureElement` ref. Attached to
   * the `<li>` so its real height corrects the size estimate after first
   * paint. Unset outside the virtualized listbox.
   */
  measureRef?: (el: HTMLElement | null) => void
  /**
   * The virtual-row index, rendered as `data-index` so
   * `@tanstack/react-virtual`'s `measureElement` can map the measured DOM
   * node back to its row. Unset outside the virtualized listbox.
   */
  dataIndex?: number
}

/**
 * Split `content` into alternating plain spans and `<mark>`
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
      // #1096 — route through the shared `.search-result-mark` treatment
      // (`--accent`/`--accent-foreground`) so the offset-highlighted row
      // reads as the SAME colour as its `SnippetHighlight` sibling inside
      // the one listbox, instead of a hand-coded yellow that diverged.
      <mark key={`m${start}`} className="search-result-mark">
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

function SearchResultBlockRowImpl({
  row,
  isFocused,
  onClick,
  loading,
  id,
  style,
  measureRef,
  dataIndex,
}: SearchResultBlockRowProps): React.ReactElement {
  const { t } = useTranslation()
  const hasOffsets =
    row.match_offsets != null && row.match_offsets.length > 0 && row.content != null
  const hasSnippet = !hasOffsets && row.snippet != null && row.snippet.length > 0
  const fallback = row.content && row.content.length > 0 ? row.content : t('common.empty')
  // Derive the offset-driven React nodes once per row.
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
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- tabIndex={-1} keeps the row out of the focus path; keyboard activation flows through the parent combobox's input via aria-activedescendant per the WAI-ARIA 1.2 combobox pattern. Phase 3.U3 removed the dead row-level onKeyDown that was never reachable.
    <li
      id={id}
      ref={measureRef}
      data-index={dataIndex}
      style={style}
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-to-interactive-role, jsx-a11y/prefer-tag-over-role -- `<li role="option">` is the canonical WAI-ARIA pattern for listbox options inside a `<ul role="listbox">`; native <option> can't host the rich row content (icons/title/excerpt) this virtualized listbox renders.
      role="option"
      aria-selected={isFocused}
      aria-disabled={loading ? true : undefined}
      tabIndex={-1}
      onClick={handleClick}
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

/**
 * Phase 4.P1 — memoised. The parent `SearchResultGroups`
 * re-renders on every focus move (it owns `focusedRowId`); without
 * memoisation, every visible row re-runs `useMemo` + reflows its
 * `<mark>` highlights even though only the two rows whose `isFocused`
 * flipped actually need to re-render.
 *
 * Custom comparator intentionally ignores `onClick` — the parent
 * passes `() => onResultClick(block)`, a fresh closure each render
 * that would defeat the default shallow check, but the closure's
 * EFFECT is invariant given the same `row` (the captured `block` is
 * the row, and `onResultClick` is the parent's stable handler). The
 * comparator returns `true` (skip re-render) when every other prop
 * is unchanged; the stale `onClick` is still wired up correctly
 * because the user can only fire it after the row commits, and on
 * commit it gets the latest closure.
 */
export const SearchResultBlockRow = memo(SearchResultBlockRowImpl, (prev, next) => {
  // `style` is the virtualizer's positioning transform; it
  // changes whenever the row's offset shifts (scroll / re-measure), so it
  // must defeat the memo. `measureRef` is stable per virtualizer instance,
  // so it is intentionally NOT compared.
  return (
    prev.row.id === next.row.id &&
    prev.row.content === next.row.content &&
    prev.row.snippet === next.row.snippet &&
    prev.row.match_offsets === next.row.match_offsets &&
    prev.isFocused === next.isFocused &&
    prev.loading === next.loading &&
    prev.id === next.id &&
    prev.dataIndex === next.dataIndex &&
    prev.style?.transform === next.style?.transform
  )
})
