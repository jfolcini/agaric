/**
 * Targeted mutation-kill tests for `computeDropIndex` (issue #3142).
 *
 * Each test is built to assert an EXACT index that differs between the
 * production code and one specific surviving mutant. See inline comments
 * for which mutant each test kills.
 */

import { describe, expect, it } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import { computeDropIndex, type FlatBlock, SENTINEL_ID } from '@/lib/tree-utils'

function mkFlat(id: string, parentId: string | null, depth: number): FlatBlock {
  return makeBlock({ id, parent_id: parentId, depth })
}

describe('computeDropIndex mutants (#3142)', () => {
  // Line 521 [ConditionalExpression]: `if (overId === SENTINEL_ID)`.
  // Forcing the condition to always-true makes a normal drop target be
  // treated as "append after last" — wrong insertAt/slot for a real id.
  it('does not treat a real overId as the append-after-last sentinel', () => {
    const items: FlatBlock[] = [mkFlat('A', null, 0), mkFlat('B', null, 0), mkFlat('C', null, 0)]
    // Drag C UP onto B → before B → slot 1. A forced-true mutant would
    // instead append (slot 2).
    expect(computeDropIndex(items, null, 'B', 'C')).toBe(1)
  })
  // Note: the always-false direction of this mutant is equivalent — SENTINEL_ID
  // never matches a real item id, so the "unknown target" else-branch also
  // resolves to `without.length`, identical to the sentinel branch.

  // Line 531 [EqualityOperator]: `overIdxInItems > activeIndex ? +1 : same`.
  it('adds one when dragging downward past the target (overIdx > activeIndex)', () => {
    const items: FlatBlock[] = [mkFlat('A', null, 0), mkFlat('B', null, 0), mkFlat('C', null, 0)]
    // Drag A DOWN onto C: overIdxInItems(2) > activeIndex(0) → drop AFTER C → slot 2.
    expect(computeDropIndex(items, null, 'C', 'A')).toBe(2)
  })

  it('omits the +1 when dragging upward before the target (overIdx < activeIndex)', () => {
    const items: FlatBlock[] = [mkFlat('A', null, 0), mkFlat('B', null, 0), mkFlat('C', null, 0)]
    // Drag C UP onto A: overIdxInItems(0) < activeIndex(2) → drop BEFORE A → slot 0.
    expect(computeDropIndex(items, null, 'A', 'C')).toBe(0)
  })

  // Line 538 [ConditionalExpression forced-true] and [LogicalOperator, `??`→`&&`]:
  // `parentId === null ? -1 : (find(...)?.depth ?? -1)`. Using a parent with a
  // truthy depth (1) distinguishes both: forcing -1 always, or `1 && -1` (= -1
  // since `&&` returns the right side on a truthy left), both wrongly zero out
  // childDepth and produce the wrong slot.
  it('derives childDepth from the real parent depth (non-null, non-zero)', () => {
    const items: FlatBlock[] = [
      mkFlat('A', null, 0),
      mkFlat('P', 'A', 1),
      mkFlat('C1', 'P', 2),
      mkFlat('C2', 'P', 2),
      mkFlat('dragged', 'P', 2),
    ]
    // parentDepth(P)=1 → childDepth=2. Insert before C2 → only C1 (depth 2,
    // parent P) precedes it → slot 1. Both mutants above collapse childDepth
    // to 0, matching no item → slot 0.
    expect(computeDropIndex(items, 'P', 'C2', 'dragged')).toBe(1)
  })
  // This same test also kills line 543 [ConditionalExpression]: slot 1 is
  // strictly between "always true" (3, = insertAt) and "always false" (0).

  // Line 538 [OptionalChaining]: removing `?.` from `find(...)?.depth` throws
  // when the parent id isn't found, instead of falling back via `?? -1`.
  it('does not throw when parentId has no matching item', () => {
    const items: FlatBlock[] = [mkFlat('A', null, 0), mkFlat('B', null, 0)]
    expect(computeDropIndex(items, 'NOPE', 'B', 'A')).toBe(0)
  })

  // Line 541 [EqualityOperator]: `i < insertAt && i < without.length`. Picks a
  // case where `without[insertAt]` itself matches the parent/depth predicate,
  // so relaxing `i < insertAt` to `i <= insertAt` pulls in one extra match.
  it('excludes the item exactly at insertAt from the sibling count', () => {
    const items: FlatBlock[] = [
      mkFlat('A', null, 0),
      mkFlat('P', 'A', 1),
      mkFlat('C1', 'P', 2),
      mkFlat('C2', 'P', 2),
      mkFlat('C3', 'P', 2),
      mkFlat('dragged', 'P', 2),
    ]
    // Drop before C1 (insertAt=2 in `without`): no matching siblings precede
    // it → slot 0. The `i <= insertAt` mutant would also test C1 itself
    // (matches parent P, depth 2) → slot 1.
    expect(computeDropIndex(items, 'P', 'C1', 'dragged')).toBe(0)
  })
  // Note: an `i < without.length` → `i <= without.length` mutant on the same
  // line is equivalent — `insertAt` is always <= `without.length` by
  // construction, so `i < insertAt` alone already guarantees `i < without.length`
  // whenever the loop body runs; the second bound never fires more permissively.

  it('sanity: SENTINEL_ID still appends after the last matching sibling', () => {
    const items: FlatBlock[] = [mkFlat('A', null, 0), mkFlat('B', null, 0)]
    expect(computeDropIndex(items, null, SENTINEL_ID, 'B')).toBe(1)
  })
})
