/**
 * Unit tests for the nested tag-query builder (#1426 / #1472).
 *
 * The builder models the backend's full nested `TagExpr` tree — `And` / `Or`
 * groups, `Tag` / `Prefix` leaves, per-node `Not` — now reachable over IPC via
 * `query_by_tag_expr`. These tests assert the COMPILED `TagExpr`, i.e. the
 * literal tree the resolver evaluates, so what the builder produces is run
 * faithfully (never silently flattened or dropped).
 */

import { describe, expect, it } from 'vitest'

import {
  type TagBuilderGroup,
  addChild,
  compileTagExpr,
  emptyTagBuilder,
  makeGroup,
  makePrefixLeaf,
  makeTagLeaf,
  removeNode,
  setGroupOp,
  tagBuilderHasLeaves,
  toggleNegated,
} from '@/lib/tagExpr'

describe('compileTagExpr', () => {
  it('compiles an empty root to null (no query yet)', () => {
    expect(compileTagExpr(emptyTagBuilder())).toBeNull()
  })

  it('collapses a single tag leaf to a bare Tag (no vacuous And wrapper)', () => {
    const r = emptyTagBuilder()
    const withTag = addChild(r, r.id, makeTagLeaf('T1', 'work'))
    expect(compileTagExpr(withTag)).toEqual({ type: 'Tag', value: 'T1' })
  })

  it('compiles a single prefix leaf to a bare Prefix', () => {
    const r = emptyTagBuilder()
    const withPrefix = addChild(r, r.id, makePrefixLeaf('proj'))
    expect(compileTagExpr(withPrefix)).toEqual({ type: 'Prefix', value: 'proj' })
  })

  it('combines two leaves under And', () => {
    let r = emptyTagBuilder()
    r = addChild(r, r.id, makeTagLeaf('A', 'a'))
    r = addChild(r, r.id, makeTagLeaf('B', 'b'))
    expect(compileTagExpr(r)).toEqual({
      type: 'And',
      value: [
        { type: 'Tag', value: 'A' },
        { type: 'Tag', value: 'B' },
      ],
    })
  })

  it('honours the Or combinator and mixes tag + prefix leaves', () => {
    const root = emptyTagBuilder()
    let r: TagBuilderGroup = setGroupOp(root, root.id, 'or')
    r = addChild(r, root.id, makeTagLeaf('T1', 'work'))
    r = addChild(r, root.id, makePrefixLeaf('proj'))
    expect(compileTagExpr(r)).toEqual({
      type: 'Or',
      value: [
        { type: 'Tag', value: 'T1' },
        { type: 'Prefix', value: 'proj' },
      ],
    })
  })

  it('wraps a negated leaf in Not(..)', () => {
    const root = emptyTagBuilder()
    const leaf = makeTagLeaf('C', 'gamma')
    let r = addChild(root, root.id, leaf)
    r = toggleNegated(r, leaf.id)
    expect(compileTagExpr(r)).toEqual({ type: 'Not', value: { type: 'Tag', value: 'C' } })
  })

  it('builds the headline (A AND B) OR (NOT C) tree', () => {
    const root = emptyTagBuilder()
    let r = setGroupOp(root, root.id, 'or')

    // Sub-group (A AND B).
    const ab = makeGroup('and')
    r = addChild(r, root.id, ab)
    const a = makeTagLeaf('A', 'a')
    const b = makeTagLeaf('B', 'b')
    r = addChild(r, ab.id, a)
    r = addChild(r, ab.id, b)

    // Sub-group holding NOT C (single-child collapses to Not(Tag C)).
    const cGroup = makeGroup('and')
    r = addChild(r, root.id, cGroup)
    const c = makeTagLeaf('C', 'c')
    r = addChild(r, cGroup.id, c)
    r = toggleNegated(r, c.id)

    expect(compileTagExpr(r)).toEqual({
      type: 'Or',
      value: [
        {
          type: 'And',
          value: [
            { type: 'Tag', value: 'A' },
            { type: 'Tag', value: 'B' },
          ],
        },
        { type: 'Not', value: { type: 'Tag', value: 'C' } },
      ],
    })
  })

  it('drops empty groups so a half-built tree never injects And([])', () => {
    let r = emptyTagBuilder()
    r = addChild(r, r.id, makeTagLeaf('T1', 'work'))
    // An empty sub-group adds no leaf and must be pruned from the compiled tree.
    r = addChild(r, r.id, makeGroup('and'))
    expect(compileTagExpr(r)).toEqual({ type: 'Tag', value: 'T1' })
  })

  it('drops a whitespace-only prefix leaf', () => {
    const root = emptyTagBuilder()
    const withBlank = addChild(root, root.id, makePrefixLeaf('   '))
    expect(compileTagExpr(withBlank)).toBeNull()
  })
})

describe('immutable tree updates', () => {
  it('removeNode drops a node by id without mutating the original', () => {
    const root = emptyTagBuilder()
    const a = makeTagLeaf('A', 'a')
    const b = makeTagLeaf('B', 'b')
    let r = addChild(root, root.id, a)
    r = addChild(r, root.id, b)
    const next = removeNode(r, b.id)
    expect(compileTagExpr(next)).toEqual({ type: 'Tag', value: 'A' })
    expect(r.children).toHaveLength(2) // original untouched
  })

  it('setGroupOp changes a nested group combinator immutably', () => {
    const root = emptyTagBuilder()
    const next = setGroupOp(root, root.id, 'or')
    expect(next.op).toBe('or')
    expect(root.op).toBe('and') // original untouched
  })

  it('toggleNegated flips a deep node only', () => {
    const root = emptyTagBuilder()
    const g = makeGroup('and')
    let r = addChild(root, root.id, g)
    const leaf = makeTagLeaf('X', 'x')
    r = addChild(r, g.id, leaf)
    const toggled = toggleNegated(r, leaf.id)
    expect(compileTagExpr(toggled)).toEqual({
      type: 'Not',
      value: { type: 'Tag', value: 'X' },
    })
  })
})

describe('tagBuilderHasLeaves', () => {
  it('is false for an empty root group', () => {
    expect(tagBuilderHasLeaves(emptyTagBuilder())).toBe(false)
  })

  it('is false for a root holding only an empty sub-group', () => {
    const root = emptyTagBuilder()
    const r = addChild(root, root.id, makeGroup('and'))
    expect(tagBuilderHasLeaves(r)).toBe(false)
  })

  it('is true once any leaf is added (even nested)', () => {
    const root = emptyTagBuilder()
    const g = makeGroup('and')
    let r = addChild(root, root.id, g)
    r = addChild(r, g.id, makePrefixLeaf('x'))
    expect(tagBuilderHasLeaves(r)).toBe(true)
  })
})
