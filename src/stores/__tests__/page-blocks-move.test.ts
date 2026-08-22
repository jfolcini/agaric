// #3799 — direct unit coverage for `page-blocks-move.ts`'s cycle guard
// (`wouldCreateMoveCycle`) and its wiring into `reconcileBatchMove`.
//
// Unlike the rest of this module's callers (exercised only through the full
// `page-blocks` store — see `page-blocks.reorder.test.ts` /
// `page-blocks.move-reparent.test.ts`), `reconcileBatchMove` and
// `wouldCreateMoveCycle` are plain, store-independent functions: no Zustand
// store, no Tauri `invoke` mock, no undo/space/block-store mocks needed. That
// independence is exactly what makes the guard's own logic — as opposed to
// the post-rebuild presence check it duplicates for cyclic inputs — directly
// falsifiable: break `wouldCreateMoveCycle` and the tests in the first
// `describe` go red on the spot, with nothing else in the reconcile pipeline
// able to paper over it.
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import type { MoveResponse } from '@/lib/bindings'
import { reconcileBatchMove, wouldCreateMoveCycle } from '@/stores/page-blocks-move'
import type { PageBlockState } from '@/stores/page-blocks-types'

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({
  logger: loggerMock,
  setLogLevel: vi.fn(),
}))

/** Batch-move response echoing `wantParent` for every moved id (the happy echo path). */
function batchResp(orderedIds: string[], newParentId: string | null): MoveResponse[] {
  return orderedIds.map((id, i) => ({
    block_id: id,
    new_parent_id: newParentId,
    new_position: i + 1,
  }))
}

beforeEach(() => {
  loggerMock.warn.mockClear()
})

describe('wouldCreateMoveCycle (#3799)', () => {
  // A -> A1 -> A1a (chain), plus an unrelated sibling B.
  const a = makeBlock({ id: 'A', parent_id: null, position: 1, depth: 0 })
  const a1 = makeBlock({ id: 'A1', parent_id: 'A', position: 1, depth: 1 })
  const a1a = makeBlock({ id: 'A1a', parent_id: 'A1', position: 1, depth: 2 })
  const b = makeBlock({ id: 'B', parent_id: null, position: 2, depth: 0 })
  const blocks = [a, a1, a1a, b]

  it('rejects when the requested parent IS one of the moved ids (self-parenting)', () => {
    expect(wouldCreateMoveCycle(blocks, ['A'], 'A')).toBe(true)
  })

  it('rejects when the requested parent is a DIRECT child of a moved id', () => {
    expect(wouldCreateMoveCycle(blocks, ['A'], 'A1')).toBe(true)
  })

  it('rejects when the requested parent is an INDIRECT (grandchild) descendant of a moved id', () => {
    expect(wouldCreateMoveCycle(blocks, ['A'], 'A1a')).toBe(true)
  })

  it('rejects when the descendant relationship comes from a DIFFERENT id in a multi-id batch', () => {
    // Neither the first nor the requested parent alone is a cycle — the
    // relationship is between the SECOND moved id and the target.
    expect(wouldCreateMoveCycle(blocks, ['B', 'A'], 'A1')).toBe(true)
  })

  it('allows moving a block to an entirely unrelated parent', () => {
    expect(wouldCreateMoveCycle(blocks, ['A1'], 'B')).toBe(false)
  })

  // EQUIVALENCE (#4223, moved here from page-blocks.reorder.test.ts) — the
  // `if (wantParent == null) return false` guard skipped outright (Stryker's
  // `if (false)` ConditionalExpression mutant at this line): `orderedIds` is
  // always `readonly string[]` and every `FlatBlock.id` is always a
  // `string`, so for `wantParent === null`, both `orderedIds.includes(null)`
  // and `getDragDescendants(...).has(null)` are ALWAYS false regardless of
  // `blocks`/`orderedIds` content (no string ever `===` `null`) — the
  // fall-through path converges on the exact same `false` the early return
  // would have produced. Killing this would require an id that is literally
  // `null` at runtime, contradicting the `string[]` contract every real
  // caller (and this suite) respects. Confirmed by applying the mutation by
  // hand and running this file plus `page-blocks.move-reparent.test.ts`:
  // unchanged green (not the proof itself — the argument above is — just
  // consistent with it).
  it('allows moving a block to root (null)', () => {
    expect(wouldCreateMoveCycle(blocks, ['A1a'], null)).toBe(false)
  })

  it('allows moving a block to its own ANCESTOR (opposite direction of a cycle — legitimate "un-indent")', () => {
    // A1a's ancestor is A1 (and A) — this is an ordinary re-parent up the
    // chain, not a cycle. Pinned so an accidentally-inverted descendant check
    // (ancestor vs. descendant) would be caught here, not just missed by an
    // over-eager rejection.
    expect(wouldCreateMoveCycle(blocks, ['A1a'], 'A1')).toBe(false)
    expect(wouldCreateMoveCycle(blocks, ['A1a'], 'A')).toBe(false)
  })

  it('allows a sibling swap (neither is a descendant of the other)', () => {
    expect(wouldCreateMoveCycle(blocks, ['A'], 'B')).toBe(false)
    expect(wouldCreateMoveCycle(blocks, ['B'], 'A')).toBe(false)
  })
})

describe('reconcileBatchMove — cycle guard (#3799)', () => {
  it('rejects up front (returns null, logs a warning) when newParentId is a descendant of the moved run', () => {
    const state = {
      blocks: [
        makeBlock({ id: 'A', parent_id: 'PAGE_1', position: 1, depth: 0 }),
        makeBlock({ id: 'A1', parent_id: 'A', position: 1, depth: 1 }),
        makeBlock({ id: 'B', parent_id: 'PAGE_1', position: 2, depth: 0 }),
      ],
      rootParentId: 'PAGE_1',
    } as PageBlockState

    const result = reconcileBatchMove(state, batchResp(['A'], 'A1'), ['A'], 'A1', 0)

    expect(result).toBeNull()
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'page-blocks-move',
      'moveBlocks: rejected — newParentId would create a cycle',
      { orderedIds: ['A'], wantParent: 'A1' },
    )
  })

  it('still performs the surgical splice (no warning, non-null result) for a legitimate move', () => {
    const state = {
      blocks: [
        makeBlock({ id: 'A', parent_id: 'PAGE_1', position: 1, depth: 0 }),
        makeBlock({ id: 'A1', parent_id: 'A', position: 1, depth: 1 }),
        makeBlock({ id: 'B', parent_id: 'PAGE_1', position: 2, depth: 0 }),
      ],
      rootParentId: 'PAGE_1',
    } as PageBlockState

    // Move A1 (a leaf, no descendants) under B — an ordinary, non-cyclic
    // reparent, structurally close to the rejected case above (same tree,
    // same moved-id shape) so this test is a genuine control, not a
    // trivially-different fixture.
    const result = reconcileBatchMove(state, batchResp(['A1'], 'B'), ['A1'], 'B', 0)

    expect(result).not.toBeNull()
    expect(result?.map((b) => b.id)).toEqual(['A', 'B', 'A1'])
    expect(result?.find((b) => b.id === 'A1')?.parent_id).toBe('B')
    expect(loggerMock.warn).not.toHaveBeenCalled()
  })
})
