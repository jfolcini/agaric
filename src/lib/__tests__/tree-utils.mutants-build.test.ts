/**
 * Mutation-kill tests for src/lib/tree-utils.ts, scoped to issue #3142's
 * surviving StrykerJS mutants in the module constants, `buildFlatTree`, and
 * `computeSelectionRoots`:
 *   - tree-utils.ts:14  [StringLiteral]        SENTINEL_ID
 *   - tree-utils.ts:85  [EqualityOperator]      depth > MAX_TREE_DEPTH guard
 *   - tree-utils.ts:186 [ConditionalExpression] selected.size === 0 early return
 *   - tree-utils.ts:192 [ArrayDeclaration]      const ancestorStack: string[] = []
 *
 * Owned by this file only — do not add cases here for other survivors in
 * this module (sibling agents own those in separate files).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { makeBlock } from '@/__tests__/fixtures'
import { logger } from '@/lib/logger'
import { buildFlatTree, computeSelectionRoots, type FlatBlock, SENTINEL_ID } from '@/lib/tree-utils'

const mockedLoggerWarn = vi.mocked(logger.warn)

beforeEach(() => {
  mockedLoggerWarn.mockClear()
})

// ── tree-utils.ts:14 [StringLiteral] SENTINEL_ID ──────────────────────────

describe('SENTINEL_ID', () => {
  it('is the exact drop-after-last sentinel string, not blanked', () => {
    // A StringLiteral mutant blanks this to ''. Assert the literal value
    // directly since SENTINEL_ID's consumers (simulateProjection et al.)
    // are out of this file's scope.
    expect(SENTINEL_ID).toBe('__drop-after-last__')
    expect(SENTINEL_ID).not.toBe('')
  })
})

// ── tree-utils.ts:85 [EqualityOperator] depth > MAX_TREE_DEPTH ────────────

describe('buildFlatTree depth guard (MAX_TREE_DEPTH boundary)', () => {
  it('includes the item at exactly depth 1000 but stops before depth 1001', () => {
    // MAX_TREE_DEPTH is an internal (unexported) constant documented in
    // tree-utils.ts as 1000. Build a linear chain deep enough to straddle
    // the boundary: chain-0 (depth 0) .. chain-1001 (depth 1001).
    const CHAIN_LENGTH = 1002
    const blocks = Array.from({ length: CHAIN_LENGTH }, (_, i) =>
      makeBlock({
        id: `chain-${i}`,
        parent_id: i === 0 ? null : `chain-${i - 1}`,
        position: 0,
      }),
    )

    const result = buildFlatTree(blocks)

    // Original `depth > MAX_TREE_DEPTH`: dfs pushes depths 0..1000 (1001
    // items) then bails on depth 1001 without pushing chain-1001.
    // Mutant `depth >= MAX_TREE_DEPTH` would bail one level earlier,
    // dropping chain-1000 too and leaving only 1000 items.
    // Forced-true/forced-false ConditionalExpression variants would yield
    // 0 items or all 1002 items respectively — all four outcomes differ.
    expect(result).toHaveLength(1001)
    expect(result.at(-1)).toMatchObject({ id: 'chain-1000', depth: 1000 })
    expect(result.some((b) => b.id === 'chain-1001')).toBe(false)
    expect(mockedLoggerWarn).toHaveBeenCalledTimes(1)
  })

  it('does not trigger the depth guard for a shallow tree', () => {
    // Kills a forced-true mutant: a shallow tree must NOT be truncated.
    const blocks = [
      makeBlock({ id: 'root', parent_id: null, position: 0 }),
      makeBlock({ id: 'child', parent_id: 'root', position: 0 }),
      makeBlock({ id: 'grandchild', parent_id: 'child', position: 0 }),
    ]

    const result = buildFlatTree(blocks)

    expect(result).toEqual([
      expect.objectContaining({ id: 'root', depth: 0 }),
      expect.objectContaining({ id: 'child', depth: 1 }),
      expect.objectContaining({ id: 'grandchild', depth: 2 }),
    ])
    expect(mockedLoggerWarn).not.toHaveBeenCalled()
  })
})

// ── tree-utils.ts:186 [ConditionalExpression] selected.size === 0 ────────
// ── tree-utils.ts:192 [ArrayDeclaration] ancestorStack init ──────────────

describe('computeSelectionRoots', () => {
  it('returns [] for an empty selection', () => {
    const items: FlatBlock[] = [
      makeBlock({ id: 'a', parent_id: null, position: 0, depth: 0 }),
      makeBlock({ id: 'b', parent_id: 'a', position: 0, depth: 1 }),
    ]
    expect(computeSelectionRoots(items, [])).toEqual([])
  })

  it('computes real roots for a non-empty selection across a nested, sibling-ordered tree', () => {
    // Structure (document order, depth in parens):
    //   root1 (0)
    //     childA (1)          <- selected, nested under selected root1 => dropped
    //       grandchildA1 (2)  <- selected, nested under selected root1 => dropped
    //     childB (1)          <- not selected
    //   root2 (0)             <- selected, top-level => root
    //     onlyChild (1)       <- selected, nested under selected root2 => dropped
    //   root3 (0)             <- selected, no selected ancestor => root
    const items: FlatBlock[] = [
      makeBlock({ id: 'root1', parent_id: null, position: 0, depth: 0 }),
      makeBlock({ id: 'childA', parent_id: 'root1', position: 0, depth: 1 }),
      makeBlock({ id: 'grandchildA1', parent_id: 'childA', position: 0, depth: 2 }),
      makeBlock({ id: 'childB', parent_id: 'root1', position: 1, depth: 1 }),
      makeBlock({ id: 'root2', parent_id: null, position: 1, depth: 0 }),
      makeBlock({ id: 'onlyChild', parent_id: 'root2', position: 0, depth: 1 }),
      makeBlock({ id: 'root3', parent_id: null, position: 2, depth: 0 }),
    ]
    const selected = new Set(['root1', 'childA', 'grandchildA1', 'root2', 'onlyChild', 'root3'])

    const roots = computeSelectionRoots(items, selected)

    // A forced-true (or === -> !== flipped) ConditionalExpression mutant
    // at line 186 would short-circuit to `[]` here since selected.size !== 0
    // — asserting the real, non-empty, order-preserving root set kills it.
    expect(roots).toEqual(['root1', 'root2', 'root3'])
  })

  it('handles a single selected leaf with no children (no false nesting)', () => {
    const items: FlatBlock[] = [makeBlock({ id: 'lonely', parent_id: null, position: 0, depth: 0 })]
    expect(computeSelectionRoots(items, new Set(['lonely']))).toEqual(['lonely'])
  })
})

/*
 * Note on tree-utils.ts:192 [ArrayDeclaration]:
 * `const ancestorStack: string[] = []` mutates to a non-empty seeded array
 * (e.g. `['Stryker was here!']`). This is an EQUIVALENT mutant: every valid
 * input to computeSelectionRoots is a full DFS-flattened list, so items[0]
 * always has depth 0 (documented invariant of buildFlatTree's output). The
 * very first loop iteration executes `ancestorStack.length = item.depth`
 * (line 196) BEFORE any read of the array's contents (line 199's `.some()`),
 * which for depth 0 truncates the array back to length 0 — destroying any
 * seeded placeholder before it can ever be observed. No valid fixture can
 * distinguish the mutant from the original without contriving a selected id
 * equal to Stryker's literal placeholder string, which is not a realistic
 * test.
 *
 * Re-confirmed for #3765 by differential execution (original vs mutant over
 * 885 205 generated inputs, including lists whose FIRST item has depth > 0 —
 * the one shape that leaves the seeded element un-truncated): the outputs are
 * identical everywhere. Even then the seeded id is only ever passed to
 * `selected.has(...)`, so it can change the result only if the caller selects
 * Stryker's own placeholder string.
 */

/*
 * Note on tree-utils.ts:193:7 [ConditionalExpression]
 * `selected.size === 0` -> `false`:
 * EQUIVALENT. The mutant only deletes the empty-selection fast path. With an
 * empty selection the loop still runs, `selected.has(item.id)` is false for
 * every item, nothing is pushed, and the function returns an equally empty
 * array — the guard short-circuits work, it does not decide behaviour. (The
 * forced-TRUE direction of the same mutant IS killed, by the non-empty
 * selection test above.)
 */
