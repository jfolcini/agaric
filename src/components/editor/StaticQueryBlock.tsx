/**
 * StaticQueryBlock — the query-block render concern of StaticBlock.
 *
 * A `{{query ...}}` block renders a QueryResult inside a passive container.
 * QueryResult's inner subtree is densely interactive (chevron toggle,
 * edit-pencil, result items that navigate to their parent page, PageLink
 * badges) and those inner handlers call `stopPropagation()` — so we focus the
 * block from a capture-phase click handler that yields to explicit
 * button/link targets.
 */

import type React from 'react'
import { useCallback } from 'react'

import { QueryResult } from '@/components/query/QueryResult'

export interface StaticQueryBlockProps {
  blockId: string
  /** The query expression, i.e. the `{{query …}}` content with the delimiters stripped. */
  expression: string
  onFocus: (blockId: string) => void
  onNavigate?: ((id: string) => void) | undefined
  resolveBlockTitle?: ((id: string) => string) | undefined
  onSelect?: ((blockId: string, mode: 'toggle' | 'range') => void) | undefined
}

export function StaticQueryBlock({
  blockId,
  expression,
  onFocus,
  onNavigate,
  resolveBlockTitle,
  onSelect,
}: StaticQueryBlockProps): React.ReactElement {
  // Capture-phase handler used for query blocks. QueryResult's inner
  // subtree is densely interactive (chevron toggle, edit-pencil, result
  // items that navigate to their parent page, PageLink badges) and those
  // inner handlers call `stopPropagation()`. That left no reliable
  // bubble-phase click path for "click anywhere on the query block to
  // re-enter edit mode" — a plain `.click()` on the block-static element
  // would always land on a result item and never reach this wrapper.
  //
  // Running in the capture phase lets us eagerly focus the block for any
  // non-interactive target (result item content, empty header area, card
  // background), while still yielding the click to explicit `<button>` /
  // `<a>` / `role="link"` elements when those are the actual target.
  const handleQueryBlockClickCapture = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement
      // Let the chevron toggle, edit-query pencil, and PageLink badge
      // handle their own clicks.
      if (target.closest('button, a, [role="link"]')) return
      // Otherwise treat the click as "focus this block" (or select, with
      // modifier keys) and suppress the downstream item-level navigation
      // that would otherwise send us away to a result's parent page.
      e.preventDefault()
      e.stopPropagation()
      if ((e.ctrlKey || e.metaKey) && onSelect) onSelect(blockId, 'toggle')
      else if (e.shiftKey && onSelect) onSelect(blockId, 'range')
      else onFocus(blockId)
    },
    [blockId, onFocus, onSelect],
  )

  return (
    // Passive container — no role/tabIndex; the inner subtree
    // owns keyboard + focus. Click capture forwards bare-card clicks to
    // onFocus while yielding to inner button/link targets.
    <div
      className="block-static w-full min-h-[1.75rem] rounded-md text-left text-sm [@media(pointer:coarse)]:min-h-[2.75rem]"
      data-testid="block-static"
      data-block-id={blockId}
      onClickCapture={handleQueryBlockClickCapture}
    >
      <QueryResult
        expression={expression}
        blockId={blockId}
        onNavigate={onNavigate ? (pageId) => onNavigate(pageId) : undefined}
        resolveBlockTitle={resolveBlockTitle}
      />
    </div>
  )
}
