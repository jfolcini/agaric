/**
 * #3693 — a mock restore walks the UPWARD ancestor chain, not just the
 * downward cohort.
 *
 * #3692 made the mock's downward walk agree with the backend for all three
 * lifecycle reversals. This file covers the other half of the same semantics:
 * `agaric_store::block_descendants::restore_deleted_ancestor_chain`
 * (`src-tauri/agaric-store/src/block_descendants.rs`, #1884), which
 * `restore_block_inner` (`src-tauri/src/commands/blocks/crud.rs`), the
 * `OpPayload::RestoreBlock` apply arm (`src-tauri/src/commands/history.rs`)
 * and `project_restore_block_to_sql` all run immediately after the cohort
 * UPDATE.
 *
 * The hole it closes only opens when the two tombstones are INDEPENDENT:
 * delete a child, then later delete its parent. The parent's cascade walks
 * `DescendantWalkFilter::Active` and therefore SKIPS the already-deleted
 * child, so the child keeps its own, older `deleted_at` marker and the
 * downward cohort walk from the child can never reach the parent. Restoring
 * the child alone leaves it LIVE under a tombstoned parent — invisible in the
 * tree (`list_children` filters `deleted_at IS NULL`) and absent from trash,
 * and hard-deleted by a later purge of the parent. The backend cannot produce
 * that state; before this fix the mock could, and any frontend test written
 * against it was asserting on a tree shape production never returns.
 *
 * The chain walk is deliberately NOT cohort-filtered (the CTE's only filter is
 * `deleted_at IS NOT NULL`), so these tests pin the cross-cohort behaviour
 * specifically — a same-cohort assertion would pass against the downward walk
 * alone and prove nothing.
 *
 * ## Verification note
 * Per #3693, the reversal path cannot be cross-checked by a Rust conformance
 * fixture: the conformance runner's `apply_op` replays raw `OpPayload`s and
 * panics on unknown commands, so no fixture can drive an undo/revert. The
 * coverage here is a mock-side test plus a read of the Rust implementation,
 * NOT a cross-language fixture.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { restoreDeletedAncestorChain } from '@/lib/tauri-mock/cohort'
import { dispatch } from '@/lib/tauri-mock/handlers'
import {
  blockTags,
  blocks,
  makeBlock,
  opLog,
  properties,
  propertyDefs,
} from '@/lib/tauri-mock/seed'

const PAGE = '00000000000000000000PAGEZZ'
const GP = '000000000000000000000000GP'
const P = '0000000000000000000000000P'
const C = '0000000000000000000000000C'
const GC = '000000000000000000000000GC'
const SIB = '00000000000000000000000SIB'

interface Ref {
  device_id: string
  seq: number
}
interface WithOpsResp {
  op_refs: Ref[]
  [key: string]: unknown
}

/**
 * PAGE
 *  └─ GP
 *      └─ P
 *          ├─ C
 *          │   └─ GC
 *          └─ SIB
 */
function seedSubtree(): void {
  blocks.clear()
  properties.clear()
  blockTags.clear()
  propertyDefs.clear()
  opLog.length = 0

  blocks.set(PAGE, makeBlock(PAGE, 'page', 'Test Page', null, 0))
  blocks.set(GP, makeBlock(GP, 'content', 'GP', PAGE, 1))
  blocks.set(P, makeBlock(P, 'content', 'P', GP, 1))
  blocks.set(C, makeBlock(C, 'content', 'C', P, 1))
  blocks.set(GC, makeBlock(GC, 'content', 'GC', C, 1))
  blocks.set(SIB, makeBlock(SIB, 'content', 'SIB', P, 2))
}

function deletedAt(id: string): unknown {
  return blocks.get(id)?.['deleted_at']
}

function liveIds(): string[] {
  return [...blocks.values()].filter((b) => !b['deleted_at']).map((b) => b['id'] as string)
}

/**
 * Delete C (its own cohort), then delete GP — whose active cascade skips C and
 * GC, so the ancestors P/GP carry a DIFFERENT marker than C/GC.
 */
function deleteChildThenAncestors(): void {
  dispatch('delete_block', { blockId: C })
  dispatch('delete_block', { blockId: GP })
}

describe('#3693 — restore walks the upward ancestor chain', () => {
  beforeEach(seedSubtree)

  it('sets up two independent cohorts (precondition for every case below)', () => {
    deleteChildThenAncestors()
    // C's cascade took C + GC; GP's cascade took GP, P, SIB but NOT the
    // already-deleted C/GC (DescendantWalkFilter::Active skips them).
    expect(deletedAt(C)).toBe(deletedAt(GC))
    expect(deletedAt(GP)).toBe(deletedAt(P))
    expect(deletedAt(GP)).toBe(deletedAt(SIB))
    expect(deletedAt(C)).not.toBe(deletedAt(GP))
  })

  it('restore_block of a block under a deleted parent revives the ancestor chain', () => {
    deleteChildThenAncestors()

    const res = dispatch('restore_block', { blockId: C }) as Record<string, unknown>

    // C's own cohort (C + GC) is back…
    expect(deletedAt(C)).toBeFalsy()
    expect(deletedAt(GC)).toBeFalsy()
    // …AND so is the contiguous tombstoned chain reconnecting it to the live
    // tree. Before #3693 P and GP stayed tombstoned and C was a live orphan.
    expect(deletedAt(P)).toBeFalsy()
    expect(deletedAt(GP)).toBeFalsy()
    // The walk restores the CHAIN only — SIB shares GP's marker but is not an
    // ancestor of C, so it stays in trash.
    expect(deletedAt(SIB)).toBeTruthy()
    expect(liveIds().toSorted()).toEqual([C, GC, GP, P, PAGE].toSorted())

    // `restored_count` is the DOWNWARD cohort only (C + GC), mirroring
    // `RestoreResponse::restored_count`, which the backend reads off the
    // cohort UPDATE's `rows_affected()` — the ancestor chain is cleared by a
    // separate UPDATE whose count is not reported.
    expect(res['restored_count']).toBe(2)
  })

  it('stops at the nearest LIVE ancestor and never touches it', () => {
    // Only P is deleted (its cascade takes C, GC and SIB with it); GP stays
    // live, so the walk from C must stop at P.
    dispatch('delete_block', { blockId: C })
    dispatch('delete_block', { blockId: P })
    expect(deletedAt(GP)).toBeFalsy()

    dispatch('restore_block', { blockId: C })

    expect(deletedAt(P)).toBeFalsy()
    expect(deletedAt(GP)).toBeFalsy()
    expect(deletedAt(SIB)).toBeTruthy()
  })

  it('restores nothing upward when the parent chain is already live', () => {
    dispatch('delete_block', { blockId: C })

    const res = dispatch('restore_block', { blockId: C }) as Record<string, unknown>

    expect(liveIds().toSorted()).toEqual([C, GC, GP, P, PAGE, SIB].toSorted())
    expect(res['restored_count']).toBe(2)
  })

  it('undo_op of the delete also walks the chain (reversal apply arm)', () => {
    dispatch('delete_block', { blockId: C })
    const del = dispatch('delete_block', { blockId: GP }) as WithOpsResp
    // Undo the FIRST delete — the reverse of `delete_block` is
    // `RestoreBlock { deleted_at_ref }`, whose apply arm runs both walks.
    const delC = opLog.find((o) => o.op_type === 'delete_block')
    expect(delC).toBeDefined()
    expect(del.op_refs.length).toBeGreaterThan(0)

    dispatch('undo_op', { opRef: { device_id: delC?.device_id, seq: delC?.seq } })

    expect(deletedAt(C)).toBeFalsy()
    expect(deletedAt(GC)).toBeFalsy()
    expect(deletedAt(P)).toBeFalsy()
    expect(deletedAt(GP)).toBeFalsy()
    expect(deletedAt(SIB)).toBeTruthy()
  })

  it('revert_ops of the delete also walks the chain', () => {
    const delC = dispatch('delete_block', { blockId: C }) as WithOpsResp
    dispatch('delete_block', { blockId: GP })

    dispatch('revert_ops', { ops: delC.op_refs })

    expect(deletedAt(C)).toBeFalsy()
    expect(deletedAt(P)).toBeFalsy()
    expect(deletedAt(GP)).toBeFalsy()
    expect(deletedAt(SIB)).toBeTruthy()
  })

  it('undo_page_op (positional) of the delete also walks the chain', () => {
    dispatch('delete_block', { blockId: C })
    dispatch('delete_block', { blockId: GP })

    // undoDepth 1 = the second-most-recent undoable op = the C delete.
    dispatch('undo_page_op', { pageId: PAGE, undoDepth: 1 })

    expect(deletedAt(C)).toBeFalsy()
    expect(deletedAt(P)).toBeFalsy()
    expect(deletedAt(GP)).toBeFalsy()
    expect(deletedAt(SIB)).toBeTruthy()
  })
})

describe('#3693 — restoreDeletedAncestorChain unit behaviour', () => {
  beforeEach(seedSubtree)

  it('returns the chain depth-ascending, so the last id is the backend topmost', () => {
    deleteChildThenAncestors()

    expect(restoreDeletedAncestorChain(blocks, C)).toEqual([P, GP])
  })

  it('is idempotent — a re-run over a live chain restores nothing', () => {
    deleteChildThenAncestors()
    restoreDeletedAncestorChain(blocks, C)

    expect(restoreDeletedAncestorChain(blocks, C)).toEqual([])
  })

  it('no-ops on a missing block (no parent_id to seed the CTE from)', () => {
    deleteChildThenAncestors()

    expect(restoreDeletedAncestorChain(blocks, 'NOPE')).toEqual([])
    expect(deletedAt(P)).toBeTruthy()
  })

  it('bounds a cyclic parent_id chain instead of looping forever', () => {
    // Corrupted data (AGENTS.md invariant #9): P ⇄ GP, both tombstoned.
    const marker = '2020-01-01T00:00:00.000Z#000001'
    for (const id of [GP, P, C]) {
      const row = blocks.get(id)
      if (row) row['deleted_at'] = marker
    }
    const gp = blocks.get(GP)
    if (gp) gp['parent_id'] = P

    expect(restoreDeletedAncestorChain(blocks, C).toSorted()).toEqual([GP, P].toSorted())
  })
})
