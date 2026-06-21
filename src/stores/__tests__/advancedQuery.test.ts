import { beforeEach, describe, expect, it } from 'vitest'

import type { AggregateSpec, FilterExpr, FilterPrimitive, GroupSpec, SortKey } from '@/lib/tauri'

import {
  type BuilderGroupNode,
  builderTreeToFilterExpr,
  filterExprToBuilderTree,
  parseQuerySpec,
  selectAdvancedQueryBuilderForSpace,
  selectAdvancedQueryControlsForSpace,
  selectAdvancedQueryFiltersForSpace,
  serializeQuerySpec,
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

// --- #1460 saved-views: FilterExpr ↔ builder round-trip + load/serialize ------

/** Allocator that hands out 1, 2, 3, … so test assertions can predict ids. */
function seqAllocId(): () => number {
  let n = 0
  return () => {
    n += 1
    return n
  }
}

/** Strip the React-key-only `id` fields so two trees can be compared by shape. */
function stripIds(node: BuilderGroupNode): unknown {
  const walk = (n: BuilderGroupNode['children'][number]): unknown =>
    n.kind === 'leaf'
      ? { kind: 'leaf', primitive: n.primitive, negated: n.negated }
      : { kind: 'group', op: n.op, negated: n.negated, children: n.children.map(walk) }
  return { kind: 'group', op: node.op, negated: node.negated, children: node.children.map(walk) }
}

describe('filterExprToBuilderTree (inverse of builderTreeToFilterExpr)', () => {
  it('rebuilds a root And group with leaves', () => {
    const expr: FilterExpr = {
      type: 'And',
      children: [{ type: 'Leaf', primitive: TAG('a') }],
    }
    const tree = filterExprToBuilderTree(expr, seqAllocId())
    expect(tree).toEqual({
      kind: 'group',
      id: 1,
      op: 'And',
      negated: false,
      children: [{ kind: 'leaf', id: 2, primitive: TAG('a'), negated: false }],
    })
  })

  it('peels an outer Not into a negated group node', () => {
    const expr: FilterExpr = {
      type: 'Not',
      child: { type: 'Or', children: [{ type: 'Leaf', primitive: TAG('x') }] },
    }
    const tree = filterExprToBuilderTree(expr, seqAllocId())
    expect(tree.op).toBe('Or')
    expect(tree.negated).toBe(true)
    expect(tree.children[0]).toMatchObject({ kind: 'leaf', primitive: TAG('x'), negated: false })
  })

  it('peels a Not wrapping a leaf into a negated leaf', () => {
    const expr: FilterExpr = {
      type: 'And',
      children: [{ type: 'Not', child: { type: 'Leaf', primitive: TAG('y') } }],
    }
    const tree = filterExprToBuilderTree(expr, seqAllocId())
    expect(tree.children[0]).toMatchObject({
      kind: 'leaf',
      primitive: TAG('y'),
      negated: true,
    })
  })

  it('wraps a non-group root expr (bare leaf) in a synthetic And root', () => {
    const expr: FilterExpr = { type: 'Leaf', primitive: TAG('z') }
    const tree = filterExprToBuilderTree(expr, seqAllocId())
    expect(tree.kind).toBe('group')
    expect(tree.op).toBe('And')
    expect(tree.children).toHaveLength(1)
    expect(tree.children[0]).toMatchObject({ kind: 'leaf', primitive: TAG('z') })
  })

  it('round-trips: build → compile → save JSON → load → compile = identical wire shape', () => {
    // A reasonably nested tree exercising And/Or/Not + leaves.
    const root: BuilderGroupNode = {
      kind: 'group',
      id: 0,
      op: 'And',
      negated: false,
      children: [
        { kind: 'leaf', id: 1, primitive: TAG('a'), negated: false },
        {
          kind: 'group',
          id: 2,
          op: 'Or',
          negated: true,
          children: [
            { kind: 'leaf', id: 3, primitive: TAG('b'), negated: false },
            { kind: 'leaf', id: 4, primitive: TAG('c'), negated: true },
          ],
        },
      ],
    }

    const wire1 = builderTreeToFilterExpr(root)
    const json = JSON.stringify(wire1)
    const reloaded = filterExprToBuilderTree(JSON.parse(json) as FilterExpr, seqAllocId())
    const wire2 = builderTreeToFilterExpr(reloaded)

    // The compiled wire shape is byte-identical across the round-trip.
    expect(wire2).toEqual(wire1)
    // And the rebuilt tree matches the original up to React-key ids.
    expect(stripIds(reloaded)).toEqual(stripIds(root))
  })
})

describe('serializeQuerySpec / parseQuerySpec', () => {
  const sort: SortKey[] = [{ source: { type: 'Column', name: 'created' }, desc: true }]
  const groupBy: GroupSpec = { key: { type: 'Tag' } }
  const aggregates: AggregateSpec[] = [{ op: 'count' }]

  it('serializes builder + controls into a SavedQuerySpec', () => {
    const builder: BuilderGroupNode = {
      kind: 'group',
      id: 0,
      op: 'And',
      negated: false,
      children: [{ kind: 'leaf', id: 1, primitive: TAG('a'), negated: false }],
    }
    const spec = serializeQuerySpec(builder, {
      fulltext: 'hello',
      sort,
      groupBy,
      aggregates,
    })
    expect(spec).toEqual({
      filter: { type: 'And', children: [{ type: 'Leaf', primitive: TAG('a') }] },
      sort,
      fulltext: 'hello',
      group_by: groupBy,
      aggregates,
    })
  })

  it('parses a query_spec JSON string back into a SavedQuerySpec', () => {
    const raw = JSON.stringify({
      filter: { type: 'And', children: [] },
      sort,
      fulltext: 'x',
      group_by: groupBy,
      aggregates,
    })
    expect(parseQuerySpec(raw)).toEqual({
      filter: { type: 'And', children: [] },
      sort,
      fulltext: 'x',
      group_by: groupBy,
      aggregates,
    })
  })

  it('defaults missing optional fields when parsing', () => {
    const raw = JSON.stringify({ filter: { type: 'And', children: [] } })
    expect(parseQuerySpec(raw)).toEqual({
      filter: { type: 'And', children: [] },
      sort: [],
      fulltext: '',
      group_by: null,
      aggregates: [],
    })
  })

  it('throws on a query_spec missing its filter', () => {
    expect(() => parseQuerySpec(JSON.stringify({ sort: [] }))).toThrow(/filter/)
  })

  it('throws on malformed JSON', () => {
    expect(() => parseQuerySpec('{not json')).toThrow()
  })
})

describe('advancedQuery store — loadView (#1460)', () => {
  it('atomically hydrates builder + controls from a spec with fresh ids', () => {
    // Seed a pre-existing node so we can assert the loaded ids don't collide.
    useAdvancedQueryStore.getState().addLeaf(SPACE, [], TAG('seed'))
    const before = useAdvancedQueryStore.getState().nextAddId

    const spec = {
      filter: {
        type: 'And' as const,
        children: [{ type: 'Leaf' as const, primitive: TAG('loaded') }],
      },
      sort: [{ source: { type: 'Column' as const, name: 'created' as const }, desc: false }],
      fulltext: 'q',
      group_by: { key: { type: 'Page' as const } },
      aggregates: [{ op: 'count' as const }],
    }
    useAdvancedQueryStore.getState().loadView(SPACE, spec)

    const builder = selectAdvancedQueryBuilderForSpace(useAdvancedQueryStore.getState(), SPACE)
    expect(builder.op).toBe('And')
    expect(builder.children).toHaveLength(1)
    expect(builder.children[0]).toMatchObject({ kind: 'leaf', primitive: TAG('loaded') })

    const controls = selectAdvancedQueryControlsForSpace(useAdvancedQueryStore.getState(), SPACE)
    expect(controls.fulltext).toBe('q')
    expect(controls.sort).toEqual(spec.sort)
    expect(controls.groupBy).toEqual(spec.group_by)
    expect(controls.aggregates).toEqual(spec.aggregates)

    // Counter advanced past the prior value (fresh, non-colliding ids).
    expect(useAdvancedQueryStore.getState().nextAddId).toBeGreaterThan(before)
  })

  it('replaces an existing tree entirely (no leftover children)', () => {
    useAdvancedQueryStore.getState().addLeaf(SPACE, [], TAG('old1'))
    useAdvancedQueryStore.getState().addLeaf(SPACE, [], TAG('old2'))
    useAdvancedQueryStore.getState().loadView(SPACE, {
      filter: { type: 'Or', children: [] },
      sort: [],
      fulltext: '',
      group_by: null,
      aggregates: [],
    })
    const builder = selectAdvancedQueryBuilderForSpace(useAdvancedQueryStore.getState(), SPACE)
    expect(builder.op).toBe('Or')
    expect(builder.children).toHaveLength(0)
  })
})
