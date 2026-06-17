import { beforeEach, describe, expect, it } from 'vitest'

import type { AggregateSpec, FilterPrimitive, GroupSpec, SortKey } from '@/lib/tauri'

import {
  type BuilderGroupNode,
  builderTreeToFilterExpr,
  selectAdvancedQueryBuilderForSpace,
  selectAdvancedQueryControlsForSpace,
  selectAdvancedQueryFiltersForSpace,
  useAdvancedQueryStore,
} from '../advancedQuery'

const SPACE = 'SPACE_A'

beforeEach(() => {
  useAdvancedQueryStore.setState({
    filtersBySpace: {},
    buildersBySpace: {},
    controlsBySpace: {},
    nextAddId: 0,
  })
})

const TAG = (tag: string): FilterPrimitive => ({ type: 'Tag', tag })

describe('advancedQuery store — controls', () => {
  it('returns a stable frozen empty controls slice for an absent space', () => {
    const a = selectAdvancedQueryControlsForSpace(useAdvancedQueryStore.getState(), SPACE)
    const b = selectAdvancedQueryControlsForSpace(useAdvancedQueryStore.getState(), 'SPACE_B')
    // Same frozen default reference for any absent slice (referential idempotency).
    expect(a).toBe(b)
    expect(a).toEqual({ fulltext: '', sort: [], groupBy: null, aggregates: [] })
  })

  it('sets the full-text term per space and is a no-op when unchanged', () => {
    useAdvancedQueryStore.getState().setFulltext(SPACE, 'hello')
    expect(
      selectAdvancedQueryControlsForSpace(useAdvancedQueryStore.getState(), SPACE).fulltext,
    ).toBe('hello')

    const before = useAdvancedQueryStore.getState().controlsBySpace
    useAdvancedQueryStore.getState().setFulltext(SPACE, 'hello')
    // Identical value ⇒ same state object (no churn).
    expect(useAdvancedQueryStore.getState().controlsBySpace).toBe(before)
  })

  it('replaces the ordered sort keys', () => {
    const sort: SortKey[] = [
      { source: { type: 'Column', name: 'priority' }, desc: true },
      { source: { type: 'Relevance' } },
    ]
    useAdvancedQueryStore.getState().setSort(SPACE, sort)
    expect(
      selectAdvancedQueryControlsForSpace(useAdvancedQueryStore.getState(), SPACE).sort,
    ).toEqual(sort)
  })

  it('sets and clears the grouping directive', () => {
    const groupBy: GroupSpec = { key: { type: 'Tag' } }
    useAdvancedQueryStore.getState().setGroupBy(SPACE, groupBy)
    expect(
      selectAdvancedQueryControlsForSpace(useAdvancedQueryStore.getState(), SPACE).groupBy,
    ).toEqual(groupBy)

    useAdvancedQueryStore.getState().setGroupBy(SPACE, null)
    expect(
      selectAdvancedQueryControlsForSpace(useAdvancedQueryStore.getState(), SPACE).groupBy,
    ).toBeNull()
  })

  it('replaces the aggregate specs', () => {
    const aggregates: AggregateSpec[] = [
      { op: 'count', target: null },
      { op: 'sum', target: { type: 'Column', name: 'position' } },
    ]
    useAdvancedQueryStore.getState().setAggregates(SPACE, aggregates)
    expect(
      selectAdvancedQueryControlsForSpace(useAdvancedQueryStore.getState(), SPACE).aggregates,
    ).toEqual(aggregates)
  })

  it('partitions controls per space (no cross-space bleed)', () => {
    useAdvancedQueryStore.getState().setFulltext(SPACE, 'space-a-term')
    useAdvancedQueryStore.getState().setFulltext('SPACE_B', 'space-b-term')
    expect(
      selectAdvancedQueryControlsForSpace(useAdvancedQueryStore.getState(), SPACE).fulltext,
    ).toBe('space-a-term')
    expect(
      selectAdvancedQueryControlsForSpace(useAdvancedQueryStore.getState(), 'SPACE_B').fulltext,
    ).toBe('space-b-term')
  })

  it('leaves the chip API working alongside the new controls', () => {
    useAdvancedQueryStore.getState().addFilter(SPACE, { type: 'Tag', tag: 'project' })
    useAdvancedQueryStore.getState().setFulltext(SPACE, 'hi')
    const filters = selectAdvancedQueryFiltersForSpace(useAdvancedQueryStore.getState(), SPACE)
    expect(filters).toHaveLength(1)
    expect(filters[0]).toMatchObject({ type: 'Tag', tag: 'project' })
    expect(
      selectAdvancedQueryControlsForSpace(useAdvancedQueryStore.getState(), SPACE).fulltext,
    ).toBe('hi')
  })
})

// --- #1280 D3: builderTreeToFilterExpr converter -------------------------------

describe('builderTreeToFilterExpr', () => {
  const group = (over: Partial<BuilderGroupNode> = {}): BuilderGroupNode => ({
    kind: 'group',
    id: 0,
    op: 'And',
    negated: false,
    children: [],
    ...over,
  })

  it('compiles an empty root And group to And{[]} (match everything)', () => {
    expect(builderTreeToFilterExpr(group())).toEqual({ type: 'And', children: [] })
  })

  it('compiles an empty Or group to Or{[]} (FALSE)', () => {
    expect(builderTreeToFilterExpr(group({ op: 'Or' }))).toEqual({ type: 'Or', children: [] })
  })

  it('maps a leaf child to {type:Leaf, primitive}', () => {
    const root = group({
      children: [{ kind: 'leaf', id: 1, primitive: TAG('a'), negated: false }],
    })
    expect(builderTreeToFilterExpr(root)).toEqual({
      type: 'And',
      children: [{ type: 'Leaf', primitive: TAG('a') }],
    })
  })

  it('wraps a negated leaf in Not', () => {
    const root = group({
      children: [{ kind: 'leaf', id: 1, primitive: TAG('a'), negated: true }],
    })
    expect(builderTreeToFilterExpr(root)).toEqual({
      type: 'And',
      children: [{ type: 'Not', child: { type: 'Leaf', primitive: TAG('a') } }],
    })
  })

  it('wraps a negated group in Not around the whole And/Or', () => {
    const root = group({
      op: 'Or',
      negated: true,
      children: [
        { kind: 'leaf', id: 1, primitive: TAG('a'), negated: false },
        { kind: 'leaf', id: 2, primitive: TAG('b'), negated: false },
      ],
    })
    expect(builderTreeToFilterExpr(root)).toEqual({
      type: 'Not',
      child: {
        type: 'Or',
        children: [
          { type: 'Leaf', primitive: TAG('a') },
          { type: 'Leaf', primitive: TAG('b') },
        ],
      },
    })
  })

  it('compiles a nested mixed And/Or tree with leaf- and group-negation', () => {
    const root = group({
      op: 'And',
      children: [
        { kind: 'leaf', id: 1, primitive: TAG('top'), negated: false },
        {
          kind: 'group',
          id: 2,
          op: 'Or',
          negated: true,
          children: [
            { kind: 'leaf', id: 3, primitive: TAG('x'), negated: false },
            { kind: 'leaf', id: 4, primitive: TAG('y'), negated: true },
          ],
        },
      ],
    })
    expect(builderTreeToFilterExpr(root)).toEqual({
      type: 'And',
      children: [
        { type: 'Leaf', primitive: TAG('top') },
        {
          type: 'Not',
          child: {
            type: 'Or',
            children: [
              { type: 'Leaf', primitive: TAG('x') },
              { type: 'Not', child: { type: 'Leaf', primitive: TAG('y') } },
            ],
          },
        },
      ],
    })
  })
})

// --- #1280 D3: builder store actions ------------------------------------------

describe('advancedQuery store — nested builder', () => {
  const builder = (): BuilderGroupNode =>
    selectAdvancedQueryBuilderForSpace(useAdvancedQueryStore.getState(), SPACE)

  it('returns a stable frozen default root And group for an absent space', () => {
    const a = selectAdvancedQueryBuilderForSpace(useAdvancedQueryStore.getState(), SPACE)
    const b = selectAdvancedQueryBuilderForSpace(useAdvancedQueryStore.getState(), 'SPACE_B')
    expect(a).toBe(b)
    expect(a).toMatchObject({ kind: 'group', op: 'And', negated: false, children: [] })
  })

  it('addLeaf appends a leaf to the root with a fresh stable id', () => {
    useAdvancedQueryStore.getState().addLeaf(SPACE, [], TAG('a'))
    const root = builder()
    expect(root.children).toHaveLength(1)
    const leaf = root.children[0]
    expect(leaf).toMatchObject({ kind: 'leaf', primitive: TAG('a'), negated: false })
    expect(leaf?.id).toBeGreaterThan(0)
  })

  it('addGroup appends an empty And sub-group and nesting via path works', () => {
    useAdvancedQueryStore.getState().addGroup(SPACE, [])
    expect(builder().children[0]).toMatchObject({ kind: 'group', op: 'And', children: [] })
    // Add a leaf INTO the new sub-group (path [0]).
    useAdvancedQueryStore.getState().addLeaf(SPACE, [0], TAG('nested'))
    const sub = builder().children[0] as BuilderGroupNode
    expect(sub.children).toHaveLength(1)
    expect(sub.children[0]).toMatchObject({ kind: 'leaf', primitive: TAG('nested') })
  })

  it('removeNode deletes the addressed child', () => {
    useAdvancedQueryStore.getState().addLeaf(SPACE, [], TAG('a'))
    useAdvancedQueryStore.getState().addLeaf(SPACE, [], TAG('b'))
    useAdvancedQueryStore.getState().removeNode(SPACE, [0])
    const root = builder()
    expect(root.children).toHaveLength(1)
    expect(root.children[0]).toMatchObject({ primitive: TAG('b') })
  })

  it('removeNode on the root path is a no-op', () => {
    useAdvancedQueryStore.getState().addLeaf(SPACE, [], TAG('a'))
    const before = builder()
    useAdvancedQueryStore.getState().removeNode(SPACE, [])
    expect(builder()).toBe(before)
  })

  it('setGroupOp flips And↔Or and is a no-op when unchanged', () => {
    useAdvancedQueryStore.getState().addLeaf(SPACE, [], TAG('a'))
    useAdvancedQueryStore.getState().setGroupOp(SPACE, [], 'Or')
    expect(builder().op).toBe('Or')
    const before = useAdvancedQueryStore.getState().buildersBySpace
    useAdvancedQueryStore.getState().setGroupOp(SPACE, [], 'Or')
    expect(useAdvancedQueryStore.getState().buildersBySpace).toBe(before)
  })

  it('toggleNegate flips the negated flag of a leaf and the root group', () => {
    useAdvancedQueryStore.getState().addLeaf(SPACE, [], TAG('a'))
    useAdvancedQueryStore.getState().toggleNegate(SPACE, [0])
    expect(builder().children[0]).toMatchObject({ negated: true })
    useAdvancedQueryStore.getState().toggleNegate(SPACE, [])
    expect(builder().negated).toBe(true)
  })

  it('clearBuilder resets a dirty tree to the default root', () => {
    useAdvancedQueryStore.getState().addLeaf(SPACE, [], TAG('a'))
    useAdvancedQueryStore.getState().setGroupOp(SPACE, [], 'Or')
    useAdvancedQueryStore.getState().clearBuilder(SPACE)
    expect(builder()).toMatchObject({ op: 'And', negated: false, children: [] })
  })

  it('compiles a built tree to the wire FilterExpr end to end', () => {
    useAdvancedQueryStore.getState().addLeaf(SPACE, [], TAG('a'))
    useAdvancedQueryStore.getState().addGroup(SPACE, [])
    useAdvancedQueryStore.getState().setGroupOp(SPACE, [1], 'Or')
    useAdvancedQueryStore.getState().addLeaf(SPACE, [1], TAG('x'))
    useAdvancedQueryStore.getState().toggleNegate(SPACE, [1, 0])
    expect(builderTreeToFilterExpr(builder())).toEqual({
      type: 'And',
      children: [
        { type: 'Leaf', primitive: TAG('a') },
        { type: 'Or', children: [{ type: 'Not', child: { type: 'Leaf', primitive: TAG('x') } }] },
      ],
    })
  })

  it('partitions builder trees per space (no cross-space bleed)', () => {
    useAdvancedQueryStore.getState().addLeaf(SPACE, [], TAG('a'))
    useAdvancedQueryStore.getState().addLeaf('SPACE_B', [], TAG('b'))
    expect(
      selectAdvancedQueryBuilderForSpace(useAdvancedQueryStore.getState(), SPACE).children[0],
    ).toMatchObject({ primitive: TAG('a') })
    expect(
      selectAdvancedQueryBuilderForSpace(useAdvancedQueryStore.getState(), 'SPACE_B').children[0],
    ).toMatchObject({ primitive: TAG('b') })
  })
})
