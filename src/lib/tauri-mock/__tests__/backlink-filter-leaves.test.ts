/**
 * #6054 D2 — the References panel's `PropertyNum`, `PropertyDate`, `DueDate`
 * and `CreatedInRange` leaves, and their `Not`, on the mock's
 * `list_backlinks_grouped`. The mock once matched every block on these leaves,
 * so a `Not` over one emptied the panel where the backend
 * (`compile_backlink_filter`, `agaric-store/src/backlink/filters.rs`) keeps the
 * complement, the blocks with no value included.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, makeBlock, opLog, properties } from '@/lib/tauri-mock/seed'

const SPACE = '01SPACEA000000000000000001'
const TARGET = '0000000000000000000TARGETA'
const NOTES = '00000000000000000000NOTESA'
const LOW = '0000000000000000000000LOWA' // effort 3, review 2026-03-01, due 2026-01-10
const HIGH = '000000000000000000000HIGHA' // effort 8, review 2026-05-01, due 2026-06-01
const BARE = '000000000000000000000BAREA' // no property, no due date
// A literal ULID dated 2025-06-15; the padded ids date to the epoch.
const DATED = '01JXRE5J000000000000000001'

function prop(key: string, fields: Record<string, unknown>) {
  return {
    key,
    value_text: null,
    value_num: null,
    value_date: null,
    value_ref: null,
    value_bool: null,
    ...fields,
  }
}

function filteredIds(filters: Array<Record<string, unknown>>): string[] {
  const res = dispatch('list_backlinks_grouped', {
    blockId: TARGET,
    filters,
    limit: 10,
    scope: { kind: 'active', space_id: SPACE },
  }) as { groups: Array<{ blocks: Array<Record<string, unknown>> }> }
  return res.groups.flatMap((g) => g.blocks.map((b) => b['id'] as string)).toSorted()
}

const not = (filter: Record<string, unknown>) => ({ type: 'Not', filter })

describe('list_backlinks_grouped — Not over the property, due-date and created leaves', () => {
  beforeEach(() => {
    blocks.clear()
    properties.clear()
    opLog.length = 0
    for (const page of [TARGET, NOTES]) {
      blocks.set(page, makeBlock(page, 'page', page === TARGET ? 'Target' : 'Notes', null, 1))
      properties.set(page, new Map([['space', prop('space', { value_ref: SPACE })]]))
    }
    for (const source of [LOW, HIGH, BARE, DATED]) {
      blocks.set(source, makeBlock(source, 'content', `on [[${TARGET}]]`, NOTES, 1))
    }
    for (const [source, effort, review, due] of [
      [LOW, 3, '2026-03-01', '2026-01-10'],
      [HIGH, 8, '2026-05-01', '2026-06-01'],
    ] as const) {
      properties.set(
        source,
        new Map([
          ['effort', prop('effort', { value_num: effort })],
          ['review', prop('review', { value_date: review })],
        ]),
      )
      ;(blocks.get(source) as Record<string, unknown>)['due_date'] = due
    }
  })

  it('CreatedInRange refuses a bound that is not a date', () => {
    expect(() =>
      filteredIds([not({ type: 'CreatedInRange', after: '2025-13-01', before: null })]),
    ).toThrow(expect.objectContaining({ kind: 'validation', code: 'InvalidDateFilter' }))
  })

  it('refuses a filter type it does not know rather than matching every block', () => {
    expect(() => filteredIds([not({ type: 'Bogus' })])).toThrow(
      expect.objectContaining({ kind: 'validation' }),
    )
  })
})
