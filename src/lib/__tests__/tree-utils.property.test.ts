/**
 * Property-based tests for the tree geometry primitives (fast-check).
 *
 * Complements the example-based `tree-utils.test.ts` with generative fuzzing
 * over arbitrary random forests + random drag parameters, pinning the
 * geometric invariants every consumer (useBlockDnD, the optimistic movers,
 * reconcileBatchMove) relies on:
 *
 * 1. `buildFlatTree` output is a valid DFS flatten — parent precedes child,
 *    child depth = parent depth + 1, sibling groups stably position-sorted.
 * 2. `getProjection` NEVER offers a drop the backend rejects — no
 *    self/descendant parenting, depth never past the MAX_BLOCK_DEPTH ceiling,
 *    and the projected parent really sits at `depth - 1`.
 * 3. `computeDropIndex` always returns a slot within [0, live sibling count].
 * 4. `computeSelectionRoots` returns a prefix-free, covering, document-ordered
 *    subset of the selection.
 */

import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { makeBlock } from '../../__tests__/fixtures'
import {
  buildFlatTree,
  computeDropIndex,
  computeSelectionRoots,
  type FlatBlock,
  getDragDescendants,
  getProjection,
  MAX_BLOCK_DEPTH,
  SENTINEL_ID,
} from '../tree-utils'

// -- Configuration ------------------------------------------------------------

/**
 * Runs per property. Lower than the 500 used by the scalar-input suites: each
 * run here builds a forest and replays a full projection, and the suite must
 * stay well under the 20s budget.
 */
const NUM_RUNS = 250

const INDENT = 24

// -- Generators ---------------------------------------------------------------

/**
 * A random forest as a parent-link table: node 0 is always a root; node `i`
 * links to `null` (a new root), to node `i - 1` (chain — biased so deep trees
 * near/above the MAX_BLOCK_DEPTH ceiling are routinely generated), or to a
 * uniformly random earlier node. Positions are random small integers WITH
 * duplicates allowed, so `buildFlatTree`'s stable position sort is exercised.
 */
interface ForestSpec {
  parents: (number | null)[]
  positions: number[]
}

const arbForestSpec: fc.Arbitrary<ForestSpec> = fc
  .integer({ min: 1, max: 24 })
  .chain((n) =>
    fc.tuple(
      fc.array(fc.tuple(fc.nat({ max: 9 }), fc.nat({ max: 4095 })), {
        minLength: n - 1,
        maxLength: n - 1,
      }),
      fc.array(fc.integer({ min: 0, max: 30 }), { minLength: n, maxLength: n }),
    ),
  )
  .map(([links, positions]) => {
    const parents: (number | null)[] = [null]
    for (let i = 1; i <= links.length; i++) {
      const [choice, pick] = links[i - 1] as [number, number]
      if (choice <= 1) {
        parents.push(null) // ~20% new root
      } else if (choice <= 7) {
        parents.push(i - 1) // ~60% chain (deep trees)
      } else {
        parents.push(pick % i) // ~20% random earlier node
      }
    }
    return { parents, positions }
  })

/** Materialise a spec into a bag of BlockRows (ids in creation order). */
function specToRows(spec: ForestSpec): FlatBlock[] {
  return spec.parents.map((p, i) =>
    makeBlock({
      id: `B${String(i).padStart(2, '0')}`,
      parent_id: p === null ? null : `B${String(p).padStart(2, '0')}`,
      position: spec.positions[i] as number,
      depth: 0, // input depth is ignored by buildFlatTree
    }),
  )
}

const arbFlatTree: fc.Arbitrary<FlatBlock[]> = arbForestSpec.map((spec) =>
  buildFlatTree(specToRows(spec), null),
)

/** A flat tree plus drag parameters (active pick, over pick, drag offset). */
const arbDragScenario = fc
  .tuple(
    arbForestSpec,
    fc.nat({ max: 4095 }),
    fc.nat({ max: 4096 }),
    fc.integer({ min: -600, max: 600 }),
  )
  .map(([spec, activePick, overPick, dragOffset]) => {
    const flat = buildFlatTree(specToRows(spec), null)
    const active = flat[activePick % flat.length] as FlatBlock
    const descendants = getDragDescendants(flat, active.id)
    // Mirror useBlockDnD: the active item's descendants are excluded from the
    // candidate items during a drag.
    const items = flat.filter((b) => !descendants.has(b.id))
    // Over target: any candidate row, or the after-last sentinel.
    const overId =
      overPick === 4096 || overPick % (items.length + 1) === items.length
        ? SENTINEL_ID
        : (items[overPick % items.length] as FlatBlock).id
    // True dragged-subtree height, as useBlockDnD computes it.
    let subtreeHeight = 0
    for (const b of flat) {
      if (descendants.has(b.id)) subtreeHeight = Math.max(subtreeHeight, b.depth - active.depth)
    }
    return { flat, items, activeId: active.id, descendants, overId, dragOffset, subtreeHeight }
  })

// -- 1. buildFlatTree is a valid DFS flatten -----------------------------------

describe('property: buildFlatTree DFS validity', () => {
  it('emits every node exactly once, parents before children, depth = parent depth + 1', () => {
    fc.assert(
      fc.property(arbForestSpec, (spec) => {
        const rows = specToRows(spec)
        const flat = buildFlatTree(rows, null)

        // Every node appears exactly once.
        expect(flat).toHaveLength(rows.length)
        expect(new Set(flat.map((b) => b.id)).size).toBe(rows.length)

        const indexOf = new Map(flat.map((b, i) => [b.id, i] as const))
        for (const [i, item] of flat.entries()) {
          if (item.parent_id == null) {
            expect(item.depth).toBe(0)
          } else {
            const pIdx = indexOf.get(item.parent_id)
            // The parent appears, and precedes its child.
            expect(pIdx).toBeDefined()
            expect(pIdx as number).toBeLessThan(i)
            expect(item.depth).toBe((flat[pIdx as number] as FlatBlock).depth + 1)
          }
        }
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('reads as an outline: the nearest preceding shallower row is exactly the parent', () => {
    fc.assert(
      fc.property(arbFlatTree, (flat) => {
        for (const [i, item] of flat.entries()) {
          if (item.depth === 0) continue
          // Walk backwards to the nearest row at depth - 1; in a DFS flatten
          // that row must be the item's parent (subtrees are contiguous).
          let j = i - 1
          while (j >= 0 && (flat[j] as FlatBlock).depth >= item.depth) j--
          expect(j).toBeGreaterThanOrEqual(0)
          const nearest = flat[j] as FlatBlock
          expect(nearest.depth).toBe(item.depth - 1)
          expect(nearest.id).toBe(item.parent_id)
        }
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('orders every sibling group by a STABLE position sort of the input bag', () => {
    fc.assert(
      fc.property(arbForestSpec, (spec) => {
        const rows = specToRows(spec)
        const flat = buildFlatTree(rows, null)

        // Expected group order: input (creation) order stably sorted by
        // position — duplicates keep their relative input order.
        const groups = new Map<string | null, FlatBlock[]>()
        for (const row of rows) {
          const p = row.parent_id ?? null
          const g = groups.get(p)
          if (g) g.push(row)
          else groups.set(p, [row])
        }
        for (const [parent, children] of groups) {
          // `toSorted` is stable, so position duplicates keep input order.
          const stableSorted = children
            .toSorted(
              (a, b) =>
                (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER),
            )
            .map((b) => b.id)
          const actual = flat.filter((b) => (b.parent_id ?? null) === parent).map((b) => b.id)
          expect(actual).toEqual(stableSorted)
        }
      }),
      { numRuns: NUM_RUNS },
    )
  })
})

// -- 2. getProjection never offers an illegal drop ------------------------------

describe('property: getProjection safety', () => {
  it('never projects a parent equal to the dragged block or inside its subtree', () => {
    fc.assert(
      fc.property(
        arbDragScenario,
        ({ items, activeId, descendants, overId, dragOffset, subtreeHeight }) => {
          const proj = getProjection(
            items,
            activeId,
            overId,
            dragOffset,
            INDENT,
            null,
            subtreeHeight,
          )
          expect(proj.parentId).not.toBe(activeId)
          if (proj.parentId != null) {
            expect(descendants.has(proj.parentId)).toBe(false)
          }
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })

  it('never exceeds the MAX_BLOCK_DEPTH ceiling for the dragged subtree', () => {
    fc.assert(
      fc.property(arbDragScenario, ({ items, activeId, overId, dragOffset, subtreeHeight }) => {
        const proj = getProjection(items, activeId, overId, dragOffset, INDENT, null, subtreeHeight)
        // The dragged HEAD may sit no deeper than the ceiling that keeps its
        // tallest descendant at MAX_BLOCK_DEPTH - 1 (clamped to >= 0 for
        // pathologically tall subtrees).
        const ceiling = Math.max(0, MAX_BLOCK_DEPTH - 1 - subtreeHeight)
        expect(proj.depth).toBeGreaterThanOrEqual(0)
        expect(proj.depth).toBeLessThanOrEqual(ceiling)
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('projects a parent whose depth is exactly depth - 1 (or the root at depth 0)', () => {
    fc.assert(
      fc.property(arbDragScenario, ({ items, activeId, overId, dragOffset, subtreeHeight }) => {
        const proj = getProjection(items, activeId, overId, dragOffset, INDENT, null, subtreeHeight)
        if (proj.depth === 0) {
          // rootParentId is null in this scenario.
          expect(proj.parentId).toBeNull()
        } else {
          expect(proj.parentId).not.toBeNull()
          const parent = items.find((b) => b.id === proj.parentId)
          expect(parent).toBeDefined()
          expect((parent as FlatBlock).depth).toBe(proj.depth - 1)
        }
      }),
      { numRuns: NUM_RUNS },
    )
  })
})

// -- 3. computeDropIndex slot bounds --------------------------------------------

describe('property: computeDropIndex slot bounds', () => {
  it('always returns a slot within [0, live sibling count] for the projected parent', () => {
    fc.assert(
      fc.property(arbDragScenario, ({ items, activeId, overId, dragOffset, subtreeHeight }) => {
        const proj = getProjection(items, activeId, overId, dragOffset, INDENT, null, subtreeHeight)
        const slot = computeDropIndex(items, proj.parentId, overId, activeId)

        // Live siblings: the projected parent's children among the candidate
        // items, excluding the moved block itself (backend slot basis, #400).
        const parentDepth =
          proj.parentId === null
            ? -1
            : (items.find((b) => b.id === proj.parentId) as FlatBlock).depth
        const liveSiblings = items.filter(
          (b) =>
            b.id !== activeId &&
            (b.parent_id ?? null) === proj.parentId &&
            b.depth === parentDepth + 1,
        ).length

        expect(Number.isInteger(slot)).toBe(true)
        expect(slot).toBeGreaterThanOrEqual(0)
        expect(slot).toBeLessThanOrEqual(liveSiblings)
      }),
      { numRuns: NUM_RUNS },
    )
  })
})

// -- 4. computeSelectionRoots is prefix-free and covering ------------------------

describe('property: computeSelectionRoots', () => {
  /** Ancestor chain of `id` (nearest first), from parent links. */
  function ancestorsOf(flat: FlatBlock[], id: string): string[] {
    const parentOf = new Map(flat.map((b) => [b.id, b.parent_id ?? null] as const))
    const chain: string[] = []
    let cur = parentOf.get(id) ?? null
    while (cur != null) {
      chain.push(cur)
      cur = parentOf.get(cur) ?? null
    }
    return chain
  }

  const arbTreeAndSelection = arbForestSpec.chain((spec) => {
    const flat = buildFlatTree(specToRows(spec), null)
    return fc
      .subarray(
        flat.map((b) => b.id),
        { minLength: 0, maxLength: flat.length },
      )
      .map((selected) => ({ flat, selected }))
  })

  it('returns a document-ordered, prefix-free subset covering every selected id', () => {
    fc.assert(
      fc.property(arbTreeAndSelection, ({ flat, selected }) => {
        const roots = computeSelectionRoots(flat, selected)
        const rootSet = new Set(roots)
        const selectedSet = new Set(selected)

        // Subset of the selection, no duplicates.
        expect(rootSet.size).toBe(roots.length)
        for (const r of roots) expect(selectedSet.has(r)).toBe(true)

        // Document order (ascending flat indices).
        const indexOf = new Map(flat.map((b, i) => [b.id, i] as const))
        const indices = roots.map((r) => indexOf.get(r) as number)
        expect(indices).toEqual([...indices].toSorted((a, b) => a - b))

        // Prefix-free: no root is a descendant of another root.
        for (const r of roots) {
          expect(ancestorsOf(flat, r).some((a) => rootSet.has(a))).toBe(false)
        }

        // Covering: every selected id is a root or nests inside some root.
        for (const s of selected) {
          const covered = rootSet.has(s) || ancestorsOf(flat, s).some((a) => rootSet.has(a))
          expect(covered).toBe(true)
        }
      }),
      { numRuns: NUM_RUNS },
    )
  })
})
