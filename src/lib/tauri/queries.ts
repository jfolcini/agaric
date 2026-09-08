import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type {
  AdvancedQueryRequest,
  AdvancedQueryResponse,
  BlockRow,
  PageResponse,
} from '@/lib/bindings'
import type { SafeLimit } from '@/lib/safe-limit'
import { toSpaceScope } from '@/lib/tauri/_shared'

export interface ProjectedAgendaEntry {
  block: BlockRow
  projected_date: string
  source: string // 'due_date' | 'scheduled_date'
}
/**
 * #1280 — run a composable advanced query (boolean `FilterExpr` over the shared
 * filter vocabulary) against one space, returning a keyset-paginated page of
 * blocks. The backend gates every leaf against the advanced-query allowed-keys
 * set, bounds the tree depth, and binds every value as a parameter. Full-text,
 * grouping, and aggregation are added in follow-ups (the `score` channel on each
 * row is reserved for ranking).
 */
export async function runAdvancedQuery(
  request: AdvancedQueryRequest,
): Promise<AdvancedQueryResponse> {
  return unwrap(await commands.runAdvancedQuery(request))
}

/** List undated tasks (tasks with todo_state but no due/scheduled date).
 *
 * `spaceId` (Phase 4) — when set, restricts results to undated
 * tasks whose owning page carries `space = <spaceId>`. `null` /
 * `undefined` leaves the result set unscoped, matching the pre-
 * behaviour for cross-space callers.
 */
export async function listUndatedTasks(params?: {
  cursor?: string | undefined
  limit?: SafeLimit | undefined
  spaceId?: string | null | undefined
}): Promise<PageResponse<BlockRow>> {
  return unwrap(
    await commands.listUndatedTasks(
      params?.cursor ?? null,
      params?.limit ?? null,
      toSpaceScope(params?.spaceId),
    ),
  )
}

/**
 * List projected future occurrences of repeating tasks for a date range.
 *
 * Cursor-paginated. Pass `cursor: response.next_cursor` to fetch
 * the next page; `has_more = false` indicates the final page.
 *
 * `spaceId` (Phase 4) — when set, restricts projections to
 * blocks whose owning page carries `space = <spaceId>`. `null` /
 * `undefined` leaves the result set unscoped.
 */
export async function listProjectedAgenda(opts: {
  startDate: string
  endDate: string
  cursor?: string | undefined
  limit?: SafeLimit | undefined
  spaceId?: string | null | undefined
}): Promise<PageResponse<ProjectedAgendaEntry>> {
  return unwrap(
    await commands.listProjectedAgenda(
      opts.startDate,
      opts.endDate,
      opts.cursor ?? null,
      opts.limit ?? null,
      toSpaceScope(opts.spaceId),
    ),
  )
}

// ---------------------------------------------------------------------------
// Block fixed-field commands (thin wrappers for reserved properties)
// ---------------------------------------------------------------------------

/** Query blocks by property key and optional value, with cursor pagination.
 *
 * `spaceId` (Phase 4) — when set, restricts matches to blocks
 * whose owning page carries `space = <spaceId>`. `null` / `undefined`
 * leaves the result set unscoped (cross-space view).
 */
export async function listUnfinishedTasks(params: {
  beforeDate: string
  todoStates: string[]
  cursor?: string
  limit?: SafeLimit
  spaceId?: string | null
}): Promise<PageResponse<BlockRow>> {
  return unwrap(
    await commands.listUnfinishedTasks(
      params.beforeDate,
      params.todoStates,
      params.cursor ?? null,
      params.limit ?? null,
      toSpaceScope(params.spaceId),
    ),
  )
}
