import { describe, expect, it } from 'vitest'

import { buildFilters, OPERATOR_SYMBOLS, parseQueryExpression } from '@/lib/query-utils'

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

  // --- Escaping / edge-case tests targeting specific parser branches ---

  it('unescapes backslash-escaped operator characters before parsing property shorthand', () => {
    // Markdown serialization escapes '=' as '\=' in block content; the parser
    // must unescape it before the shorthand regex can see the operator.
    const result = parseQueryExpression('property:key\\=value')
    expect(result).toEqual({
      type: 'filtered',
      params: {},
      propertyFilters: [{ key: 'key', value: 'value', operator: 'eq' }],
      tagFilters: [],
    })
  })

  it('ignores a token where the colon is the first character', () => {
    // colonIdx === 0 must NOT satisfy the "has a prefix" gate.
    const result = parseQueryExpression(':foo')
    expect(result).toEqual({
      type: 'unknown',
      params: {},
      propertyFilters: [],
      tagFilters: [],
    })
  })

  it('treats a property: token without an operator character as a plain param', () => {
    // prefix === 'property' alone must not be sufficient to enter shorthand parsing.
    const result = parseQueryExpression('property:plainvalue')
    expect(result).toEqual({
      type: 'unknown',
      params: { property: 'plainvalue' },
      propertyFilters: [],
      tagFilters: [],
    })
  })

  it('treats a tag: token containing "=" as a tag filter, not property shorthand', () => {
    // An operator character in rest alone must not be sufficient without prefix === 'property'.
    const result = parseQueryExpression('tag:has=equals')
    expect(result).toEqual({
      type: 'filtered',
      params: {},
      propertyFilters: [],
      tagFilters: ['has=equals'],
    })
  })

  it('falls through to params instead of dropping a property shorthand token whose value does not start immediately after the key (#3795)', () => {
    // opMatch's leading \w+ must be anchored at the very start of rest.
    // Previously this token was dropped entirely (not parsed, not recorded
    // in params, no error). #3795: it now falls through to the same
    // "unrecognised token" handling as any other prefix, so the source
    // text survives. `'property:' + result.params.property` round-trips
    // the original input verbatim.
    const result = parseQueryExpression('property:=key=value')
    expect(result).toEqual({
      type: 'unknown',
      params: { property: '=key=value' },
      propertyFilters: [],
      tagFilters: [],
    })
    expect(`property:${result.params['property']}`).toBe('property:=key=value')
  })

  it('falls through to params instead of dropping a property shorthand token with an operator but no value after it (#3795)', () => {
    // opMatch's trailing (.+) must require at least one value character, not zero.
    // Same fall-through as above: the raw text is preserved in params
    // rather than silently discarded.
    const result = parseQueryExpression('property:key=')
    expect(result).toEqual({
      type: 'unknown',
      params: { property: 'key=' },
      propertyFilters: [],
      tagFilters: [],
    })
    expect(`property:${result.params['property']}`).toBe('property:key=')
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

  it('maps neq operator to Neq compare op', () => {
    const filters = buildFilters([{ key: 'status', value: 'active', operator: 'neq' }], [])
    expect(filters).toEqual([{ type: 'PropertyText', key: 'status', op: 'Neq', value: 'active' }])
  })

  it('maps lt operator to Lt compare op', () => {
    const filters = buildFilters([{ key: 'status', value: 'active', operator: 'lt' }], [])
    expect(filters).toEqual([{ type: 'PropertyText', key: 'status', op: 'Lt', value: 'active' }])
  })

  it('maps gte operator to Gte compare op', () => {
    const filters = buildFilters([{ key: 'status', value: 'active', operator: 'gte' }], [])
    expect(filters).toEqual([{ type: 'PropertyText', key: 'status', op: 'Gte', value: 'active' }])
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
