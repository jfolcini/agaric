import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type {
  BlockRow,
  CreateBlockSpec,
  DateRange,
  DeleteResponse,
  MoveResponse,
  PageResponse,
  PurgeResponse,
  RestoreResponse,
  SpaceScope,
  WithOps,
} from '@/lib/bindings'
import { PAGINATION_LIMIT } from '@/lib/constants'
import type { SafeLimit } from '@/lib/safe-limit'
import { toSpaceScope, requireActiveScope } from '@/lib/tauri/_shared'

/** Create a new block. Returns the created block with its generated ID.
 *
 * / H-3a — when `blockType === 'page'`, `spaceId` is REQUIRED.
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
  /**
   * #2849 PR2 — optional client-generated ULID for optimistic create. When
   * supplied it MUST be a well-formed ULID (see `newBlockId`): the backend uses
   * it verbatim and rejects a malformed or already-existing id. Omit to let the
   * backend mint a server id (all legacy callers).
   */
  blockId?: string | undefined
}): Promise<WithOps<BlockRow>> {
  return unwrap(
    await commands.createBlock(
      params.blockType,
      params.content,
      params.parentId ?? null,
      params.index ?? null,
      toSpaceScope(params.spaceId),
      params.blockId ?? null,
    ),
  )
}

/**
 * Atomically create N blocks (with optional per-block
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

/** Edit a block's text content.
 *
 * #2468: the response carries the appended op ref(s) (`WithOps`) so callers
 * can seed the ref-addressed undo stack (`useUndoStore.onNewAction`).
 */
export async function editBlock(blockId: string, toText: string): Promise<WithOps<BlockRow>> {
  return unwrap(await commands.editBlock(blockId, toText))
}

/** Soft-delete a block (cascade to descendants). #2468: carries `op_refs`. */
export async function deleteBlock(blockId: string): Promise<WithOps<DeleteResponse>> {
  return unwrap(await commands.deleteBlock(blockId))
}

/**
 * Batch soft-delete a list of blocks (cascade to
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
 * Are coalesced — the FE no longer needs the ancestor
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
 * #81 / move N blocks to a target space in a single IPC.
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

/**
 * Restore a list of soft-deleted blocks in a single IPC.
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
 * Permanently purge a list of soft-deleted blocks in a
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
 * Backend cap on the `block_ids` batch accepted by `restore_blocks_by_ids`
 * / `purge_blocks_by_ids` (`MAX_BATCH_BLOCK_IDS` in
 * `src-tauri/src/commands/mod.rs`). Mirrored here so
 * {@link restoreAllDeletedInSpace} / {@link purgeAllDeletedInSpace} can
 * chunk an arbitrarily large trash into backend-accepted batches instead
 * of surfacing `AppError::Validation` for a busy trash.
 */
const MAX_TRASH_BATCH_IDS = 1000

/**
 * Collect every trash-root id belonging to `spaceId` by walking
 * `listTrash`'s cursor chain to completion — independent of whatever page
 * / cursor position the caller's own UI list happens to be showing.
 * Shared by {@link restoreAllDeletedInSpace} and
 * {@link purgeAllDeletedInSpace}.
 */
async function collectAllTrashRootIds(spaceId: string): Promise<string[]> {
  const ids: string[] = []
  let cursor: string | undefined
  for (;;) {
    const page = await listTrash({
      ...(cursor != null && { cursor }),
      limit: PAGINATION_LIMIT,
      spaceId,
    })
    ids.push(...page.items.map((b) => b.id))
    if (!page.has_more || page.next_cursor == null) break
    cursor = page.next_cursor
  }
  return ids
}

/**
 * Restore every soft-deleted block in `spaceId`.
 *
 * #2544 — the backend's `restore_all_deleted` command is intentionally
 * NOT called here: it takes no `space_id` and would resurrect trashed
 * blocks across EVERY space, not just the one the Trash view displays
 * (and the one its confirmation dialog counted). Instead this drains the
 * already space-scoped `listTrash` cursor chain for `spaceId` (mirroring
 * the "ignore the frontend's own load-more frontier, act on everything in
 * trash" semantics `purge_all_deleted` used to provide, just space-scoped)
 * and hands the resulting root ids to `restoreBlocksByIds` — the same
 * space-safe path the per-row and multi-select restore actions already
 * use — chunked to the backend's batch-size cap.
 */
export async function restoreAllDeletedInSpace(spaceId: string): Promise<BulkTrashResponse> {
  const ids = await collectAllTrashRootIds(spaceId)
  let affectedCount = 0
  for (let i = 0; i < ids.length; i += MAX_TRASH_BATCH_IDS) {
    affectedCount += await restoreBlocksByIds(ids.slice(i, i + MAX_TRASH_BATCH_IDS))
  }
  return { affected_count: affectedCount }
}

/**
 * Permanently purge every soft-deleted block in `spaceId`. Irreversible.
 *
 * #2544 — mirrors {@link restoreAllDeletedInSpace}'s rationale: the
 * backend's `purge_all_deleted` command is unscoped and would destroy
 * trash in every space, not just the active one shown (and confirmed) by
 * the Trash view's "Empty trash" dialog. Scoped here the same way, via
 * `purgeBlocksByIds`.
 */
export async function purgeAllDeletedInSpace(spaceId: string): Promise<BulkTrashResponse> {
  const ids = await collectAllTrashRootIds(spaceId)
  let affectedCount = 0
  for (let i = 0; i < ids.length; i += MAX_TRASH_BATCH_IDS) {
    affectedCount += await purgeBlocksByIds(ids.slice(i, i + MAX_TRASH_BATCH_IDS))
  }
  return { affected_count: affectedCount }
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
 * Collapses the TemplatesView preview-fetch N+1
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
 * Batch-fetch full BlockRows by id.
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
 * backward compatibility. On the IPC boundary all query params are
 * marshalled into the single Rust `ListBlocksRequest` DTO (#2277 item 7) —
 * the intentional per-command IPC request type. The `spaceId`-derived
 * `SpaceScope` stays a separate argument.
 *
 * `spaceId` (#2248) — required. The backend filters results to
 * blocks whose owning page carries `space = <spaceId>`. It is wrapped into
 * the canonical `{ kind: 'active', space_id }` via `requireActiveScope`,
 * which throws on an empty string. There is intentionally no cross-space
 * (`global`) block listing, so callers with no active space must NOT invoke
 * this: short-circuit locally on a falsy `currentSpaceId` and render an empty
 * result. Passing `''` throws loudly (rather than the old silent empty-page
 * no-match) instead of leaking across spaces.
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
  const request = {
    parentId: params.parentId ?? null,
    blockType: params.blockType ?? null,
    tagId: params.tagId ?? null,
    date: params.agendaDate ?? null,
    dateRange: params.agendaDateRange ?? null,
    source: params.agendaSource ?? null,
    cursor: params.cursor ?? null,
    limit: params.limit ?? null,
  }
  return unwrap(await commands.listBlocks(request, requireActiveScope(params.spaceId)))
}

/**
 * Paginate soft-deleted blocks (the trash view). Scoped to a single space.
 *
 * #2248 — the IPC now takes the canonical `SpaceScope`. `spaceId` is still a
 * required non-empty ULID; it is wrapped into `{ kind: 'active', space_id }`
 * via `toSpaceScope`. There is intentionally no cross-space (`global`) trash
 * listing — callers with no active space must not invoke this (guard on
 * `currentSpaceId` and render an empty view locally). Passing `''` reaches the
 * backend as `Active('')` and is rejected as a malformed space id, rather than
 * the old silent empty-page no-match.
 */
export async function listTrash(params: {
  cursor?: string | undefined
  limit?: SafeLimit | undefined
  spaceId: string
}): Promise<PageResponse<BlockRow>> {
  return unwrap(
    await commands.listTrash(
      params.cursor ?? null,
      params.limit ?? null,
      toSpaceScope(params.spaceId),
    ),
  )
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

/**
 * #2300 — explicit resolution scope for {@link batchResolve}: a space ULID to
 * scope resolution to that (active) space, or the literal `'global'` to opt IN
 * to cross-space resolution (trash / global search). REQUIRED: omitting the
 * scope — the old silent-`global` default — is no longer possible, so a
 * callsite that means active-space scoping can't leak other spaces' titles by
 * forgetting the argument (the 'no live links between spaces' policy).
 */
export type ResolveScope = string | 'global'

/** Batch-resolve block metadata for multiple IDs in a single call.
 *
 * `scope` — REQUIRED (#2300). Pass a space ULID to restrict resolution to
 * blocks whose owning page carries `space = <scope>`; foreign-space targets
 * simply do not appear in the response, which is what makes the chip fall into
 * the "unknown id" branch and render via the broken-link UX (locked-in policy:
 * no live links between spaces, ever). Pass the literal `'global'` to opt IN to
 * cross-space resolution on surfaces that genuinely want it (trash breadcrumbs,
 * global search).
 *
 * The scope is no longer optional: previously omitting `spaceId` silently
 * routed through `toSpaceScope(undefined)` → `{ kind: 'global' }`, so a caller
 * that meant active-space scoping could leak other spaces' titles just by
 * forgetting the argument. Making it required turns that mistake into a compile
 * error — a caller must now spell out `'global'` to cross spaces on purpose.
 */
export async function batchResolve(ids: string[], scope: ResolveScope): Promise<ResolvedBlock[]> {
  const spaceScope: SpaceScope =
    scope === 'global' ? { kind: 'global' } : { kind: 'active', space_id: scope }
  return unwrap(await commands.batchResolve(ids, spaceScope))
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
): Promise<WithOps<MoveResponse>> {
  return unwrap(await commands.moveBlock(blockId, newParentId, newIndex))
}

/**
 * #2274 — batched multi-select drag reparent/reorder. Moves the given block
 * ids, IN ORDER, under `newParentId` (a real block id, or `null` for the page
 * root) at consecutive slots starting at the 0-based `newIndex`. The whole
 * batch runs in ONE backend IMMEDIATE transaction (N `MoveBlock` ops), so it
 * replaces the old per-root `moveBlock` IPC loop + full page reload with a
 * single IPC returning the authoritative per-root parent/position.
 *
 * `block_ids` MUST already be sorted by current document position (the store's
 * `moveBlocks` does this) so the moved run preserves relative order at the
 * destination.
 *
 */
export async function moveBlocksBatch(
  blockIds: string[],
  newParentId: string | null,
  newIndex: number,
): Promise<MoveResponse[]> {
  return unwrap(await commands.moveBlocksBatch(blockIds, newParentId, newIndex))
}
