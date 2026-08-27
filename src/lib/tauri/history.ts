import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type { HistoryEntry, PageResponse } from '@/lib/bindings'
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

/**
 * Undo the Nth most-recent undoable op on a page.
 *
 * No production call site: `undoDeleteOf` (`@/stores/undo`) now goes through
 * the ref-addressed `undoOp` exclusively. PR #4410 (which deleted 37 other
 * dead wrappers from this layer) considered and rejected deleting this one
 * too, for a reason specific to it and not to the other 36: three
 * `.not.toHaveBeenCalled()` assertions in `src/stores/__tests__/undo.test.ts`
 * (lines 1789, 1807, 1878) are live #4328 regression guards against the
 * positional-undo bug, where `undoDeleteOf` reversed the op at the delete's
 * LIST index instead of its own (device_id, seq) ref once a prior undo had
 * appended a reverse row out of band. One of the three
 * (`mockedUndoPageOp.mockImplementation` at line 1850) doesn't just assert
 * non-invocation — it reproduces the old positional behavior, so the test
 * reddens on a regression rather than passing vacuously. Those assertions
 * need a real, importable/mockable `undoPageOp` symbol to spy on; removing
 * this function means rewriting them to prove the negative some other way
 * first (e.g. asserting on `commands.undoPageOp` directly), not just deleting
 * dead code. Re-evaluate only after that test file no longer imports this
 * symbol from `@/lib/tauri`.
 */
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

/** Redo a previously undone op by reversing it again. */
export async function redoPageOp(params: {
  undoDeviceId: string
  undoSeq: number
}): Promise<UndoResult> {
  return unwrap(await commands.redoPageOp(params.undoDeviceId, params.undoSeq))
}
