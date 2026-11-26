import { describe, expect, it } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import { bucketTasks, groupByPage, taskDate } from '@/components/agenda/task-buckets'

const TODAY = '2026-11-25'
const WEEK_END = '2026-11-29'

function ids(rows: { id: string }[]): string[] {
  return rows.map((r) => r.id)
}

describe('taskDate', () => {
  it('is the earlier of the due and scheduled dates', () => {
    expect(taskDate(makeBlock({ due_date: '2026-12-02', scheduled_date: '2026-11-26' }))).toBe(
      '2026-11-26',
    )
    expect(taskDate(makeBlock({ due_date: '2026-11-20', scheduled_date: '2026-11-26' }))).toBe(
      '2026-11-20',
    )
  })

  it('is whichever date there is, or null with none', () => {
    expect(taskDate(makeBlock({ due_date: null, scheduled_date: '2026-11-26' }))).toBe('2026-11-26')
    expect(taskDate(makeBlock({ due_date: '2026-11-26', scheduled_date: null }))).toBe('2026-11-26')
    expect(taskDate(makeBlock({ due_date: null, scheduled_date: null }))).toBeNull()
  })
})

describe('bucketTasks', () => {
  it('puts each open task under the tab its earlier date names', () => {
    const open = [
      makeBlock({ id: 'OVERDUE_SCHEDULED', scheduled_date: '2026-11-23', due_date: '2026-12-01' }),
      makeBlock({ id: 'OVERDUE_DUE', due_date: '2026-11-24', scheduled_date: null }),
      makeBlock({ id: 'TODAY', due_date: '2026-11-26', scheduled_date: TODAY }),
      makeBlock({ id: 'WEEK_LAST_DAY', due_date: WEEK_END, scheduled_date: null }),
      makeBlock({ id: 'LATER', due_date: null, scheduled_date: '2026-11-30' }),
      makeBlock({ id: 'UNDATED', due_date: null, scheduled_date: null }),
    ]
    const buckets = bucketTasks([], open, TODAY, WEEK_END)
    expect(ids(buckets.overdue)).toEqual(['OVERDUE_SCHEDULED', 'OVERDUE_DUE'])
    expect(ids(buckets.today)).toEqual(['TODAY'])
    expect(ids(buckets.thisWeek)).toEqual(['WEEK_LAST_DAY'])
    expect(ids(buckets.later)).toEqual(['LATER'])
    expect(ids(buckets.noDate)).toEqual(['UNDATED'])
  })

  it("lists the day's own rows under Today, unless their date puts them elsewhere", () => {
    const dueTodayScheduledEarlier = makeBlock({
      id: 'BOTH',
      todo_state: 'TODO',
      due_date: TODAY,
      scheduled_date: '2026-11-20',
    })
    const byProperty = makeBlock({ id: 'PROPERTY', todo_state: null, due_date: null })
    const buckets = bucketTasks(
      [dueTodayScheduledEarlier, byProperty],
      [dueTodayScheduledEarlier],
      TODAY,
      WEEK_END,
    )
    expect(ids(buckets.overdue)).toEqual(['BOTH'])
    expect(ids(buckets.today)).toEqual(['PROPERTY'])
  })

  it('sorts a tab by date, then priority', () => {
    const open = [
      makeBlock({ id: 'NOV28_P3', due_date: '2026-11-28', priority: '3' }),
      makeBlock({ id: 'NOV27_NONE', due_date: '2026-11-27', priority: null }),
      makeBlock({ id: 'NOV28_P1', due_date: '2026-11-28', priority: '1' }),
      makeBlock({ id: 'NOV27_P2', due_date: '2026-11-27', priority: '2' }),
    ]
    expect(ids(bucketTasks([], open, TODAY, WEEK_END).thisWeek)).toEqual([
      'NOV27_P2',
      'NOV27_NONE',
      'NOV28_P1',
      'NOV28_P3',
    ])
  })
})

describe('groupByPage', () => {
  it('runs the pages by their earliest row and keeps the rows’ order inside each', () => {
    const rows = [
      makeBlock({ id: 'B1', page_id: 'P_B' }),
      makeBlock({ id: 'A1', page_id: 'P_A' }),
      makeBlock({ id: 'B2', page_id: 'P_B' }),
      makeBlock({ id: 'A2', page_id: 'P_A' }),
    ]
    expect(groupByPage(rows).map((g) => [g.pageId, ids(g.rows)])).toEqual([
      ['P_B', ['B1', 'B2']],
      ['P_A', ['A1', 'A2']],
    ])
  })
})
