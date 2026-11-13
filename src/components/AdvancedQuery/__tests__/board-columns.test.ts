import { describe, expect, it } from 'vitest'

import { boardColumns } from '@/components/AdvancedQuery/board-columns'
import type { PropertyDefinition } from '@/lib/bindings'

function def(key: string, valueType: string, options: string[] | null): PropertyDefinition {
  return {
    key,
    value_type: valueType,
    options: options && JSON.stringify(options),
    created_at: '2026-01-01T00:00:00Z',
    builtin: false,
  }
}

const defs = new Map([
  ['stage', def('stage', 'select', ['later', 'now'])],
  ['effort', def('effort', 'number', null)],
])

describe('boardColumns', () => {
  it('gives task state its four states in toggle order, then the blocks with none', () => {
    expect(boardColumns({ key: { type: 'State' } }, undefined)).toEqual([
      ...['TODO', 'DOING', 'DONE', 'CANCELLED'].map((state) => ({
        id: `value:${state}`,
        kind: 'value',
        value: state,
        filter: { type: 'Leaf', primitive: { type: 'State', values: [state] } },
      })),
      {
        id: 'none',
        kind: 'none',
        filter: { type: 'Leaf', primitive: { type: 'State', values: [], is_null: true } },
      },
    ])
  })

  it('gives a select property its options in the stored order, then no value, then the rest', () => {
    const has = (predicate: unknown) => ({
      type: 'Leaf',
      primitive: { type: 'HasProperty', key: 'stage', predicate },
    })
    const text = (value: string) => ({ type: 'Text', value })
    expect(boardColumns({ key: { type: 'Property', key: 'stage' } }, defs)).toEqual([
      {
        id: 'value:later',
        kind: 'value',
        value: 'later',
        filter: has({ type: 'Eq', value: text('later') }),
      },
      {
        id: 'value:now',
        kind: 'value',
        value: 'now',
        filter: has({ type: 'Eq', value: text('now') }),
      },
      { id: 'none', kind: 'none', filter: has({ type: 'NotExists' }) },
      {
        id: 'other',
        kind: 'other',
        filter: {
          type: 'And',
          children: [
            has({ type: 'Exists' }),
            has({ type: 'Ne', value: text('later') }),
            has({ type: 'Ne', value: text('now') }),
          ],
        },
      },
    ])
  })

  it.each([
    ['no grouping', null],
    ['a multi-valued key', { key: { type: 'Tag' } } as const],
    ['a property that is not a select', { key: { type: 'Property', key: 'effort' } } as const],
    ['a property with no definition', { key: { type: 'Property', key: 'nope' } } as const],
  ])('has no board for %s', (_name, groupBy) => {
    expect(boardColumns(groupBy, defs)).toBeNull()
  })

  it('has no board for a property while the definitions are unread', () => {
    expect(boardColumns({ key: { type: 'Property', key: 'stage' } }, undefined)).toBeNull()
  })
})
