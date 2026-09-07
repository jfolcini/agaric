import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type {
  BatchDeleteResponse,
  BlockRow,
  CreateBlockSpec,
  DeleteResponse,
  PageResponse,
  PurgeResponse,
  RestoreResponse,
  WithOps,
} from '@/lib/bindings'
import type { SafeLimit } from '@/lib/safe-limit'
import { toSpaceScope } from '@/lib/tauri/_shared'

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

/**
 * Soft-delete a block (cascade to descendants). #2468: carries `op_refs`.
 *
 * #4523: the reply also carries `affected_page_ids` — the `block_type =
 * 'page'` members of that cascade. It exists because the cascade walks
 * `parent_id` with NO page-boundary stop, so a deleted page's nested PAGE
 * children are trashed with it and only the backend knows their ids. A caller
 * that maintains a per-space page cache (the `[[` picker's, via
 * `notifyPageRemoved`) must evict those too, or it goes on offering rows that
 * are now in the trash. See `usePageDeleteAction.handleConfirm`, and
 * `deleteBlocksByIds` below for the batch half of the same story.
 */
export async function deleteBlock(blockId: string): Promise<WithOps<DeleteResponse>> {
  return unwrap(await commands.deleteBlock(blockId))
}

/**
 * Batch soft-delete a list of blocks (cascade to
 * descendants for each root) inside a single backend IMMEDIATE
 * transaction.
 *
 * Returns a `BatchDeleteResponse`: `deleted_count`, the number of blocks
 * soft-deleted (roots + descendants combined), plus `affected_page_ids`
 * (#4480) — the `block_type = 'page'` members of that cascade.
 *
 * `affected_page_ids` exists because the cascade walks `parent_id` with NO
 * page-boundary stop, so a selected page's nested PAGE children are trashed
 * with it and only the backend knows their ids. A caller that maintains a
 * per-space page cache (the `[[` picker's, via `notifyPageRemoved`) must
 * evict those too, or it goes on offering rows that are now in the trash.
 * See `PageBrowserBatchToolbar.handleTrash`.
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
export async function deleteBlocksByIds(blockIds: string[]): Promise<BatchDeleteResponse> {
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
