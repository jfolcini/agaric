import { describe, expect, it } from 'vitest'

import {
  canFold,
  carriedEnd,
  foldEnd,
  foldsOver,
  headingLevel,
  hiddenRows,
  outlineOf,
  stepOver,
} from '@/lib/section-fold'

/** An outline from `[depth, content]` pairs. */
const outline = (rows: [number, string][]) =>
  outlineOf(rows.map(([depth, content], i) => ({ id: `r${i}`, depth, content })))

describe('headingLevel', () => {
  it('reads the level of the heading a block opens with', () => {
    expect(headingLevel('# A')).toBe(1)
    expect(headingLevel('### C\nbody')).toBe(3)
    expect(headingLevel('###### F')).toBe(6)
  })

  it('is null for a tag, seven marks, a heading on a later line, or no text', () => {
    expect(headingLevel('#tag')).toBeNull()
    expect(headingLevel('####### G')).toBeNull()
    expect(headingLevel('text\n# B')).toBeNull()
    expect(headingLevel('#\nB')).toBeNull()
    expect(headingLevel(null)).toBeNull()
  })
})

describe('foldEnd', () => {
  const page = outline([
    [0, '# One'], // 0
    [0, 'a'], // 1
    [0, '## Two'], // 2
    [1, 'child of two'], // 3
    [0, 'b'], // 4
    [0, '### Three'], // 5
    [0, 'c'], // 6
    [0, '## Four'], // 7
    [0, 'd'], // 8
    [0, '# Five'], // 9
    [0, 'e'], // 10
  ])

  it('folds an H2 up to the next H2 and stops there', () => {
    expect(foldEnd(page, 2)).toBe(7)
  })

  it('folds an H1 past its H2 sections up to the next H1', () => {
    expect(foldEnd(page, 0)).toBe(9)
  })

  it('folds a deeper heading up to the next heading of its level or higher', () => {
    expect(foldEnd(page, 5)).toBe(7)
  })

  it('folds a block only the rows under it', () => {
    expect(foldEnd(page, 3)).toBe(4)
    expect(foldEnd(page, 1)).toBe(2)
  })

  it('runs to the end with no next heading, and folds nothing for the last row', () => {
    expect(foldEnd(page, 9)).toBe(11)
    expect(foldEnd(page, 10)).toBe(11)
  })

  it("keeps a nested heading's fold within its parent", () => {
    const nested = outline([
      [0, 'parent'], // 0
      [1, '## Inner'], // 1
      [1, 'x'], // 2
      [0, 'after parent'], // 3
    ])
    expect(foldEnd(nested, 1)).toBe(3)
  })

  it('carries a heading past deeper headings under its siblings', () => {
    const deep = outline([
      [0, '## Two'], // 0
      [0, 'a'], // 1
      [1, '# Deeper H1'], // 2
      [0, 'b'], // 3
      [0, '## Next'], // 4
    ])
    expect(foldEnd(deep, 0)).toBe(4)
  })
})

describe('canFold', () => {
  it('is true for a heading with only siblings in its section, false for one right before its peer', () => {
    const page = outline([
      [0, '## A'],
      [0, 'a'],
      [0, '## B'],
      [0, '## C'],
    ])
    expect(canFold(page, 0)).toBe(true)
    expect(canFold(page, 2)).toBe(false)
    expect(canFold(page, 3)).toBe(false)
    expect(canFold(page, 1)).toBe(false)
  })
})

describe('hiddenRows', () => {
  const page = outline([
    [0, '# One'], // 0
    [0, '## Two'], // 1
    [0, 'a'], // 2
    [1, 'a1'], // 3
    [0, '## Three'], // 4
    [0, 'b'], // 5
    [0, '# Four'], // 6
  ])

  it("hides a folded H1's nested sections, and its unfold shows each inner fold as it was", () => {
    const folded = new Set([0, 1, 2])
    expect(hiddenRows(page, (i) => folded.has(i))).toEqual([
      false,
      true,
      true,
      true,
      true,
      true,
      false,
    ])
    folded.delete(0)
    expect(hiddenRows(page, (i) => folded.has(i))).toEqual([
      false,
      false,
      true,
      true,
      false,
      false,
      false,
    ])
  })

  it('hides nothing with nothing folded', () => {
    expect(hiddenRows(page, () => false).some(Boolean)).toBe(false)
  })
})

describe('foldsOver', () => {
  it('names every folded row whose fold holds the target, and none whose fold stops before it', () => {
    const page = outline([
      [0, '# One'], // 0
      [0, 'a'], // 1
      [1, 'a1'], // 2
      [0, '# Two'], // 3
      [0, 'b'], // 4
    ])
    expect(foldsOver(page, 'r2', new Set(['r0', 'r1', 'r3']))).toEqual(['r0', 'r1'])
    expect(foldsOver(page, 'r4', new Set(['r0', 'r1', 'r3']))).toEqual(['r3'])
    expect(foldsOver(page, 'r3', new Set(['r0', 'r1']))).toEqual([])
    expect(foldsOver(page, 'gone', new Set(['r0']))).toEqual([])
  })
})

describe('carriedEnd and stepOver', () => {
  const page = outline([
    [0, 'p'], // 0
    [0, '## One'], // 1
    [1, 'child of one'], // 2
    [0, 'in one'], // 3
    [0, '## Two'], // 4
    [0, 'in two'], // 5
  ])
  const carryWith = (folded: ReadonlySet<number>) => (index: number) =>
    carriedEnd(page, index, folded.has(index))

  it('carries a folded heading’s section, and an unfolded one only the rows under it', () => {
    expect(carriedEnd(page, 1, true)).toBe(4)
    expect(carriedEnd(page, 1, false)).toBe(3)
    expect(carriedEnd(page, 5, true)).toBe(6)
  })

  it('steps a move over a folded sibling and what it hides, either way', () => {
    const carry = carryWith(new Set([1]))
    expect(stepOver(page, carry, 4, -1)).toEqual({ end: 5, to: 1 })
    expect(stepOver(page, carry, 0, 1)).toEqual({ end: 1, to: 4 })
  })

  it('steps to the next sibling where nothing is folded', () => {
    const carry = carryWith(new Set())
    expect(stepOver(page, carry, 4, -1)).toEqual({ end: 5, to: 3 })
    expect(stepOver(page, carry, 1, 1)).toEqual({ end: 3, to: 4 })
  })

  it('has no sibling to step to for a first or last child', () => {
    const carry = carryWith(new Set([4]))
    expect(stepOver(page, carry, 2, -1)).toEqual({ end: 3, to: null })
    expect(stepOver(page, carry, 4, 1)).toEqual({ end: 6, to: null })
    expect(stepOver(page, carry, 0, -1)).toEqual({ end: 1, to: null })
  })
})
