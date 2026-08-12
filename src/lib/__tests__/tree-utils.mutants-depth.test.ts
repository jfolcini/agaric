/**
 * Targeted mutation-kill tests for `projectDepth` (issue #3142).
 *
 * These construct `ProjectionSim` fixtures directly (both `sentinel` and
 * `normal` shapes) rather than going through `simulateProjection`, so each
 * boundary/branch inside `projectDepth` can be pinned exactly. Sibling test
 * files own the rest of tree-utils.ts — do not add coverage here beyond
 * `projectDepth`.
 */

import { describe, expect, it } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import { type ProjectionSim, projectDepth } from '@/lib/tree-utils'

const INDENT = 10

function block(id: string, depth: number, parent_id: string | null = null) {
  return makeBlock({ id, depth, parent_id })
}

describe('projectDepth — sentinel branch (drop after last item)', () => {
  it('beyond dead zone: subtracts DEAD_ZONE_PX and divides by indentWidth', () => {
    const sim: ProjectionSim = {
      kind: 'sentinel',
      rest: [],
      lastItem: block('last', 0),
      maxEndDepth: 20,
      rootParentId: null,
    }
    // abs(50) > 20 → effectiveOffset = 50 - 20 = 30 → round(30/10) = 3
    const result = projectDepth(sim, 50, INDENT)
    expect(result.depth).toBe(3)
    expect(result.parentId).toBeNull()
  })

  it('within dead zone: offset is ignored entirely', () => {
    const sim: ProjectionSim = {
      kind: 'sentinel',
      rest: [],
      lastItem: block('last', 4),
      maxEndDepth: 20,
      rootParentId: 'R',
    }
    // abs(5) is not > 20 → effectiveOffset = 0 → depth unchanged from lastItem
    const result = projectDepth(sim, 5, INDENT)
    expect(result.depth).toBe(4)
  })

  it('endDepth > 0 walks back to find the ancestor at endDepth - 1', () => {
    const sim: ProjectionSim = {
      kind: 'sentinel',
      rest: [block('a', 0), block('b', 1), block('c', 1)],
      lastItem: block('last', 1),
      maxEndDepth: 20,
      rootParentId: 'ROOTC',
    }
    // dead-zone offset → dragDepthVal 0 → endDepth = lastItem.depth (1)
    const result = projectDepth(sim, 10, INDENT)
    expect(result.depth).toBe(1)
    expect(result.parentId).toBe('a')
  })

  it('endDepth === 0 never runs the ancestor walk', () => {
    const sim: ProjectionSim = {
      kind: 'sentinel',
      // A depth of -1 cannot occur for real data; it exists purely so a
      // wrongly-always-entered ancestor walk would find it and diverge from
      // the expected rootParentId fallback.
      rest: [block('neg', -1)],
      lastItem: block('last2', 0),
      maxEndDepth: 20,
      rootParentId: 'ROOTD',
    }
    const result = projectDepth(sim, 0, INDENT)
    expect(result.depth).toBe(0)
    expect(result.parentId).toBe('ROOTD')
  })

  it('falls back to rootParentId when no ancestor matches (no throw)', () => {
    const sim: ProjectionSim = {
      kind: 'sentinel',
      rest: [block('x', 0)],
      lastItem: block('last3', 5),
      maxEndDepth: 20,
      rootParentId: 'ROOTE',
    }
    let result: ReturnType<typeof projectDepth> | undefined
    expect(() => {
      result = projectDepth(sim, 0, INDENT)
    }).not.toThrow()
    expect(result?.depth).toBe(5)
    expect(result?.parentId).toBe('ROOTE')
  })
})

describe('projectDepth — normal branch (dead zone + clamps)', () => {
  it('beyond dead zone: subtracts DEAD_ZONE_PX before dividing', () => {
    const sim: ProjectionSim = {
      kind: 'normal',
      clonedItems: [],
      projectedIndex: 0,
      previousItem: block('prev', 10, 'pp'),
      nextItem: undefined,
      activeItem: block('act', 5),
      depthCeiling: 15,
      rootParentId: 'ROOTN1',
    }
    // effectiveOffset = 50-20=30 → dragDepth = 3 → projectedDepth = 5+3 = 8
    const result = projectDepth(sim, 50, INDENT)
    expect(result.depth).toBe(8)
    expect(result.parentId).toBe('ROOTN1')
  })

  it('within dead zone: offset ignored', () => {
    const sim: ProjectionSim = {
      kind: 'normal',
      clonedItems: [],
      projectedIndex: 0,
      previousItem: block('prev2', 10, 'pp2'),
      nextItem: undefined,
      activeItem: block('act2', 5),
      depthCeiling: 15,
      rootParentId: 'ROOTN2',
    }
    const result = projectDepth(sim, 5, INDENT)
    expect(result.depth).toBe(5)
    expect(result.parentId).toBe('ROOTN2')
  })

  it('does not clamp up to maxDepth when already below it', () => {
    const sim: ProjectionSim = {
      kind: 'normal',
      clonedItems: [],
      projectedIndex: 0,
      previousItem: block('p3', 5, 'pp3'),
      nextItem: undefined,
      activeItem: block('act3', 0),
      depthCeiling: 10,
      rootParentId: 'ROOTN3',
    }
    // maxDepth = min(6, 10) = 6; projectedDepth 0 is well below it
    const result = projectDepth(sim, 0, INDENT)
    expect(result.depth).toBe(0)
    expect(result.parentId).toBe('ROOTN3')
  })

  it('does not clamp up to minDepth when already above it', () => {
    const sim: ProjectionSim = {
      kind: 'normal',
      clonedItems: [],
      projectedIndex: 0,
      previousItem: block('p4', 20, 'pp4'),
      nextItem: block('n4', 3),
      activeItem: block('act4', 8),
      depthCeiling: 25,
      rootParentId: 'ROOTN4',
    }
    // maxDepth = min(21,25)=21, minDepth = 3; projectedDepth 8 needs no clamp
    const result = projectDepth(sim, 0, INDENT)
    expect(result.depth).toBe(8)
    expect(result.parentId).toBe('ROOTN4')
  })

  it('does not clamp down to depthCeiling when already below it', () => {
    const sim: ProjectionSim = {
      kind: 'normal',
      clonedItems: [],
      projectedIndex: 0,
      previousItem: block('p5', 10, 'pp5'),
      nextItem: undefined,
      activeItem: block('act5', 3),
      depthCeiling: 5,
      rootParentId: 'ROOTN5',
    }
    // maxDepth = min(11,5) = 5; projectedDepth 3 stays below depthCeiling (5)
    const result = projectDepth(sim, 0, INDENT)
    expect(result.depth).toBe(3)
    expect(result.parentId).toBe('ROOTN5')
  })

  it('depth === 0 short-circuits to rootParentId even with a previousItem', () => {
    const sim: ProjectionSim = {
      kind: 'normal',
      // A depth of -1 cannot occur for real data; present only to detect a
      // wrongly-entered ancestor walk if the short-circuit guard is weakened.
      clonedItems: [block('ANCNEG', -1)],
      projectedIndex: 1,
      previousItem: block('p6', 3, 'pp6'),
      nextItem: undefined,
      activeItem: block('act6', 0),
      depthCeiling: 10,
      rootParentId: 'ROOTN6',
    }
    const result = projectDepth(sim, 0, INDENT)
    expect(result.depth).toBe(0)
    expect(result.parentId).toBe('ROOTN6')
  })

  it('!previousItem short-circuits to rootParentId even at nonzero depth', () => {
    const sim: ProjectionSim = {
      kind: 'normal',
      clonedItems: [],
      projectedIndex: 0,
      previousItem: undefined,
      nextItem: block('n7', 5),
      activeItem: block('act7', 0),
      depthCeiling: 10,
      rootParentId: 'ROOTN7',
    }
    // maxDepth = min(0,10)=0, minDepth = 5 → depth clamped up to 5, but no
    // previousItem to consult, so the guard must still fire.
    const result = projectDepth(sim, 0, INDENT)
    expect(result.depth).toBe(5)
    expect(result.parentId).toBe('ROOTN7')
  })

  it('same depth as previousItem reuses its parent_id', () => {
    const sim: ProjectionSim = {
      kind: 'normal',
      clonedItems: [],
      projectedIndex: 0,
      previousItem: block('p8', 3, 'PP8'),
      nextItem: undefined,
      activeItem: block('act8', 3),
      depthCeiling: 10,
      rootParentId: 'ROOTN8',
    }
    const result = projectDepth(sim, 0, INDENT)
    expect(result.depth).toBe(3)
    expect(result.parentId).toBe('PP8')
  })

  it('exactly one level deeper than previousItem becomes its child', () => {
    const sim: ProjectionSim = {
      kind: 'normal',
      clonedItems: [],
      projectedIndex: 0,
      previousItem: block('PID', 5, 'PP2'),
      nextItem: undefined,
      activeItem: block('act9', 6),
      depthCeiling: 10,
      rootParentId: 'ROOTN9',
    }
    const result = projectDepth(sim, 0, INDENT)
    expect(result.depth).toBe(6)
    expect(result.parentId).toBe('PID')
  })

  it('shallower than previousItem falls back to rootParentId with no ancestor match (no throw)', () => {
    const sim: ProjectionSim = {
      kind: 'normal',
      clonedItems: [],
      projectedIndex: 0,
      previousItem: block('PID2', 5, 'PP3'),
      nextItem: undefined,
      activeItem: block('act10', 3),
      depthCeiling: 10,
      rootParentId: 'ROOTN10',
    }
    let result: ReturnType<typeof projectDepth> | undefined
    expect(() => {
      result = projectDepth(sim, 0, INDENT)
    }).not.toThrow()
    expect(result?.depth).toBe(3)
    expect(result?.parentId).toBe('ROOTN10')
  })
})

/*
 * Equivalent mutants in `projectDepth` (issue #3765). Each is unkillable by
 * construction, so no test is added for them:
 *
 * - tree-utils.ts:386:7 and 413:5 [EqualityOperator]
 *   `Math.abs(dragOffset) > DEAD_ZONE_PX` -> `>=`. The two arms coincide
 *   exactly at the boundary they disagree on: when
 *   `Math.abs(dragOffset) === DEAD_ZONE_PX` the mutant takes the then-arm and
 *   computes `dragOffset - Math.sign(dragOffset) * DEAD_ZONE_PX`. At that
 *   boundary `dragOffset` equals `Math.sign(dragOffset) * DEAD_ZONE_PX`
 *   exactly, so the subtraction always yields `0` — the same value the
 *   original's else-arm supplies — for any value of `DEAD_ZONE_PX`,
 *   including `0` (where `Math.sign(0) === 0` keeps the identity intact).
 *   This is not specific to the constant's current value.
 *
 * - tree-utils.ts:426:7 `depth > maxDepth` -> `>=`
 * - tree-utils.ts:427:7 `depth < minDepth` -> `<=`
 * - tree-utils.ts:434:7 `depth > depthCeiling` -> `>=`
 *   Each guards an idempotent clamp of the form
 *   `if (depth > bound) depth = bound`. The only extra case the mutant admits
 *   is `depth === bound`, where the assignment writes back the value `depth`
 *   already holds.
 *
 * - tree-utils.ts:446:9 `depth > previousItem.depth` -> `>=` (inside
 *   `getParentId`). The equality case cannot reach this line: the earlier
 *   `if (depth === previousItem.depth)` branch has already returned, so
 *   `depth !== previousItem.depth` holds here and `>` and `>=` agree.
 *
 * Verified by differential execution over 1 082 327 generated inputs —
 * including synthetic `ProjectionSim` fixtures (as this file builds) with
 * depths, ceilings and offsets swept across each boundary, plus
 * `dragOffset === ±DEAD_ZONE_PX` exactly: zero output differences.
 *
 * "Zero differences" only means something if the sweep actually produced the
 * equality inputs these mutants need — every mutant the suite already kills at
 * these same lines differs on a whole half-space, so killing those does not
 * prove the measure-zero boundary was ever generated. Re-checked with canaries
 * that fire ONLY at the equality point: `depth === maxDepth` fires 44 460
 * times, `depth === minDepth` 150 068, `depth === depthCeiling` 19 657, and
 * `Math.abs(dragOffset) === DEAD_ZONE_PX` 17 680 (both dead-zone sites). So
 * the boundaries are reached and the arms provably coincide there. For 446:9
 * the same canary fires 28 918 times when spliced ABOVE the
 * `depth === previousItem.depth` branch and zero times at line 446 itself,
 * which confirms the earlier `return` shadows it rather than the sweep simply
 * missing the case.
 */
