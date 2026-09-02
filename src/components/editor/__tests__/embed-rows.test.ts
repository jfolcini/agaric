/**
 * Embedded-row selection and depth re-basing (#4550).
 *
 * The failure this guards against is quiet and compounding: without the
 * re-base, a target at storage depth 19 renders 19 indent levels INSIDE a
 * container that may itself sit at depth 19 of the host page, and every
 * embedded row's `aria-level` is announced at the source page's level rather
 * than the host's.
 */

import { describe, expect, it } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import { embedAncestors, selectEmbeddedRows } from '@/components/editor/embed/embed-rows'
import type { FlatBlock } from '@/lib/tree-utils'

/** PAGE › A(0) › B(1) › TARGET(2) › CHILD(3) › GRAND(4), then SIBLING(1). */
const flat: FlatBlock[] = [
  makeBlock({ id: 'A', parent_id: 'PAGE', depth: 0, content: 'A' }),
  makeBlock({ id: 'B', parent_id: 'A', depth: 1, content: 'B' }),
  makeBlock({ id: 'TARGET', parent_id: 'B', depth: 2, content: 'target' }),
  makeBlock({ id: 'CHILD', parent_id: 'TARGET', depth: 3, content: 'child' }),
  makeBlock({ id: 'GRAND', parent_id: 'CHILD', depth: 4, content: 'grand' }),
  makeBlock({ id: 'SIBLING', parent_id: 'A', depth: 1, content: 'sibling' }),
]

describe('selectEmbeddedRows', () => {
  it('takes the target and its descendants, re-based to depth 0', () => {
    const { rows, hiddenCount, missing } = selectEmbeddedRows(flat, 'TARGET', 'PAGE', 32)
    expect(missing).toBe(false)
    expect(hiddenCount).toBe(0)
    expect(rows.map((r) => [r.id, r.depth])).toEqual([
      ['TARGET', 0],
      ['CHILD', 1],
      ['GRAND', 2],
    ])
  })

  it('stops at the first row that is not a descendant', () => {
    const { rows } = selectEmbeddedRows(flat, 'TARGET', 'PAGE', 32)
    expect(rows.map((r) => r.id)).not.toContain('SIBLING')
  })

  it('leaves the source rows untouched (no in-place depth mutation)', () => {
    selectEmbeddedRows(flat, 'TARGET', 'PAGE', 32)
    // A re-base that mutated the store's own rows would silently re-indent
    // the SOURCE page for everyone else looking at it.
    expect(flat.map((b) => b.depth)).toEqual([0, 1, 2, 3, 4, 1])
  })

  it('renders the whole page for a page target, which is already depth-0', () => {
    const { rows } = selectEmbeddedRows(flat, 'PAGE', 'PAGE', 32)
    expect(rows).toHaveLength(flat.length)
    expect(rows[0]?.depth).toBe(0)
  })

  it('reports a target that is absent from the source page', () => {
    expect(selectEmbeddedRows(flat, 'NOPE', 'PAGE', 32)).toEqual({
      rows: [],
      hiddenCount: 0,
      missing: true,
    })
  })

  it('truncates at the mount limit and reports the remainder', () => {
    const { rows, hiddenCount } = selectEmbeddedRows(flat, 'TARGET', 'PAGE', 2)
    expect(rows.map((r) => r.id)).toEqual(['TARGET', 'CHILD'])
    expect(hiddenCount).toBe(1)
  })
})

describe('embedAncestors', () => {
  const byId = new Map(flat.map((b) => [b.id, b]))

  it('walks parents up to (but excluding) the page root, outermost first', () => {
    expect(embedAncestors(byId, 'TARGET', 'PAGE').map((b) => b.id)).toEqual(['A', 'B'])
  })

  it('returns nothing for a top-level block', () => {
    expect(embedAncestors(byId, 'A', 'PAGE')).toEqual([])
  })

  it('terminates on a cyclic parent chain rather than spinning', () => {
    const cyclic = new Map<string, FlatBlock>([
      ['X', makeBlock({ id: 'X', parent_id: 'Y', depth: 1 })],
      ['Y', makeBlock({ id: 'Y', parent_id: 'X', depth: 1 })],
    ])
    expect(embedAncestors(cyclic, 'X', 'PAGE').map((b) => b.id)).toEqual(['Y'])
  })
})
