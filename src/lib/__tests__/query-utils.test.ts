import { describe, expect, it } from 'vitest'

import {
  buildFilters,
  legacyQueryToFilterExpr,
  OPERATOR_SYMBOLS,
  parseQueryExpression,
} from '../query-utils'

describe('parseQueryExpression', () => {
  it('parses tag query', () => {
    expect(parseQueryExpression('type:tag expr:project')).toEqual({
      type: 'tag',
      params: { type: 'tag', expr: 'project' },
      propertyFilters: [],
      tagFilters: [],
    })
  })

  it('parses property query', () => {
    expect(parseQueryExpression('type:property key:priority value:1')).toEqual({
      type: 'property',
      params: { type: 'property', key: 'priority', value: '1' },
      propertyFilters: [],
      tagFilters: [],
    })
  })

  it('parses backlinks query', () => {
    expect(parseQueryExpression('type:backlinks target:ULID123')).toEqual({
      type: 'backlinks',
      params: { type: 'backlinks', target: 'ULID123' },
      propertyFilters: [],
      tagFilters: [],
    })
  })

  it('returns unknown for missing type', () => {
    expect(parseQueryExpression('foo:bar')).toEqual({
      type: 'unknown',
      params: { foo: 'bar' },
      propertyFilters: [],
      tagFilters: [],
    })
  })

  it('parses single property shorthand', () => {
    expect(parseQueryExpression('property:todo_state=TODO')).toEqual({
      type: 'filtered',
      params: {},
      propertyFilters: [{ key: 'todo_state', value: 'TODO', operator: 'eq' }],
      tagFilters: [],
    })
  })

  it('parses multiple property shorthands (AND)', () => {
    const result = parseQueryExpression('property:todo_state=TODO property:priority=1')
    expect(result).toEqual({
      type: 'filtered',
      params: {},
      propertyFilters: [
        { key: 'todo_state', value: 'TODO', operator: 'eq' },
        { key: 'priority', value: '1', operator: 'eq' },
      ],
      tagFilters: [],
    })
  })

  it('parses tag shorthand', () => {
    expect(parseQueryExpression('tag:project-x')).toEqual({
      type: 'filtered',
      params: {},
      propertyFilters: [],
      tagFilters: ['project-x'],
    })
  })

  it('parses tag + property combination', () => {
    const result = parseQueryExpression('tag:project-x property:todo_state=TODO')
    expect(result).toEqual({
      type: 'filtered',
      params: {},
      propertyFilters: [{ key: 'todo_state', value: 'TODO', operator: 'eq' }],
      tagFilters: ['project-x'],
    })
  })

  it('preserves extra params alongside shorthand filters', () => {
    const result = parseQueryExpression('property:todo_state=TODO table:true')
    expect(result).toEqual({
      type: 'filtered',
      params: { table: 'true' },
      propertyFilters: [{ key: 'todo_state', value: 'TODO', operator: 'eq' }],
      tagFilters: [],
    })
  })

  it('handles empty string gracefully', () => {
    const result = parseQueryExpression('')
    expect(result.type).toBe('unknown')
    expect(result.params).toEqual({})
    expect(result.propertyFilters).toEqual([])
    expect(result.tagFilters).toEqual([])
  })

  it('handles whitespace-only string', () => {
    const result = parseQueryExpression('   ')
    expect(result.type).toBe('unknown')
  })

  it('ignores tokens without colons', () => {
    const result = parseQueryExpression('type:tag randomword expr:test')
    expect(result).toEqual({
      type: 'tag',
      params: { type: 'tag', expr: 'test' },
      propertyFilters: [],
      tagFilters: [],
    })
  })

  it('handles property shorthand with equals in value', () => {
    const result = parseQueryExpression('property:key=val=ue')
    expect(result.propertyFilters).toEqual([{ key: 'key', value: 'val=ue', operator: 'eq' }])
  })

  it('ignores tag shorthand with empty rest', () => {
    // tag: with nothing after colon goes into params, not tagFilters
    const result = parseQueryExpression('tag:')
    // 'tag' prefix with empty rest => params[tag] = ''
    expect(result.tagFilters).toEqual([])
    expect(result.params).toEqual({ tag: '' })
  })

  it('handles multiple tag shorthands', () => {
    const result = parseQueryExpression('tag:alpha tag:beta')
    expect(result.tagFilters).toEqual(['alpha', 'beta'])
    expect(result.type).toBe('filtered')
  })

  // --- Operator parsing tests ---

  it('parses property:key>value with operator gt', () => {
    const result = parseQueryExpression('property:due_date>2025-01-01')
    expect(result.propertyFilters).toEqual([
      { key: 'due_date', value: '2025-01-01', operator: 'gt' },
    ])
  })

  it('parses property:key<value with operator lt', () => {
    const result = parseQueryExpression('property:due_date<2025-12-31')
    expect(result.propertyFilters).toEqual([
      { key: 'due_date', value: '2025-12-31', operator: 'lt' },
    ])
  })

  it('parses property:key>=value with operator gte (longer match first)', () => {
    const result = parseQueryExpression('property:due_date>=2025-06-01')
    expect(result.propertyFilters).toEqual([
      { key: 'due_date', value: '2025-06-01', operator: 'gte' },
    ])
  })

  it('parses property:key<=value with operator lte (longer match first)', () => {
    const result = parseQueryExpression('property:due_date<=2025-12-31')
    expect(result.propertyFilters).toEqual([
      { key: 'due_date', value: '2025-12-31', operator: 'lte' },
    ])
  })

  it('parses property:key!=value with operator neq', () => {
    const result = parseQueryExpression('property:status!=done')
    expect(result.propertyFilters).toEqual([{ key: 'status', value: 'done', operator: 'neq' }])
  })

  it('parses property:key=value with operator eq (backward compat)', () => {
    const result = parseQueryExpression('property:key=value')
    expect(result.propertyFilters).toEqual([{ key: 'key', value: 'value', operator: 'eq' }])
  })

  it('handles mixed operators in multi-filter query', () => {
    const result = parseQueryExpression('property:due_date>2025-01-01 property:priority=1')
    expect(result.propertyFilters).toEqual([
      { key: 'due_date', value: '2025-01-01', operator: 'gt' },
      { key: 'priority', value: '1', operator: 'eq' },
    ])
  })
})

describe('buildFilters', () => {
  it('maps todo_state to TodoState filter', () => {
    const filters = buildFilters([{ key: 'todo_state', value: 'TODO' }], [])
    expect(filters).toEqual([{ type: 'TodoState', state: 'TODO' }])
  })

  it('maps priority to Priority filter', () => {
    const filters = buildFilters([{ key: 'priority', value: '1' }], [])
    expect(filters).toEqual([{ type: 'Priority', level: '1' }])
  })

  it('maps due_date to DueDate Eq filter', () => {
    const filters = buildFilters([{ key: 'due_date', value: '2025-01-01' }], [])
    expect(filters).toEqual([{ type: 'DueDate', op: 'Eq', value: '2025-01-01' }])
  })

  it('maps custom property key to PropertyText filter', () => {
    const filters = buildFilters([{ key: 'status', value: 'active' }], [])
    expect(filters).toEqual([{ type: 'PropertyText', key: 'status', op: 'Eq', value: 'active' }])
  })

  it('maps tag filters to HasTagPrefix', () => {
    const filters = buildFilters([], ['project-x'])
    expect(filters).toEqual([{ type: 'HasTagPrefix', prefix: 'project-x' }])
  })

  it('combines multiple property and tag filters', () => {
    const filters = buildFilters(
      [
        { key: 'todo_state', value: 'TODO' },
        { key: 'priority', value: '1' },
      ],
      ['project-x'],
    )
    expect(filters).toEqual([
      { type: 'TodoState', state: 'TODO' },
      { type: 'Priority', level: '1' },
      { type: 'HasTagPrefix', prefix: 'project-x' },
    ])
  })

  it('returns empty array when no filters', () => {
    expect(buildFilters([], [])).toEqual([])
  })

  it('handles multiple tag filters', () => {
    const filters = buildFilters([], ['alpha', 'beta'])
    expect(filters).toEqual([
      { type: 'HasTagPrefix', prefix: 'alpha' },
      { type: 'HasTagPrefix', prefix: 'beta' },
    ])
  })

  it('preserves order of property filters followed by tag filters', () => {
    const filters = buildFilters([{ key: 'status', value: 'active' }], ['tag1'])
    expect(filters[0]?.type).toBe('PropertyText')
    expect(filters[1]?.type).toBe('HasTagPrefix')
  })

  it('maps due_date with gt operator to DueDate Gt filter', () => {
    const filters = buildFilters([{ key: 'due_date', value: '2025-06-01', operator: 'gt' }], [])
    expect(filters).toEqual([{ type: 'DueDate', op: 'Gt', value: '2025-06-01' }])
  })

  it('maps custom property with lte operator to PropertyText Lte filter', () => {
    const filters = buildFilters([{ key: 'score', value: '100', operator: 'lte' }], [])
    expect(filters).toEqual([{ type: 'PropertyText', key: 'score', op: 'Lte', value: '100' }])
  })

  it('defaults to Eq when operator is undefined', () => {
    const filters = buildFilters([{ key: 'due_date', value: '2025-01-01' }], [])
    expect(filters).toEqual([{ type: 'DueDate', op: 'Eq', value: '2025-01-01' }])
  })
})

describe('OPERATOR_SYMBOLS', () => {
  it('maps all operator names to display symbols', () => {
    expect(OPERATOR_SYMBOLS['eq']).toBe('=')
    expect(OPERATOR_SYMBOLS['neq']).toBe('≠')
    expect(OPERATOR_SYMBOLS['lt']).toBe('<')
    expect(OPERATOR_SYMBOLS['gt']).toBe('>')
    expect(OPERATOR_SYMBOLS['lte']).toBe('≤')
    expect(OPERATOR_SYMBOLS['gte']).toBe('≥')
  })
})

// ---------------------------------------------------------------------------
// legacyQueryToFilterExpr — the back-compat bridge from a parsed legacy
// `{{query …}}` to the advanced engine's `FilterExpr`.
//
// These tests are the unit-level back-compat oracle for the execution
// unification: every faithfully-translatable shape must produce the exact
// engine leaf that reproduces the legacy match semantics, and every
// NOT-faithfully-translatable shape must report `filterExpr: null` so the
// caller keeps the legacy IPC path (never silently changing a block's results).
// ---------------------------------------------------------------------------

describe('legacyQueryToFilterExpr', () => {
  const translate = (expr: string): ReturnType<typeof legacyQueryToFilterExpr> =>
    legacyQueryToFilterExpr(parseQueryExpression(expr))

  describe('faithfully translatable property shapes', () => {
    it('translates todo_state=TODO to a State membership leaf', () => {
      const { filterExpr, reasons } = translate('property:todo_state=TODO')
      expect(reasons).toEqual([])
      expect(filterExpr).toEqual({
        type: 'And',
        children: [
          {
            type: 'Leaf',
            primitive: { type: 'State', values: ['TODO'], is_null: false, exclude: false },
          },
        ],
      })
    })

    it('translates priority=1 to a Priority membership leaf', () => {
      const { filterExpr, reasons } = translate('property:priority=1')
      expect(reasons).toEqual([])
      expect(filterExpr).toEqual({
        type: 'And',
        children: [
          {
            type: 'Leaf',
            primitive: { type: 'Priority', values: ['1'], is_null: false, exclude: false },
          },
        ],
      })
    })

    it('translates a custom property eq to HasProperty Eq(Text)', () => {
      const { filterExpr, reasons } = translate('property:context=@office')
      expect(reasons).toEqual([])
      expect(filterExpr).toEqual({
        type: 'And',
        children: [
          {
            type: 'Leaf',
            primitive: {
              type: 'HasProperty',
              key: 'context',
              predicate: { type: 'Eq', value: { type: 'Text', value: '@office' } },
            },
          },
        ],
      })
    })

    it('maps every comparison operator on a custom property faithfully', () => {
      const cases: [string, string][] = [
        ['property:score!=100', 'Ne'],
        ['property:score<100', 'Lt'],
        ['property:score>100', 'Gt'],
        ['property:score<=100', 'Lte'],
        ['property:score>=100', 'Gte'],
      ]
      for (const [expr, predType] of cases) {
        const { filterExpr, reasons } = translate(expr)
        expect(reasons).toEqual([])
        expect(filterExpr).toEqual({
          type: 'And',
          children: [
            {
              type: 'Leaf',
              primitive: {
                type: 'HasProperty',
                key: 'score',
                predicate: { type: predType, value: { type: 'Text', value: '100' } },
              },
            },
          ],
        })
      }
    })

    it('maps due_date comparison operators to DueDate date predicates', () => {
      const cases: [string, Record<string, string>][] = [
        ['property:due_date=2025-01-01', { type: 'On', date: '2025-01-01' }],
        ['property:due_date<2025-01-01', { type: 'Before', date: '2025-01-01' }],
        ['property:due_date>2025-01-01', { type: 'After', date: '2025-01-01' }],
        ['property:due_date<=2025-01-01', { type: 'OnOrBefore', date: '2025-01-01' }],
        ['property:due_date>=2025-01-01', { type: 'OnOrAfter', date: '2025-01-01' }],
      ]
      for (const [expr, predicate] of cases) {
        const { filterExpr, reasons } = translate(expr)
        expect(reasons).toEqual([])
        expect(filterExpr).toEqual({
          type: 'And',
          children: [{ type: 'Leaf', primitive: { type: 'DueDate', predicate } }],
        })
      }
    })

    it('translates a multi-filter AND into an And of leaves preserving order', () => {
      const { filterExpr, reasons } = translate(
        'property:todo_state=TODO property:due_date>=2025-06-01 property:context=@office',
      )
      expect(reasons).toEqual([])
      expect(filterExpr).toEqual({
        type: 'And',
        children: [
          {
            type: 'Leaf',
            primitive: { type: 'State', values: ['TODO'], is_null: false, exclude: false },
          },
          {
            type: 'Leaf',
            primitive: { type: 'DueDate', predicate: { type: 'OnOrAfter', date: '2025-06-01' } },
          },
          {
            type: 'Leaf',
            primitive: {
              type: 'HasProperty',
              key: 'context',
              predicate: { type: 'Eq', value: { type: 'Text', value: '@office' } },
            },
          },
        ],
      })
    })
  })

  describe('NOT faithfully translatable (keeps legacy path)', () => {
    it('refuses tag shorthand (no name-prefix engine primitive)', () => {
      const { filterExpr, reasons } = translate('tag:work')
      expect(filterExpr).toBeNull()
      expect(reasons).toContain('tag-prefix-match-has-no-engine-primitive')
    })

    it('refuses explicit type:tag', () => {
      const { filterExpr, reasons } = translate('type:tag expr:work')
      expect(filterExpr).toBeNull()
      expect(reasons).toContain('tag-prefix-match-has-no-engine-primitive')
    })

    it('refuses a tag+property combination because of the tag', () => {
      const { filterExpr, reasons } = translate('tag:work property:todo_state=TODO')
      expect(filterExpr).toBeNull()
      expect(reasons).toContain('tag-prefix-match-has-no-engine-primitive')
    })

    it('refuses backlinks', () => {
      const { filterExpr, reasons } = translate('type:backlinks target:ULID123')
      expect(filterExpr).toBeNull()
      expect(reasons).toContain('backlinks-target-has-no-engine-primitive')
    })

    it('refuses explicit type:property (params, not shorthand)', () => {
      const { filterExpr, reasons } = translate('type:property key:context value:@remote')
      expect(filterExpr).toBeNull()
      expect(reasons).toContain('explicit-type-property-uses-params-not-shorthand')
    })

    it('refuses unknown shapes', () => {
      const { filterExpr, reasons } = translate('foo:bar')
      expect(filterExpr).toBeNull()
      expect(reasons).toContain('unknown-query-shape')
    })

    it('refuses a non-eq operator on the membership-only todo_state field', () => {
      const { filterExpr, reasons } = translate('property:todo_state!=DONE')
      expect(filterExpr).toBeNull()
      expect(reasons).toContain('property-operator-not-expressible:todo_state:neq')
    })

    it('refuses a non-eq operator on the membership-only priority field', () => {
      const { filterExpr, reasons } = translate('property:priority>1')
      expect(filterExpr).toBeNull()
      expect(reasons).toContain('property-operator-not-expressible:priority:gt')
    })

    it('refuses due_date != (no != date primitive exists)', () => {
      const { filterExpr, reasons } = translate('property:due_date!=2025-01-01')
      expect(filterExpr).toBeNull()
      expect(reasons).toContain('property-operator-not-expressible:due_date:neq')
    })
  })
})
