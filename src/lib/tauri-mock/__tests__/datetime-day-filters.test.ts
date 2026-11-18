/**
 * #6906 — a day operand reads each stored value by its form on the References
 * panel's property leaf, `filtered_blocks_query` and `query_by_property`, as
 * the backend's `LocalDay::test` does: a datetime against the device's local
 * day, a date as written. Noon UTC is its UTC day in every zone from UTC-11
 * to UTC+11, so no case depends on the host's zone.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { clearMock, id, setSpace } from '@/lib/tauri-mock/__tests__/mock-store-helpers'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, makeBlock, properties } from '@/lib/tauri-mock/seed'

const SPACE = id('SPACE')
const PAGE = id('PAGE')
const TARGET = id('TARGET')
const INSTANT = id('INSTANT') // when 2026-11-14T12:00Z
const DAY = id('DAY') // when 2026-11-14, as a date key holds it
const LISTED = id('LISTED') // when [2026-11-14T12:00Z]
const LATER = id('LATER') // when 2026-11-20T12:00Z
const NONE = id('NONE') // no when

function hold(blockId: string, fields: Record<string, unknown>): void {
  const empty = { value_text: null, value_num: null, value_date: null, value_ref: null }
  properties.set(
    blockId,
    new Map([['when', { key: 'when', ...empty, value_bool: null, ...fields }]]),
  )
}

beforeEach(() => {
  clearMock()
  for (const page of [PAGE, TARGET]) {
    blocks.set(page, makeBlock(page, 'page', page === PAGE ? 'Notes' : 'Target', null, 1))
    setSpace(page, SPACE)
  }
  for (const [i, blockId] of [INSTANT, DAY, LISTED, LATER, NONE].entries()) {
    blocks.set(blockId, makeBlock(blockId, 'content', `on [[${TARGET}]]`, PAGE, i + 1))
  }
  hold(INSTANT, { value_date: '2026-11-14T12:00Z' })
  hold(DAY, { value_date: '2026-11-14' })
  hold(LISTED, { value_list: ['2026-11-14T12:00Z'] })
  hold(LATER, { value_date: '2026-11-20T12:00Z' })
})

const sorted = (ids: string[]) => ids.toSorted()

describe('the References panel’s date leaf on a day', () => {
  function matching(op: string): string[] {
    const res = dispatch('list_backlinks_grouped', {
      blockId: TARGET,
      filters: [{ type: 'PropertyDate', key: 'when', op, value: '2026-11-14' }],
      limit: 50,
      scope: { kind: 'active', space_id: SPACE },
    }) as { groups: Array<{ blocks: Array<Record<string, unknown>> }> }
    return sorted(res.groups.flatMap((g) => g.blocks.map((b) => b['id'] as string)))
  }

  it('reads each row by its form, and Neq needs the key and no item on the day', () => {
    expect(matching('Eq')).toEqual(sorted([INSTANT, DAY, LISTED]))
    expect(matching('Neq')).toEqual([LATER])
    expect(matching('Lt')).toEqual([])
    expect(matching('Lte')).toEqual(sorted([INSTANT, DAY, LISTED]))
    expect(matching('Gt')).toEqual([LATER])
    expect(matching('Gte')).toEqual(sorted([INSTANT, DAY, LISTED, LATER]))
  })
})

describe('filtered_blocks_query on a day', () => {
  function matching(filter: Record<string, unknown>): string[] {
    const res = dispatch('filtered_blocks_query', {
      propertyFilters: [{ key: 'when', ...filter }],
      tagFilters: null,
      scope: { kind: 'active', space_id: SPACE },
    }) as { items: Array<Record<string, unknown>> }
    return sorted(res.items.map((b) => b['id'] as string))
  }
  const on = (operator: string) => matching({ valueDate: '2026-11-14', operator })

  it('reads each row and string item by its form, under every operator and a range', () => {
    expect(on('eq')).toEqual(sorted([INSTANT, DAY, LISTED]))
    expect(on('neq')).toEqual([LATER])
    expect(on('lt')).toEqual([])
    expect(on('lte')).toEqual(sorted([INSTANT, DAY, LISTED]))
    expect(on('gt')).toEqual([LATER])
    expect(on('gte')).toEqual(sorted([INSTANT, DAY, LISTED, LATER]))
    expect(matching({ valueDateRange: ['2026-11-14', '2026-11-15'] })).toEqual(
      sorted([INSTANT, DAY, LISTED]),
    )
  })
})

describe('query_by_property on a day', () => {
  function matching(fields: Record<string, unknown>): string[] {
    const res = dispatch('query_by_property', {
      request: { key: 'when', valueText: null, valueDate: null, ...fields },
      scope: { kind: 'active', space_id: SPACE },
    }) as { items: Array<Record<string, unknown>> }
    return sorted(res.items.map((b) => b['id'] as string))
  }
  const on = (operator: string) => matching({ valueDate: '2026-11-14', operator })

  it('reads each scalar by its form; a list holds no value_date, which `neq` takes', () => {
    expect(on('eq')).toEqual(sorted([INSTANT, DAY]))
    expect(on('neq')).toEqual(sorted([LISTED, LATER]))
    expect(on('lt')).toEqual([])
    expect(on('lte')).toEqual(sorted([INSTANT, DAY]))
    expect(on('gt')).toEqual([LATER])
    expect(on('gte')).toEqual(sorted([INSTANT, DAY, LATER]))
    expect(matching({ valueDateRange: ['2026-11-14', '2026-11-15'] })).toEqual(
      sorted([INSTANT, DAY]),
    )
  })
})
