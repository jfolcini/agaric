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
  /**
   * The `today` used for date-preset translation on the active-filter
   * path. Callers must thread it back into `loadMoreAgendaFilters` so a
   * page fetched after midnight continues page 1's predicate instead of
   * recomputing a different one (#720). Unset on the no-filter path
   * (its queries carry no date predicates).
   */
  today?: Date
}

// ---------------------------------------------------------------------------
// No-filter pagination (#721)
// ---------------------------------------------------------------------------

/**
 * Composite cursor state for the unfiltered agenda (#721). One entry per
 * source query; a key that is ABSENT means the source is exhausted, a
 * `null` value means "fetch the first page", a string is the source's
 * own backend keyset cursor.
 *
 * The previous implementation walked all three sources to exhaustion
 * (`paginateAll`) and returned `hasMore: false`, after which the view
 * layer sliced to 200 rows — with >200 items the surplus was silently
 * dropped (merge order preferentially dropped scheduled-only and
 * undated blocks) and the full IPC cost was paid anyway. Windowed
 * fetches keep each call bounded at one page per source and surface
 * the remainder through `hasMore` + this composite cursor.
 */
interface UnfilteredCursorState {
  due?: string | null
  scheduled?: string | null
  undated?: string | null
}

/** Namespace prefix so the composite cursor can never be confused with a
 *  backend keyset cursor. */
const UNFILTERED_CURSOR_PREFIX = 'agenda-unfiltered:'

function encodeUnfilteredCursor(state: UnfilteredCursorState): string | null {
  if (state.due === undefined && state.scheduled === undefined && state.undated === undefined) {
    return null
  }
  return UNFILTERED_CURSOR_PREFIX + JSON.stringify(state)
}

function decodeUnfilteredCursor(cursor: string): UnfilteredCursorState | null {
  if (!cursor.startsWith(UNFILTERED_CURSOR_PREFIX)) return null
  try {
    const parsed: unknown = JSON.parse(cursor.slice(UNFILTERED_CURSOR_PREFIX.length))
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed as UnfilteredCursorState
  } catch {
    return null
  }
}

/**
 * Fetch ONE window of the unfiltered agenda: one page per non-exhausted
 * source (due_date / scheduled_date / undated tasks), merged and
 * deduplicated by block id. `hasMore` is true while any source has more
 * pages; the composite cursor records where each source resumes.
 */
async function fetchUnfilteredAgendaPage(
  state: UnfilteredCursorState,
  spaceId: string,
): Promise<ExecuteFiltersResult> {
  const [dueResp, schedResp, undatedResp] = await Promise.all([
    state.due !== undefined
      ? queryByProperty({
          key: 'due_date',
          cursor: state.due ?? undefined,
          limit: AGENDA_QUERY_LIMIT,
          spaceId,
        })
      : Promise.resolve<PageResponse<BlockRow> | null>(null),
    state.scheduled !== undefined
      ? queryByProperty({
          key: 'scheduled_date',
          cursor: state.scheduled ?? undefined,
          limit: AGENDA_QUERY_LIMIT,
          spaceId,
        })
      : Promise.resolve<PageResponse<BlockRow> | null>(null),
    state.undated !== undefined
      ? listUndatedTasks({ cursor: state.undated ?? undefined, limit: AGENDA_QUERY_LIMIT, spaceId })
      : Promise.resolve<PageResponse<BlockRow> | null>(null),
  ])

  const seen = new Set<string>()
  const merged: BlockRow[] = []
  for (const b of [
    ...(dueResp?.items ?? []),
    ...(schedResp?.items ?? []),
    ...(undatedResp?.items ?? []),
  ]) {
    if (!seen.has(b.id)) {
      seen.add(b.id)
      merged.push(b)
    }
  }

  const next: UnfilteredCursorState = {}
  if (dueResp?.has_more && dueResp.next_cursor !== null) next.due = dueResp.next_cursor
  if (schedResp?.has_more && schedResp.next_cursor !== null) {
    next.scheduled = schedResp.next_cursor
  }
  if (undatedResp?.has_more && undatedResp.next_cursor !== null) {
    next.undated = undatedResp.next_cursor
  }
  const cursor = encodeUnfilteredCursor(next)
  return { blocks: merged, hasMore: cursor !== null, cursor }
}

/**
 * Fetch the next window of the no-filter agenda from a composite cursor
 * minted by `executeAgendaFilters`' empty-filter branch (#721). Sources
 * already exhausted are skipped; the rest resume from their own keyset
 * cursors. Callers should dedupe against already-rendered blocks (a
 * block with both dates can surface from two sources in different
 * windows).
 */
export async function loadMoreUnfilteredAgenda(
  cursor: string,
  spaceId: string | null,
): Promise<ExecuteFiltersResult> {
  const state = decodeUnfilteredCursor(cursor)
  if (!state) return { blocks: [], hasMore: false, cursor: null }
  return fetchUnfilteredAgendaPage(state, spaceId ?? '')
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
 * Client-side residual predicate applied to every page returned by
 * `filtered_blocks_query`. Used only where a within-dimension OR cannot
 * ride the backend's AND-only composed-EXISTS shape (#720: Overdue
 * combined with other date presets). Pages may shrink after filtering;
 * `hasMore` / `cursor` stay valid because the backend keyset walks the
 * SQL superset.
 */
type BlockPostFilter = (block: BlockRow) => boolean

/** Output of {@link translateFilters}: the IPC payload + residual predicates. */
interface TranslatedFilters {
  propertyFilters: FilteredBlocksPropertyFilter[]
  postFilters: BlockPostFilter[]
}

/** Union (min-start / max-end) of inclusive `{start, end}` date ranges.
 *
 * Exact for the agenda presets: every future preset (Today / This week /
 * This month / Next N days) and every past preset (Today / This week /
 * This month / Last N days) covers today, so any subset overlaps at
 * today and its union is the single span `[min(start), max(end)]`.
 */
function unionRanges(
  ranges: Array<{ start: string; end: string }>,
): { start: string; end: string } | null {
  const first = ranges[0]
  if (!first) return null
  let { start, end } = first
  for (const r of ranges) {
    if (r.start < start) start = r.start
    if (r.end > end) end = r.end
  }
  return { start, end }
}

/**
 * Translate ALL selected values of one future-date dimension (dueDate /
 * scheduledDate) into property filters with OR-within-the-dimension
 * semantics (#720).
 *
 * The previous per-value translation pushed one AND filter per selected
 * checkbox, so `Today + Overdue` emitted `due_date = today AND
 * due_date < today` — provably empty — and `Today + This week`
 * silently collapsed to `Today`.
 *
 * - Range presets union into ONE span filter (exact: every preset
 *   contains today, see {@link unionRanges}).
 * - `Overdue` alone keeps the legacy pair `column < today AND
 *   todo_state != 'DONE'`.
 * - `Overdue` + range presets: SQL fetches the superset
 *   `column < endExclusive` (every overdue date < today ≤ endExclusive);
 *   the residual `column >= start OR (todo_state IS NOT NULL AND
 *   todo_state != 'DONE')` is applied client-side per page via a
 *   {@link BlockPostFilter} because the backend cannot OR across
 *   columns. The explicit NOT-NULL arm mirrors the backend's reserved-
 *   column shape (`AND b.todo_state IS NOT NULL AND b.todo_state != ?`)
 *   so the union reproduces single-select Overdue EXACTLY — a bare JS
 *   `!== 'DONE'` would admit NULL-state blocks dated before the range
 *   start that Overdue-alone excludes.
 */
function appendFutureDateDimension(
  values: string[],
  columnKey: 'due_date' | 'scheduled_date',
  today: Date,
  out: TranslatedFilters,
): void {
  const todayStr = formatDate(today)
  const hasOverdue = values.includes('Overdue')
  const ranges: Array<{ start: string; end: string }> = []
  for (const value of values) {
    if (value === 'Overdue') continue
    const preset = toFutureDatePreset(value)
    if (!preset) continue
    const range = getDateRangeForFilter(preset, today)
    if (range) ranges.push(range)
  }
  const span = unionRanges(ranges)

  if (!span) {
    if (hasOverdue) {
      // Overdue alone — legacy encoding (excluding null-column blocks is
      // implicit: the backend adds `b.<col> IS NOT NULL` automatically).
      out.propertyFilters.push(
        { key: columnKey, operator: 'lt', valueDate: todayStr },
        { key: 'todo_state', operator: 'neq', valueText: 'DONE' },
      )
    }
    return
  }

  if (!hasOverdue) {
    if (span.start === span.end) {
      out.propertyFilters.push({ key: columnKey, operator: 'eq', valueDate: span.start })
    } else {
      out.propertyFilters.push({ key: columnKey, valueDateRange: toHalfOpenRange(span) })
    }
    return
  }

  // Overdue OR [span.start, span.end]: superset in SQL, residual in JS.
  const [, endExclusive] = toHalfOpenRange(span)
  out.propertyFilters.push({ key: columnKey, operator: 'lt', valueDate: endExclusive })
  const start = span.start
  out.postFilters.push((block) => {
    const col = columnKey === 'due_date' ? block.due_date : block.scheduled_date
    if (col === null) return false
    // NULL todo_state fails the Overdue arm (mirrors the backend's
    // `b.todo_state IS NOT NULL AND b.todo_state != 'DONE'` shape) but
    // can still match the range arm.
    return col >= start || (block.todo_state !== null && block.todo_state !== 'DONE')
  })
}

/**
 * Translate ALL selected values of one past-date dimension
 * (completedDate / createdDate) into a single property filter whose
 * half-open `valueDateRange` is the union of the selected presets
 * (#720 — OR within the dimension; exact, see {@link unionRanges}).
 */
function appendPastDateDimension(
  values: string[],
  propertyKey: 'completed_at' | 'created_at',
  today: Date,
  out: TranslatedFilters,
): void {
  const ranges: Array<{ start: string; end: string }> = []
  for (const value of values) {
    const preset = toPastDatePreset(value)
    if (!preset) continue
    const range = getDateRangeForFilter(preset, today)
    if (range) ranges.push(range)
  }
  const span = unionRanges(ranges)
  if (!span) return
  out.propertyFilters.push({ key: propertyKey, valueDateRange: toHalfOpenRange(span) })
}

/**
 * Translate the custom `property` dimension values (e.g. `assignee` or
 * `assignee:Alice`) with OR semantics for values sharing a key (#720):
 * same-key valued entries collapse into one `valueTextIn` filter, and a
 * bare key (is-set) subsumes any valued entries for that key. Distinct
 * keys still AND together — OR across different property keys is not
 * expressible in the composed-EXISTS shape.
 */
function appendCustomPropertyDimension(values: string[], out: TranslatedFilters): void {
  const byKey = new Map<string, { isSet: boolean; texts: string[] }>()
  for (const value of values) {
    const colonIdx = value.indexOf(':')
    const key = colonIdx > 0 ? value.slice(0, colonIdx) : value
    const entry = byKey.get(key) ?? { isSet: false, texts: [] }
    if (colonIdx > 0) entry.texts.push(value.slice(colonIdx + 1))
    else entry.isSet = true
    byKey.set(key, entry)
  }
  for (const [key, entry] of byKey) {
    const [firstText] = entry.texts
    if (entry.isSet || firstText === undefined) {
      out.propertyFilters.push({ key })
    } else if (entry.texts.length === 1) {
      out.propertyFilters.push({ key, operator: 'eq', valueText: firstText })
    } else {
      out.propertyFilters.push({ key, operator: 'eq', valueTextIn: entry.texts })
    }
  }
}

/**
 * Translate every non-tag dimension into the `filtered_blocks_query`
 * property-filter payload plus any client-side residual predicates.
 * Values WITHIN a dimension OR together; dimensions AND together
 * (#720). Tag dimensions are handled separately by `resolveTagFilters`.
 */
function translateFilters(filters: AgendaFilter[], today: Date): TranslatedFilters {
  const out: TranslatedFilters = { propertyFilters: [], postFilters: [] }
  for (const filter of filters) {
    switch (filter.dimension) {
      case 'status':
        if (filter.values.length > 0) {
          out.propertyFilters.push({
            key: 'todo_state',
            operator: 'eq',
            valueTextIn: filter.values,
          })
        }
        break
      case 'priority':
        if (filter.values.length > 0) {
          out.propertyFilters.push({ key: 'priority', operator: 'eq', valueTextIn: filter.values })
        }
        break
      case 'dueDate':
        appendFutureDateDimension(filter.values, 'due_date', today, out)
        break
      case 'scheduledDate':
        appendFutureDateDimension(filter.values, 'scheduled_date', today, out)
        break
      case 'completedDate':
        appendPastDateDimension(filter.values, 'completed_at', today, out)
        break
      case 'createdDate':
        appendPastDateDimension(filter.values, 'created_at', today, out)
        break
      case 'property':
        appendCustomPropertyDimension(filter.values, out)
        break
      case 'tag':
        // Handled separately by `resolveTagFilters` (needs a `listTagsByPrefix`
        // round-trip per prefix to map names → tag_ids).
        break
    }
  }
  return out
}

/** Apply every residual predicate (AND across dimensions) to a result page. */
function applyPostFilters(blocks: BlockRow[], postFilters: BlockPostFilter[]): BlockRow[] {
  if (postFilters.length === 0) return blocks
  return blocks.filter((block) => postFilters.every((predicate) => predicate(block)))
}

/**
 * Dispatch ONE logical page of `filtered_blocks_query`, applying the
 * residual post-filters and advancing past backend pages whose every
 * row the residual rejects (#720).
 *
 * Without the walk, a page fully consumed by the residual would return
 * `blocks: []` with `hasMore: true` — on page 1 AgendaResults renders
 * the "no matching tasks" empty state WITHOUT a LoadMoreButton (the
 * button only renders alongside results), permanently hiding the
 * matching rows on later pages; mid-run, a load-more click would
 * appear to do nothing.
 *
 * Terminates: every iteration either returns or advances the backend
 * keyset cursor by a full page (`next_cursor` comes from a non-empty
 * raw page whenever `has_more` is true). When `postFilters` is empty
 * the loop body runs exactly once (an empty raw page implies
 * `has_more: false`).
 */
async function fetchFilteredBlocksWindow(
  propertyFilters: FilteredBlocksPropertyFilter[],
  tagFilters: FilteredBlocksTagFilter | undefined,
  postFilters: BlockPostFilter[],
  spaceId: string,
  initialCursor?: string,
): Promise<{ blocks: BlockRow[]; hasMore: boolean; cursor: string | null }> {
  let cursor = initialCursor
  for (;;) {
    const resp = await filteredBlocksQuery({
      propertyFilters,
      tagFilters,
      spaceId,
      limit: AGENDA_QUERY_LIMIT,
      cursor,
    })
    const blocks = applyPostFilters(resp.items, postFilters)
    if (blocks.length > 0 || !resp.has_more || resp.next_cursor === null) {
      return { blocks, hasMore: resp.has_more, cursor: resp.next_cursor }
    }
    cursor = resp.next_cursor
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
 *   scheduled_date, plus undated tasks. ONE windowed page per source
 *   (#721) — the remainder is surfaced via `hasMore` + a composite
 *   cursor consumed by `loadMoreUnfilteredAgenda`.
 * - Non-empty → ONE `filtered_blocks_query` IPC. Property filters AND
 *   together server-side via composed-EXISTS; values WITHIN a dimension
 *   OR together (#720); tag filters union via `mode: 'or'` across
 *   resolved tag IDs.
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
    // Default: blocks with due_date or scheduled_date, plus undated
    // tasks. #721 — one windowed page per source; `null` = first page.
    return fetchUnfilteredAgendaPage(
      { due: null, scheduled: null, undated: null },
      normalizedSpaceId,
    )
  }

  // ── Active-filter path: translate every dimension into the single
  //    `filtered_blocks_query` IPC. AND-intersection across dimensions
  //    happens server-side; OR within a dimension is encoded via
  //    valueTextIn / range-union (+ residual post-filters for
  //    Overdue-with-range combos, #720).
  const today = new Date()
  const { propertyFilters, postFilters } = translateFilters(filters, today)
  const tagFilters = await resolveTagFilters(filters)

  // `filtered_blocks_query` rejects empty input. This can happen when
  // the only active dimensions resolve to nothing (e.g. unknown date
  // preset, status with `values: []`, tag with no matching prefix). The
  // legacy code returned an empty result set in that case; preserve
  // that shape rather than letting the backend Validation error bubble.
  if (propertyFilters.length === 0 && !tagFilters) {
    return { blocks: [], hasMore: false, cursor: null, today }
  }

  const window = await fetchFilteredBlocksWindow(
    propertyFilters,
    tagFilters,
    postFilters,
    normalizedSpaceId,
  )
  return { ...window, today }
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
 *
 * `today` (#720) — the reference date page 1's translation used
 * (`ExecuteFiltersResult.today`). Threading it through keeps every page
 * of one pagination run on the SAME date predicate; recomputing
 * `new Date()` here meant page 2 fetched after midnight silently used
 * a different predicate than page 1. Falls back to `new Date()` only
 * when the caller has no page-1 value.
 */
export async function loadMoreAgendaFilters(
  filters: AgendaFilter[],
  cursor: string,
  spaceId: string | null,
  today: Date = new Date(),
): Promise<ExecuteFiltersResult> {
  const normalizedSpaceId = spaceId ?? ''

  const { propertyFilters, postFilters } = translateFilters(filters, today)
  const tagFilters = await resolveTagFilters(filters)

  // Mirror `executeAgendaFilters`: short-circuit when every dimension
  // resolves to an empty payload, rather than letting the backend
  // Validation error bubble.
  if (propertyFilters.length === 0 && !tagFilters) {
    return { blocks: [], hasMore: false, cursor: null, today }
  }

  const window = await fetchFilteredBlocksWindow(
    propertyFilters,
    tagFilters,
    postFilters,
    normalizedSpaceId,
    cursor,
  )
  return { ...window, today }
}
