import { Channel } from '@tauri-apps/api/core'

import { commands } from './bindings'
import { logger } from './logger'
import { setLogBackendSink } from './logger-transport'
import { isMobilePlatform } from './platform'
import type { SafeLimit } from './safe-limit'

export type {
  ActiveBlockRow,
  AdvancedQueryRequest,
  AdvancedQueryResponse,
  AggOp,
  AggregateColumn,
  AggregateResult,
  AggregateSpec,
  AggregateTarget,
  BacklinkFilter,
  BacklinkGroup,
  BacklinkQueryResponse,
  BacklinkSort,
  BlockRow,
  CompareOp,
  CreateBlockSpec,
  DateBucketUnit,
  DateField,
  DateRange,
  DeleteResponse,
  DiffSpan,
  DiffTag,
  Draft,
  FilterExpr,
  FilterPrimitive,
  FlushAllDraftsResult,
  GroupedBacklinkResponse,
  GroupKey,
  GroupSpec,
  HistoryEntry,
  ImportProgressUpdate,
  MoveResponse,
  PageHeading,
  PageResponse,
  PageSort,
  PageSubtree,
  PageWithMetadataRow,
  PartitionedSearchResponse,
  PropertyDefinition,
  PurgeResponse,
  QueryGroup,
  QueryResultRow,
  RecoveryStatus,
  RestoreResponse,
  SearchBlockRow,
  SearchFilter,
  SortColumn,
  SortDir,
  SortKey,
  SortSource,
  SpaceId,
  SpaceRow,
  SpaceScope,
  StatusInfo,
  SyncProgressUpdate,
  TagCacheRow,
  TagResponse,
  TaskNotification,
} from './bindings'
export type { SafeLimit } from './safe-limit'
export {
  LIST_BLOCKS_MAX,
  LIST_PROJECTED_AGENDA_MAX,
  listBlocksLimit,
  listProjectedAgendaLimit,
  PAGINATION_MAX,
  paginationLimit,
  SEARCH_BLOCKS_MAX,
  safeLimit,
  searchBlocksLimit,
} from './safe-limit'

import type {
  AdvancedQueryRequest,
  AdvancedQueryResponse,
  BacklinkFilter,
  BacklinkQueryResponse,
  BacklinkSort,
  BlockRow,
  CreateBlockSpec,
  DateRange,
  DeleteResponse,
  DiffSpan,
  Draft,
  FilterPrimitive,
  FlushAllDraftsResult,
  GroupedBacklinkResponse,
  HistoryEntry,
  ImportProgressUpdate,
  MoveResponse,
  PageHeading,
  PageResponse,
  PageSort,
  PageSubtree,
  PageWithMetadataRow,
  PartitionedSearchResponse,
  PropertyDefinition,
  PurgeResponse,
  RecoveryStatus,
  RestoreResponse,
  SearchBlockRow,
  SpaceRow,
  SpaceScope,
  StatusInfo,
  SyncProgressUpdate,
  TagCacheRow,
  TagResponse,
  TaskNotification,
} from './bindings'

/**
 * PEND-18 Phase 3 — translate the JS-side `spaceId: string | null` shape
 * into the new tagged-enum [`SpaceScope`] the IPC boundary now expects.
 *
 * `null` / `undefined` → `{ kind: 'global' }` (cross-space view, the
 * pre-FEAT-3 behaviour for callsites that haven't promoted to per-space
 * scoping yet). A non-empty ULID → `{ kind: 'active', space_id }`.
 *
 * The wrapper signatures in this file keep accepting the legacy
 * `spaceId: string | null` for backward-compatibility with the rest of
 * the frontend; the SpaceScope object is constructed here so the
 * translation lives in one place.
 */
function toSpaceScope(spaceId: string | null | undefined): SpaceScope {
  return spaceId == null ? { kind: 'global' } : { kind: 'active', space_id: spaceId }
}

export interface ProjectedAgendaEntry {
  block: BlockRow
  projected_date: string
  source: string // 'due_date' | 'scheduled_date'
}

// ---------------------------------------------------------------------------
// Command wrappers — type-safe Tauri invoke layer
// ---------------------------------------------------------------------------

/**
 * Unwrap a `commands.*` result, throwing on error to preserve the
 * reject-based semantics of the legacy `invoke()` wrappers. Internal
 * helper for the staged migration to `bindings.ts`.
 */
function unwrap<T>(result: { status: 'ok'; data: T } | { status: 'error'; error: unknown }): T {
  if (result.status === 'ok') return result.data
  throw result.error
}

// ---------------------------------------------------------------------------
// PEND-73 Phase 2.R4 — AbortSignal plumbing for the typed IPC wrappers.
//
// The pattern below races the wrapped IPC promise against the caller's
// AbortSignal. Tauri 2's `invoke()` itself does NOT honour the signal —
// the IPC channel stays open server-side until the Rust future resolves —
// but rejecting the JS promise on abort lets consumers stop waiting,
// drop their generation guards earlier, and surface `kind: 'cancelled'`
// through the same `isCancellation()` predicate that the server-side
// `AppError::Cancelled` path uses.
//
// New consumers should reach for `withAbort(promise, signal)` instead
// of hand-rolling a generation counter. Existing consumers are NOT
// migrated in this commit — `useGenerationGuard` already gives them
// the discard semantics, and the rewrite has no user-visible win
// without an orchestrator decomposition (PEND-74-equivalent).
// ---------------------------------------------------------------------------

import type { AppError } from './bindings'

/**
 * Build the same `{ kind: 'cancelled', message }` shape the backend
 * emits for `AppError::Cancelled`, so `isCancellation(err)` (from
 * `lib/app-error.ts`) discriminates client-side aborts the same way
 * it discriminates server-side cancellations.
 */
export function cancelledError(reason = 'aborted client-side'): AppError {
  return { kind: 'cancelled', message: reason }
}

/**
 * Wrap a typed IPC promise so it rejects with a `cancelled`-kind
 * `AppError` if the supplied `AbortSignal` fires. The underlying IPC
 * is NOT cancelled server-side (Tauri 2 limitation); the wrapper is
 * a client-side stop-waiting primitive. Use alongside
 * `useGenerationGuard` if the consumer also needs to discard the
 * value when it eventually arrives.
 *
 * If `signal` is undefined or already aborted, the behaviour is
 * unchanged from the bare promise (already-aborted short-circuits
 * before the IPC even starts; undefined passes through verbatim).
 */
export function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal == null) return promise
  if (signal.aborted) {
    // The IPC promise was already constructed (args are eager); it's now
    // orphaned by the early reject below. Swallow its eventual settlement so a
    // later rejection doesn't surface as an unhandled promise rejection.
    promise.catch(() => {})
    return Promise.reject(cancelledError(signal.reason?.toString()))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(cancelledError(signal.reason?.toString()))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

/** Create a new block. Returns the created block with its generated ID.
 *
 * BUG-1 / H-3a — when `blockType === 'page'`, `spaceId` is REQUIRED.
 * The backend rejects page-typed creates without a space ULID with
 * `AppError::Validation`. For page creation, prefer the explicit
 * `createPageInSpace` helper below — it makes the invariant readable
 * at the callsite and routes through the dedicated `create_page_in_space`
 * IPC. The optional `spaceId` here exists so callers stuck on
 * `createBlock` can still satisfy the invariant if needed (and so the
 * specta-bound IPC parameter list matches the Rust signature).
 *
 * Other block types (`content`, `tag`) ignore `spaceId`.
 */
export async function createBlock(params: {
  blockType: string
  content: string
  parentId?: string | undefined
  /** #400: 0-based sibling slot among `parentId`'s children; omit to append. */
  index?: number | undefined
  spaceId?: string | undefined
}): Promise<BlockRow> {
  return unwrap(
    await commands.createBlock(
      params.blockType,
      params.content,
      params.parentId ?? null,
      params.index ?? null,
      toSpaceScope(params.spaceId),
    ),
  )
}

/**
 * PEND-35 Tier 4.3 — atomically create N blocks (with optional per-block
 * properties) in a single backend IMMEDIATE transaction.
 *
 * Replaces the per-block `createBlock` IPC loop in
 * `template-utils.ts::insertTemplateBlocks` /
 * `insertTemplateBlocksFromString` (one IPC per descendant / per markdown
 * line). The new path is one IPC, one writer-lock window, one op_log
 * scope. A 10-line journal template that previously fired 10 IPCs now
 * fires 1.
 *
 * **All-or-nothing atomicity**: any error inside the batch (invalid
 * `blockType`, missing parent, oversize content, property validation
 * rejection) rolls the whole transaction back. Returns the created
 * `BlockRow`s in input order — callers map their template-line index to
 * the returned block.
 *
 * **Forward references**: a spec's `parentId` may point to a block id
 * created EARLIER in the same batch (e.g. a child whose parent was just
 * inserted at the previous index). The backend's parent-existence probe
 * runs against the live transaction state.
 *
 * **Validation failures**: empty list / oversize list (>1000) reject
 * with `AppError::Validation`.
 */
export async function createBlocksBatch(specs: CreateBlockSpec[]): Promise<BlockRow[]> {
  return unwrap(await commands.createBlocksBatch(specs))
}

/** Edit a block's text content. */
export async function editBlock(blockId: string, toText: string): Promise<BlockRow> {
  return unwrap(await commands.editBlock(blockId, toText))
}

/** Soft-delete a block (cascade to descendants). */
export async function deleteBlock(blockId: string): Promise<DeleteResponse> {
  return unwrap(await commands.deleteBlock(blockId))
}

/**
 * PEND-35 Tier 2.1 — batch soft-delete a list of blocks (cascade to
 * descendants for each root) inside a single backend IMMEDIATE
 * transaction. Returns the number of blocks soft-deleted (roots +
 * descendants combined).
 *
 * Replaces the per-row `deleteBlock` IPC loop in
 * `useBlockMultiSelect.handleBatchDelete`. Multi-select gestures used
 * to fire one IPC per selected block (50 IPCs for a 50-row delete);
 * the new path is one IPC, one writer-lock window, one op_log
 * append-scope. The backend's recursive CTE seeds from every root
 * simultaneously so descendant ids that are also in the input set
 * are coalesced — the FE no longer needs the MAINT-173 ancestor
 * pre-walk.
 *
 * Already-deleted / missing ids are silently dropped on the backend
 * (best-effort across the surviving subset). Validation failures
 * (empty list, oversize list >1000, non-empty space block) reject
 * the whole call and surface as `AppError::Validation` /
 * `AppError::InvalidOperation` toast text.
 */
export async function deleteBlocksByIds(blockIds: string[]): Promise<number> {
  return unwrap(await commands.deleteBlocksByIds(blockIds))
}

/**
 * #81 / PEND-57 — move N blocks to a target space in a single IPC.
 *
 * Returns the number of blocks actually moved (the backend skips ids
 * that are missing or already in `spaceId`). Used by the Pages-view
 * batch toolbar's "Move to space" action.
 */
export async function moveBlocksToSpace(blockIds: string[], spaceId: string): Promise<number> {
  return unwrap(await commands.moveBlocksToSpace(blockIds, spaceId))
}

/** Restore a soft-deleted block using its `deleted_at` timestamp as ref. */
export async function restoreBlock(
  blockId: string,
  deletedAtRef: number,
): Promise<RestoreResponse> {
  return unwrap(await commands.restoreBlock(blockId, deletedAtRef))
}

/** Permanently purge a block and its descendants. Irreversible. */
export async function purgeBlock(blockId: string): Promise<PurgeResponse> {
  return unwrap(await commands.purgeBlock(blockId))
}

export interface BulkTrashResponse {
  affected_count: number
}

/** Restore all soft-deleted blocks. Returns count of restored blocks. */
export async function restoreAllDeleted(): Promise<BulkTrashResponse> {
  return unwrap(await commands.restoreAllDeleted())
}

/** Permanently purge all soft-deleted blocks. Irreversible. */
export async function purgeAllDeleted(): Promise<BulkTrashResponse> {
  return unwrap(await commands.purgeAllDeleted())
}

/**
 * PEND-35 Tier 2.2 — restore a list of soft-deleted blocks in a single IPC.
 *
 * Mirrors `restoreBlock` but accepts an array of ids; the backend runs one
 * IMMEDIATE transaction with one op_log scope instead of N. Each id is
 * treated as a cascade root (matches the TrashView's `listTrash` source).
 * Non-deleted / missing ids are
 * silently skipped (no error). Returns the number of blocks (roots +
 * descendants) whose `deleted_at` was actually cleared.
 */
export async function restoreBlocksByIds(blockIds: string[]): Promise<number> {
  const resp = unwrap(await commands.restoreBlocksByIds(blockIds))
  return resp.affected_count
}

/**
 * PEND-35 Tier 2.2 — permanently purge a list of soft-deleted blocks in a
 * single IPC.
 *
 * Mirrors `purgeBlock` but accepts an array of ids; the backend runs one
 * IMMEDIATE transaction with the ~13-table cleanup chain executed once
 * instead of N times. Non-deleted / missing ids are silently skipped (no
 * error). Returns the number of `blocks` rows physically removed.
 */
export async function purgeBlocksByIds(blockIds: string[]): Promise<number> {
  const resp = unwrap(await commands.purgeBlocksByIds(blockIds))
  return resp.affected_count
}

/**
 * Batch-count cascade-deleted descendants per trash root.
 *
 * Given a list of trash-root IDs (as returned by `listTrash`),
 * returns a map of `root_id -> descendant_count`. Descendants are blocks sharing
 * the root's `deleted_at` timestamp, excluding the root itself and conflict copies.
 * Roots with zero descendants are omitted — treat missing keys as `0`.
 */
export async function trashDescendantCounts(rootIds: string[]): Promise<Record<string, number>> {
  return unwrap(await commands.trashDescendantCounts(rootIds))
}

/**
 * Batch-fetch the first child of each parent block in a single IPC call.
 *
 * PEND-35 Tier 2.8 — collapses the TemplatesView preview-fetch N+1
 * (`listBlocks({ parentId, limit: 1 })` per template) into a single
 * window-function-backed query on the backend. The returned record
 * maps `parentId -> firstChildBlockRow`, ordered by `(position, id)`
 * ASC inside the CTE so the value is the canonical first sibling.
 *
 * Parents with no active children are omitted from the record. Soft-deleted
 * and conflict-copy children are filtered out inside the CTE so the
 * returned row is always a live, surfaceable block.
 */
export async function firstChildForBlocks(blockIds: string[]): Promise<Record<string, BlockRow>> {
  return unwrap(await commands.firstChildForBlocks(blockIds))
}

/**
 * PEND-35 Tier 2.3 — batch-fetch full BlockRows by id.
 *
 * Sibling of `batchResolve` returning the full 12-column `BlockRow`
 * (not just the lightweight `id / title / block_type / deleted`
 * projection). Consumers that need `todo_state`, `priority`, `due_date`,
 * `scheduled_date`, `content`, `parent_id`, `position`, etc. collapse a
 * per-row `getBlock` IPC fan-out into a single query.
 *
 * Soft-deleted rows are INCLUDED (unlike `batchResolve` which filters
 * them out).
 *
 * IDs that don't exist are silently omitted from the response — callers
 * must map by `id` and treat missing keys as "unknown / lost". Returned
 * rows are NOT guaranteed to be in input order. Empty input rejects with
 * `AppError::Validation` (mirrors `batchResolve`).
 */
export async function getBlocks(ids: string[]): Promise<BlockRow[]> {
  return unwrap(await commands.getBlocks(ids))
}

/** List blocks with optional filters and cursor-based pagination.
 *
 * The public TypeScript shape keeps the agenda knobs (`agendaDate`,
 * `agendaDateRange`, `agendaSource`) as three top-level fields for
 * backward compatibility. On the IPC boundary they are bundled into the
 * Rust `AgendaQuery` struct so the Tauri command stays under the
 * `tauri-specta` 10-arg limit after FEAT-3 Phase 2 added `spaceId`.
 *
 * `spaceId` (FEAT-3 Phase 4) — required. The backend filters results to
 * blocks whose owning page carries `space = <spaceId>`. Callers must
 * resolve the active `currentSpaceId` (from `useSpaceStore`) before
 * invoking; pre-bootstrap callers should pass `''` (empty string), which
 * the backend treats as a no-match (returns an empty page) rather than
 * crashing on a runtime null deref.
 */
export async function listBlocks(params: {
  parentId?: string | undefined
  blockType?: string | undefined
  tagId?: string | undefined
  agendaDate?: string | undefined
  agendaDateRange?: DateRange | undefined
  agendaSource?: string | undefined
  cursor?: string | undefined
  limit?: SafeLimit | undefined
  spaceId: string
}): Promise<PageResponse<BlockRow>> {
  const hasAgenda =
    params.agendaDate != null || params.agendaDateRange != null || params.agendaSource != null
  const agenda = hasAgenda
    ? {
        date: params.agendaDate ?? null,
        dateRange: params.agendaDateRange ?? null,
        source: params.agendaSource ?? null,
      }
    : null
  return unwrap(
    await commands.listBlocks(
      params.parentId ?? null,
      params.blockType ?? null,
      params.tagId ?? null,
      agenda,
      params.cursor ?? null,
      params.limit ?? null,
      params.spaceId,
    ),
  )
}

/**
 * Paginate soft-deleted blocks (the trash view). Scoped to a single space.
 */
export async function listTrash(params: {
  cursor?: string | undefined
  limit?: SafeLimit | undefined
  spaceId: string
}): Promise<PageResponse<BlockRow>> {
  return unwrap(
    await commands.listTrash(params.cursor ?? null, params.limit ?? null, params.spaceId),
  )
}

/**
 * Look up a single journal page by its date string in the given space.
 *
 * BUG-48 — replaces the frontend pattern of paginating `listBlocks({ blockType:
 * 'page', limit: 100 })` and probing the resulting Map. Backed by the partial
 * index `idx_blocks_journal_date` (migration 0047) so the lookup is O(index)
 * regardless of total block count. Returns `null` when no journal page exists
 * for `date` in `spaceId`.
 */
export async function getJournalPageByDate(params: {
  date: string
  spaceId: string
}): Promise<BlockRow | null> {
  return unwrap(await commands.getJournalPageByDate(params.date, params.spaceId))
}

/**
 * List the date-formatted journal pages in the given space whose date falls
 * inclusively in `[startDate, endDate]`.
 *
 * BUG-48 — replaces the cursor-paginated `listBlocks({ blockType: 'page',
 * limit: 100 })` loop in `useCalendarPageDates` with a range-scoped
 * indexed lookup. Callers pass the visible date range (typically the
 * 6-week calendar grid for monthly views, or the visible week / day for
 * smaller views) so the response is bounded by what the UI actually
 * renders rather than every journal page ever created in the space.
 */
export async function listJournalPagesInRange(params: {
  startDate: string
  endDate: string
  spaceId: string
}): Promise<BlockRow[]> {
  return unwrap(
    await commands.listJournalPagesInRange(params.startDate, params.endDate, params.spaceId),
  )
}

/**
 * PEND-56 — paginated page list with per-page metadata columns:
 * `last_modified_at`, `inbound_link_count`, `child_block_count`, and a
 * `has_property_flags` bitmask (bit 0 tags / 1 todo / 2 scheduled / 3 due).
 *
 * Sibling of {@link listBlocks}. This wrapper backs the `PageBrowser`
 * page list.
 *
 * Sort modes that need server-derived sort keys (`recently-modified`,
 * `most-linked`, `biggest`) cursor-paginate via the new keysets. The
 * frontend-only `recent` (per-device visit history) and `created`
 * (ULID DESC) modes reuse the `ulid` SQL ordering and re-sort in JS.
 */
export async function listPagesWithMetadata(params: {
  sort?: PageSort | undefined
  spaceId: string
  cursor?: string | undefined
  limit?: SafeLimit | undefined
  /**
   * PEND-58 Phase 3 — compound filter primitives applied server-side
   * (AND-composed). Omit / empty for today's unfiltered behaviour. The
   * backend gates each primitive against the Pages allowed-keys set and
   * rejects Search-only primitives with a validation error.
   */
  filters?: FilterPrimitive[] | undefined
}): Promise<PageResponse<PageWithMetadataRow>> {
  return unwrap(
    await commands.listPagesWithMetadata(
      // No frontend-side default — the Rust `#[default] Alphabetical`
      // attribute on `PageSort` is the single source of truth. Sending
      // an explicit value here would silently drift if the backend
      // default ever changes (Review Round 1 — UX MEDIUM #5).
      //
      // `filters` defaults to `[]` (the Rust `#[serde(default)]` would
      // accept its absence too, but sending an explicit empty array keeps
      // the wire shape unambiguous for the mock handler).
      {
        sort: params.sort ?? null,
        spaceId: params.spaceId,
        filters: params.filters ?? [],
      } as Parameters<typeof commands.listPagesWithMetadata>[0],
      params.cursor ?? null,
      params.limit ?? null,
    ),
  )
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
 * `spaceId` (FEAT-3 Phase 4) — when set, restricts results to undated
 * tasks whose owning page carries `space = <spaceId>`. `null` /
 * `undefined` leaves the result set unscoped, matching the pre-FEAT-3
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
 * Cursor-paginated (M-25). Pass `cursor: response.next_cursor` to fetch
 * the next page; `has_more = false` indicates the final page.
 *
 * `spaceId` (FEAT-3 Phase 4) — when set, restricts projections to
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

/**
 * Fire a native OS notification for a due / scheduled task (FEAT-11).
 *
 * Thin wrapper over the `notify_task` IPC command. `title` is required and
 * must be non-empty (the backend rejects a blank title with a validation
 * error); `body` and `blockId` are optional. `blockId` is carried only for
 * caller-side dedupe correlation — it is never shown to the OS.
 *
 * Desktop fires immediately once the `notification:default` capability is
 * granted. On Android 13+ the caller must first obtain the
 * `POST_NOTIFICATIONS` runtime grant (see {@link ensureNotificationPermission}).
 */
export async function notifyTask(notification: TaskNotification): Promise<void> {
  // The command resolves `Result<(), AppError>` (bindings type `null`);
  // discard the null payload and surface only success / rejection.
  unwrap(await commands.notifyTask(notification))
}

/**
 * Ensure the OS notification permission is granted (FEAT-11).
 *
 * On Android 13+ a runtime `POST_NOTIFICATIONS` grant is required before
 * {@link notifyTask} can surface anything; on desktop the capability grant
 * is sufficient and this resolves `true` without prompting. The
 * `@tauri-apps/plugin-notification` JS API is imported dynamically so this
 * module stays usable (and testable) in plain web / test contexts where the
 * plugin is unavailable — a failed import resolves `false` rather than
 * throwing.
 *
 * @returns `true` if notifications may be shown, `false` if denied or the
 *   plugin is unavailable.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  try {
    const { isPermissionGranted, requestPermission } =
      await import('@tauri-apps/plugin-notification')
    if (await isPermissionGranted()) {
      return true
    }
    const permission = await requestPermission()
    return permission === 'granted'
  } catch (error) {
    logger.warn('tauri', 'notification plugin unavailable for permission check', undefined, error)
    return false
  }
}

/** Fetch a single block by ID. */
export async function getBlock(blockId: string): Promise<BlockRow> {
  return unwrap(await commands.getBlock(blockId))
}

/** Resolved metadata for a block — lightweight alternative to full BlockRow. */
export interface ResolvedBlock {
  id: string
  title: string | null
  block_type: string
  deleted: boolean
}

/** Batch-resolve block metadata for multiple IDs in a single call.
 *
 * `spaceId` (FEAT-3p7) — when set, restricts resolution to blocks
 * whose owning page carries `space = <spaceId>`. Foreign-space targets
 * simply do not appear in the response, which is what makes the chip
 * fall into the "unknown id" branch and render via the broken-link
 * UX (locked-in policy: no live links between spaces, ever).
 *
 * The wrapper keeps `spaceId` optional at the TypeScript boundary so
 * legacy cross-space callers (TrashView breadcrumbs, SearchPanel
 * results, agenda panels, dependency chips) compile unchanged; in the
 * generated `bindings.ts` `space_id` is required, so leaving it
 * `undefined` passes JSON `null` to the backend, which rejects at
 * runtime. The intent is to migrate every call site to pass the
 * active `currentSpaceId` (or an explicit override for genuinely
 * cross-space surfaces like the trash) before the backend tightens
 * `Option<String>` → `String`. Mirrors the optional `spaceId` shape
 * used by `listBlocks` / `searchBlocks`.
 */
export async function batchResolve(
  ids: string[],
  spaceId?: string | undefined,
): Promise<ResolvedBlock[]> {
  return unwrap(await commands.batchResolve(ids, toSpaceScope(spaceId)))
}

/**
 * Move a block under a new parent at a 0-based sibling slot (#400). `newIndex`
 * is an insertion slot among the target parent's other children (0 = first /
 * top); the backend derives the convergent fractional key from it.
 */
export async function moveBlock(
  blockId: string,
  newParentId: string | null,
  newIndex: number,
): Promise<MoveResponse> {
  return unwrap(await commands.moveBlock(blockId, newParentId, newIndex))
}

/** Associate a tag with a block. */
export async function addTag(blockId: string, tagId: string): Promise<TagResponse> {
  return unwrap(await commands.addTag(blockId, tagId))
}

/**
 * #81 / PEND-57 — add ONE tag to N blocks in a single IPC.
 *
 * Bulk counterpart to {@link addTag}; the backend skips ids that are
 * missing or already carry the tag, and returns the number of blocks
 * newly tagged. Used by the Pages-view batch toolbar's "Add tag" action.
 */
export async function addTagsByIds(blockIds: string[], tagId: string): Promise<number> {
  return unwrap(await commands.addTagsByIds(blockIds, tagId))
}

/** Remove a tag association from a block. */
export async function removeTag(blockId: string, tagId: string): Promise<TagResponse> {
  return unwrap(await commands.removeTag(blockId, tagId))
}

/** List blocks that link to the given block (backlinks), paginated.
 *
 * `spaceId` (FEAT-3 Phase 4) — when set, restricts the backlinks to
 * source blocks whose owning page carries `space = <spaceId>`. `null` /
 * `undefined` leaves the result set unscoped (cross-space view).
 */
export async function getBacklinks(params: {
  blockId: string
  cursor?: string | undefined
  limit?: SafeLimit | undefined
  spaceId?: string | null | undefined
}): Promise<PageResponse<BlockRow>> {
  return unwrap(
    await commands.getBacklinks(
      params.blockId,
      params.cursor ?? null,
      params.limit ?? null,
      toSpaceScope(params.spaceId),
    ),
  )
}

/** List op-log history for a block, paginated (newest first).
 *
 * PEND-35 Tier 1.3 — `opTypeFilter` is pushed into SQL so cursor pages
 * arrive pre-filtered. Mirrors `listPageHistory`. When `undefined`, all
 * op types for the block are returned. */
export async function getBlockHistory(params: {
  blockId: string
  opTypeFilter?: string | undefined
  cursor?: string | undefined
  limit?: SafeLimit | undefined
}): Promise<PageResponse<HistoryEntry>> {
  return unwrap(
    await commands.getBlockHistory(
      params.blockId,
      params.opTypeFilter ?? null,
      params.cursor ?? null,
      params.limit ?? null,
    ),
  )
}

/** Full-text search across all blocks, paginated by relevance.
 *
 * `spaceId` (FEAT-3 Phase 4) — required. Restricts matches to blocks
 * whose owning page carries `space = <spaceId>`. Callers must resolve
 * the active `currentSpaceId` (from `useSpaceStore`) before invoking;
 * pre-bootstrap callers should pass `''` (empty string), which the
 * backend treats as a no-match (returns an empty page) rather than
 * crashing on a runtime null deref.
 *
 * PEND-50 Phase 0 — `parentId`, `tagIds`, `spaceId` are marshalled into
 * the backend's `SearchFilter` struct at the IPC boundary. The public
 * API stays flat so existing call sites (e.g. `SearchPanel.tsx`) do
 * not need to change. Follow-up plans (PEND-51 / 54 / 55 / 53) append
 * new filter fields here; the wrapper forwards each into the struct.
 *
 * PEND-50 Phase 1 — responses now carry `SearchBlockRow` (which adds
 * `snippet: string | null`). The shape is a strict superset of
 * `BlockRow`, so existing consumers compile unchanged.
 */
export async function searchBlocks(
  params: {
    query: string
    parentId?: string | undefined
    tagIds?: string[] | undefined
    cursor?: string | undefined
    limit?: SafeLimit | undefined
    spaceId: string
    /** PEND-54 — page-name glob include list. See `SearchFilter`. */
    includePageGlobs?: string[] | undefined
    /** PEND-54 — page-name glob exclude list. See `SearchFilter`. */
    excludePageGlobs?: string[] | undefined
    /** PEND-55 — case-sensitive post-FTS filter. See `SearchFilter`. */
    caseSensitive?: boolean | undefined
    /** PEND-55 — ASCII whole-word post-FTS filter. See `SearchFilter`. */
    wholeWord?: boolean | undefined
    /** PEND-55 — regex-mode (bypasses FTS5). See `SearchFilter`. */
    isRegex?: boolean | undefined
    /**
     * PEND-51 — restrict to a specific `blocks.block_type` (e.g. `'page'`).
     * The Cmd+K palette fires a page-only query in parallel with an
     * unrestricted blocks query so the FE only has to merge by `page_id`.
     * `undefined` preserves the pre-PEND-51 "all block types" behaviour.
     * See `SearchFilter.block_type_filter`.
     */
    blockTypeFilter?: string | undefined
    /** PEND-53 — `blocks.todo_state IN (...)`. See `SearchFilter`. */
    stateFilter?: string[] | undefined
    /** PEND-53 — `blocks.priority IN (...)`. See `SearchFilter`. */
    priorityFilter?: string[] | undefined
    /**
     * PEND-53 — date predicate on `blocks.due_date`. The frontend AST
     * carries `DateFilterValue` with operators `< <= = >= >`; this
     * wrapper translates to the wire shape `{ named: ... } | { op: {
     * op: 'lt' | 'lte' | 'eq' | 'gte' | 'gt', date } }`.
     */
    dueFilter?: DateFilterValueInput | null | undefined
    /** PEND-53 — same shape as `dueFilter` but on `blocks.scheduled_date`. */
    scheduledFilter?: DateFilterValueInput | null | undefined
    /** PEND-53 — AND-joined property filters; see `SearchPropertyFilter`. */
    propertyFilters?: { key: string; value: string }[] | undefined
    /** PEND-53 — AND-joined property exclusions. */
    excludedPropertyFilters?: { key: string; value: string }[] | undefined
    /**
     * PEND-63 — `not-state:` projection. Backend emits
     * `(todo_state IS NULL OR todo_state NOT IN (...))` — NULL-inclusive
     * inversion. Literal `'none'` flips to `todo_state IS NOT NULL`.
     */
    excludedStateFilter?: string[] | undefined
    /** PEND-63 — `not-priority:` projection. Symmetric to `excludedStateFilter`. */
    excludedPriorityFilter?: string[] | undefined
  },
  /**
   * PEND-58f FE-2 — optional client-side abort. When the supplied
   * `AbortSignal` fires the returned promise rejects with a
   * `cancelled`-kind `AppError` (see {@link withAbort}), which
   * `isCancellation()` discriminates so superseded searches are
   * swallowed silently by the caller. The underlying IPC is NOT
   * cancelled server-side (Tauri 2 limitation); this is a
   * stop-waiting primitive that lets a newer search drop the prior
   * in-flight one. Omit for the pre-PEND-58f fire-and-forget shape.
   */
  signal?: AbortSignal,
): Promise<PageResponse<SearchBlockRow>> {
  return unwrap(
    await withAbort(
      commands.searchBlocks(params.query, params.cursor ?? null, params.limit ?? null, {
        parentId: params.parentId ?? null,
        tagIds: params.tagIds ?? [],
        spaceId: params.spaceId,
        includePageGlobs: params.includePageGlobs ?? [],
        excludePageGlobs: params.excludePageGlobs ?? [],
        caseSensitive: params.caseSensitive ?? false,
        wholeWord: params.wholeWord ?? false,
        isRegex: params.isRegex ?? false,
        blockTypeFilter: params.blockTypeFilter ?? null,
        stateFilter: params.stateFilter ?? [],
        priorityFilter: params.priorityFilter ?? [],
        dueFilter: marshalDateFilter(params.dueFilter ?? null),
        scheduledFilter: marshalDateFilter(params.scheduledFilter ?? null),
        propertyFilters: params.propertyFilters ?? [],
        excludedPropertyFilters: params.excludedPropertyFilters ?? [],
        excludedStateFilter: params.excludedStateFilter ?? [],
        excludedPriorityFilter: params.excludedPriorityFilter ?? [],
      }),
      signal,
    ),
  )
}

/**
 * PEND-61 Phase 1 — partitioned full-text search.
 *
 * Returns `pages` (rows where `block_type='page'`) and `blocks`
 * (unrestricted rank-ordered set; may include pages alongside content)
 * in **one** FTS5 scan. Replaces the PEND-51 palette pattern of firing
 * two parallel `searchBlocks` calls.
 *
 * `filter.blockTypeFilter` is ignored — the partitioning IS the
 * block-type split. The field stays on the wire for `SearchFilter` compat.
 */
export async function searchBlocksPartitioned(params: {
  query: string
  pageLimit: number
  blockLimit: number
  parentId?: string | undefined
  tagIds?: string[] | undefined
  spaceId: string
  includePageGlobs?: string[] | undefined
  excludePageGlobs?: string[] | undefined
  caseSensitive?: boolean | undefined
  wholeWord?: boolean | undefined
  isRegex?: boolean | undefined
  stateFilter?: string[] | undefined
  priorityFilter?: string[] | undefined
  dueFilter?: DateFilterValueInput | null | undefined
  scheduledFilter?: DateFilterValueInput | null | undefined
  propertyFilters?: { key: string; value: string }[] | undefined
  excludedPropertyFilters?: { key: string; value: string }[] | undefined
  excludedStateFilter?: string[] | undefined
  excludedPriorityFilter?: string[] | undefined
}): Promise<PartitionedSearchResponse> {
  return unwrap(
    await commands.searchBlocksPartitioned(params.query, params.pageLimit, params.blockLimit, {
      parentId: params.parentId ?? null,
      tagIds: params.tagIds ?? [],
      spaceId: params.spaceId,
      includePageGlobs: params.includePageGlobs ?? [],
      excludePageGlobs: params.excludePageGlobs ?? [],
      caseSensitive: params.caseSensitive ?? false,
      wholeWord: params.wholeWord ?? false,
      isRegex: params.isRegex ?? false,
      blockTypeFilter: null,
      stateFilter: params.stateFilter ?? [],
      priorityFilter: params.priorityFilter ?? [],
      dueFilter: marshalDateFilter(params.dueFilter ?? null),
      scheduledFilter: marshalDateFilter(params.scheduledFilter ?? null),
      propertyFilters: params.propertyFilters ?? [],
      excludedPropertyFilters: params.excludedPropertyFilters ?? [],
      excludedStateFilter: params.excludedStateFilter ?? [],
      excludedPriorityFilter: params.excludedPriorityFilter ?? [],
    }),
  )
}

/**
 * PEND-53 — frontend-side `DateFilter` input shape. Mirrors the
 * `DateFilterValue` union in `src/lib/search-query/types.ts` (the
 * shape the AST projection emits). The IPC wrapper translates this
 * to the wire shape (`DateFilter`) at the IPC boundary so the rest
 * of the frontend doesn't need to know about specta's `lt`/`lte`/…
 * string codes.
 */
export type DateFilterValueInput =
  | { kind: 'named'; name: string }
  | { kind: 'op'; op: '<' | '<=' | '=' | '>=' | '>'; date: string }

/** Translate a frontend `DateFilterValueInput` to the wire shape. */
function marshalDateFilter(v: DateFilterValueInput | null): import('./bindings').DateFilter | null {
  if (v == null) return null
  if (v.kind === 'named') {
    // The wire shape uses kebab-case for the `NamedDateRange` enum;
    // the input shape already matches.
    return { named: v.name as import('./bindings').NamedDateRange }
  }
  const opMap: Record<'<' | '<=' | '=' | '>=' | '>', import('./bindings').DateOp> = {
    '<': 'lt',
    '<=': 'lte',
    '=': 'eq',
    '>=': 'gte',
    '>': 'gt',
  }
  return { op: { op: opMap[v.op], date: v.date } }
}

/** Get materializer queue status and metrics. */
export async function getStatus(): Promise<StatusInfo> {
  return unwrap(await commands.getStatus())
}

/** Query blocks by boolean tag expression (AND/OR mode), paginated.
 *
 * `spaceId` (FEAT-3 Phase 4) — when set, restricts matches to blocks
 * whose owning page carries `space = <spaceId>`. `null` / `undefined`
 * leaves the result set unscoped (cross-space view).
 *
 * `blockType` (PEND-35 Tier 3.4) — when set, restricts matches to
 * blocks whose `block_type` equals the supplied value (e.g. `'page'`).
 * Pushes GraphView's JS-side `pagesResp.items.filter(p => p.block_type
 * === 'page')` predicate into SQL.
 */
export async function queryByTags(params: {
  tagIds: string[]
  prefixes: string[]
  mode: string // 'and' | 'or'
  includeInherited?: boolean | undefined
  cursor?: string | undefined
  limit?: SafeLimit | undefined
  spaceId?: string | null | undefined
  blockType?: string | undefined
}): Promise<PageResponse<BlockRow>> {
  return unwrap(
    await commands.queryByTags(
      params.tagIds,
      params.prefixes,
      params.mode,
      params.includeInherited ?? null,
      params.cursor ?? null,
      params.limit ?? null,
      toSpaceScope(params.spaceId),
      params.blockType ?? null,
    ),
  )
}

/** List tags whose name starts with the given prefix (autocomplete). */
export async function listTagsByPrefix(params: {
  prefix: string
  limit?: SafeLimit | undefined
}): Promise<TagCacheRow[]> {
  return unwrap(await commands.listTagsByPrefix(params.prefix, params.limit ?? null))
}

export async function listTagsForBlock(blockId: string): Promise<string[]> {
  return unwrap(await commands.listTagsForBlock(blockId))
}

/**
 * List the tag IDs a block holds via inheritance (`block_tag_inherited`),
 * i.e. tags a strict ancestor applies directly that propagate down. Paired
 * with {@link listTagsForBlock} so the UI can render inherited (derived) tag
 * chips distinctly from directly-applied ones (#1423).
 */
export async function listInheritedTagsForBlock(blockId: string): Promise<string[]> {
  return unwrap(await commands.listInheritedTagsForBlock(blockId))
}

// ---------------------------------------------------------------------------
// Property commands
// ---------------------------------------------------------------------------

export interface PropertyRow {
  key: string
  value_text: string | null
  value_num: number | null
  value_date: string | null
  value_ref: string | null
  /** PEND-14: native boolean property storage; SQLite represents it as 0/1/null. */
  value_bool: number | null
}

/** Set (upsert) a property on a block. Exactly one value field must be non-null. */
export async function setProperty(params: {
  blockId: string
  key: string
  valueText?: string | null | undefined
  valueNum?: number | null | undefined
  valueDate?: string | null | undefined
  valueRef?: string | null | undefined
  valueBool?: boolean | null | undefined
}): Promise<BlockRow> {
  return unwrap(
    await commands.setProperty(params.blockId, params.key, {
      value_text: params.valueText ?? null,
      value_num: params.valueNum ?? null,
      value_date: params.valueDate ?? null,
      value_ref: params.valueRef ?? null,
      value_bool: params.valueBool ?? null,
    }),
  )
}

/** Delete a property from a block by key. */
export async function deleteProperty(blockId: string, key: string): Promise<void> {
  unwrap(await commands.deleteProperty(blockId, key))
}

/** Get all properties for a block. */
export async function getProperties(blockId: string): Promise<PropertyRow[]> {
  return unwrap(await commands.getProperties(blockId))
}

/** Get a single property row by `(block_id, key)` primary key
 * (PEND-35 Tier 2.4c).
 *
 * Returns the row, or `null` when no property exists for `key` on the
 * given block. Replaces the pattern of calling `getProperties(blockId)`
 * (which ships every row across the IPC boundary) just to read one
 * well-known key — `loadJournalTemplateForSpace`, the `StaticBlock`
 * `image_width` read, and the three `blocked_by` dependency probes
 * (gutter cycle, slash command, checkbox syntax) all migrated to this
 * dedicated PK lookup.
 */
export async function getProperty(blockId: string, key: string): Promise<PropertyRow | null> {
  return unwrap(await commands.getProperty(blockId, key))
}

/** Batch-fetch properties for multiple blocks in a single IPC call. */
export async function getBatchProperties(
  blockIds: string[],
): Promise<Record<string, PropertyRow[]>> {
  return unwrap(await commands.getBatchProperties(blockIds))
}

// ---------------------------------------------------------------------------
// Batch count commands (#604)
// ---------------------------------------------------------------------------

/** Batch-count agenda items per date. Returns a map of date -> count.
 *
 * `spaceId` (FEAT-3 Phase 4) — when set, restricts counts to agenda
 * items whose owning page carries `space = <spaceId>`. `null` /
 * `undefined` leaves the counts cross-space.
 */
export async function countAgendaBatch(params: {
  dates: string[]
  spaceId?: string | null | undefined
}): Promise<Record<string, number>> {
  return unwrap(await commands.countAgendaBatch(params.dates, toSpaceScope(params.spaceId)))
}

/** Batch-count agenda items per (date, source). Returns nested map: date -> source -> count.
 *
 * `spaceId` (FEAT-3 Phase 4) — when set, restricts counts to agenda
 * items whose owning page carries `space = <spaceId>`. `null` /
 * `undefined` leaves the counts cross-space.
 */
export async function countAgendaBatchBySource(params: {
  dates: string[]
  spaceId?: string | null | undefined
}): Promise<Record<string, Record<string, number>>> {
  return unwrap(await commands.countAgendaBatchBySource(params.dates, toSpaceScope(params.spaceId)))
}

/** Batch-count backlinks per target page. Returns a map of pageId -> count.
 *
 * `spaceId` (PEND-35 Tier 1.6) — when set, restricts the counted source
 * blocks to those whose owning page carries `space = <spaceId>`.
 * `null` / `undefined` keeps the cross-space (legacy) behaviour. The
 * scope is forwarded as a [`SpaceScope`] via `toSpaceScope`. Without
 * this filter a page in space A could surface a non-zero badge count
 * whose source blocks live in space B — backlinks the user can't see.
 */
export async function countBacklinksBatch(params: {
  pageIds: string[]
  spaceId?: string | null | undefined
}): Promise<Record<string, number>> {
  return unwrap(await commands.countBacklinksBatch(params.pageIds, toSpaceScope(params.spaceId)))
}

/** Count soft-deleted blocks in a space. Used by the sidebar trash badge.
 *
 * The badge fetches the count via a `SELECT COUNT(*)` IPC so it stays
 * accurate regardless of trash size (limit-clamp follow-up).
 *
 * Pass `''` for the pre-bootstrap window before a space is active — the
 * backend `value_ref` filter treats the empty string as a no-match, so
 * the result is `0`. Mirrors the `?? ''` fallback used by `TrashView`.
 */
export async function countTrash(spaceId: string): Promise<number> {
  return unwrap(await commands.countTrash(spaceId))
}

// ---------------------------------------------------------------------------
// Block fixed-field commands (thin wrappers for reserved properties)
// ---------------------------------------------------------------------------

/** Set or clear the todo state on a block. Pass null to clear. */
export async function setTodoState(blockId: string, state: string | null): Promise<BlockRow> {
  return unwrap(await commands.setTodoState(blockId, state))
}

/**
 * PEND-35 Tier 2.1 — batch set/clear todo state across a list of blocks
 * inside a single backend IMMEDIATE transaction. Returns the number of
 * blocks whose `todo_state` actually changed.
 *
 * Replaces the per-row `setTodoState` IPC loop in
 * `useBlockMultiSelect.handleBatchSetTodo`. Multi-select "mark done"
 * used to fire one IPC per selected block (50 IPCs for a 50-row
 * gesture); the new path is one IPC, one writer-lock window, one
 * op_log append-scope.
 *
 * Missing / soft-deleted ids are silently skipped on the backend
 * (best-effort across the surviving subset). The single-row
 * `setTodoState` path stays in place for the per-block call sites
 * (BlockContextMenu, slash commands) — its recurrence + timestamp
 * transitions (`created_at` / `completed_at` auto-population, repeat
 * sibling creation) are intentionally NOT applied by the batch path
 * because propagating them per item under one IMMEDIATE lock would
 * defeat the latency win.
 */
export async function setTodoStateBatch(blockIds: string[], state: string | null): Promise<number> {
  return unwrap(await commands.setTodoStateBatch(blockIds, state))
}

/** Set or clear the priority level on a block. Pass null to clear. */
export async function setPriority(blockId: string, level: string | null): Promise<BlockRow> {
  return unwrap(await commands.setPriority(blockId, level))
}

/** Set or clear the due date on a block. Pass null to clear. */
export async function setDueDate(blockId: string, date: string | null): Promise<BlockRow> {
  return unwrap(await commands.setDueDate(blockId, date))
}

/** Set or clear the scheduled date on a block. Pass null to clear. */
export async function setScheduledDate(blockId: string, date: string | null): Promise<BlockRow> {
  return unwrap(await commands.setScheduledDate(blockId, date))
}

/** List global operation history (page-scoped), paginated (newest first).
 *
 * FEAT-3 Phase 8 — `spaceId` narrows the global (`pageId === '__all__'`)
 * query to ops whose `payload.block_id` belongs to the requested space.
 * Pass `undefined` to disable the space filter (cross-space t('history.allSpacesToggle')
 * mode). Ignored in per-page mode — a real ULID `pageId` is already
 * space-bound. */
export async function listPageHistory(params: {
  pageId: string
  opTypeFilter?: string | undefined
  spaceId?: string | undefined
  cursor?: string | undefined
  limit?: SafeLimit | undefined
}): Promise<PageResponse<HistoryEntry>> {
  return unwrap(
    await commands.listPageHistory(
      params.pageId,
      params.opTypeFilter ?? null,
      toSpaceScope(params.spaceId),
      params.cursor ?? null,
      params.limit ?? null,
    ),
  )
}

/** List all page-to-page links for graph visualization.
 *
 * `spaceId` (FEAT-3 Phase 4) — when set, restricts the link set to
 * source pages whose `space = <spaceId>`. `null` / `undefined` leaves
 * the graph cross-space (legacy behaviour).
 *
 * `tagIds` (PEND-35 Tier 4.5) — when non-empty, restricts edges to
 * those whose **target page** carries at least one of the listed
 * tags (via `block_tags`, `block_tag_inherited`, or
 * `block_tag_refs` — same UX-250 union semantics as `queryByTags`).
 * Pushes the GraphView tag-filter predicate into SQL so the renderer
 * no longer fetches every space-wide edge then drops the off-tag
 * subgraph in JS. `null` / `undefined` / empty leaves the edge set
 * unfiltered.
 *
 * Backward-compat note: callers that still pass a bare `spaceId`
 * string keep working — the legacy positional shape is detected and
 * normalised to `{ spaceId, tagIds: null }` below.
 */
export async function listPageLinks(
  arg?:
    | string
    | null
    | undefined
    | {
        spaceId?: string | null | undefined
        tagIds?: string[] | null | undefined
      },
): Promise<Array<{ source_id: string; target_id: string; ref_count: number }>> {
  const params = typeof arg === 'object' && arg !== null ? arg : { spaceId: arg ?? null }
  const tagIds = params.tagIds && params.tagIds.length > 0 ? params.tagIds : null
  return unwrap(await commands.listPageLinks(toSpaceScope(params.spaceId), tagIds))
}

/** Revert a batch of operations (by device_id + seq pairs). */
export async function revertOps(params: {
  ops: Array<{ device_id: string; seq: number }>
}): Promise<unknown> {
  return unwrap(await commands.revertOps(params.ops))
}

/** Restore a page to its state at a specific operation (point-in-time restore). */
export async function restorePageToOp(params: {
  pageId: string
  targetDeviceId: string
  targetSeq: number
}): Promise<{
  ops_reverted: number
  non_reversible_skipped: number
  results: unknown[]
}> {
  return unwrap(
    await commands.restorePageToOp(params.pageId, params.targetDeviceId, params.targetSeq),
  )
}

/** Query blocks by property key and optional value, with cursor pagination.
 *
 * `spaceId` (FEAT-3 Phase 4) — when set, restricts matches to blocks
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

/** Query blocks by property key/value with cursor pagination.
 *
 * `excludeParentId` / `contentNonEmpty` (PEND-35 Tier 1.5) push the
 * DonePanel's two post-filters down into SQL so cursor pagination,
 * `total_count`, and t('donePanel.loadMore') reflect the visible set instead of
 * the unfiltered raw page. `undefined` / `false` preserves the legacy
 * unfiltered behaviour.
 *
 * `blockType` / `valueTextIn` / `valueDateRange` (PEND-35 Tier 3.4)
 * push three more filters into SQL:
 *  - `blockType` — equality on `b.block_type` (e.g. restrict templates
 *    to `'page'`).
 *  - `valueTextIn` — set-membership on `value_text`. Mutually
 *    exclusive with `valueText`; passing both is rejected by the
 *    backend.
 *  - `valueDateRange` — half-open `[from, to)` date range on
 *    `value_date` (or the matching reserved column for
 *    `due_date` / `scheduled_date`).
 *
 * On the IPC boundary the five push-down knobs are bundled into the
 * Rust `ExtraQueryFilters` struct so the Tauri command stays under the
 * `tauri-specta` 10-arg limit. The flat public API is preserved here.
 */
export async function queryByProperty(params: {
  key: string
  valueText?: string | undefined
  valueDate?: string | undefined
  operator?: string | undefined // 'eq', 'neq', 'lt', 'gt', 'lte', 'gte'
  cursor?: string | undefined
  limit?: SafeLimit | undefined
  spaceId?: string | null | undefined
  excludeParentId?: string | undefined
  contentNonEmpty?: boolean | undefined
  blockType?: string | undefined
  valueTextIn?: string[] | undefined
  valueDateRange?: [string, string] | undefined
  excludeTodoStates?: string[] | undefined
}): Promise<PageResponse<BlockRow>> {
  const hasExtra =
    params.excludeParentId !== undefined ||
    params.contentNonEmpty !== undefined ||
    params.blockType !== undefined ||
    params.valueTextIn !== undefined ||
    params.valueDateRange !== undefined ||
    params.excludeTodoStates !== undefined
  const extraFilters = hasExtra
    ? {
        excludeParentId: params.excludeParentId ?? null,
        contentNonEmpty: params.contentNonEmpty ?? null,
        blockType: params.blockType ?? null,
        valueTextIn: params.valueTextIn ?? null,
        valueDateRange: params.valueDateRange ?? null,
        excludeTodoStates: params.excludeTodoStates ?? null,
      }
    : null
  return unwrap(
    await commands.queryByProperty(
      params.key,
      params.valueText ?? null,
      params.valueDate ?? null,
      params.operator ?? null,
      params.cursor ?? null,
      params.limit ?? null,
      toSpaceScope(params.spaceId),
      extraFilters,
    ),
  )
}

/** Per-call property predicate accepted by [`filteredBlocksQuery`].
 *
 * Mirrors the Rust [`PropertyFilter`] struct shape (one EXISTS subquery
 * per filter). Distinct from the parser-side `PropertyFilter` in
 * `query-utils.ts` (which carries `{ key, value, operator }` for the
 * legacy fan-out shape) — the latter is translated into this shape at
 * the IPC boundary by `useQueryExecution`.
 */
export interface FilteredBlocksPropertyFilter {
  key: string
  valueText?: string | null
  valueTextIn?: string[]
  valueDate?: string | null
  valueDateRange?: [string, string] | null
  /** 'eq' | 'neq' | 'lt' | 'gt' | 'lte' | 'gte' (default: 'eq'). */
  operator?: string
}

/** Tag predicate accepted by [`filteredBlocksQuery`]. Mirrors the Rust
 *  [`TagFilterExpr`] struct.
 */
export interface FilteredBlocksTagFilter {
  tagIds?: string[]
  prefixes?: string[]
  /** 'and' for intersection, anything else (default 'or') for union. */
  mode?: string
  includeInherited?: boolean
}

/** PEND-35 Tier 2.10b — AND-intersect property + tag predicates in SQL.
 *
 * Replaces the legacy `useQueryExecution.fetchFilteredQuery` shape that
 * fanned out one `queryByProperty` / `queryByTags` IPC per sub-filter
 * (each capped at 200 rows) and intersected the resulting block-id sets
 * in JS (capped at 50 rows). Any AND-set member outside the top-200 of
 * any one sub-query was silently dropped — the load-bearing regression
 * this command fixes.
 *
 * Each `propertyFilters[i]` becomes one `EXISTS (SELECT 1 FROM
 * block_properties …)` subquery composed into the parent SQL; the AND
 * across filters is the structural conjunction of those EXISTS clauses
 * (no JS post-filter, no per-sub-query row cap). `tagFilters` follows
 * the same shape (one `EXISTS` over `block_tags` / `block_tag_refs`
 * UNION). The composed query honours the page `cursor` / `limit` so
 * pagination walks the post-intersection set.
 *
 * At least one of `propertyFilters` / `tagFilters` / `blockType` must
 * be supplied — empty inputs are rejected with `Validation` so a
 * misconfigured caller surfaces loudly rather than silently scanning
 * every active block.
 */
export async function filteredBlocksQuery(params: {
  propertyFilters?: FilteredBlocksPropertyFilter[]
  tagFilters?: FilteredBlocksTagFilter | undefined
  blockType?: string | undefined
  spaceId?: string | null | undefined
  cursor?: string | undefined
  limit?: SafeLimit | undefined
}): Promise<PageResponse<BlockRow>> {
  // Marshal property filters into the camelCase Rust struct shape on
  // the IPC boundary. `valueTextIn` defaults to `[]` (matches the
  // Rust `#[serde(default)]` on `Vec<String>`); empty arrays are
  // semantically equivalent to "no IN-set predicate".
  const marshalledProps = (params.propertyFilters ?? []).map((pf) => ({
    key: pf.key,
    valueText: pf.valueText ?? null,
    valueTextIn: pf.valueTextIn ?? [],
    valueDate: pf.valueDate ?? null,
    valueDateRange: pf.valueDateRange ?? null,
    operator: pf.operator ?? 'eq',
  }))
  const marshalledTags = params.tagFilters
    ? {
        tagIds: params.tagFilters.tagIds ?? [],
        prefixes: params.tagFilters.prefixes ?? [],
        mode: params.tagFilters.mode ?? 'or',
        includeInherited: params.tagFilters.includeInherited ?? false,
      }
    : null
  return unwrap(
    await commands.filteredBlocksQuery(
      // The bindings.ts type uses an inline shape for PropertyFilter;
      // the marshalled object is structurally compatible.
      marshalledProps as Parameters<typeof commands.filteredBlocksQuery>[0],
      marshalledTags as Parameters<typeof commands.filteredBlocksQuery>[1],
      params.blockType ?? null,
      toSpaceScope(params.spaceId),
      params.cursor ?? null,
      params.limit ?? null,
    ),
  )
}

// ---------------------------------------------------------------------------
// Undo / Redo commands
// ---------------------------------------------------------------------------

export interface OpRef {
  device_id: string
  seq: number
}

export interface UndoResult {
  reversed_op: OpRef
  reversed_op_type: string
  new_op_ref: OpRef
  new_op_type: string
  is_redo: boolean
}

/** Undo the Nth most-recent undoable op on a page. */
export async function undoPageOp(params: {
  pageId: string
  undoDepth: number
}): Promise<UndoResult> {
  return unwrap(await commands.undoPageOp(params.pageId, params.undoDepth))
}

/**
 * PEND-35 Tier 4.4 — Compute the size of the consecutive same-device,
 * within-window undo group starting at the Nth-most-recent undoable op
 * of a page.
 *
 * Replaces the FE's pre-existing growing-window `listPageHistory`
 * re-fetch (executed after every Ctrl+Z) with a single backend query.
 * The undo store calls this once per Ctrl+Z to know how many ops to
 * revert as a group; it then issues `undoPageOp` `groupSize` times.
 *
 * Semantics mirrored from the prior FE-side filter:
 *   - "Undoable" excludes ops whose `op_type` starts with `undo_` /
 *     `redo_` (those are reverse ops, never user-undoable).
 *   - `depth = 0` seeds at the most-recent undoable op for the page.
 *   - The group extends backward (older direction) one op at a time
 *     until either `device_id` differs or the gap exceeds `windowMs`.
 *
 * Returns >= 1 normally; returns 0 when the seed op doesn't exist
 * (depth exceeds the page's undoable-op count) — callers should
 * fall back to a single undo (groupSize = 1) in that case.
 */
export async function findUndoGroup(params: {
  pageId: string
  depth: number
  windowMs: number
}): Promise<number> {
  return unwrap(await commands.findUndoGroup(params.pageId, params.depth, params.windowMs))
}

/** Redo a previously undone op by reversing it again. */
export async function redoPageOp(params: {
  undoDeviceId: string
  undoSeq: number
}): Promise<UndoResult> {
  return unwrap(await commands.redoPageOp(params.undoDeviceId, params.undoSeq))
}

// ---------------------------------------------------------------------------
// Word-level diff for history display
// ---------------------------------------------------------------------------

/** Compute a word-level diff for an edit_block history entry. Returns null for non-edit ops. */
export async function computeEditDiff(params: {
  deviceId: string
  seq: number
}): Promise<DiffSpan[] | null> {
  return unwrap(await commands.computeEditDiff(params.deviceId, params.seq))
}

/**
 * Compute a word-level diff between a block's historical content (as of
 * `historicalSeq`) and its current live content. Powers the "Compared to
 * current" mode in the per-block history panel (PEND-17 Part B).
 *
 * Direction is `historical → current`, so `Insert` spans = text added
 * since the historical version (would be REMOVED on restore) and
 * `Delete` spans = text removed since the historical version (would be
 * RESTORED). Returns an empty array (or all-Equal spans) when the two
 * snapshots are byte-identical.
 *
 * Throws on a soft-deleted / purged block — the in-panel preview is
 * meaningless for trashed blocks.
 */
export async function computeBlockVsCurrentDiff(params: {
  blockId: string
  historicalCreatedAt: number
  historicalSeq: number
}): Promise<DiffSpan[]> {
  return unwrap(
    await commands.computeBlockVsCurrentDiff(
      params.blockId,
      params.historicalCreatedAt,
      params.historicalSeq,
    ),
  )
}

// ---------------------------------------------------------------------------
// Filtered backlink query commands
// ---------------------------------------------------------------------------

/** Query backlinks with composable filters, sort, and pagination.
 *
 * `spaceId` (FEAT-3 Phase 4) — when set, restricts the source set to
 * blocks whose owning page carries `space = <spaceId>`. `null` /
 * `undefined` leaves the result set unscoped (cross-space view).
 */
export async function queryBacklinksFiltered(params: {
  blockId: string
  filters?: BacklinkFilter[] | undefined
  sort?: BacklinkSort | undefined
  cursor?: string | undefined
  limit?: SafeLimit | undefined
  spaceId?: string | null | undefined
}): Promise<BacklinkQueryResponse> {
  return unwrap(
    await commands.queryBacklinksFiltered(
      params.blockId,
      params.filters ?? null,
      params.sort ?? null,
      params.cursor ?? null,
      params.limit ?? null,
      toSpaceScope(params.spaceId),
    ),
  )
}

/** Query backlinks grouped by source page, with filters and pagination.
 *
 * `spaceId` (FEAT-3 Phase 4) — when set, restricts the source set to
 * blocks whose owning page carries `space = <spaceId>`. `null` /
 * `undefined` leaves the result set unscoped.
 */
export async function listBacklinksGrouped(params: {
  blockId: string
  filters?: BacklinkFilter[] | undefined
  sort?: BacklinkSort | undefined
  cursor?: string | undefined
  limit?: SafeLimit | undefined
  spaceId?: string | null | undefined
}): Promise<GroupedBacklinkResponse> {
  return unwrap(
    await commands.listBacklinksGrouped(
      params.blockId,
      params.filters ?? null,
      params.sort ?? null,
      params.cursor ?? null,
      params.limit ?? null,
      toSpaceScope(params.spaceId),
    ),
  )
}

/** Query unlinked references grouped by source page, with filters, sort, and pagination.
 *
 * `spaceId` (FEAT-3 Phase 4) — when set, restricts the candidate set
 * to blocks whose owning page carries `space = <spaceId>`. `null` /
 * `undefined` leaves the result set unscoped.
 */
export async function listUnlinkedReferences(params: {
  pageId: string
  filters?: BacklinkFilter[] | null | undefined
  sort?: BacklinkSort | null | undefined
  cursor?: string | null | undefined
  limit?: SafeLimit | null | undefined
  spaceId?: string | null | undefined
}): Promise<GroupedBacklinkResponse> {
  return unwrap(
    await commands.listUnlinkedReferences(
      params.pageId,
      params.filters ?? null,
      params.sort ?? null,
      params.cursor ?? null,
      params.limit ?? null,
      toSpaceScope(params.spaceId),
    ),
  )
}

/** List all distinct property keys currently in use. */
export async function listPropertyKeys(): Promise<string[]> {
  return unwrap(await commands.listPropertyKeys())
}

// ---------------------------------------------------------------------------
// Property definition commands
// ---------------------------------------------------------------------------

/** Create a new property definition. */
export async function createPropertyDef(params: {
  key: string
  valueType: string
  options?: string | null | undefined
}): Promise<PropertyDefinition> {
  return unwrap(
    await commands.createPropertyDef(params.key, params.valueType, params.options ?? null),
  )
}

/** Fetch a single property definition by key (PEND-35 Tier 2.6).
 *
 * Returns the row, or `null` when no definition exists for `key`.
 * Replaces the pattern of calling `listPropertyDefs()` (which paginates
 * the entire vocabulary) just to read one well-known key — boot
 * recovery's `priority` lookup and the per-block property-editor popover
 * each used to ship the full def list to the renderer for a one-row
 * read.
 */
export async function getPropertyDef(key: string): Promise<PropertyDefinition | null> {
  return unwrap(await commands.getPropertyDef(key))
}

/** List all property definitions, paginated (M-85).
 *
 * Returns the canonical [`PageResponse`] envelope (`items`,
 * `next_cursor`, `has_more`). Single-page consumers (the typical case
 * for property-defs picker UIs — the seeded vocabulary fits well under
 * a single page) destructure `.items` and ignore the cursor. Callers
 * that genuinely walk every page must thread `next_cursor` back via
 * `cursor` until `has_more === false`.
 *
 * Pre-M-85: `listPropertyDefs(): Promise<PropertyDefinition[]>`.
 */
export async function listPropertyDefs(opts?: {
  cursor?: string | null | undefined
  limit?: SafeLimit | null | undefined
}): Promise<PageResponse<PropertyDefinition>> {
  return unwrap(await commands.listPropertyDefs(opts?.cursor ?? null, opts?.limit ?? null))
}

/** Update the options JSON for a select-type property definition. */
export async function updatePropertyDefOptions(
  key: string,
  options: string,
): Promise<PropertyDefinition> {
  return unwrap(await commands.updatePropertyDefOptions(key, options))
}

/** Delete a property definition by key. */
export async function deletePropertyDef(key: string): Promise<void> {
  unwrap(await commands.deletePropertyDef(key))
}

// ---------------------------------------------------------------------------
// Sync / Peer-ref commands
// ---------------------------------------------------------------------------
// NOTE: Only peer_refs CRUD exists on the backend so far. Full sync protocol
// commands (startPairing, startSync, etc.) will be added when the backend
// implements them.

/** Peer reference row returned by `list_peer_refs` / `get_peer_ref`.
 *  Fields match the Rust `PeerRef` struct (see src-tauri/src/peer_refs.rs). */
export interface PeerRefRow {
  peer_id: string
  last_hash: string | null
  last_sent_hash: string | null
  /** Epoch milliseconds (UTC), or null if never synced. #109 Phase 2: was an ISO string. */
  synced_at: number | null
  reset_count: number
  /** Epoch milliseconds (UTC), or null if never reset. #109 Phase 2: was an ISO string. */
  last_reset_at: number | null
  cert_hash: string | null
  device_name: string | null
  last_address: string | null
}

/** List all known peer references. */
export async function listPeerRefs(): Promise<PeerRefRow[]> {
  return unwrap(await commands.listPeerRefs())
}

/** Fetch a single peer reference by ID, or null if not found. */
export async function getPeerRef(peerId: string): Promise<PeerRefRow | null> {
  return unwrap(await commands.getPeerRef(peerId))
}

/** Delete a peer reference by ID. */
export async function deletePeerRef(peerId: string): Promise<void> {
  unwrap(await commands.deletePeerRef(peerId))
}

/** Update the display name for a paired peer. Pass null to clear. */
export async function updatePeerName(peerId: string, deviceName: string | null): Promise<void> {
  unwrap(await commands.updatePeerName(peerId, deviceName))
}

/** Manually set a peer's network address (host:port) for direct connection. */
export async function setPeerAddress(peerId: string, address: string): Promise<void> {
  unwrap(await commands.setPeerAddress(peerId, address))
}

/** Get the local device ID. */
export async function getDeviceId(): Promise<string> {
  return unwrap(await commands.getDeviceId())
}

// ---------------------------------------------------------------------------
// Sync protocol commands
// ---------------------------------------------------------------------------

export interface DeviceHead {
  device_id: string
  seq: number
  hash: string
}

export interface SyncSessionInfo {
  state: string
  local_device_id: string
  remote_device_id: string
  ops_received: number
  ops_sent: number
}

/** Start the pairing flow — returns a passphrase and QR SVG.
 *
 * M-34: the QR carries only the passphrase. mDNS owns discovery and
 * address resolution end-to-end, so there is no `host`/`port` field on
 * the returned payload.
 */
export async function startPairing(): Promise<{
  passphrase: string
  qr_svg: string
}> {
  return unwrap(await commands.startPairing())
}

/** Confirm a pairing with the given passphrase and remote device ID. */
export async function confirmPairing(passphrase: string, remoteDeviceId: string): Promise<void> {
  unwrap(await commands.confirmPairing(passphrase, remoteDeviceId))
}

/** Cancel an in-progress pairing. */
export async function cancelPairing(): Promise<void> {
  unwrap(await commands.cancelPairing())
}

/** Start a sync session with a known peer. */
export async function startSync(
  peerId: string,
  onProgress?: (update: SyncProgressUpdate) => void,
): Promise<SyncSessionInfo> {
  const channel = new Channel<SyncProgressUpdate>()
  if (onProgress) channel.onmessage = onProgress
  return unwrap(await commands.startSync(peerId, channel))
}

/** Cancel an in-progress sync session. */
export async function cancelSync(): Promise<void> {
  unwrap(await commands.cancelSync())
}

// ---------------------------------------------------------------------------
// Page alias commands (#598)
// ---------------------------------------------------------------------------

/** Set the complete list of aliases for a page (replaces existing). */
export async function setPageAliases(pageId: string, aliases: string[]): Promise<string[]> {
  return unwrap(await commands.setPageAliases(pageId, aliases))
}

/** Get all aliases for a page. */
export async function getPageAliases(pageId: string): Promise<string[]> {
  return unwrap(await commands.getPageAliases(pageId))
}

/**
 * Resolve a page by one of its aliases. Returns page ID + title, or null.
 *
 * `spaceId` (PEND-35 Tier 1.2) — when set, restricts the match to
 * aliases pointing at pages whose `space` property equals `spaceId`.
 * Mirrors the param-object shape used by `listPageAliasesByPrefix`
 * directly below. Pass `null` / `undefined` to leave the resolve
 * unscoped (cross-space) for callers (e.g. agent / MCP tools) that
 * span every space.
 */
export async function resolvePageByAlias(params: {
  alias: string
  spaceId?: string | null | undefined
}): Promise<[string, string | null] | null> {
  return unwrap(await commands.resolvePageByAlias(params.alias, toSpaceScope(params.spaceId)))
}

/**
 * List page aliases whose alias starts with the given prefix, ordered
 * shortest-alias first, then alphabetical. Bounded server-side at 50.
 *
 * Used by the [[ picker for progressive alias filtering (PEND-34). The
 * exact-match `resolvePageByAlias` is still used by SearchPanel /
 * PageBrowser (out of scope here — see PEND-34 follow-ups).
 *
 * `spaceId` (PEND-34 Q3) — when set, restricts matches to aliases
 * pointing at pages whose `space` property equals `spaceId`. Pass
 * `null`/`undefined` to leave the result set unscoped (cross-space).
 */
export async function listPageAliasesByPrefix(params: {
  prefix: string
  limit?: SafeLimit | undefined
  spaceId?: string | null | undefined
}): Promise<Array<[string, string, string | null]>> {
  return unwrap(
    await commands.listPageAliasesByPrefix(
      params.prefix,
      params.limit ?? null,
      toSpaceScope(params.spaceId),
    ),
  )
}

// ---------------------------------------------------------------------------
// Markdown export (#519)
// ---------------------------------------------------------------------------

/** Export a page as Markdown with human-readable tag/page references. */
export async function exportPageMarkdown(pageId: string): Promise<string> {
  return unwrap(await commands.exportPageMarkdown(pageId))
}

/**
 * List every page in `spaceId` as `{ id, content }`.  No pagination, no
 * clamp — bounded by the space's intrinsic page count.  Use when the
 * caller genuinely needs every page (markdown export, graph rendering);
 * use `listBlocks` for paginated list views.
 *
 * `tagIds`, when non-empty, restricts the result to pages carrying at
 * least one of those tags via the direct `block_tags` table.  Inherited
 * tags are intentionally excluded — mirrors the GraphView semantics.
 */
export async function listAllPagesInSpace(
  spaceId: string,
  tagIds: string[] | null = null,
): Promise<PageHeading[]> {
  return unwrap(await commands.listAllPagesInSpace(spaceId, tagIds))
}

/**
 * Return the IDs of every page in `spaceId` whose `template` property
 * is set to `'true'`.  No pagination, no clamp — templates are a
 * small bounded set by convention.  Used by the graph view to flag
 * template pages with a visual marker.
 */
export async function listTemplatePageIdsInSpace(spaceId: string): Promise<string[]> {
  return unwrap(await commands.listTemplatePageIdsInSpace(spaceId))
}

/**
 * List every tag in `spaceId` as `TagCacheRow[]`.  No pagination, no
 * clamp — bounded by the space's intrinsic tag count.  Use when the
 * caller genuinely needs every tag (the tag-management list view);
 * use `listTagsByPrefix` for typeahead pickers.
 *
 * limit-clamp-followup — replaces `TagList.tsx`'s
 * `listTagsByPrefix({ prefix: '', limit: 500 })` call, which the
 * backend silently clamped to 200 via `MAX_TAGS_PREFIX`.  Tags are
 * space-scoped via `block_properties(key='space')` on the tag block
 * itself (see `commands/tags.rs` cross-space guard).
 */
export async function listAllTagsInSpace(spaceId: string): Promise<TagCacheRow[]> {
  return unwrap(await commands.listAllTagsInSpace(spaceId))
}

/**
 * Load every active descendant under `rootBlockId` in `spaceId` — a
 * single SELECT against the materializer-maintained `page_id` index.
 * Replaces the FE-side recursive `listBlocks` walk that silently
 * clamped each parent to 100 children.
 *
 * Excludes the root block and soft-deleted descendants.  Result order
 * is not load-bearing — `buildFlatTree` regroups by `parent_id`.
 *
 * #1258 — returns the full {@link PageSubtree} (not a bare array) so the
 * caller can read `truncated` / `total`: when a page exceeds the backend
 * `PAGE_SUBTREE_MAX_BLOCKS` cap, `blocks` is capped but `total` carries
 * the true descendant count, letting the UI surface a non-blocking
 * "showing the first N of M" notice instead of silently dropping blocks.
 */
export async function loadPageSubtree(rootBlockId: string, spaceId: string): Promise<PageSubtree> {
  return unwrap(await commands.loadPageSubtree(rootBlockId, spaceId))
}

// ---------------------------------------------------------------------------
// Attachment commands (F-7)
// ---------------------------------------------------------------------------

export interface AttachmentRow {
  id: string
  block_id: string
  filename: string
  mime_type: string
  size_bytes: number
  fs_path: string
  /** Epoch-ms (attachments.created_at is INTEGER since migration 0081). */
  created_at: number
}

/** List all attachments for a block. */
export async function listAttachments(blockId: string): Promise<AttachmentRow[]> {
  return unwrap(await commands.listAttachments(blockId))
}

/**
 * Batch-fetch full attachment lists for many blocks in one IPC.
 *
 * Returns a record mapping block_id → AttachmentRow[]. Block IDs absent
 * from the record have either 0 attachments or are not in the database;
 * callers should default missing keys to `[]`. Counts are derivable as
 * `result[id].length` — PEND-35 Tier 2.7a folded the separate count
 * batch (`get_batch_attachment_counts`) into this one.
 *
 * MAINT-131 — replaces N per-block `listAttachments` IPCs for both the
 * SortableBlock paperclip badge and the StaticBlock inline-image render
 * path with a single batched query mounted at the BlockTree level.
 */
export async function getBatchAttachments(
  blockIds: string[],
): Promise<Record<string, AttachmentRow[]>> {
  return unwrap(await commands.listAttachmentsBatch(blockIds))
}

/** Add an attachment to a block. */
export async function addAttachment(params: {
  blockId: string
  filename: string
  mimeType: string
  sizeBytes: number
  fsPath: string
}): Promise<AttachmentRow> {
  return unwrap(
    await commands.addAttachment(
      params.blockId,
      params.filename,
      params.mimeType,
      params.sizeBytes,
      params.fsPath,
    ),
  )
}

/**
 * Add an attachment by passing the file's raw bytes over IPC (PEND-76 F2).
 * The backend is the sole writer — it persists the bytes under
 * `$APPDATA/attachments/` and records the row. `bytes` is the file content
 * (e.g. from `new Uint8Array(await file.arrayBuffer())`).
 */
export async function addAttachmentWithBytes(params: {
  blockId: string
  filename: string
  mimeType: string
  bytes: Uint8Array
}): Promise<AttachmentRow> {
  return unwrap(
    await commands.addAttachmentWithBytes(
      params.blockId,
      params.filename,
      params.mimeType,
      Array.from(params.bytes),
    ),
  )
}

/** Read an attachment's raw bytes by ID (PEND-76 F2). */
export async function readAttachment(attachmentId: string): Promise<Uint8Array> {
  return Uint8Array.from(unwrap(await commands.readAttachment(attachmentId)))
}

/** Delete an attachment by ID. */
export async function deleteAttachment(attachmentId: string): Promise<void> {
  unwrap(await commands.deleteAttachment(attachmentId))
}

/** Rename an attachment by ID. */
export async function renameAttachment(params: {
  attachmentId: string
  newFilename: string
}): Promise<void> {
  unwrap(await commands.renameAttachment(params.attachmentId, params.newFilename))
}

// ---------------------------------------------------------------------------
// Markdown import (#660)
// ---------------------------------------------------------------------------

export interface ImportResult {
  page_title: string
  blocks_created: number
  properties_set: number
  warnings: string[]
}

/**
 * Import a Logseq/Markdown file. Creates a page from the filename and
 * blocks from content.
 *
 * `spaceId` (PEND-35 Tier 1.1) — required. The created page is stamped
 * with `space = ?spaceId` inside the same backend transaction as the
 * `CreateBlock` op, so an imported page can never exist without its
 * space property. Callers must pass the active space's ULID; the
 * import button must stay disabled while the space store is not
 * bootstrapped (no active space) so this never receives an empty
 * string.
 *
 * `onProgress` (#128, PEND-38 / PEND-06 Tier 3) — optional. When
 * supplied, the backend streams per-block progress over a
 * `Channel<ImportProgressUpdate>`: one `started` event, one `progress`
 * per block, then one `complete` after the import transaction commits.
 * A failed import emits `started` (+ any `progress`) but no `complete`,
 * so a consumer that never sees `complete` should treat it as failed.
 * The channel is always created (mirroring `startSync`) even when no
 * callback is passed; events are simply discarded.
 */
export async function importMarkdown(
  content: string,
  filename: string | undefined,
  spaceId: string,
  onProgress?: (update: ImportProgressUpdate) => void,
): Promise<ImportResult> {
  const channel = new Channel<ImportProgressUpdate>()
  if (onProgress) channel.onmessage = onProgress
  return unwrap(await commands.importMarkdown(content, filename ?? null, spaceId, channel))
}

// ---------------------------------------------------------------------------
// Draft autosave commands (F-17)
// ---------------------------------------------------------------------------

/** Save (upsert) a draft for a block. Called every ~2s during active typing. */
export async function saveDraft(blockId: string, content: string): Promise<void> {
  unwrap(await commands.saveDraft(blockId, content))
}

/** Flush a draft: write an edit_block op and delete the draft row. Called on blur/unmount. */
export async function flushDraft(blockId: string): Promise<void> {
  unwrap(await commands.flushDraft(blockId))
}

/**
 * Flush every pending draft in a single `BEGIN IMMEDIATE` tx (PEND-35
 * Tier 2.12). Used by `useAppBootRecovery` to consolidate boot recovery
 * into one IPC instead of N fire-and-forget per-draft round-trips. The
 * backend semantics are all-or-nothing: a single draft failure rolls
 * back the whole batch — see `flush_all_drafts_inner`'s doc comment.
 */
export async function flushAllDrafts(): Promise<FlushAllDraftsResult> {
  return unwrap(await commands.flushAllDrafts())
}

/**
 * #1255: read the boot-recovery status. Used by `useRecoveryStatus` to
 * backfill the degraded-boot signal on mount — boot runs (and emits
 * `recovery:degraded`) before the webview registers its listener, so the
 * live event can be missed. `degraded === true` means the C-2b op-log
 * replay failed and the materialized view may be incomplete/stale (the op
 * log is canonical — nothing is lost). Mirrors the `useDeepLinkRouter` +
 * `getCurrentDeepLink()` "emit + query-on-mount backfill" shape.
 */
export async function getRecoveryStatus(): Promise<RecoveryStatus> {
  return unwrap(await commands.getRecoveryStatus())
}

/** Delete a draft for a block (e.g. after a successful normal save). */
export async function deleteDraft(blockId: string): Promise<void> {
  unwrap(await commands.deleteDraft(blockId))
}

/** List all drafts, ordered by updated_at ascending. */
export async function listDrafts(): Promise<Draft[]> {
  return unwrap(await commands.listDrafts())
}

// ---------------------------------------------------------------------------
// Frontend logging (F-19)
// ---------------------------------------------------------------------------

/** Log a frontend message to the backend's daily-rolling log file. Fire-and-forget. */
export async function logFrontend(
  level: string,
  module: string,
  message: string,
  stack?: string | null,
  context?: string | null,
  data?: string | null,
): Promise<void> {
  unwrap(
    await commands.logFrontend(
      level,
      module,
      message,
      stack ?? null,
      context ?? null,
      data ?? null,
    ),
  )
}

// Wire the IPC log call into the logger's backend-transport seam (#761). This
// import-time side effect replaces the old direct `logger.ts -> tauri.ts`
// import that formed an import cycle; `logger.ts` now depends only on the leaf
// `logger-transport.ts`.
setLogBackendSink(logFrontend)

/** Return the path to the logs directory. */
export async function getLogDir(): Promise<string> {
  return unwrap(await commands.getLogDir())
}

// ---------------------------------------------------------------------------
// Op Log Compaction (F-20)
// ---------------------------------------------------------------------------

export interface CompactionStatus {
  total_ops: number
  /** Epoch-ms (max op_log.created_at, INTEGER since migration 0079). */
  oldest_op_date: number | null
  eligible_ops: number
  retention_days: number
}

export interface CompactionResult {
  snapshot_id: string | null
  ops_deleted: number
}

/** Get current op log compaction status and stats. */
export async function getCompactionStatus(): Promise<CompactionStatus> {
  return unwrap(await commands.getCompactionStatus())
}

/** Compact the op log by removing ops older than retentionDays. */
export async function compactOpLog(retentionDays: number): Promise<CompactionResult> {
  return unwrap(await commands.compactOpLogCmd(retentionDays))
}

// ---------------------------------------------------------------------------
// Link metadata (UX-165)
// ---------------------------------------------------------------------------

export interface LinkMetadata {
  url: string
  title: string | null
  favicon_url: string | null
  description: string | null
  /** Milliseconds since the UNIX epoch (UTC). #109 Phase 2: was an RFC 3339 string. */
  fetched_at: number
  auth_required: boolean
  /**
   * MAINT-213 (PEND-24 M4 follow-up): `true` when the most recent
   * fetch saw a terminal "gone" status (HTTP 404 or 410). Distinct
   * from `auth_required` (401/403, sign-in card) and from transient
   * 5xx (both flags `false` plus `title === null`). Optional so a
   * legacy serialized blob without the field still deserializes.
   */
  not_found?: boolean
}

/** Fetch and cache link metadata (triggers HTTP fetch if not cached). */
export async function fetchLinkMetadata(url: string): Promise<LinkMetadata> {
  return unwrap(await commands.fetchLinkMetadata(url))
}

/** Get cached link metadata (no network fetch). */
export async function getLinkMetadata(url: string): Promise<LinkMetadata | null> {
  return unwrap(await commands.getLinkMetadata(url))
}

// ---------------------------------------------------------------------------
// Bug report (FEAT-5)
// ---------------------------------------------------------------------------

export interface BugReport {
  app_version: string
  os: string
  arch: string
  device_id: string
  recent_errors: string[]
}

export interface LogFileEntry {
  name: string
  contents: string
}

/**
 * Gather app version, OS/arch, device ID and a tail of recent error/warn
 * lines from today's log for pre-filling a bug report.
 *
 * #609: `recent_errors` arrives ALREADY redacted — the backend runs the
 * tail through the same pipeline as the redacted ZIP export, because the
 * lines are embedded in the prefilled public GitHub issue body.
 */
export async function collectBugReportMetadata(): Promise<BugReport> {
  return unwrap(await commands.collectBugReportMetadata())
}

/**
 * Enumerate rolled log files within the last 7 days. When `redact=true`,
 * home paths are replaced with `~`, the device ID is blanked, and long
 * lines are truncated.
 */
export async function readLogsForReport(redact: boolean): Promise<LogFileEntry[]> {
  return unwrap(await commands.readLogsForReport(redact))
}

// ---------------------------------------------------------------------------
// Spaces (FEAT-3 Phase 1)
// ---------------------------------------------------------------------------

/**
 * List every space (id + display name) alphabetical by name. Used by the
 * sidebar `SpaceSwitcher` + the Zustand `useSpaceStore`.
 */
export async function listSpaces(): Promise<SpaceRow[]> {
  return unwrap(await commands.listSpaces())
}

/**
 * Create a new page block and atomically assign it to `spaceId`.
 *
 * FEAT-3 Phase 2 — the backend wraps both the `CreateBlock` op and the
 * `SetProperty(space = <spaceId>)` op in a single transaction so a page
 * never exists without its space property. Callers that create
 * top-level pages (PageBrowser t('pageBrowser.newPage'), App new-page actions, the
 * link-picker create-new-page affordance) must route through this
 * command rather than `createBlock({ blockType: 'page' })` — the latter
 * leaves the new page unscoped and violates the "nothing outside of
 * spaces" invariant.
 *
 * Returns the new page's ULID.
 */
export async function createPageInSpace(params: {
  parentId?: string | null | undefined
  content: string
  spaceId: string
}): Promise<string> {
  return unwrap(
    await commands.createPageInSpace(params.parentId ?? null, params.content, params.spaceId),
  )
}

/**
 * Create a new space (a top-level page block flagged
 * `is_space = 'true'`).
 *
 * FEAT-3 Phase 6 — the backend wraps the `CreateBlock` op, the
 * `SetProperty(is_space = "true")` op, and the optional
 * `SetProperty(accent_color = …)` op in a single transaction so a
 * partial failure never leaves a half-created space (a page block
 * without its `is_space` flag) in the op log.
 *
 * `accentColor` accepts the palette tokens consumed by FEAT-3p10
 * (e.g. `accent-violet`, `accent-blue`, …). Pass `null` / `undefined`
 * to skip the accent-color property entirely.
 *
 * Returns the new space's ULID.
 */
export async function createSpace(params: {
  name: string
  accentColor?: string | null | undefined
}): Promise<string> {
  return unwrap(await commands.createSpace(params.name, params.accentColor ?? null))
}

// ---------------------------------------------------------------------------
// Quick capture (FEAT-12)
// ---------------------------------------------------------------------------

// FEAT-12: the global-shortcut JS API below is gated on `isMobilePlatform()`
// (a CAPABILITY check, exported from `./platform`) rather than `useIsMobile`
// (a width breakpoint). `tauri-plugin-global-shortcut` is desktop-only — its
// native dependency (`global-hotkey` crate) compiles only on
// Linux/macOS/Windows, and the Rust-side registration in
// `src-tauri/src/lib.rs` is gated behind `#[cfg(desktop)]`. Calling the
// underlying `invoke('plugin:…')` on Android / iOS would throw at runtime, so
// we guard at the wrapper boundary and return a no-op promise on mobile.

/**
 * FEAT-12 + FEAT-3p5: drop a single content block onto today's journal
 * page in the active space.
 *
 * Resolves today's journal page in `spaceId` on the backend (creating it
 * if missing) and appends a content block as a child. Used by the
 * global-shortcut quick-capture flow (`QuickCaptureDialog` →
 * `quickCaptureBlock`). The space scoping is required: every journal
 * page belongs to a space, so two devices in different spaces capture
 * into their own daily notes without colliding.
 */
export async function quickCaptureBlock(content: string, spaceId: string): Promise<BlockRow> {
  return unwrap(await commands.quickCaptureBlock(content, spaceId))
}

/**
 * FEAT-12: register a global hotkey via `@tauri-apps/plugin-global-shortcut`.
 *
 * `accelerator` is the chord string (`'CommandOrControl+Alt+N'`) that the
 * plugin recognises. `callback` fires once per press (we filter on
 * `state === 'Pressed'` so users don't get double-fires on key release).
 *
 * **Desktop-only** — on mobile this resolves immediately without
 * registering anything. The plugin's underlying `global-hotkey` crate
 * does not compile for Android / iOS targets, and registration is
 * `#[cfg(desktop)]`-gated in `src-tauri/src/lib.rs`. Throws on the
 * desktop side if the chord conflicts with another app's binding —
 * callers should surface that as a user-visible toast.
 */
export async function registerGlobalShortcut(
  accelerator: string,
  callback: () => void,
): Promise<void> {
  if (isMobilePlatform()) return
  const { register } = await import('@tauri-apps/plugin-global-shortcut')
  await register(accelerator, (event) => {
    // The plugin emits both `Pressed` and `Released` — fire the user
    // callback once per logical activation only.
    if (event.state === 'Pressed') callback()
  })
}

/**
 * FEAT-12: unregister a previously-registered global hotkey.
 *
 * Desktop-only; a no-op on mobile (matches `registerGlobalShortcut`).
 * Safe to call when the chord was never registered — the underlying
 * plugin throws in that case, which we let propagate so callers can
 * decide whether to log or swallow.
 */
export async function unregisterGlobalShortcut(accelerator: string): Promise<void> {
  if (isMobilePlatform()) return
  const { unregister } = await import('@tauri-apps/plugin-global-shortcut')
  await unregister(accelerator)
}

/**
 * FEAT-12: probe whether `accelerator` is currently registered by *this*
 * application. Returns `false` for both "not registered by us" and
 * "registered by another app" cases — the plugin can't distinguish OS-
 * level conflicts from a clean unbound state.
 *
 * Desktop-only; resolves to `false` on mobile.
 */
export async function isGlobalShortcutRegistered(accelerator: string): Promise<boolean> {
  if (isMobilePlatform()) return false
  const { isRegistered } = await import('@tauri-apps/plugin-global-shortcut')
  return isRegistered(accelerator)
}

// ---------------------------------------------------------------------------
// Autostart (FEAT-13) — launch-on-login support
// ---------------------------------------------------------------------------
//
// Thin wrappers around `@tauri-apps/plugin-autostart`'s three exports
// (`enable`, `disable`, `isEnabled`).  Desktop-only — the Rust side
// gates registration with `#[cfg(desktop)]` (see lib.rs FEAT-13 block),
// so on Android / iOS the underlying IPC will reject with "command not
// found".  Each wrapper uses a dynamic `import(...)` (matching the
// `clipboard.ts` / `relaunch-app.ts` pattern) so a plain-browser dev
// session without `__TAURI_INTERNALS__` can still resolve the module
// and surface a clean error to the caller's catch block (no module-load
// crash at app boot).
//
// Errors are propagated to the caller — the Settings UI uses the
// rejection both to (a) hide the toggle row when the plugin / IPC is
// unavailable and (b) surface a `toast.error` when a user-initiated
// enable / disable round-trip fails.

/**
 * Return whether Agaric is currently registered to launch on login.
 *
 * Rejects when the plugin is unavailable (mobile build, browser dev
 * fallback, IPC denied).  Callers that need a tri-state (enabled /
 * disabled / unavailable) view should treat the rejection as the third
 * state — see `SettingsView`'s general-tab autostart row.
 */
export async function isAutostartEnabled(): Promise<boolean> {
  const { isEnabled } = await import('@tauri-apps/plugin-autostart')
  return isEnabled()
}

/**
 * Register Agaric to launch when the user signs into their computer.
 *
 * Rejects when the plugin is unavailable; the `SettingsView` toggle
 * surfaces the failure via `toast.error(t('settings.autostart.toggleFailed'))`
 * and reverts the optimistic UI update.
 */
export async function enableAutostart(): Promise<void> {
  try {
    const { enable } = await import('@tauri-apps/plugin-autostart')
    await enable()
  } catch (err) {
    logger.warn('autostart', 'enable() failed or plugin unavailable', undefined, err)
    throw err
  }
}

/**
 * Unregister Agaric from launching at login.
 *
 * Same error semantics as `enableAutostart` — the rejection is the
 * caller's signal to revert its optimistic UI update and surface
 * `t('settings.autostart.toggleFailed')`.
 */
export async function disableAutostart(): Promise<void> {
  try {
    const { disable } = await import('@tauri-apps/plugin-autostart')
    await disable()
  } catch (err) {
    logger.warn('autostart', 'disable() failed or plugin unavailable', undefined, err)
    throw err
  }
}

// ---------------------------------------------------------------------------
// Deep-link plugin wrappers (FEAT-10)
// ---------------------------------------------------------------------------
//
// `@tauri-apps/plugin-deep-link` exposes `getCurrent()` which returns the
// URL(s) the OS used to launch the app (Linux / Windows / Android), or
// `null` when the app was started normally.  Used by `useDeepLinkRouter`
// on mount to backfill any deep-link the listener missed before
// registration completed (Linux / Windows deliver the URL as a CLI arg
// before the React tree mounts).  Dynamic-import keeps a plain-browser
// dev session without `__TAURI_INTERNALS__` resolving cleanly.

/**
 * Return the URL(s) the OS used to open Agaric, or `null` if the app
 * was launched normally (no deep link).  Resolves to `null` when the
 * plugin is unavailable so callers can treat "no current URL" and
 * "plugin missing" the same way (the listener still fires on
 * subsequent activations).
 */
export async function getCurrentDeepLink(): Promise<string[] | null> {
  try {
    const { getCurrent } = await import('@tauri-apps/plugin-deep-link')
    return await getCurrent()
  } catch (err) {
    logger.warn('deeplink', 'getCurrent() failed or plugin unavailable', undefined, err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Window title (FEAT-3p10) — visual-identity surface
// ---------------------------------------------------------------------------
//
// Wrapper around `@tauri-apps/api/window`'s
// `getCurrentWindow().setTitle(title)`. Used by the App-level effect
// that runs on every space change to re-stamp the OS window title as
// `"<SpaceName> · Agaric"` so the user gets a glance-able cue from the
// taskbar, the OS notification centre, and the macOS window menu.
//
// No-op fallback for non-Tauri runtimes (vitest jsdom, storybook,
// plain-browser dev sessions) so callers don't need to gate every
// `setWindowTitle(...)` call on `__TAURI_INTERNALS__` themselves. The
// dynamic import + try/catch matches the `getCurrentDeepLink` /
// `enableAutostart` pattern.

/**
 * Set the OS window title to `title`. No-op when the Tauri window
 * plugin is unavailable (jsdom, storybook, browser dev fallback).
 *
 * Failures are logged at warn level via the shared logger and
 * swallowed — a stale window title is not user-fatal and the next
 * space switch will retry.
 */
export async function setWindowTitle(title: string): Promise<void> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().setTitle(title)
  } catch (err) {
    logger.warn('window', 'setTitle() failed or window plugin unavailable', { title }, err)
  }
}
