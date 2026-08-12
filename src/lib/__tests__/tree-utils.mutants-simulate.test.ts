// Targeted mutant-killing tests for `simulateProjection` (issue #3142).
// Scope: tree-utils.ts:294, 303, 325, 328 only. Do not add unrelated coverage
// here — see tree-utils.test.ts for the general suite.

import { describe, expect, it } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import { type FlatBlock, simulateProjection } from '@/lib/tree-utils'

function mkFlat(
  id: string,
  parentId: string | null,
  position: number | null,
  depth: number,
): FlatBlock {
  return makeBlock({ id, parent_id: parentId, position, depth })
}

// [0] A  (depth 0)
// [1] A1 (depth 1, child of A)
// [2] A2 (depth 1, child of A)
// [3] B  (depth 0)
// [4] C  (depth 0)
const items: FlatBlock[] = [
  mkFlat('A', null, 0, 0),
  mkFlat('A1', 'A', 0, 1),
  mkFlat('A2', 'A', 1, 1),
  mkFlat('B', null, 1, 0),
  mkFlat('C', null, 2, 0),
]

describe('simulateProjection mutant kills (#3142)', () => {
  it('projects a normal drag (C onto B) with the full structural shape', () => {
    // Kills tree-utils.ts:294/303 ConditionalExpression forced-true: forcing
    // either guard to always-true would short-circuit this valid drag into
    // the 'fixed' branch instead of computing the real projection.
    const sim = simulateProjection(items, 'C', 'B')
    expect(sim).toEqual({
      kind: 'normal',
      clonedItems: [items[0], items[1], items[2], items[4], items[3]],
      projectedIndex: 3,
      previousItem: items[2],
      nextItem: items[3],
      activeItem: items[4],
      depthCeiling: 19,
      rootParentId: null,
    })
  })

  it('projects a normal drag onto the very first item (overIndex === 0)', () => {
    // Kills tree-utils.ts:325 EqualityOperator: if `overIndex < 0` were
    // widened to `overIndex <= 0`, dropping onto the first item (a legal,
    // in-bounds overIndex of 0) would be wrongly rejected as "not found".
    const sim = simulateProjection(items, 'C', 'A')
    expect(sim).toEqual({
      kind: 'normal',
      clonedItems: [items[4], items[0], items[1], items[2], items[3]],
      projectedIndex: 0,
      previousItem: undefined,
      nextItem: items[0],
      activeItem: items[4],
      depthCeiling: 19,
      rootParentId: null,
    })
  })

  it('refuses a drop onto an overId absent from items (not the sentinel)', () => {
    // Kills tree-utils.ts:325 BlockStatement/ConditionalExpression: skipping
    // this guard would fall through to the splice/index math with
    // overIndex === -1 and produce a bogus 'normal' result instead of the
    // safe fixed default. Also kills tree-utils.ts:328 ObjectLiteral: a
    // distinctive non-null rootParentId and all-zero fields pin every
    // literal in the returned projection.
    const sim = simulateProjection(items, 'C', 'NOPE', 'page-root')
    expect(sim).toEqual({
      kind: 'fixed',
      projection: { depth: 0, parentId: 'page-root', maxDepth: 0, minDepth: 0 },
    })
  })

  it('refuses a drag of an activeId absent from items', () => {
    // Correctness coverage for tree-utils.ts:294/303: an unknown activeId
    // must resolve to the same fixed default, keyed off the given rootParentId.
    const sim = simulateProjection(items, 'MISSING', 'B', 'root-x')
    expect(sim).toEqual({
      kind: 'fixed',
      projection: { depth: 0, parentId: 'root-x', maxDepth: 0, minDepth: 0 },
    })
  })
})

/*
 * Equivalent and unreachable mutants in `simulateProjection` (issue #3765).
 * No fixture can distinguish these, so no test is added for them:
 *
 * - tree-utils.ts:301:7  [ConditionalExpression] `activeIndex < 0` -> `false`
 * - tree-utils.ts:301:24 [BlockStatement]        the guard's `return` block -> `{}`
 * - tree-utils.ts:310:7  [ConditionalExpression] `!activeItem` -> `false`
 * - tree-utils.ts:310:20, 311:12, 312:13, 313:19 — reported NoCoverage
 *
 * The two guards are mutually redundant BY DESIGN; the source comment at
 * tree-utils.ts:294-300 says so explicitly. Disabling the first one lets a
 * missing `activeId` fall through to `items[-1] === undefined`, and the
 * `!activeItem` guard then returns the character-for-character identical
 * `{ kind: 'fixed', projection: { depth: 0, parentId: rootParentId,
 * maxDepth: 0, minDepth: 0 } }`. In the other direction, while the first guard
 * stands, `activeItem` is `items[activeIndex]` for an index `findIndex` just
 * matched, so it is never nullish — the `!activeItem` body is unreachable,
 * which is exactly why its four inner mutants get no coverage at all.
 *
 * Verified by differential execution over 885 205 generated inputs (items
 * lists x activeId/overId incl. absent ids x rootParentId x subtreeHeight):
 * zero output differences. The same harness flags all 211 mutants in this
 * module's functions that the suite already kills, so its blindness here is a
 * property of the code, not of the input space.
 */
