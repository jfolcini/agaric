/**
 * QueryResultRowContent — the rich-content body of one query-result row.
 *
 * #4719. Shared by `QueryResultList` (the `role="option"` row) and
 * `QueryResultTable` (the content cell), which render the same block content
 * in the same two conditions — inside a clamping inline wrapper, and inside
 * an element that is ITSELF the click target. Written once because the two
 * are the third and fourth copy of this row body in the codebase
 * (`AlertSection`'s `AlertRowContent` and `DuePanel`'s
 * `ProjectedEntryContent` are the first two), and because a query row is
 * exactly the surface where the two components must not drift: they render
 * the same `resolveBlockDisplay` output and are already kept in step by it.
 *
 * The two agenda copies are deliberately NOT folded in here. `DuePanel`'s
 * passes `interactive: true` plus an `onTagClick`, and memoizes through refs
 * keyed on the resolve-store version rather than on the callbacks — a
 * different contract, not a duplicate of this one.
 *
 * Memoized on the content string, following `AlertRowContent` (#4705): both
 * callers re-render on state that is not the row's content (roving
 * `focusedIndex` in the list, a header click re-sorting the table), and
 * `renderRichContent`'s element tree — unlike its `parse` — is not cached.
 *
 * The callbacks are sourced INSIDE the memo: `useRichContentCallbacks()`
 * returns a fresh object literal per render, so taking them as a prop would
 * fail the shallow compare on every parent re-render and defeat the memo.
 */

import type React from 'react'
import { memo } from 'react'

import { renderRichContent } from '@/components/RichContentRenderer'
import { useRichContentCallbacks } from '@/hooks/useRichContentCallbacks'
import { unresolvedBlockLabel } from '@/lib/block-title'

/**
 * The resolver the CHIPS in this body render from, in the `(id) => string`
 * shape `resolveBlockDisplay`'s `resolveRefTitle` takes.
 *
 * Exported so the row's accessible name is substituted with the SAME lookup
 * the visible chip performs — the callers own the name, this file owns the
 * chips, and the two must not drift (WCAG 2.5.3). The `unresolvedBlockLabel`
 * fallback restates `renderBlockLink`'s own: `useRichContentCallbacks`
 * returns `undefined` for a miss, where the chip then shows `[[id…]]`.
 */
export function useRefTitleResolver(): (id: string) => string {
  const { resolveBlockTitle } = useRichContentCallbacks()
  return (id: string): string => resolveBlockTitle(id) ?? unresolvedBlockLabel(id)
}

function QueryResultRowContentInner({ content }: { content: string }): React.ReactElement {
  const { resolveBlockTitle, resolveBlockStatus, resolveTagName, resolveTagStatus } =
    useRichContentCallbacks()
  return (
    <>
      {renderRichContent(content, {
        // Keeps block/tag chips from taking focus inside the row (and,
        // inside the table's <button>, from nesting a focusable in a
        // control). NOTE this does not silence external markdown links:
        // `renderExternalLink` sets `role="link"` and `onClick`
        // unconditionally and gates only `tabIndex`, so `[docs](…)` in a row
        // still opens its URL on click instead of navigating to the block.
        interactive: false,
        // Both bodies land in a clamping wrapper (`truncate`), so block-level
        // nodes must be downgraded to inline text: a heading/list/table box
        // inside a single-line row breaks the layout (#1533).
        inline: true,
        resolveBlockTitle,
        resolveBlockStatus,
        resolveTagName,
        resolveTagStatus,
      })}
    </>
  )
}

export const QueryResultRowContent = memo(QueryResultRowContentInner)
QueryResultRowContent.displayName = 'QueryResultRowContent'
