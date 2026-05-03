/**
 * Pure filter execution engine for the agenda view.
 *
 * Evaluates AgendaFilter[] against the backend, returning matching blocks.
 * Extracted from AgendaView.tsx (R-13) — no React dependencies.
 */

import type { AgendaFilter } from '../components/AgendaFilterBuilder'
import type { PageResponse } from './bindings'
import { formatDate, getDateRangeForFilter } from './date-utils'
import type { BlockRow } from './tauri'
import { listBlocks, listTagsByPrefix, listUndatedTasks, queryByProperty } from './tauri'

/**
 * Pagination limit for agenda-driven IPC queries. The `listBlocks` /
 * `queryByProperty` / `listUndatedTasks` calls driven from this module
 * use this value so changes propagate consistently.
 *
 * Note: the `listTagsByPrefix` call inside `executeAgendaFilters` uses
 * `limit: 50` deliberately (it's a typeahead-style tag lookup, not an
 * agenda paginator) and is not affected by this constant.
 *
 * Added for FE-H-2.
 */
export const AGENDA_QUERY_LIMIT = 500

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
// Per-dimension query handlers
// ---------------------------------------------------------------------------

/** Query blocks matching the given todo_state values. */
async function queryStatus(values: string[], spaceId: string): Promise<Map<string, BlockRow>> {
  const result = new Map<string, BlockRow>()
  for (const value of values) {
    const resp = await queryByProperty({
      key: 'todo_state',
      valueText: value,
      limit: AGENDA_QUERY_LIMIT,
      spaceId,
    })
    for (const b of resp.items) {
      result.set(b.id, b)
    }
  }
  return result
}

/** Query blocks matching the given priority values. */
async function queryPriority(values: string[], spaceId: string): Promise<Map<string, BlockRow>> {
  const result = new Map<string, BlockRow>()
  for (const value of values) {
    const resp = await queryByProperty({
      key: 'priority',
      valueText: value,
      limit: AGENDA_QUERY_LIMIT,
      spaceId,
    })
    for (const b of resp.items) {
      result.set(b.id, b)
    }
  }
  return result
}

// --- queryDateDimension helpers (module-private) ---------------------------

/** True when the block's date column is before today and the block isn't DONE. */
function isOverdue(
  block: BlockRow,
  columnKey: 'due_date' | 'scheduled_date',
  todayStr: string,
): boolean {
  const dateVal = columnKey === 'due_date' ? block.due_date : block.scheduled_date
  return dateVal != null && dateVal < todayStr && block.todo_state !== 'DONE'
}

/** Fetch and filter overdue blocks for a date column. */
async function queryOverdueForColumn(
  columnKey: 'due_date' | 'scheduled_date',
  todayStr: string,
  spaceId: string,
): Promise<Map<string, BlockRow>> {
  const result = new Map<string, BlockRow>()
  const resp = await queryByProperty({ key: columnKey, limit: AGENDA_QUERY_LIMIT, spaceId })
  for (const b of resp.items) {
    if (isOverdue(b, columnKey, todayStr)) {
      result.set(b.id, b)
    }
  }
  return result
}

/**
 * Resolve a preset label to a date range and fetch blocks via listBlocks.
 * Dispatches to the single-day branch when start === end, otherwise the range branch.
 * Returns an empty map when the value is not a known preset or the range resolves to null.
 */
async function queryPresetRangeForColumn(
  value: string,
  columnKey: 'due_date' | 'scheduled_date',
  today: Date,
  spaceId: string,
): Promise<Map<string, BlockRow>> {
  const result = new Map<string, BlockRow>()
  const preset = toFutureDatePreset(value)
  if (!preset) return result
  const range = getDateRangeForFilter(preset, today)
  if (!range) return result
  const agendaSource = `column:${columnKey}`
  const resp =
    range.start === range.end
      ? await listBlocks({
          agendaDate: range.start,
          agendaSource,
          limit: AGENDA_QUERY_LIMIT,
          spaceId,
        })
      : await listBlocks({
          agendaDateRange: range,
          agendaSource,
          limit: AGENDA_QUERY_LIMIT,
          spaceId,
        })
  for (const b of resp.items) {
    result.set(b.id, b)
  }
  return result
}

/**
 * Query blocks by a date column (due_date or scheduled_date).
 * Handles 'Overdue' (client-side filter) and preset date ranges.
 */
async function queryDateDimension(
  values: string[],
  columnKey: 'due_date' | 'scheduled_date',
  today: Date,
  spaceId: string,
): Promise<Map<string, BlockRow>> {
  const result = new Map<string, BlockRow>()
  const todayStr = formatDate(today)

  for (const value of values) {
    const partial =
      value === 'Overdue'
        ? await queryOverdueForColumn(columnKey, todayStr, spaceId)
        : await queryPresetRangeForColumn(value, columnKey, today, spaceId)
    for (const [id, block] of partial) {
      result.set(id, block)
    }
  }
  return result
}

/**
 * Query blocks by a property-based date dimension (completed_at or created_at).
 * Iterates each day in the range and queries by valueDate.
 */
async function queryPropertyDateDimension(
  values: string[],
  propertyKey: string,
  today: Date,
  spaceId: string,
): Promise<Map<string, BlockRow>> {
  const result = new Map<string, BlockRow>()

  for (const value of values) {
    const preset = toPastDatePreset(value)
    if (!preset) continue
    const range = getDateRangeForFilter(preset, today)
    if (!range) continue
    const start = new Date(`${range.start}T00:00:00`)
    const end = new Date(`${range.end}T00:00:00`)
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = formatDate(d)
      const resp = await queryByProperty({
        key: propertyKey,
        valueDate: dateStr,
        limit: AGENDA_QUERY_LIMIT,
        spaceId,
      })
      for (const b of resp.items) {
        result.set(b.id, b)
      }
    }
  }
  return result
}

/** Query blocks matching the given tag names (resolved to IDs via prefix search). */
async function queryTag(values: string[], spaceId: string): Promise<Map<string, BlockRow>> {
  const result = new Map<string, BlockRow>()
  for (const value of values) {
    // Resolve tag name to ID via prefix search + exact match
    const candidates = await listTagsByPrefix({ prefix: value, limit: 50 })
    const match = candidates.find((t) => t.name.toLowerCase() === value.toLowerCase())
    if (!match) continue
    const resp = await listBlocks({ tagId: match.tag_id, limit: AGENDA_QUERY_LIMIT, spaceId })
    for (const b of resp.items) {
      result.set(b.id, b)
    }
  }
  return result
}

/** Query blocks by custom property key[:value] pairs. */
async function queryPropertyDimension(
  values: string[],
  spaceId: string,
): Promise<Map<string, BlockRow>> {
  const result = new Map<string, BlockRow>()
  for (const filterValue of values) {
    const colonIdx = filterValue.indexOf(':')
    const key = colonIdx > 0 ? filterValue.slice(0, colonIdx) : filterValue
    const value = colonIdx > 0 ? filterValue.slice(colonIdx + 1) : undefined
    const resp = await queryByProperty({
      key,
      ...(value != null && { valueText: value }),
      limit: AGENDA_QUERY_LIMIT,
      spaceId,
    })
    for (const b of resp.items) {
      result.set(b.id, b)
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Execute agenda filters against the backend.
 *
 * - Empty filter list → default: all blocks with a due_date or scheduled_date.
 * - Non-empty → evaluate each dimension, then intersect result sets (AND).
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
  // The empty-string fallback is the FEAT-3 Phase 4 pre-bootstrap
  // no-match value (a `listBlocks` IPC requires a non-null `spaceId`);
  // the semantic risk of empty-string-as-no-match is tracked separately
  // as FE-H-22.
  const normalizedSpaceId = spaceId ?? ''

  if (filters.length === 0) {
    // Default: blocks with due_date or scheduled_date, plus undated tasks.
    // FE-H-1 — paginate each query to exhaustion via `paginateAll` so we
    // honour AGENTS invariant #3 (cursor-based pagination on ALL list
    // queries) and never silently drop items past `AGENDA_QUERY_LIMIT`.
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
    // Merge and deduplicate by id
    const seen = new Set<string>()
    const merged: BlockRow[] = []
    for (const b of [...dueItems, ...schedItems, ...undatedItems]) {
      if (!seen.has(b.id)) {
        seen.add(b.id)
        merged.push(b)
      }
    }
    // FE-H-1 — every page already drained above, so the result envelope's
    // `hasMore` / `cursor` collapse to the post-pagination invariant.
    return { blocks: merged, hasMore: false, cursor: null }
  }

  // Execute each filter dimension and intersect
  const resultSets: Set<string>[] = []
  const allBlocks = new Map<string, BlockRow>()
  const today = new Date()

  for (const filter of filters) {
    let blockMap = new Map<string, BlockRow>()

    switch (filter.dimension) {
      case 'status':
        blockMap = await queryStatus(filter.values, normalizedSpaceId)
        break
      case 'priority':
        blockMap = await queryPriority(filter.values, normalizedSpaceId)
        break
      case 'dueDate':
        blockMap = await queryDateDimension(filter.values, 'due_date', today, normalizedSpaceId)
        break
      case 'scheduledDate':
        blockMap = await queryDateDimension(
          filter.values,
          'scheduled_date',
          today,
          normalizedSpaceId,
        )
        break
      case 'completedDate':
        blockMap = await queryPropertyDateDimension(
          filter.values,
          'completed_at',
          today,
          normalizedSpaceId,
        )
        break
      case 'createdDate':
        blockMap = await queryPropertyDateDimension(
          filter.values,
          'created_at',
          today,
          normalizedSpaceId,
        )
        break
      case 'tag':
        blockMap = await queryTag(filter.values, normalizedSpaceId)
        break
      case 'property':
        blockMap = await queryPropertyDimension(filter.values, normalizedSpaceId)
        break
    }

    const ids = new Set(blockMap.keys())
    for (const [id, block] of blockMap) {
      allBlocks.set(id, block)
    }
    resultSets.push(ids)
  }

  // Intersect all result sets
  let blocks: BlockRow[] = []
  if (resultSets.length > 0) {
    let intersection = resultSets[0] as Set<string>
    for (let i = 1; i < resultSets.length; i++) {
      intersection = new Set([...intersection].filter((id) => resultSets[i]?.has(id)))
    }
    blocks = [...intersection].map((id) => allBlocks.get(id) as BlockRow).filter(Boolean)
  }

  return { blocks, hasMore: false, cursor: null }
}
