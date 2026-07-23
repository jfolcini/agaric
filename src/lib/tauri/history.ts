import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type { DiffSpan, HistoryEntry, PageResponse, RestoreToOpResult } from '@/lib/bindings'
import type { SafeLimit } from '@/lib/safe-limit'
import { toSpaceScope } from '@/lib/tauri/_shared'

/** List op-log history for a block, paginated (newest first).
 *
 * `opTypeFilter` is pushed into SQL so cursor pages
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

/** List global operation history (page-scoped), paginated (newest first).
 *
 * Phase 8 — `spaceId` narrows the global (`pageId === '__all__'`)
 * query to ops whose `payload.block_id` belongs to the requested space.
 * Pass `undefined` to disable the space filter (cross-space all-spaces
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

/** Revert a batch of operations (by device_id + seq pairs). */
export async function revertOps(params: {
  ops: Array<{ device_id: string; seq: number }>
}): Promise<UndoResult[]> {
  return unwrap(await commands.revertOps(params.ops))
}

/** Restore a page to its state at a specific operation (point-in-time restore). */
export async function restorePageToOp(params: {
  pageId: string
  targetDeviceId: string
  targetSeq: number
}): Promise<RestoreToOpResult> {
  return unwrap(
    await commands.restorePageToOp(params.pageId, params.targetDeviceId, params.targetSeq),
  )
}

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
 * #2190 — Undo an entire consecutive same-device, within-window undo group in
 * a SINGLE IMMEDIATE transaction.
 *
 * Replaces the undo store's `findUndoGroup` + N × `undoPageOp` IPC loop (one
 * IPC / one page-subtree CTE walk / one writer-lock acquisition per op — 20
 * IPCs for a 20-op recurrence group) with ONE command. The backend resolves
 * the page subtree + the group's op refs once, reverts them newest-first, and
 * returns one `UndoResult` per reverted op (newest-first). An empty array means
 * no group existed (seed op absent / no undoable ops).
 *
 * `depth` is 0-based (0 = seed at the most-recent undoable op, matching
 * `findUndoGroup`); `windowMs` is the grouping window.
 */
export async function undoPageGroup(params: {
  pageId: string
  depth: number
  windowMs: number
}): Promise<UndoResult[]> {
  return unwrap(await commands.undoPageGroup(params.pageId, params.depth, params.windowMs))
}

/**
 * #2468 — ref-addressed single undo, the `undoPageOp` successor. The frontend
 * passes the EXACT `OpRef` captured from the mutating command's `op_refs`
 * response at action time, killing the positional-offset race (#2446): ops
 * landing between capture and Ctrl+Z can no longer shift the target.
 *
 * The backend rejects foreign/replicated refs, already-reversed ops, and refs
 * that point at undo ops (use `redoPageOp` for those). Same `UndoResult`
 * contract as `undoPageOp`.
 */
export async function undoOp(params: { opRef: OpRef }): Promise<UndoResult> {
  return unwrap(await commands.undoOp(params.opRef))
}

/**
 * #2468 — ref-addressed group undo, the `undoPageGroup` successor for
 * FE-coalesced undo groups. Reverts the given ref-set ATOMICALLY (all ops or
 * none) and returns one `UndoResult` per reverted op, newest-first. Same
 * reject rules as {@link undoOp}, applied to every ref before anything is
 * reverted.
 */
export async function undoOps(params: { ops: OpRef[] }): Promise<UndoResult[]> {
  return unwrap(await commands.undoOps(params.ops))
}

/**
 * Compute the size of the consecutive same-device,
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
 * Current" mode in the per-block history panel (Part B).
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
