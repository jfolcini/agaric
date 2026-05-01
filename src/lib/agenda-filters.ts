/**
 * Pure filter execution engine for the agenda view.
 *
 * Evaluates AgendaFilter[] against the backend, returning matching blocks.
 * Extracted from AgendaView.tsx (R-13) — no React dependencies.
 */

import type { AgendaFilter } from '../components/AgendaFilterBuilder'
import { formatDate, getDateRangeForFilter } from './date-utils'
import type { BlockRow } from './tauri'
import { listBlocks, listTagsByPrefix, listUndatedTasks, queryByProperty } from './tauri'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecuteFiltersResult {
  blocks: BlockRow[]
  hasMore: boolean
  cursor: string | null
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
async function queryStatus(
  values: string[],
  spaceId: string | null,
): Promise<Map<string, BlockRow>> {
  const result = new Map<string, BlockRow>()
  for (const value of values) {
    const resp = await queryByProperty({
      key: 'todo_state',
      valueText: value,
      limit: 500,
      spaceId,
    })
    for (const b of resp.items) {
      result.set(b.id, b)
    }
  }
  return result
}

/** Query blocks matching the given priority values. */
async function queryPriority(
  values: string[],
  spaceId: string | null,
): Promise<Map<string, BlockRow>> {
  const result = new Map<string, BlockRow>()
  for (const value of values) {
    const resp = await queryByProperty({
      key: 'priority',
      valueText: value,
      limit: 500,
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
  spaceId: string | null,
): Promise<Map<string, BlockRow>> {
  const result = new Map<string, BlockRow>()
  const resp = await queryByProperty({ key: columnKey, limit: 500, spaceId })
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
      ? await listBlocks({ agendaDate: range.start, agendaSource, limit: 500, spaceId })
      : await listBlocks({ agendaDateRange: range, agendaSource, limit: 500, spaceId })
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
  spaceId: string | null,
): Promise<Map<string, BlockRow>> {
  const result = new Map<string, BlockRow>()
  const todayStr = formatDate(today)

  for (const value of values) {
    const partial =
      value === 'Overdue'
        ? await queryOverdueForColumn(columnKey, todayStr, spaceId)
        : // FEAT-3 Phase 4 — `listBlocks` requires `spaceId`. The `?? ''`
          // fallback is intentional pre-bootstrap behaviour: empty string
          // forces a no-match SQL filter rather than a runtime null deref.
          await queryPresetRangeForColumn(value, columnKey, today, spaceId ?? '')
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
  spaceId: string | null,
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
        limit: 500,
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
    const resp = await listBlocks({ tagId: match.tag_id, limit: 500, spaceId })
    for (const b of resp.items) {
      result.set(b.id, b)
    }
  }
  return result
}

/** Query blocks by custom property key[:value] pairs. */
async function queryPropertyDimension(
  values: string[],
  spaceId: string | null,
): Promise<Map<string, BlockRow>> {
  const result = new Map<string, BlockRow>()
  for (const filterValue of values) {
    const colonIdx = filterValue.indexOf(':')
    const key = colonIdx > 0 ? filterValue.slice(0, colonIdx) : filterValue
    const value = colonIdx > 0 ? filterValue.slice(colonIdx + 1) : undefined
    const resp = await queryByProperty({
      key,
      ...(value != null && { valueText: value }),
      limit: 500,
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
 * Required helpers (`listBlocks`) receive `''` as the no-match
 * pre-bootstrap fallback per the AGENTS conventions.
 */
export async function executeAgendaFilters(
  filters: AgendaFilter[],
  spaceId: string | null,
): Promise<ExecuteFiltersResult> {
  if (filters.length === 0) {
    // Default: blocks with due_date or scheduled_date, plus undated tasks
    const [dueResp, schedResp, undatedResp] = await Promise.all([
      queryByProperty({ key: 'due_date', limit: 500, spaceId }),
      queryByProperty({ key: 'scheduled_date', limit: 500, spaceId }),
      listUndatedTasks({ limit: 500, spaceId }),
    ])
    // Merge and deduplicate by id
    const seen = new Set<string>()
    const merged: BlockRow[] = []
    for (const b of [...dueResp.items, ...schedResp.items, ...undatedResp.items]) {
      if (!seen.has(b.id)) {
        seen.add(b.id)
        merged.push(b)
      }
    }
    return {
      blocks: merged,
      hasMore: dueResp.has_more || schedResp.has_more || undatedResp.has_more,
      cursor: null,
    }
  }

  // Execute each filter dimension and intersect
  const resultSets: Set<string>[] = []
  const allBlocks = new Map<string, BlockRow>()
  const today = new Date()

  for (const filter of filters) {
    let blockMap = new Map<string, BlockRow>()

    switch (filter.dimension) {
      case 'status':
        blockMap = await queryStatus(filter.values, spaceId)
        break
      case 'priority':
        blockMap = await queryPriority(filter.values, spaceId)
        break
      case 'dueDate':
        blockMap = await queryDateDimension(filter.values, 'due_date', today, spaceId)
        break
      case 'scheduledDate':
        blockMap = await queryDateDimension(filter.values, 'scheduled_date', today, spaceId)
        break
      case 'completedDate':
        blockMap = await queryPropertyDateDimension(filter.values, 'completed_at', today, spaceId)
        break
      case 'createdDate':
        blockMap = await queryPropertyDateDimension(filter.values, 'created_at', today, spaceId)
        break
      case 'tag':
        // FEAT-3 Phase 4 — `listBlocks` requires `spaceId`. `?? ''` is
        // the pre-bootstrap no-match fallback.
        blockMap = await queryTag(filter.values, spaceId ?? '')
        break
      case 'property':
        blockMap = await queryPropertyDimension(filter.values, spaceId)
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
