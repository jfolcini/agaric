/**
 * Pure filter execution engine for the agenda view.
 *
 * Evaluates AgendaFilter[] against the backend, returning matching blocks.
 * Extracted from AgendaView.tsx (R-13) — no React dependencies.
 *
 * Audit H3 — when the user has at least one filter active, dispatch ONE
 * `filtered_blocks_query` IPC that AND-intersects every dimension in SQL.
 * The previous implementation fanned out one IPC per dimension (each
 * capped at 200 rows by `PageRequest::new`) and intersected the result
 * sets in JS — any AND-set member outside the top-200 of any sub-query
 * was silently dropped before the intersection ran. The composed-EXISTS
 * shape on the backend evaluates the full predicate set in a single SQL
 * round-trip with cursor-paginated, correctness-preserving output.
 */

import { PAGINATION_LIMIT } from '@/lib/constants'

import type { AgendaFilter } from '../components/AgendaFilterBuilder'
import type { PageResponse } from './bindings'
import { formatDate, getDateRangeForFilter } from './date-utils'
import { paginationLimit, type SafeLimit } from './safe-limit'
import type { BlockRow, FilteredBlocksPropertyFilter, FilteredBlocksTagFilter } from './tauri'
import { filteredBlocksQuery, listTagsByPrefix, listUndatedTasks, queryByProperty } from './tauri'

/**
 * Per-page limit for agenda queries — pinned to `PageRequest::new`'s
 * `MAX_PAGE_SIZE = 200` (limit-clamp-followup Phase 1 turns this into a
 * loud `AppError::Validation`). Used for both the no-filter default
 * branch (queryByProperty / listUndatedTasks) and the active-filter
 * `filtered_blocks_query` call.
 */
export const AGENDA_QUERY_LIMIT: SafeLimit = paginationLimit(200)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecuteFiltersResult {
  blocks: BlockRow[]
  hasMore: boolean
  cursor: string | null
}

// ---------------------------------------------------------------------------
// Pagination helper
// ---------------------------------------------------------------------------

/**
 * Walk a cursor-paginated IPC to exhaustion, accumulating every page's
 * `items`. Used by the no-filters default branch (FE-H-1) so users with
 * more than `AGENDA_QUERY_LIMIT` due / scheduled / undated blocks don't
 * silently lose data — see AGENTS invariant #3.
 */
async function paginateAll<T>(
  fetchPage: (cursor: string | undefined) => Promise<PageResponse<T>>,
): Promise<T[]> {
  const all: T[] = []
  let cursor: string | undefined
  let hasMore = true
  while (hasMore) {
    const resp = await fetchPage(cursor)
    all.push(...resp.items)
    hasMore = resp.has_more
    cursor = resp.next_cursor ?? undefined
  }
  return all
}

// ---------------------------------------------------------------------------
// Helpers — map filter UI values to date-utils presets
// ---------------------------------------------------------------------------

/** Map a due/scheduled date filter value to a date-utils preset string. */
export function toFutureDatePreset(value: string): string | null {
  switch (value) {
    case 'Today':
      return 'today'
    case 'This week':
      return 'this-week'
    case 'This month':
      return 'this-month'
    case 'Next 7 days':
      return 'next-7-days'
    case 'Next 14 days':
      return 'next-14-days'
    case 'Next 30 days':
      return 'next-30-days'
    default:
      return null
  }
}

/** Map a completed/created date filter value to a date-utils preset string. */
export function toPastDatePreset(value: string): string | null {
  switch (value) {
    case 'Today':
      return 'today'
    case 'This week':
      return 'this-week'
    case 'This month':
      return 'this-month'
    case 'Last 7 days':
      return 'last-7-days'
    case 'Last 30 days':
      return 'last-30-days'
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Filter translation — AgendaFilter[] → filtered_blocks_query inputs
// ---------------------------------------------------------------------------

/**
 * Convert an inclusive `{start, end}` range into the half-open
 * `[start, endExclusive)` form expected by `valueDateRange` /
 * `value_date_range` on the backend (mirror of the previous inline
 * conversion in `queryPropertyDateDimension`).
 */
function toHalfOpenRange(range: { start: string; end: string }): [string, string] {
  const endExclusiveDate = new Date(`${range.end}T00:00:00`)
  endExclusiveDate.setDate(endExclusiveDate.getDate() + 1)
  return [range.start, formatDate(endExclusiveDate)]
}

/**
 * Translate one future-dated filter value (dueDate / scheduledDate) into
 * a list of property filters on the reserved date column. Returns
 * multiple filters only for `Overdue`, where the predicate is
 * `column < today AND todo_state != 'DONE'`.
 */
function futureDateValueToFilters(
  value: string,
  columnKey: 'due_date' | 'scheduled_date',
  today: Date,
): FilteredBlocksPropertyFilter[] {
  const todayStr = formatDate(today)
  if (value === 'Overdue') {
    // Replicate the legacy client-side filter `column < today AND
    // todo_state != 'DONE'` (excluding null-column blocks is implicit:
    // the backend adds `b.<col> IS NOT NULL` automatically).
    return [
      { key: columnKey, operator: 'lt', valueDate: todayStr },
      { key: 'todo_state', operator: 'neq', valueText: 'DONE' },
    ]
  }
  const preset = toFutureDatePreset(value)
  if (!preset) return []
  const range = getDateRangeForFilter(preset, today)
  if (!range) return []
  if (range.start === range.end) {
    return [{ key: columnKey, operator: 'eq', valueDate: range.start }]
  }
  return [{ key: columnKey, valueDateRange: toHalfOpenRange(range) }]
}

/**
 * Translate one past-dated filter value (completedDate / createdDate)
 * into a single property filter with a half-open `valueDateRange`.
 */
function pastDateValueToFilter(
  value: string,
  propertyKey: 'completed_at' | 'created_at',
  today: Date,
): FilteredBlocksPropertyFilter | null {
  const preset = toPastDatePreset(value)
  if (!preset) return null
  const range = getDateRangeForFilter(preset, today)
  if (!range) return null
  return { key: propertyKey, valueDateRange: toHalfOpenRange(range) }
}

/**
 * Translate a single custom `property` dimension value (e.g. `assignee`
 * or `assignee:Alice`) into a property filter. Bare keys (no colon) map
 * to is-set semantics (no value field set).
 */
function customPropertyValueToFilter(value: string): FilteredBlocksPropertyFilter {
  const colonIdx = value.indexOf(':')
  if (colonIdx > 0) {
    return {
      key: value.slice(0, colonIdx),
      operator: 'eq',
      valueText: value.slice(colonIdx + 1),
    }
  }
  return { key: value }
}

/**
 * Push the property-filter translation of one dimension onto the
 * accumulator. Tag and empty-value dimensions are handled separately
 * by the caller.
 */
function appendPropertyFilters(
  filter: AgendaFilter,
  today: Date,
  out: FilteredBlocksPropertyFilter[],
): void {
  switch (filter.dimension) {
    case 'status':
      if (filter.values.length > 0) {
        out.push({ key: 'todo_state', operator: 'eq', valueTextIn: filter.values })
      }
      return
    case 'priority':
      if (filter.values.length > 0) {
        out.push({ key: 'priority', operator: 'eq', valueTextIn: filter.values })
      }
      return
    case 'dueDate':
      for (const value of filter.values) {
        out.push(...futureDateValueToFilters(value, 'due_date', today))
      }
      return
    case 'scheduledDate':
      for (const value of filter.values) {
        out.push(...futureDateValueToFilters(value, 'scheduled_date', today))
      }
      return
    case 'completedDate':
      for (const value of filter.values) {
        const pf = pastDateValueToFilter(value, 'completed_at', today)
        if (pf) out.push(pf)
      }
      return
    case 'createdDate':
      for (const value of filter.values) {
        const pf = pastDateValueToFilter(value, 'created_at', today)
        if (pf) out.push(pf)
      }
      return
    case 'property':
      for (const value of filter.values) {
        out.push(customPropertyValueToFilter(value))
      }
      return
    case 'tag':
      // Handled separately by `resolveTagFilters` (needs a `listTagsByPrefix`
      // round-trip per prefix to map names → tag_ids).
      return
  }
}

/**
 * Resolve every `tag` dimension in the filter list into a single
 * `FilteredBlocksTagFilter` payload. One `listTagsByPrefix` IPC per
 * distinct prefix; unresolved names are silently dropped (matches the
 * legacy `queryTag` behaviour of skipping `undefined` exact matches).
 */
async function resolveTagFilters(
  filters: AgendaFilter[],
): Promise<FilteredBlocksTagFilter | undefined> {
  const tagValues = filters.filter((f) => f.dimension === 'tag').flatMap((f) => f.values)
  if (tagValues.length === 0) return undefined

  const tagIds: string[] = []
  for (const value of tagValues) {
    const candidates = await listTagsByPrefix({ prefix: value, limit: PAGINATION_LIMIT })
    const match = candidates.find((t) => t.name.toLowerCase() === value.toLowerCase())
    if (match) tagIds.push(match.tag_id)
  }
  if (tagIds.length === 0) return undefined
  // Multiple tag values within a single tag dimension union (legacy
  // `queryTag` Map-merge semantics). `filtered_blocks_query` honours
  // this with `mode: 'or'` across `tag_ids`.
  return { tagIds, mode: 'or' }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Execute agenda filters against the backend.
 *
 * - Empty filter list → default unfiltered: all blocks with due_date /
 *   scheduled_date, plus undated tasks. Pagination is walked to
 *   exhaustion per dimension (FE-H-1 / AGENTS invariant #3).
 * - Non-empty → ONE `filtered_blocks_query` IPC. Property filters AND
 *   together server-side via composed-EXISTS; tag filters union via
 *   `mode: 'or'` across resolved tag IDs.
 *
 * `spaceId` (FEAT-3 Phase 4) — when set, scopes every dispatched IPC
 * to the active space; when `null` the call is cross-space (legacy).
 * Normalized to `''` at this boundary so internal helpers can take
 * `spaceId: string` (see FE-L-12).
 */
export async function executeAgendaFilters(
  filters: AgendaFilter[],
  spaceId: string | null,
): Promise<ExecuteFiltersResult> {
  // FE-L-12 — normalize once at the public boundary. Every internal
  // helper takes `spaceId: string`; none of them re-apply the fallback.
  const normalizedSpaceId = spaceId ?? ''

  if (filters.length === 0) {
    // Default: blocks with due_date or scheduled_date, plus undated tasks.
    // FE-H-1 — paginate each query to exhaustion via `paginateAll`.
    const [dueItems, schedItems, undatedItems] = await Promise.all([
      paginateAll((cursor) =>
        queryByProperty({
          key: 'due_date',
          cursor,
          limit: AGENDA_QUERY_LIMIT,
          spaceId: normalizedSpaceId,
        }),
      ),
      paginateAll((cursor) =>
        queryByProperty({
          key: 'scheduled_date',
          cursor,
          limit: AGENDA_QUERY_LIMIT,
          spaceId: normalizedSpaceId,
        }),
      ),
      paginateAll((cursor) =>
        listUndatedTasks({ cursor, limit: AGENDA_QUERY_LIMIT, spaceId: normalizedSpaceId }),
      ),
    ])
    const seen = new Set<string>()
    const merged: BlockRow[] = []
    for (const b of [...dueItems, ...schedItems, ...undatedItems]) {
      if (!seen.has(b.id)) {
        seen.add(b.id)
        merged.push(b)
      }
    }
    return { blocks: merged, hasMore: false, cursor: null }
  }

  // ── Active-filter path: translate every dimension into the single
  //    `filtered_blocks_query` IPC. AND-intersection happens server-side;
  //    no JS post-filter, no per-sub-query row cap.
  const today = new Date()
  const propertyFilters: FilteredBlocksPropertyFilter[] = []
  for (const filter of filters) {
    appendPropertyFilters(filter, today, propertyFilters)
  }
  const tagFilters = await resolveTagFilters(filters)

  // `filtered_blocks_query` rejects empty input. This can happen when
  // the only active dimensions resolve to nothing (e.g. unknown date
  // preset, status with `values: []`, tag with no matching prefix). The
  // legacy code returned an empty result set in that case; preserve
  // that shape rather than letting the backend Validation error bubble.
  if (propertyFilters.length === 0 && !tagFilters) {
    return { blocks: [], hasMore: false, cursor: null }
  }

  const resp = await filteredBlocksQuery({
    propertyFilters,
    tagFilters,
    spaceId: normalizedSpaceId,
    limit: AGENDA_QUERY_LIMIT,
  })

  return {
    blocks: resp.items,
    hasMore: resp.has_more,
    cursor: resp.next_cursor,
  }
}

// ---------------------------------------------------------------------------
// Load-more for the active-filter branch
// ---------------------------------------------------------------------------

/**
 * Fetch the next page of an active-filter agenda by re-running the same
 * filter translation `executeAgendaFilters` used and passing the saved
 * `cursor` to `filtered_blocks_query`.
 *
 * Fixes the cursor-namespace mismatch where `AgendaView.loadMoreAgenda`
 * was previously calling `query_by_property` with a cursor minted by
 * `filtered_blocks_query` — the cursor's `b.id` was meaningless in the
 * `query_by_property` keyset, so page 2 silently returned the wrong
 * result set (right shape, no AND-intersection of the active filters).
 *
 * Mirror semantics of `executeAgendaFilters`:
 * - Same `propertyFilters` / `tagFilters` translation per dimension.
 * - Same short-circuit when every dimension resolves to nothing.
 * - Same `spaceId` normalization at the boundary (FE-L-12).
 */
export async function loadMoreAgendaFilters(
  filters: AgendaFilter[],
  cursor: string,
  spaceId: string | null,
): Promise<ExecuteFiltersResult> {
  const normalizedSpaceId = spaceId ?? ''

  const today = new Date()
  const propertyFilters: FilteredBlocksPropertyFilter[] = []
  for (const filter of filters) {
    appendPropertyFilters(filter, today, propertyFilters)
  }
  const tagFilters = await resolveTagFilters(filters)

  // Mirror `executeAgendaFilters`: short-circuit when every dimension
  // resolves to an empty payload, rather than letting the backend
  // Validation error bubble.
  if (propertyFilters.length === 0 && !tagFilters) {
    return { blocks: [], hasMore: false, cursor: null }
  }

  const resp = await filteredBlocksQuery({
    propertyFilters,
    tagFilters,
    spaceId: normalizedSpaceId,
    limit: AGENDA_QUERY_LIMIT,
    cursor,
  })

  return {
    blocks: resp.items,
    hasMore: resp.has_more,
    cursor: resp.next_cursor,
  }
}
