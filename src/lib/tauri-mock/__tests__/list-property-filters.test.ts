/**
 * #6741 PR 3 — a property comparison holds for a list when it holds for at
 * least one item, and "not equals" holds when no item is equal, on every mock
 * evaluator that compares a property value: the advanced-query / Pages /
 * Search `HasProperty` (`hasPropertyMatches`), the References leaves
 * (`propertyLeafMatches`), `filtered_blocks_query` (the agenda's property
 * filter too), and the value typeahead (`list_property_values`).
 *
 * Not a conformance fixture yet: the backend half of this change authors the
 * fixtures (`query_advanced_filters`, `query_filtered_blocks_value_shapes`,
 * `query_backlinks_grouped_filters` gain list rows). Until they land, these
 * cases pin the mock to the rule as the approved design states it.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { clearMock, id, setSpace } from '@/lib/tauri-mock/__tests__/mock-store-helpers'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, makeBlock, properties, spacePropertyDefs } from '@/lib/tauri-mock/seed'

const SPACE = id('SPACE')
const PAGE = id('PAGE')
const TARGET = id('TARGET')
const L1 = id('L1') // authors [Ann, Bob]
const L2 = id('L2') // authors [Cy]
const L3 = id('L3') // authors text 'Ann'
const L4 = id('L4') // no authors
const N1 = id('N1') // scores [3, 10]
const N2 = id('N2') // scores ['3']
const D1 = id('D1') // days ['2026-01-05', '2026-03-01']
const R1 = id('R1') // refs [TARGET]

function row(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    value_text: null,
    value_num: null,
    value_date: null,
    value_ref: null,
    value_bool: null,
    ...fields,
  }
}

function hold(blockId: string, key: string, fields: Record<string, unknown>): void {
  const held = properties.get(blockId) ?? new Map<string, Record<string, unknown>>()
  held.set(key, { key, ...row(fields) })
  properties.set(blockId, held)
}

beforeEach(() => {
  clearMock()
  for (const page of [PAGE, TARGET]) {
    blocks.set(page, makeBlock(page, 'page', page === PAGE ? 'Notes' : 'Target', null, 1))
    setSpace(page, SPACE)
  }
  for (const [i, blockId] of [L1, L2, L3, L4, N1, N2, D1, R1].entries()) {
    blocks.set(blockId, makeBlock(blockId, 'content', `on [[${TARGET}]]`, PAGE, i + 1))
  }
  hold(L1, 'authors', { value_list: ['Ann', 'Bob'] })
  hold(L2, 'authors', { value_list: ['Cy'] })
  hold(L3, 'authors', { value_text: 'Ann' })
  hold(N1, 'scores', { value_list: [3, 10] })
  hold(N2, 'scores', { value_list: ['3'] })
  hold(D1, 'days', { value_list: ['2026-01-05', '2026-03-01'] })
  hold(R1, 'refs', { value_list: [TARGET] })
})

describe('run_advanced_query — HasProperty over a list', () => {
  function matching(key: string, predicate: Record<string, unknown>): string[] {
    const res = dispatch('run_advanced_query', {
      request: {
        spaceId: SPACE,
        filter: { type: 'Leaf', primitive: { type: 'HasProperty', key, predicate } },
      },
    }) as { rows: Array<Record<string, unknown>> }
    return res.rows.map((r) => r['id'] as string).toSorted()
  }
  const text = (type: string, value: string) => ({ type, value: { type: 'Text', value } })
  const num = (type: string, value: number) => ({ type, value: { type: 'Num', value } })

  it('Eq holds when one item equals, beside an equal scalar', () => {
    expect(matching('authors', text('Eq', 'Ann'))).toEqual([L1, L3].toSorted())
  })

  it('Ne holds when no item equals, for a block without the key too', () => {
    expect(matching('authors', text('Ne', 'Ann'))).toEqual(
      [PAGE, TARGET, L2, L4, N1, N2, D1, R1].toSorted(),
    )
  })

  it('Contains and StartsWith look at each string item, ASCII case-insensitively', () => {
    expect(matching('authors', text('Contains', 'OB'))).toEqual([L1])
    expect(matching('authors', text('StartsWith', 'c'))).toEqual([L2])
  })

  it('a Num predicate compares the number items only, a Text one the string items only', () => {
    expect(matching('scores', num('Eq', 3))).toEqual([N1])
    expect(matching('scores', text('Eq', '3'))).toEqual([N2])
    expect(matching('scores', num('Gt', 5))).toEqual([N1])
    expect(matching('scores', num('Contains', 3))).toEqual([])
  })

  it('a Date predicate orders the string items', () => {
    const before = { type: 'Lt', value: { type: 'Date', value: '2026-02-01' } }
    expect(matching('days', before)).toEqual([D1])
  })

  it('a Ref predicate matches a ref list holding the target', () => {
    expect(matching('refs', { type: 'Eq', value: { type: 'Ref', value: TARGET } })).toEqual([R1])
  })
})

describe('list_backlinks_grouped — the property leaves over a list', () => {
  function matching(filter: Record<string, unknown>): string[] {
    const res = dispatch('list_backlinks_grouped', {
      blockId: TARGET,
      filters: [filter],
      limit: 50,
      scope: { kind: 'active', space_id: SPACE },
    }) as { groups: Array<{ blocks: Array<Record<string, unknown>> }> }
    return res.groups.flatMap((g) => g.blocks.map((b) => b['id'] as string)).toSorted()
  }

  it('Eq holds when one item equals', () => {
    const filter = { type: 'PropertyText', key: 'authors', op: 'Eq', value: 'Ann' }
    expect(matching(filter)).toEqual([L1, L3].toSorted())
  })

  it('Neq needs the key: a list with an item to compare and none equal, or an unequal scalar', () => {
    const filter = { type: 'PropertyText', key: 'authors', op: 'Neq', value: 'Bob' }
    expect(matching(filter)).toEqual([L2, L3].toSorted())
  })

  it('Neq skips a list with no item of the leaf type', () => {
    expect(matching({ type: 'PropertyNum', key: 'scores', op: 'Neq', value: 4 })).toEqual([N1])
    expect(matching({ type: 'PropertyText', key: 'scores', op: 'Neq', value: '4' })).toEqual([N2])
  })

  it('an ordering and Contains hold when one item does', () => {
    expect(matching({ type: 'PropertyNum', key: 'scores', op: 'Gte', value: 10 })).toEqual([N1])
    expect(matching({ type: 'PropertyText', key: 'authors', op: 'Contains', value: 'y' })).toEqual([
      L2,
    ])
    expect(matching({ type: 'PropertyDate', key: 'days', op: 'Gt', value: '2026-02-01' })).toEqual([
      D1,
    ])
  })
})

describe('filtered_blocks_query — a property filter over a list', () => {
  function matching(filter: Record<string, unknown>): string[] {
    const res = dispatch('filtered_blocks_query', {
      propertyFilters: [filter],
      tagFilters: null,
      scope: { kind: 'active', space_id: SPACE },
    }) as { items: Array<Record<string, unknown>> }
    return res.items.map((b) => b['id'] as string).toSorted()
  }

  it('= and an ordering hold when one string item does', () => {
    expect(matching({ key: 'authors', valueText: 'Ann' })).toEqual([L1, L3].toSorted())
    expect(matching({ key: 'authors', valueText: 'Bz', operator: 'gt' })).toEqual([L2])
    expect(matching({ key: 'days', valueDate: '2026-02-01', operator: 'lt' })).toEqual([D1])
  })

  it('neq takes a block with the key and no equal item', () => {
    expect(matching({ key: 'authors', valueText: 'Ann', operator: 'neq' })).toEqual([L2])
  })

  it('value_text_in and value_date_range hold when one string item does', () => {
    expect(matching({ key: 'authors', valueTextIn: ['Bob', 'Zed'] })).toEqual([L1])
    expect(matching({ key: 'days', valueDateRange: ['2026-03-01', '2026-04-01'] })).toEqual([D1])
  })

  it('a number item is no text', () => {
    expect(matching({ key: 'scores', valueText: '3' })).toEqual([N2])
  })
})

describe('list_property_values — the items of a text, select or url list', () => {
  const values = (key: string) => dispatch('list_property_values', { key }) as string[]
  const define = (key: string, valueType: string) =>
    spacePropertyDefs(SPACE).set(key, {
      key,
      value_type: valueType,
      options: null,
      multiple: true,
      created_at: '2026-01-01T00:00:00.000Z',
    })

  it('offers each string item, ranked with the scalar values by use', () => {
    define('authors', 'text')
    expect(values('authors')).toEqual(['Ann', 'Bob', 'Cy'])
  })

  it('offers nothing of a list whose key is undeclared, or declared ref, date or number', () => {
    expect(values('authors')).toEqual(['Ann'])
    define('refs', 'ref')
    define('days', 'date')
    define('scores', 'number')
    expect([...values('refs'), ...values('days'), ...values('scores')]).toEqual([])
  })
})
