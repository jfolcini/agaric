import { describe, expect, it } from 'vitest'

import { makeProjectedEntry } from '@/__tests__/fixtures'
import { planAgendaProjection } from '@/lib/agenda-projection'
import type { AgendaFilter } from '@/lib/filter-dimension-metadata'

// A fixed local day, so no assertion depends on the clock.
const TODAY = new Date(2026, 9, 18)

const DEFAULT_FILTERS: AgendaFilter[] = [{ dimension: 'status', values: ['TODO', 'DOING'] }]

describe('planAgendaProjection', () => {
  it('projects the coming week when no due or scheduled filter sets a range', () => {
    const plan = planAgendaProjection(DEFAULT_FILTERS, TODAY)
    expect(plan && { start: plan.start, end: plan.end }).toEqual({
      start: '2026-10-18',
      end: '2026-10-24',
    })
    expect(plan?.accepts(makeProjectedEntry({ projected_date: '2026-10-24' }))).toBe(true)
    expect(plan?.accepts(makeProjectedEntry({ projected_date: '2026-10-25' }))).toBe(false)
  })

  it('takes a due filter span from today on and judges only due-date occurrences', () => {
    const plan = planAgendaProjection([{ dimension: 'dueDate', values: ['This month'] }], TODAY)
    expect(plan && { start: plan.start, end: plan.end }).toEqual({
      start: '2026-10-18',
      end: '2026-10-31',
    })
    expect(plan?.accepts(makeProjectedEntry({ projected_date: '2026-10-31' }))).toBe(true)
    expect(
      plan?.accepts(
        makeProjectedEntry({
          projected_date: '2026-10-25',
          source: 'scheduled_date',
          block: { scheduled_date: '2026-10-11' },
        }),
      ),
    ).toBe(false)
  })

  it('judges scheduled occurrences by the scheduled filter and due ones by the due filter', () => {
    const plan = planAgendaProjection(
      [
        { dimension: 'dueDate', values: ['Today'] },
        { dimension: 'scheduledDate', values: ['Next 14 days'] },
      ],
      TODAY,
    )
    expect(plan && { start: plan.start, end: plan.end }).toEqual({
      start: '2026-10-18',
      end: '2026-10-31',
    })
    const scheduled = (projected_date: string) =>
      makeProjectedEntry({ projected_date, source: 'scheduled_date', block: { due_date: null } })
    expect(plan?.accepts(scheduled('2026-10-30'))).toBe(true)
    expect(plan?.accepts(makeProjectedEntry({ projected_date: '2026-10-18' }))).toBe(true)
    expect(plan?.accepts(makeProjectedEntry({ projected_date: '2026-10-19' }))).toBe(false)
  })

  it('projects nothing for an Overdue-only date filter', () => {
    expect(planAgendaProjection([{ dimension: 'dueDate', values: ['Overdue'] }], TODAY)).toBeNull()
  })

  it.each([
    ['tag', ['work']],
    ['property', ['assignee']],
    ['completedDate', ['Today']],
    ['createdDate', ['Last 7 days']],
  ] as const)(
    'projects nothing under a %s filter no occurrence can answer',
    (dimension, values) => {
      expect(planAgendaProjection([{ dimension, values: [...values] }], TODAY)).toBeNull()
    },
  )

  it('ignores a filter with no values, as the agenda query does', () => {
    expect(planAgendaProjection([{ dimension: 'tag', values: [] }], TODAY)).not.toBeNull()
  })

  it('keeps an occurrence only when its task passes the status and priority filters', () => {
    const plan = planAgendaProjection(
      [...DEFAULT_FILTERS, { dimension: 'priority', values: ['1'] }],
      TODAY,
    )
    expect(plan?.accepts(makeProjectedEntry({ block: { priority: '1' } }))).toBe(true)
    expect(plan?.accepts(makeProjectedEntry({ block: { priority: '2' } }))).toBe(false)
    expect(plan?.accepts(makeProjectedEntry({ block: { priority: null } }))).toBe(false)
    expect(
      plan?.accepts(makeProjectedEntry({ block: { priority: '1', todo_state: 'CANCELLED' } })),
    ).toBe(false)
    expect(plan?.accepts(makeProjectedEntry({ block: { priority: '1', todo_state: null } }))).toBe(
      false,
    )
  })

  it('drops an occurrence on its own task date, which the agenda lists as the task itself', () => {
    const plan = planAgendaProjection(DEFAULT_FILTERS, TODAY)
    expect(
      plan?.accepts(
        makeProjectedEntry({ projected_date: '2026-10-20', block: { due_date: '2026-10-20' } }),
      ),
    ).toBe(false)
    expect(
      plan?.accepts(
        makeProjectedEntry({ projected_date: '2026-10-20', block: { due_date: '2026-10-13' } }),
      ),
    ).toBe(true)
  })
})
