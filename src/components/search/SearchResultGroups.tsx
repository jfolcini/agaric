/**
 * SearchResultGroups — page-grouped result list for SearchPanel
 * (PEND-50 Phase 1).
 *
 * Wraps `CollapsibleGroupList` (reused unchanged for the row/header
 * markup) with the search-specific a11y model:
 *
 *  - The outer container carries `role="region"` and
 *    `aria-label={t('search.resultsRegionLabel')}` so screen readers
 *    announce the area entry.
 *  - Each group's row list is a `role="listbox"` with its own
 *    `aria-activedescendant`. We deliberately render per-group listboxes
 *    rather than a single tree (see PEND-50 a11y rationale): trees
 *    require `aria-posinset` / `aria-setsize` / typeahead accounting,
 *    whereas per-group listboxes preserve the existing
 *    `useListKeyboardNavigation` roving model.
 *  - The block row component (`SearchResultBlockRow`) renders the
 *    `role="option"` `<li>` and the `<mark>`-highlighted snippet.
 *
 * Keyboard nav across groups: the parent (`SearchPanel`) drives a single
 * `focusedIndex` over the flattened result array, then this component
 * maps `focusedIndex` → `{ groupIdx, rowIdx }` to highlight the right
 * row and surface the right `aria-activedescendant` per group. Arrow
 * keys forwarded to each group's listbox call back into the parent's
 * `onKeyDown` so navigation stays continuous across collapsed/expanded
 * groups (collapsed groups contribute zero rows to the flat index).
 *
 * The component is intentionally read-only with regard to expand/collapse
 * state — the parent owns `expandedGroups` so it can reset on query
 * change and persist across re-renders.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'
import type { SearchBlockRow } from '@/lib/bindings'
import { CollapsibleGroupList } from '../CollapsibleGroupList'
import { ResultCountSummary } from './ResultCountSummary'
import { SearchResultBlockRow } from './SearchResultBlockRow'
import { VirtualizedResultListbox } from './VirtualizedResultListbox'

/** A page-bucketed group of matching block rows. */
export interface SearchResultGroup {
  page_id: string
  page_title: string | null
  /**
   * True when the page itself matched (e.g. title-only hit) and at
   * least one of `blocks` represents that page. PEND-50: such hits are
   * surfaced as "1 match (in name)" in the per-group counter.
   */
  has_page_name_match: boolean
  blocks: SearchBlockRow[]
}

export interface SearchResultGroupsProps {
  groups: SearchResultGroup[]
  /** Flat block list in render order — used to resolve `focusedIndex`. */
  flatRows: SearchBlockRow[]
  /** Index into `flatRows` of the currently roving-focused row. */
  focusedIndex: number
  expandedGroups: Record<string, boolean>
  onToggleGroup: (pageId: string) => void
  onResultClick: (block: SearchBlockRow) => void
  loadingResultId: string | null
  /** Forwarded from `useListKeyboardNavigation.handleKeyDown`. */
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => boolean
  /** Click handler for a group's page-title link (navigates to the page). */
  onPageTitleClick?: (pageId: string, title: string) => void
}

export function SearchResultGroups({
  groups,
  flatRows,
  focusedIndex,
  expandedGroups,
  onToggleGroup,
  onResultClick,
  loadingResultId,
  onKeyDown,
  onPageTitleClick,
}: SearchResultGroupsProps): React.ReactElement | null {
  const { t } = useTranslation()
  if (groups.length === 0) return null

  const focusedRow = flatRows[focusedIndex]
  const totalMatches = flatRows.length
  const pageCount = groups.length

  // Resolve, per group, the id of the row that should drive
  // `aria-activedescendant`. Only the group containing the currently-
  // focused row sets a non-undefined value — the others stay quiet so
  // screen readers don't announce stale active descendants.
  function activeDescendantFor(group: SearchResultGroup): string | undefined {
    if (!focusedRow) return undefined
    if (group.page_id !== focusedRow.page_id) return undefined
    return `search-result-${focusedRow.id}`
  }

  // Index of the focused row WITHIN a group's own `blocks` array, or `-1`
  // when the focused row is not in this group. PEND-58f FE-3: the
  // virtualizer needs this to `scrollToIndex` the active row so it is
  // mounted and `aria-activedescendant` resolves to a real DOM node.
  function activeRowIndexFor(group: SearchResultGroup): number {
    if (!focusedRow) return -1
    if (group.page_id !== focusedRow.page_id) return -1
    return group.blocks.findIndex((b) => b.id === focusedRow.id)
  }

  // FE-A7: roving `tabIndex`. Exactly one group must be in the tab order so
  // the results region is reachable with Tab. Normally that is the group
  // owning the focused row. But immediately after a collapse `focusedRow`
  // can be `undefined` (the focused flat index now points past the shrunk
  // list); without a fallback NO group would be tabbable and the whole
  // region would drop out of the tab order. Fall back to the first EXPANDED
  // group (collapsed groups render no listbox, so they cannot host tabIndex).
  const firstExpandedGroupId = groups.find(
    (g) => (expandedGroups[g.page_id] ?? true) && g.blocks.length > 0,
  )?.page_id
  function tabIndexFor(group: SearchResultGroup): 0 | -1 {
    if (focusedRow) return group.page_id === focusedRow.page_id ? 0 : -1
    return group.page_id === firstExpandedGroupId ? 0 : -1
  }

  return (
    <section
      aria-label={t('search.resultsRegionLabel')}
      data-testid="search-result-region"
      className="search-result-region space-y-2"
    >
      <ResultCountSummary matchCount={totalMatches} pageCount={pageCount} />
      <CollapsibleGroupList<SearchResultGroup>
        groups={groups}
        expandedGroups={expandedGroups}
        onToggleGroup={onToggleGroup}
        {...(onPageTitleClick ? { onPageTitleClick } : {})}
        untitledLabel={t('common.untitled') as string}
        defaultExpanded
        groupClassName="search-result-group"
        formatCount={(g) => {
          // PEND-50 recommendation: page-name-only hits show as
          // "1 match (in name)" so the user understands why the group
          // is there. We detect those as a group with one block that
          // matched on the page title rather than its content.
          if (
            g.has_page_name_match &&
            g.blocks.length === 1 &&
            !(g.blocks[0]?.snippet && g.blocks[0].snippet.length > 0)
          ) {
            return t('search.matchCountInGroupNameOnly') as string
          }
          if (g.blocks.length === 1) return t('search.matchCountInGroupSingular') as string
          return t('search.matchCountInGroupPlural', { count: g.blocks.length }) as string
        }}
        // `renderBlock` is unused once `renderGroupList` is supplied (the
        // override owns the `<ul>` + rows), but the prop is required by
        // CollapsibleGroupList's type, so provide the same row markup the
        // virtualized path uses for the (unreachable) default branch.
        renderBlock={(block) => (
          <SearchResultBlockRow
            key={block.id}
            row={block}
            id={`search-result-${block.id}`}
            isFocused={!!focusedRow && focusedRow.id === block.id}
            onClick={() => onResultClick(block)}
            loading={loadingResultId === block.id}
          />
        )}
        // PEND-58f FE-3 — replace the eager per-group `<ul>` with a
        // virtualized listbox so a group with up to the 5000-item cap of
        // rows mounts only its visible window. The roving a11y model is
        // preserved unchanged: per-group `role="listbox"`, per-group
        // `aria-activedescendant`, and the focused row scrolled into view.
        renderGroupList={(group, title) => (
          <VirtualizedResultListbox
            blocks={group.blocks}
            activeRowId={activeDescendantFor(group)}
            activeRowIndex={activeRowIndexFor(group)}
            ariaLabel={t('search.groupExpandedLabel', { pageTitle: title })}
            tabIndex={tabIndexFor(group)}
            dataTestId={`search-result-group-${group.page_id}`}
            onKeyDown={(e) => {
              if (onKeyDown(e)) e.preventDefault()
            }}
            renderRow={(block, style, measureRef, index) => (
              <SearchResultBlockRow
                key={block.id}
                row={block}
                id={`search-result-${block.id}`}
                isFocused={!!focusedRow && focusedRow.id === block.id}
                onClick={() => onResultClick(block)}
                loading={loadingResultId === block.id}
                style={style}
                measureRef={measureRef}
                dataIndex={index}
              />
            )}
          />
        )}
      />
    </section>
  )
}

/**
 * Group a flat search result list by `page_id`, preserving the original
 * relevance ordering at both the group and the row level (the first
 * appearance of a page seeds the group, subsequent rows in that page
 * append to the same group). Rows with `page_id == null` (root blocks,
 * page-on-page hits without a parent) are bucketed under the block's own
 * id so they each render as their own group; the `page_title` for those
 * groups falls back to the block's own content.
 *
 * Pure — exported for the integration tests to assert grouping
 * semantics in isolation.
 */
export function groupResultsByPage(
  rows: SearchBlockRow[],
  pageTitles: Map<string, string>,
): SearchResultGroup[] {
  const seen = new Map<string, SearchResultGroup>()
  const order: string[] = []
  for (const row of rows) {
    // Pages (block_type === 'page') match on their own title — they
    // seed a group keyed by the block's own id, titled by the block's
    // content (the page name). Other rows bucket under their owning
    // page (`page_id`); rows with no page_id (defensive — shouldn't
    // appear in normal use) get a single-row bucket under their id,
    // titled `null` so the renderer falls back to the `untitledLabel`.
    const isPageRow = row.block_type === 'page'
    const groupKey = isPageRow ? row.id : (row.page_id ?? row.id)
    let group = seen.get(groupKey)
    if (!group) {
      let title: string | null
      if (isPageRow) {
        title = row.content ?? null
      } else if (row.page_id) {
        title = pageTitles.get(row.page_id) ?? null
      } else {
        // Avoid surfacing the same text twice (as group header and as
        // row body) for orphan rows: keep the title null so the
        // renderer uses `untitledLabel`.
        title = null
      }
      group = {
        page_id: groupKey,
        page_title: title,
        has_page_name_match: isPageRow,
        blocks: [],
      }
      seen.set(groupKey, group)
      order.push(groupKey)
    } else if (isPageRow) {
      group.has_page_name_match = true
    }
    group.blocks.push(row)
  }
  // `order` mirrors `seen.keys()` insertion order, so every key
  // resolves; the `?? null` keeps biome happy without `!` non-null.
  const out: SearchResultGroup[] = []
  for (const k of order) {
    const g = seen.get(k)
    if (g) out.push(g)
  }
  return out
}
