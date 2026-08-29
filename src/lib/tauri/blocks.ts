import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type {
  BatchDeleteResponse,
  BlockRow,
  CreateBlockSpec,
  DateRange,
  DeleteResponse,
  PageResponse,
  PurgeResponse,
  RestoreResponse,
  SpaceScope,
  WithOps,
} from '@/lib/bindings'
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
 * Restore a list of soft-deleted blocks in a single IPC.
 *
 * Mirrors `restoreBlock` but accepts an array of ids; the backend runs one
 * IMMEDIATE transaction with one op_log scope instead of N. Each id is
 * treated as a cascade root (matches the TrashView's `listTrash` source).
 * Missing ids are silently skipped; a LIVE (not soft-deleted) id REJECTS the
 * whole call with `InvalidOperation` and restores nothing (#3838 — it used to
 * be silently skipped, where `restoreBlock` refuses the same id), exactly as
 * `purgeBlocksByIds` rejects a live id. Callers sourcing ids from a trash
 * listing should reload on that error: it means the listing went stale.
 * Returns the number of blocks (roots + descendants) whose `deleted_at` was
 * actually cleared.
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
 * instead of N times. Missing ids are silently skipped; a LIVE (not
 * soft-deleted) id REJECTS the whole call with `InvalidOperation` and
 * purges nothing (#3819 — it used to hard-delete that block's subtree with
 * no op and no sync), exactly as `purgeBlock` rejects the same id. Callers
 * sourcing ids from a trash listing should reload on that error: it means
 * the listing went stale. Returns the number of `blocks` rows physically
 * removed.
 */
export async function purgeBlocksByIds(blockIds: string[]): Promise<number> {
  const resp = unwrap(await commands.purgeBlocksByIds(blockIds))
  return resp.affected_count
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
