import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import {
  groupByDate,
  groupByPage,
  groupByPriority,
  groupByState,
  sortAgendaBlocks,
  sortAgendaBlocksBy,
  sortByPage,
  sortByPriority,
  sortByState,
} from '@/lib/agenda-sort'
import { __resetPriorityLevelsForTests, setPriorityLevels } from '@/lib/priority-levels'

beforeEach(() => {
  __resetPriorityLevelsForTests()
})

afterEach(() => {
  __resetPriorityLevelsForTests()
})

describe('sortAgendaBlocks', () => {
  it('sorts by date ascending', () => {
    const blocks = [
      makeBlock({ id: 'B2', due_date: '2025-06-20' }),
      makeBlock({ id: 'B1', due_date: '2025-06-15' }),
    ]
    const sorted = sortAgendaBlocks(blocks)
    expect(sorted[0]?.id).toBe('B1')
    expect(sorted[1]?.id).toBe('B2')
  })

  it('uses scheduled_date as fallback when no due_date', () => {
    const blocks = [
      makeBlock({ id: 'B2', scheduled_date: '2025-06-20' }),
      makeBlock({ id: 'B1', due_date: '2025-06-15' }),
    ]
    const sorted = sortAgendaBlocks(blocks)
    expect(sorted[0]?.id).toBe('B1')
    expect(sorted[1]?.id).toBe('B2')
  })

  it('sorts blocks with no date to bottom', () => {
    const blocks = [makeBlock({ id: 'B1' }), makeBlock({ id: 'B2', due_date: '2025-06-15' })]
    const sorted = sortAgendaBlocks(blocks)
    expect(sorted[0]?.id).toBe('B2')
    expect(sorted[1]?.id).toBe('B1')
  })

  it('within same date, sorts DOING > TODO > DONE > CANCELLED > null ()', () => {
    const blocks = [
      makeBlock({ id: 'done', due_date: '2025-06-15', todo_state: 'DONE' }),
      makeBlock({ id: 'todo', due_date: '2025-06-15', todo_state: 'TODO' }),
      makeBlock({ id: 'doing', due_date: '2025-06-15', todo_state: 'DOING' }),
      makeBlock({ id: 'cancelled', due_date: '2025-06-15', todo_state: 'CANCELLED' }),
      makeBlock({ id: 'none', due_date: '2025-06-15', todo_state: null }),
    ]
    const sorted = sortAgendaBlocks(blocks)
    expect(sorted.map((b) => b.id)).toEqual(['doing', 'todo', 'done', 'cancelled', 'none'])
  })

  it('within same date and state, sorts by priority 1 > 2 > 3 > null', () => {
    const blocks = [
      makeBlock({ id: 'p3', due_date: '2025-06-15', todo_state: 'TODO', priority: '3' }),
      makeBlock({ id: 'p1', due_date: '2025-06-15', todo_state: 'TODO', priority: '1' }),
      makeBlock({ id: 'pn', due_date: '2025-06-15', todo_state: 'TODO', priority: null }),
      makeBlock({ id: 'p2', due_date: '2025-06-15', todo_state: 'TODO', priority: '2' }),
    ]
    const sorted = sortAgendaBlocks(blocks)
    expect(sorted.map((b) => b.id)).toEqual(['p1', 'p2', 'p3', 'pn'])
  })

  it('prefers due_date over scheduled_date when both present', () => {
    const blocks = [
      makeBlock({ id: 'B1', due_date: '2025-06-20', scheduled_date: '2025-06-10' }),
      makeBlock({ id: 'B2', due_date: '2025-06-15' }),
    ]
    const sorted = sortAgendaBlocks(blocks)
    // B2 (due 06-15) should come before B1 (due 06-20, not sched 06-10)
    expect(sorted[0]?.id).toBe('B2')
    expect(sorted[1]?.id).toBe('B1')
  })

  it('does not mutate input array', () => {
    const blocks = [
      makeBlock({ id: 'B2', due_date: '2025-06-20' }),
      makeBlock({ id: 'B1', due_date: '2025-06-15' }),
    ]
    const copy = [...blocks]
    sortAgendaBlocks(blocks)
    expect(blocks[0]?.id).toBe(copy[0]?.id)
    expect(blocks[1]?.id).toBe(copy[1]?.id)
  })
})

describe('groupByDate', () => {
  // Pin the system clock so groupByDate's internal `new Date()` matches
  // the `todayStr` constructed in the "Overdue group is always first" test.
  // Otherwise a midnight crossing between the two `new Date()` calls flakes the test.
  // Local-time timestamp (no `Z`) so `.getDate()` / `.getMonth()` resolve identically
  // in every CI / dev timezone.
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-15T12:00:00'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('puts overdue non-DONE tasks in Overdue group', () => {
    const blocks = [makeBlock({ id: 'B1', due_date: '2020-01-01', todo_state: 'TODO' })]
    const groups = groupByDate(blocks)
    expect(groups[0]?.label).toBe('Overdue')
    expect(groups[0]?.blocks.length).toBe(1)
  })

  it('does not put DONE tasks in Overdue', () => {
    const blocks = [makeBlock({ id: 'B1', due_date: '2020-01-01', todo_state: 'DONE' })]
    const groups = groupByDate(blocks)
    // Should not be in "Overdue" group
    const overdueGroup = groups.find((g) => g.label === 'Overdue')
    expect(overdueGroup).toBeUndefined()
  })

  it('puts blocks with no date in "No date" group at the end', () => {
    const blocks = [
      makeBlock({ id: 'B1' }),
      makeBlock({ id: 'B2', due_date: '2020-01-01', todo_state: 'TODO' }),
    ]
    const groups = groupByDate(blocks)
    const lastGroup = groups.at(-1)
    expect(lastGroup?.label).toBe('No date')
    expect(lastGroup?.blocks[0]?.id).toBe('B1')
  })

  it('includes count in group', () => {
    const blocks = [
      makeBlock({ id: 'B1', due_date: '2020-01-01', todo_state: 'TODO' }),
      makeBlock({ id: 'B2', due_date: '2020-01-02', todo_state: 'TODO' }),
    ]
    const groups = groupByDate(blocks)
    expect(groups[0]?.label).toBe('Overdue')
    expect(groups[0]?.blocks.length).toBe(2)
  })

  it('orders a past-dated DONE group before Today (chronological monotonicity, #1524)', () => {
    // A DONE task with a past effective date is NOT bucketed as Overdue, so it
    // keeps its own raw past date key. It must still render BEFORE Today — the
    // old code pinned Overdue/Today/Tomorrow ahead of the date groups, so the
    // past-DONE group landed after Today/Tomorrow and broke monotonicity.
    const blocks = [
      makeBlock({ id: 'today', due_date: '2025-01-15', todo_state: 'TODO' }),
      makeBlock({ id: 'pastDone', due_date: '2025-01-10', todo_state: 'DONE' }),
      makeBlock({ id: 'overdue', due_date: '2020-01-01', todo_state: 'TODO' }),
    ]
    const groups = groupByDate(blocks)
    const labels = groups.map((g) => g.label)
    const overdueIdx = labels.indexOf('Overdue')
    const todayIdx = labels.indexOf('Today')
    const pastIdx = groups.findIndex((g) => g.blocks.some((b) => b.id === 'pastDone'))

    expect(overdueIdx).toBe(0) // Overdue still pins to the front
    expect(todayIdx).toBeGreaterThanOrEqual(0)
    expect(pastIdx).toBeGreaterThan(overdueIdx) // after Overdue
    expect(pastIdx).toBeLessThan(todayIdx) // …but BEFORE Today (the #1524 fix)
  })

  it('Overdue group is always first', () => {
    // Hardcoded `todayStr` aligned with the fake system time set in beforeEach.
    // Previously this constructed `todayStr` from `new Date()` and then groupByDate
    // called `new Date()` again — across midnight, the two values diverged and the
    // "Today" assertion flaked.
    const todayStr = '2025-01-15'
    const blocks = [
      makeBlock({ id: 'today', due_date: todayStr, todo_state: 'TODO' }),
      makeBlock({ id: 'overdue', due_date: '2020-01-01', todo_state: 'TODO' }),
    ]
    const groups = groupByDate(blocks)
    expect(groups[0]?.label).toBe('Overdue')
    expect(groups[1]?.label).toBe('Today')
  })

  // #757 — concrete date headers are formatted via the runtime locale
  // (`toLocaleDateString(undefined, …)`, the formatDateDisplay convention)
  // instead of hardcoded English weekday/month tables. Compute the
  // expected labels with the same Intl options so these assertions hold
  // under any system locale. Weekday is always included; the year only
  // when it differs from the (fake-timer-pinned 2025) current year.
  function expectedHeader(dateStr: string): string {
    const [y, m, d] = dateStr.split('-').map(Number)
    return new Date(y as number, (m as number) - 1, d).toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      ...(y === new Date().getFullYear() ? {} : { year: 'numeric' }),
    })
  }

  // #757 — pin the locale-awareness contract itself: the same Intl option
  // set produces language-correct weekday/month names per locale (Node
  // ships full ICU), which the removed WEEKDAYS/MONTH_SHORT tables never
  // could.
  it('date group headers use locale-aware weekday/month names (#757)', () => {
    const blocks = [makeBlock({ id: 'mon', due_date: '2026-06-15', todo_state: 'TODO' })]
    const groups = groupByDate(blocks)
    expect(groups.map((g) => g.label)).toEqual([expectedHeader('2026-06-15')])

    const date = new Date(2026, 5, 15)
    const opts = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' } as const
    expect(date.toLocaleDateString('en-US', opts)).toBe('Mon, Jun 15, 2026')
    expect(date.toLocaleDateString('fr-FR', opts)).toBe('lun. 15 juin 2026')
  })

  // #719 — date groups beyond Tomorrow were ordered alphabetically by
  // their formatted label ("Fri, Jun 19" < "Mon, Jun 15"), not
  // chronologically. These tests pin the relative order of concrete
  // future-date groups, the exact gap the original suite never covered.
  describe('#719: future date groups are chronological, not label-alphabetical', () => {
    it('orders weekday-named groups by date (Mon, Jun 15 before Fri, Jun 19)', () => {
      // 2026-06-15 is a Monday and 2026-06-19 a Friday — the issue's
      // reported failure case: "Fri, ..." sorts before "Mon, ..."
      // alphabetically, inverting the chronology.
      const blocks = [
        makeBlock({ id: 'fri', due_date: '2026-06-19', todo_state: 'TODO' }),
        makeBlock({ id: 'mon', due_date: '2026-06-15', todo_state: 'TODO' }),
      ]
      const groups = groupByDate(blocks)
      expect(groups.map((g) => g.label)).toEqual([
        expectedHeader('2026-06-15'),
        expectedHeader('2026-06-19'),
      ])
      expect(groups[0]?.blocks[0]?.id).toBe('mon')
      expect(groups[1]?.blocks[0]?.id).toBe('fri')
    })

    it('orders groups correctly across a month boundary', () => {
      // 2025-07-28 (Mon) precedes 2025-08-01 (Fri); the label sort put
      // "Fri, Aug 1" first because F < M.
      const blocks = [
        makeBlock({ id: 'aug', due_date: '2025-08-01', todo_state: 'TODO' }),
        makeBlock({ id: 'jul', due_date: '2025-07-28', todo_state: 'TODO' }),
      ]
      const groups = groupByDate(blocks)
      expect(groups.map((g) => g.label)).toEqual([
        expectedHeader('2025-07-28'),
        expectedHeader('2025-08-01'),
      ])
    })

    it('orders groups correctly across a year boundary', () => {
      // "Fri, Jan 2, 2026" < "Wed, Dec 31" alphabetically — the label
      // sort rendered next year's group before this year's.
      const blocks = [
        makeBlock({ id: 'jan', due_date: '2026-01-02', todo_state: 'TODO' }),
        makeBlock({ id: 'dec', due_date: '2025-12-31', todo_state: 'TODO' }),
      ]
      const groups = groupByDate(blocks)
      expect(groups.map((g) => g.label)).toEqual([
        expectedHeader('2025-12-31'),
        expectedHeader('2026-01-02'),
      ])
    })

    it('keeps special groups around chronological date groups', () => {
      const blocks = [
        makeBlock({ id: 'no-date' }),
        makeBlock({ id: 'late', due_date: '2025-06-20', todo_state: 'TODO' }),
        makeBlock({ id: 'early', due_date: '2025-02-03', todo_state: 'TODO' }),
        makeBlock({ id: 'today', due_date: '2025-01-15', todo_state: 'TODO' }),
        makeBlock({ id: 'tomorrow', due_date: '2025-01-16', todo_state: 'TODO' }),
        makeBlock({ id: 'overdue', due_date: '2025-01-10', todo_state: 'TODO' }),
      ]
      const groups = groupByDate(blocks)
      expect(groups.map((g) => g.label)).toEqual([
        'Overdue',
        'Today',
        'Tomorrow',
        expectedHeader('2025-02-03'),
        expectedHeader('2025-06-20'),
        'No date',
      ])
    })
  })
})

describe('groupByPriority', () => {
  it('groups blocks by priority level', () => {
    const blocks = [
      makeBlock({ id: 'p1', priority: '1' }),
      makeBlock({ id: 'p2', priority: '2' }),
      makeBlock({ id: 'p3', priority: '3' }),
      makeBlock({ id: 'pn', priority: null }),
    ]
    const groups = groupByPriority(blocks)
    expect(groups.map((g) => g.label)).toEqual(['P1', 'P2', 'P3', 'No priority'])
    expect(groups[0]?.blocks[0]?.id).toBe('p1')
    expect(groups[1]?.blocks[0]?.id).toBe('p2')
    expect(groups[2]?.blocks[0]?.id).toBe('p3')
    expect(groups[3]?.blocks[0]?.id).toBe('pn')
  })

  it('sorts within groups by date then state', () => {
    const blocks = [
      makeBlock({ id: 'late-todo', priority: '1', due_date: '2025-06-20', todo_state: 'TODO' }),
      makeBlock({ id: 'early-done', priority: '1', due_date: '2025-06-10', todo_state: 'DONE' }),
      makeBlock({ id: 'early-doing', priority: '1', due_date: '2025-06-10', todo_state: 'DOING' }),
    ]
    const groups = groupByPriority(blocks)
    expect(groups.length).toBe(1)
    expect(groups[0]?.blocks.map((b) => b.id)).toEqual(['early-doing', 'early-done', 'late-todo'])
  })

  it('omits empty priority groups', () => {
    const blocks = [makeBlock({ id: 'p1', priority: '1' })]
    const groups = groupByPriority(blocks)
    expect(groups.length).toBe(1)
    expect(groups[0]?.label).toBe('P1')
  })

  it('empty blocks returns empty groups', () => {
    const groups = groupByPriority([])
    expect(groups).toEqual([])
  })
})

describe('groupByState', () => {
  it('groups blocks by todo state (: DOING, TODO, DONE, CANCELLED, No state)', () => {
    const blocks = [
      makeBlock({ id: 'doing', todo_state: 'DOING' }),
      makeBlock({ id: 'todo', todo_state: 'TODO' }),
      makeBlock({ id: 'cancelled', todo_state: 'CANCELLED' }),
      makeBlock({ id: 'done', todo_state: 'DONE' }),
      makeBlock({ id: 'none', todo_state: null }),
    ]
    const groups = groupByState(blocks)
    expect(groups.map((g) => g.label)).toEqual(['DOING', 'TODO', 'DONE', 'CANCELLED', 'No state'])
    expect(groups[0]?.blocks[0]?.id).toBe('doing')
    expect(groups[1]?.blocks[0]?.id).toBe('todo')
    expect(groups[2]?.blocks[0]?.id).toBe('done')
    expect(groups[3]?.blocks[0]?.id).toBe('cancelled')
    expect(groups[4]?.blocks[0]?.id).toBe('none')
  })

  it('groups an unrecognised todo state under No state', () => {
    const groups = groupByState([
      makeBlock({ id: 'unknown', todo_state: 'WAITING' }),
      makeBlock({ id: 'none', todo_state: null }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.label).toBe('No state')
    expect(groups[0]?.blocks.map((block) => block.id)).toEqual(['unknown', 'none'])
  })

  it('sorts within groups by date then priority', () => {
    const blocks = [
      makeBlock({ id: 'late-p1', todo_state: 'TODO', due_date: '2025-06-20', priority: '1' }),
      makeBlock({ id: 'early-p3', todo_state: 'TODO', due_date: '2025-06-10', priority: '3' }),
      makeBlock({ id: 'early-p1', todo_state: 'TODO', due_date: '2025-06-10', priority: '1' }),
    ]
    const groups = groupByState(blocks)
    expect(groups.length).toBe(1)
    expect(groups[0]?.blocks.map((b) => b.id)).toEqual(['early-p1', 'early-p3', 'late-p1'])
  })

  it('omits empty state groups', () => {
    const blocks = [makeBlock({ id: 'doing', todo_state: 'DOING' })]
    const groups = groupByState(blocks)
    expect(groups.length).toBe(1)
    expect(groups[0]?.label).toBe('DOING')
  })

  it('empty blocks returns empty groups', () => {
    const groups = groupByState([])
    expect(groups).toEqual([])
  })
})

describe('sortByPriority', () => {
  it('sorts priority first, then date, then state', () => {
    const blocks = [
      makeBlock({ id: 'p3-early', priority: '3', due_date: '2025-06-10', todo_state: 'TODO' }),
      makeBlock({ id: 'p1-late', priority: '1', due_date: '2025-06-20', todo_state: 'TODO' }),
      makeBlock({
        id: 'p1-early-doing',
        priority: '1',
        due_date: '2025-06-10',
        todo_state: 'DOING',
      }),
      makeBlock({ id: 'p1-early-done', priority: '1', due_date: '2025-06-10', todo_state: 'DONE' }),
      makeBlock({ id: 'p2', priority: '2', due_date: '2025-06-15', todo_state: 'TODO' }),
    ]
    const sorted = sortByPriority(blocks)
    expect(sorted.map((b) => b.id)).toEqual([
      'p1-early-doing',
      'p1-early-done',
      'p1-late',
      'p2',
      'p3-early',
    ])
  })

  it('sorts null priority to bottom', () => {
    const blocks = [
      makeBlock({ id: 'pn', priority: null, due_date: '2025-06-10' }),
      makeBlock({ id: 'p1', priority: '1', due_date: '2025-06-10' }),
    ]
    const sorted = sortByPriority(blocks)
    expect(sorted[0]?.id).toBe('p1')
    expect(sorted[1]?.id).toBe('pn')
  })

  it('does not mutate input array', () => {
    const blocks = [makeBlock({ id: 'p2', priority: '2' }), makeBlock({ id: 'p1', priority: '1' })]
    const copy = [...blocks]
    sortByPriority(blocks)
    expect(blocks[0]?.id).toBe(copy[0]?.id)
    expect(blocks[1]?.id).toBe(copy[1]?.id)
  })
})

describe('sortByState', () => {
  it('sorts state first, then date, then priority', () => {
    const blocks = [
      makeBlock({ id: 'done', todo_state: 'DONE', due_date: '2025-06-10', priority: '1' }),
      makeBlock({ id: 'doing-late', todo_state: 'DOING', due_date: '2025-06-20', priority: '1' }),
      makeBlock({
        id: 'doing-early-p3',
        todo_state: 'DOING',
        due_date: '2025-06-10',
        priority: '3',
      }),
      makeBlock({
        id: 'doing-early-p1',
        todo_state: 'DOING',
        due_date: '2025-06-10',
        priority: '1',
      }),
      makeBlock({ id: 'todo', todo_state: 'TODO', due_date: '2025-06-10', priority: '1' }),
      makeBlock({ id: 'none', todo_state: null, due_date: '2025-06-10', priority: '1' }),
    ]
    const sorted = sortByState(blocks)
    expect(sorted.map((b) => b.id)).toEqual([
      'doing-early-p1',
      'doing-early-p3',
      'doing-late',
      'todo',
      'done',
      'none',
    ])
  })

  it('sorts null state to bottom', () => {
    const blocks = [
      makeBlock({ id: 'none', todo_state: null, due_date: '2025-06-10' }),
      makeBlock({ id: 'todo', todo_state: 'TODO', due_date: '2025-06-10' }),
    ]
    const sorted = sortByState(blocks)
    expect(sorted[0]?.id).toBe('todo')
    expect(sorted[1]?.id).toBe('none')
  })

  it('does not mutate input array', () => {
    const blocks = [
      makeBlock({ id: 'done', todo_state: 'DONE' }),
      makeBlock({ id: 'doing', todo_state: 'DOING' }),
    ]
    const copy = [...blocks]
    sortByState(blocks)
    expect(blocks[0]?.id).toBe(copy[0]?.id)
    expect(blocks[1]?.id).toBe(copy[1]?.id)
  })
})

describe('sortAgendaBlocksBy', () => {
  const blocks = [
    makeBlock({ id: 'p3-doing', priority: '3', todo_state: 'DOING', due_date: '2025-06-20' }),
    makeBlock({ id: 'p1-todo', priority: '1', todo_state: 'TODO', due_date: '2025-06-10' }),
  ]

  it('dispatches to date sort for sortBy=date', () => {
    const sorted = sortAgendaBlocksBy(blocks, 'date')
    // date-first: 06-10 before 06-20
    expect(sorted[0]?.id).toBe('p1-todo')
    expect(sorted[1]?.id).toBe('p3-doing')
  })

  it('dispatches to priority sort for sortBy=priority', () => {
    const sorted = sortAgendaBlocksBy(blocks, 'priority')
    // priority-first: p1 before p3
    expect(sorted[0]?.id).toBe('p1-todo')
    expect(sorted[1]?.id).toBe('p3-doing')
  })

  it('dispatches to state sort for sortBy=state', () => {
    const sorted = sortAgendaBlocksBy(blocks, 'state')
    // state-first: DOING (0) before TODO (1)
    expect(sorted[0]?.id).toBe('p3-doing')
    expect(sorted[1]?.id).toBe('p1-todo')
  })

  it('dispatches to page sort for sortBy=page', () => {
    const pageBlocks = [
      makeBlock({ id: 'b1', page_id: 'page-b', todo_state: 'TODO' }),
      makeBlock({ id: 'b2', page_id: 'page-a', todo_state: 'TODO' }),
    ]
    const pageTitles = new Map([
      ['page-a', 'Alpha'],
      ['page-b', 'Beta'],
    ])
    const sorted = sortAgendaBlocksBy(pageBlocks, 'page', pageTitles)
    // Alpha before Beta
    expect(sorted[0]?.id).toBe('b2')
    expect(sorted[1]?.id).toBe('b1')
  })
})

describe('groupByPage', () => {
  it('groups blocks by page_id', () => {
    const blocks = [
      makeBlock({ id: 'b1', page_id: 'page-1', todo_state: 'TODO' }),
      makeBlock({ id: 'b2', page_id: 'page-2', todo_state: 'TODO' }),
      makeBlock({ id: 'b3', page_id: 'page-1', todo_state: 'DOING' }),
    ]
    const pageTitles = new Map([
      ['page-1', 'Beta Page'],
      ['page-2', 'Alpha Page'],
    ])
    const groups = groupByPage(blocks, pageTitles)
    // Alphabetical: Alpha Page before Beta Page
    expect(groups.map((g) => g.label)).toEqual(['Alpha Page', 'Beta Page'])
    expect(groups[0]?.blocks.length).toBe(1)
    expect(groups[0]?.blocks[0]?.id).toBe('b2')
    expect(groups[1]?.blocks.length).toBe(2)
  })

  it('puts blocks without page_id in "No page" group at end', () => {
    const blocks = [
      makeBlock({ id: 'b1', page_id: null, todo_state: 'TODO' }),
      makeBlock({ id: 'b2', page_id: 'page-1', todo_state: 'TODO' }),
    ]
    const pageTitles = new Map([['page-1', 'My Page']])
    const groups = groupByPage(blocks, pageTitles)
    expect(groups.length).toBe(2)
    expect(groups[0]?.label).toBe('My Page')
    expect(groups[1]?.label).toBe('No page')
    expect(groups[1]?.className).toBe('text-muted-foreground')
    expect(groups[1]?.blocks[0]?.id).toBe('b1')
  })

  it('sorts within group by state then priority then date', () => {
    const blocks = [
      makeBlock({
        id: 'done-p1',
        page_id: 'page-1',
        todo_state: 'DONE',
        priority: '1',
        due_date: '2026-04-10',
      }),
      makeBlock({
        id: 'todo-p3',
        page_id: 'page-1',
        todo_state: 'TODO',
        priority: '3',
        due_date: '2026-04-10',
      }),
      makeBlock({
        id: 'todo-p1',
        page_id: 'page-1',
        todo_state: 'TODO',
        priority: '1',
        due_date: '2026-04-10',
      }),
      makeBlock({
        id: 'doing',
        page_id: 'page-1',
        todo_state: 'DOING',
        priority: '2',
        due_date: '2026-04-15',
      }),
    ]
    const pageTitles = new Map([['page-1', 'Test Page']])
    const groups = groupByPage(blocks, pageTitles)
    expect(groups.length).toBe(1)
    // DOING first, then TODO p1, TODO p3, then DONE
    expect(groups[0]?.blocks.map((b) => b.id)).toEqual(['doing', 'todo-p1', 'todo-p3', 'done-p1'])
  })
})

describe('sortByPage', () => {
  it('sorts blocks alphabetically by page title', () => {
    const blocks = [
      makeBlock({ id: 'b1', page_id: 'page-c', todo_state: 'TODO' }),
      makeBlock({ id: 'b2', page_id: 'page-a', todo_state: 'TODO' }),
      makeBlock({ id: 'b3', page_id: 'page-b', todo_state: 'TODO' }),
    ]
    const pageTitles = new Map([
      ['page-a', 'Alpha'],
      ['page-b', 'Beta'],
      ['page-c', 'Charlie'],
    ])
    const sorted = sortByPage(blocks, pageTitles)
    expect(sorted.map((b) => b.id)).toEqual(['b2', 'b3', 'b1'])
  })

  it('puts blocks without page_id at end', () => {
    const blocks = [
      makeBlock({ id: 'no-page', page_id: null, todo_state: 'TODO' }),
      makeBlock({ id: 'has-page', page_id: 'page-1', todo_state: 'TODO' }),
    ]
    const pageTitles = new Map([['page-1', 'My Page']])
    const sorted = sortByPage(blocks, pageTitles)
    expect(sorted[0]?.id).toBe('has-page')
    expect(sorted[1]?.id).toBe('no-page')
  })
})

// -----------------------------------------------------------------------
// Priority sort / group with user-configured levels.
// -----------------------------------------------------------------------
describe('custom priority levels', () => {
  it('sortByPriority honours extended level set (A > B > C > D)', () => {
    setPriorityLevels(['A', 'B', 'C', 'D'])
    const blocks = [
      makeBlock({ id: 'd', priority: 'D', due_date: '2025-06-10' }),
      makeBlock({ id: 'a', priority: 'A', due_date: '2025-06-10' }),
      makeBlock({ id: 'c', priority: 'C', due_date: '2025-06-10' }),
      makeBlock({ id: 'b', priority: 'B', due_date: '2025-06-10' }),
      makeBlock({ id: 'n', priority: null, due_date: '2025-06-10' }),
    ]
    const sorted = sortByPriority(blocks)
    expect(sorted.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd', 'n'])
  })

  it('sortAgendaBlocks tiebreaker uses configured level order', () => {
    setPriorityLevels(['High', 'Mid', 'Low'])
    const blocks = [
      makeBlock({
        id: 'low',
        due_date: '2025-06-10',
        todo_state: 'TODO',
        priority: 'Low',
      }),
      makeBlock({
        id: 'high',
        due_date: '2025-06-10',
        todo_state: 'TODO',
        priority: 'High',
      }),
    ]
    const sorted = sortAgendaBlocks(blocks)
    expect(sorted.map((x) => x.id)).toEqual(['high', 'low'])
  })

  it('groupByPriority produces a group per configured level', () => {
    setPriorityLevels(['1', '2', '3', '4'])
    const blocks = [
      makeBlock({ id: 'p1', priority: '1' }),
      makeBlock({ id: 'p2', priority: '2' }),
      makeBlock({ id: 'p3', priority: '3' }),
      makeBlock({ id: 'p4', priority: '4' }),
      makeBlock({ id: 'pn', priority: null }),
    ]
    const groups = groupByPriority(blocks)
    expect(groups.map((g) => g.label)).toEqual(['P1', 'P2', 'P3', 'P4', 'No priority'])
    expect(groups[3]?.blocks[0]?.id).toBe('p4')
  })

  it('groupByPriority handles alphabetical custom level keys', () => {
    setPriorityLevels(['A', 'B'])
    const blocks = [makeBlock({ id: 'a', priority: 'A' }), makeBlock({ id: 'b', priority: 'B' })]
    const groups = groupByPriority(blocks)
    expect(groups.map((g) => g.label)).toEqual(['PA', 'PB'])
  })
})

// ---------------------------------------------------------------------------
// Mutation-testing regression coverage (GitHub #3142 StrykerJS survivors).
// These pin behaviour the specs above exercised but never asserted precisely
// enough to fail under an equivalent-looking mutant: full tie-break chains
// (not just one differentiating pair) and className strings that were
// previously never asserted at all.
// ---------------------------------------------------------------------------

describe('mutation coverage: stateRank ordering', () => {
  it('sorts a fully-reversed input back to DOING > TODO > DONE > CANCELLED > null (same date)', () => {
    // Input is the exact reverse of the correct order so any stateRank mutant
    // that collapses two distinct ranks to the same value (e.g. forcing the
    // DONE or CANCELLED `if` to always/never match) leaves a detectable
    // ordering artifact instead of accidentally reproducing the right answer.
    const blocks = [
      makeBlock({ id: 'none', due_date: '2025-06-15', todo_state: null }),
      makeBlock({ id: 'cancelled', due_date: '2025-06-15', todo_state: 'CANCELLED' }),
      makeBlock({ id: 'done', due_date: '2025-06-15', todo_state: 'DONE' }),
      makeBlock({ id: 'todo', due_date: '2025-06-15', todo_state: 'TODO' }),
      makeBlock({ id: 'doing', due_date: '2025-06-15', todo_state: 'DOING' }),
    ]
    const sorted = sortAgendaBlocks(blocks)
    expect(sorted.map((b) => b.id)).toEqual(['doing', 'todo', 'done', 'cancelled', 'none'])
  })

  it('ranks an unrecognised (empty-string) todo_state like null, distinct from CANCELLED', () => {
    const blocks = [
      makeBlock({ id: 'cancelled', due_date: '2025-06-15', todo_state: 'CANCELLED' }),
      makeBlock({ id: 'empty', due_date: '2025-06-15', todo_state: '' }),
    ]
    const sorted = sortAgendaBlocks(blocks)
    // CANCELLED (rank 3) must still sort before an unrecognised state (rank 4).
    // A StringLiteral mutant on the 'CANCELLED' literal ('' instead) would
    // make '' match the CANCELLED check and tie/invert this pair.
    expect(sorted.map((b) => b.id)).toEqual(['cancelled', 'empty'])
  })
})

describe('mutation coverage: sortAgendaBlocks date/state tiebreak', () => {
  it('keeps an already-correctly-ordered, same-date pair in place (no spurious tiebreak swap)', () => {
    // Same date: only the state tiebreak may reorder these two. If the
    // date-equality check were forced to always fire it would return a
    // constant sign and could flip this already-correct pair.
    const blocks = [
      makeBlock({ id: 'doing', due_date: '2025-06-15', todo_state: 'DOING' }),
      makeBlock({ id: 'done', due_date: '2025-06-15', todo_state: 'DONE' }),
    ]
    const sorted = sortAgendaBlocks(blocks)
    expect(sorted.map((b) => b.id)).toEqual(['doing', 'done'])
  })

  it('lets an earlier date win even when its state ranks worse (date must not be skipped)', () => {
    // 'earlyButCancelled' has the worse state but the earlier date;
    // 'lateButDoing' has the best state but a later date. Input order matches
    // what a (buggy) state-only comparison would already produce, so a
    // mutant that disables the date check would leave the array unchanged.
    const blocks = [
      makeBlock({ id: 'lateButDoing', due_date: '2025-06-20', todo_state: 'DOING' }),
      makeBlock({ id: 'earlyButCancelled', due_date: '2025-06-10', todo_state: 'CANCELLED' }),
    ]
    const sorted = sortAgendaBlocks(blocks)
    expect(sorted.map((b) => b.id)).toEqual(['earlyButCancelled', 'lateButDoing'])
  })

  it('leaves 4 already-ascending distinct dates untouched (ternary direction, not just its guard)', () => {
    // agenda-sort.ts:33 — `dateA < dateB ? -1 : 1`. A mutant that forces
    // this ternary to always take the `-1` branch (regardless of which
    // date is actually earlier) still passes a 2-element "is the earlier
    // date first" check, because with only two elements a constant-sign
    // comparator can accidentally produce the same swap decision either
    // way. With 4 distinct, already-ascending dates, an "always -1"
    // comparator is not a valid total order and empirically reverses the
    // whole array, while the real comparator (correctly a no-op on
    // already-sorted input) leaves it unchanged.
    const blocks = [
      makeBlock({ id: 'a', due_date: '2025-06-10' }),
      makeBlock({ id: 'b', due_date: '2025-06-15' }),
      makeBlock({ id: 'c', due_date: '2025-06-20' }),
      makeBlock({ id: 'd', due_date: '2025-06-25' }),
    ]
    const sorted = sortAgendaBlocks(blocks)
    expect(sorted.map((b) => b.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('mutation coverage: groupByDate zero-padded Today/Tomorrow keys', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // Single-digit month AND day so an un-padded (or blanked) todayStr /
    // tomorrowStr no longer string-equals the zero-padded due_date below.
    vi.setSystemTime(new Date('2025-06-05T12:00:00'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('buckets a single-digit-month/day due date as Today (zero-padding intact)', () => {
    const blocks = [makeBlock({ id: 'today', due_date: '2025-06-05' })]
    const groups = groupByDate(blocks)
    expect(groups.find((g) => g.label === 'Today')?.blocks.map((b) => b.id)).toEqual(['today'])
  })

  it('buckets a single-digit-month/day due date as Tomorrow (zero-padding intact)', () => {
    const blocks = [makeBlock({ id: 'tomorrow', due_date: '2025-06-06' })]
    const groups = groupByDate(blocks)
    expect(groups.find((g) => g.label === 'Tomorrow')?.blocks.map((b) => b.id)).toEqual([
      'tomorrow',
    ])
  })
})

describe('mutation coverage: groupByDate className', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-15T12:00:00'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('assigns the destructive class to Overdue, muted class to No date, and none to a plain date group', () => {
    const blocks = [
      makeBlock({ id: 'overdue', due_date: '2020-01-01', todo_state: 'TODO' }),
      makeBlock({ id: 'future', due_date: '2025-06-20', todo_state: 'TODO' }),
      makeBlock({ id: 'nodate' }),
    ]
    const groups = groupByDate(blocks)
    const overdue = groups.find((g) => g.label === 'Overdue')
    const noDate = groups.find((g) => g.label === 'No date')
    const future = groups.find((g) => g.blocks.some((b) => b.id === 'future'))
    expect(overdue?.className).toBe('text-destructive')
    expect(noDate?.className).toBe('text-muted-foreground')
    expect(future?.className).toBeUndefined()
  })
})

describe('mutation coverage: groupByDate Overdue-before-earlier-raw-date ordering (#1524)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-06-05T12:00:00'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sorts the Overdue group before a raw-date group whose own date is chronologically earlier', () => {
    // agenda-sort.ts:104/109/112/115 — the group-order sort key
    // (`SPECIAL_SORT_KEY`/`sortKeyFor`/the comparator itself). `Overdue`
    // must sort first regardless of how recent its underlying (non-DONE,
    // past) dates are. `doneOld` is DONE, so it's excluded from the
    // `Overdue` bucket and instead keyed by its own raw (very old) date —
    // which sorts EARLIER than `notDoneRecent`'s date in the initial
    // date-ascending pass, so `doneOld`'s raw-date group is inserted into
    // the Map BEFORE the `Overdue` group. If the final group-order sort
    // were a no-op (BlockStatement `{}`), always-undefined `sortKeyFor`
    // (ArrowFunction), the `Overdue` sentinel losing its value
    // (StringLiteral), or a broken 3-way compare (ConditionalExpression/
    // EqualityOperator at line 115), that (wrong) insertion order would
    // survive untouched instead of being corrected to Overdue-first.
    const blocks = [
      makeBlock({ id: 'doneOld', due_date: '2020-01-01', todo_state: 'DONE' }),
      makeBlock({ id: 'notDoneRecent', due_date: '2025-06-01', todo_state: 'TODO' }),
    ]
    const groups = groupByDate(blocks)
    const overdueIdx = groups.findIndex((g) => g.label === 'Overdue')
    const rawDateIdx = groups.findIndex((g) => g.blocks.some((b) => b.id === 'doneOld'))
    expect(overdueIdx).toBeGreaterThanOrEqual(0)
    expect(rawDateIdx).toBeGreaterThanOrEqual(0)
    expect(overdueIdx).toBeLessThan(rawDateIdx)
  })

  it('breaks a tie between Overdue and a raw-date group literally keyed "0000-00-00"', () => {
    // agenda-sort.ts:115 — `Overdue`'s sentinel key IS the literal string
    // '0000-00-00'. A DONE block dated exactly '0000-00-00' is excluded
    // from the Overdue bucket (DONE) and instead forms its OWN raw-date
    // group keyed '0000-00-00' — genuinely tying with Overdue's sort key.
    // `Map` insertion order puts this raw-date group before `Overdue` (it's
    // encountered first during the ascending date pass), so only the final
    // comparator's strict `<` (not `<=`) correctly leaves the tie alone and
    // preserves that order. A `ka <= kb` mutant at line 115 flips a tied
    // comparison to "swap", reversing Overdue and the raw-date group.
    const blocks = [
      makeBlock({ id: 'overdueBlock', due_date: '2020-01-01', todo_state: 'TODO' }),
      makeBlock({ id: 'zeroDateDone', due_date: '0000-00-00', todo_state: 'DONE' }),
    ]
    const groups = groupByDate(blocks)
    const overdueIdx = groups.findIndex((g) => g.label === 'Overdue')
    const zeroIdx = groups.findIndex((g) => g.blocks.some((b) => b.id === 'zeroDateDone'))
    expect(overdueIdx).toBeGreaterThanOrEqual(0)
    expect(zeroIdx).toBeGreaterThanOrEqual(0)
    expect(zeroIdx).toBeLessThan(overdueIdx)
  })
})

describe('mutation coverage: groupByPriority routing and className', () => {
  it('routes null and unrecognised priority values into "No priority", never a phantom bucket', () => {
    const blocks = [
      makeBlock({ id: 'valid', priority: '1' }),
      makeBlock({ id: 'nullPrio', priority: null }),
      makeBlock({ id: 'unknownPrio', priority: 'not-a-real-level' }),
    ]
    const groups = groupByPriority(blocks)
    const noPriority = groups.find((g) => g.label === 'No priority')
    expect(noPriority?.blocks.map((b) => b.id).toSorted()).toEqual(['nullPrio', 'unknownPrio'])
    const p1 = groups.find((g) => g.label === 'P1')
    expect(p1?.blocks.map((b) => b.id)).toEqual(['valid'])
  })

  it('assigns the destructive/pending/active classes by level index, and muted for No priority', () => {
    const blocks = [
      makeBlock({ id: 'p1', priority: '1' }),
      makeBlock({ id: 'p2', priority: '2' }),
      makeBlock({ id: 'p3', priority: '3' }),
      makeBlock({ id: 'pn', priority: null }),
    ]
    const groups = groupByPriority(blocks)
    expect(groups.map((g) => g.className)).toEqual([
      'text-destructive',
      'text-status-pending-foreground',
      'text-status-active-foreground',
      'text-muted-foreground',
    ])
  })

  it('clamps level 4+ to the same "active" class as level 3 (index out of range)', () => {
    setPriorityLevels(['1', '2', '3', '4'])
    const blocks = [makeBlock({ id: 'p4', priority: '4' })]
    const groups = groupByPriority(blocks)
    expect(groups[0]?.className).toBe('text-status-active-foreground')
  })
})

describe('mutation coverage: groupByPriority sortWithin date/state tiebreak', () => {
  it('keeps an already-correctly-ordered, same-date pair in place within a priority group', () => {
    const blocks = [
      makeBlock({ id: 'doing', priority: '1', due_date: '2025-06-15', todo_state: 'DOING' }),
      makeBlock({ id: 'done', priority: '1', due_date: '2025-06-15', todo_state: 'DONE' }),
    ]
    const groups = groupByPriority(blocks)
    expect(groups[0]?.blocks.map((b) => b.id)).toEqual(['doing', 'done'])
  })

  it('lets an earlier date win over a better state within a priority group', () => {
    const blocks = [
      makeBlock({
        id: 'lateButDoing',
        priority: '1',
        due_date: '2025-06-20',
        todo_state: 'DOING',
      }),
      makeBlock({
        id: 'earlyButCancelled',
        priority: '1',
        due_date: '2025-06-10',
        todo_state: 'CANCELLED',
      }),
    ]
    const groups = groupByPriority(blocks)
    expect(groups[0]?.blocks.map((b) => b.id)).toEqual(['earlyButCancelled', 'lateButDoing'])
  })

  it('leaves 4 already-ascending distinct dates untouched within a priority group (ternary direction)', () => {
    // agenda-sort.ts:160 — `dateA < dateB ? -1 : 1`. A ConditionalExpression(true)
    // mutant forces every comparison to -1, which (empirically) reverses an
    // already-ascending 4+-element array under toSorted, even though a naive
    // 2-element check can't tell -1 apart from the correct answer.
    const blocks = [
      makeBlock({ id: 'a', priority: '1', due_date: '2025-06-10' }),
      makeBlock({ id: 'b', priority: '1', due_date: '2025-06-15' }),
      makeBlock({ id: 'c', priority: '1', due_date: '2025-06-20' }),
      makeBlock({ id: 'd', priority: '1', due_date: '2025-06-25' }),
    ]
    const groups = groupByPriority(blocks)
    expect(groups[0]?.blocks.map((b) => b.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('mutation coverage: groupByState className', () => {
  it('assigns the per-state classes, including the CANCELLED token', () => {
    const blocks = [
      makeBlock({ id: 'doing', todo_state: 'DOING' }),
      makeBlock({ id: 'todo', todo_state: 'TODO' }),
      makeBlock({ id: 'done', todo_state: 'DONE' }),
      makeBlock({ id: 'cancelled', todo_state: 'CANCELLED' }),
      makeBlock({ id: 'none', todo_state: null }),
    ]
    const groups = groupByState(blocks)
    expect(groups.map((g) => g.className)).toEqual([
      'text-status-pending-foreground', // DOING
      'text-status-active-foreground', // TODO
      'text-status-done-foreground', // DONE
      'text-task-cancelled', // CANCELLED
      'text-muted-foreground', // No state
    ])
  })
})

describe('mutation coverage: groupByState sortWithin date/priority tiebreak', () => {
  it('keeps an already-correctly-ordered, same-date pair in place within a state group', () => {
    const blocks = [
      makeBlock({ id: 'p1', todo_state: 'TODO', due_date: '2025-06-15', priority: '1' }),
      makeBlock({ id: 'p3', todo_state: 'TODO', due_date: '2025-06-15', priority: '3' }),
    ]
    const groups = groupByState(blocks)
    const todoGroup = groups.find((g) => g.label === 'TODO')
    expect(todoGroup?.blocks.map((b) => b.id)).toEqual(['p1', 'p3'])
  })

  it('lets an earlier date win over a better priority within a state group', () => {
    const blocks = [
      makeBlock({ id: 'lateButP1', todo_state: 'TODO', due_date: '2025-06-20', priority: '1' }),
      makeBlock({ id: 'earlyButP3', todo_state: 'TODO', due_date: '2025-06-10', priority: '3' }),
    ]
    const groups = groupByState(blocks)
    const todoGroup = groups.find((g) => g.label === 'TODO')
    expect(todoGroup?.blocks.map((b) => b.id)).toEqual(['earlyButP3', 'lateButP1'])
  })

  it('leaves 4 already-ascending distinct dates untouched within a state group (ternary direction)', () => {
    // agenda-sort.ts:222 — `dateA < dateB ? -1 : 1`. Same always-(-1)-reverses-a
    // sorted-4-array discriminator as the sortAgendaBlocks/groupByPriority cases.
    const blocks = [
      makeBlock({ id: 'a', todo_state: 'TODO', due_date: '2025-06-10' }),
      makeBlock({ id: 'b', todo_state: 'TODO', due_date: '2025-06-15' }),
      makeBlock({ id: 'c', todo_state: 'TODO', due_date: '2025-06-20' }),
      makeBlock({ id: 'd', todo_state: 'TODO', due_date: '2025-06-25' }),
    ]
    const groups = groupByState(blocks)
    const todoGroup = groups.find((g) => g.label === 'TODO')
    expect(todoGroup?.blocks.map((b) => b.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('mutation coverage: sortByPriority date/state tiebreak', () => {
  it('lets an earlier date win over a better state when priority ties', () => {
    const blocks = [
      makeBlock({
        id: 'lateButDoing',
        priority: '1',
        due_date: '2025-06-20',
        todo_state: 'DOING',
      }),
      makeBlock({
        id: 'earlyButCancelled',
        priority: '1',
        due_date: '2025-06-10',
        todo_state: 'CANCELLED',
      }),
    ]
    const sorted = sortByPriority(blocks)
    expect(sorted.map((b) => b.id)).toEqual(['earlyButCancelled', 'lateButDoing'])
  })

  it('treats equal states as a true tie (state - state, not state + state)', () => {
    // Both blocks share priority, date, and state — the comparator must
    // return 0 (a genuine tie, preserving input order). Note: a `+` mutant
    // here is NOT actually distinguishable by this test alone (0 vs a
    // positive number are both "non-negative", i.e. the same sort decision
    // for a stable 2-element sort) — the real discriminator for +/- is the
    // 'lets a later state's rank win the correct sign' test below.
    const blocks = [
      makeBlock({ id: 'second', priority: '1', due_date: '2025-06-15', todo_state: 'TODO' }),
      makeBlock({ id: 'first', priority: '1', due_date: '2025-06-15', todo_state: 'TODO' }),
    ]
    const sorted = sortByPriority(blocks)
    expect(sorted.map((b) => b.id)).toEqual(['second', 'first'])
  })

  it('orders two differing, tied-on-priority-and-date states by the correct sign (- not +)', () => {
    // agenda-sort.ts:266 — `stateA - stateB`. Unlike the equal-state tie
    // above, DOING (rank 0) vs TODO (rank 1) gives opposite signs for `-`
    // (-1) vs `+` (1), which is a real, observable reorder.
    const blocks = [
      makeBlock({ id: 'todo', priority: '1', due_date: '2025-06-15', todo_state: 'TODO' }),
      makeBlock({ id: 'doing', priority: '1', due_date: '2025-06-15', todo_state: 'DOING' }),
    ]
    const sorted = sortByPriority(blocks)
    expect(sorted.map((b) => b.id)).toEqual(['doing', 'todo'])
  })

  it('falls through to the state tiebreak when priority AND date already tie', () => {
    // agenda-sort.ts:261 (guard) — `dateA !== dateB`. A ConditionalExpression(true)
    // mutant would force entry into the date-ternary even though the dates
    // are equal here, returning 1 (dateA<dateB is false) instead of falling
    // through to the correct state-based order below.
    const blocks = [
      makeBlock({
        id: 'cancelled',
        priority: '1',
        due_date: '2025-06-15',
        todo_state: 'CANCELLED',
      }),
      makeBlock({ id: 'doing', priority: '1', due_date: '2025-06-15', todo_state: 'DOING' }),
    ]
    const sorted = sortByPriority(blocks)
    expect(sorted.map((b) => b.id)).toEqual(['doing', 'cancelled'])
  })

  it('leaves 4 already-ascending distinct dates untouched when priority ties (ternary direction)', () => {
    // agenda-sort.ts:261 (ternary) — `dateA < dateB ? -1 : 1`.
    const blocks = [
      makeBlock({ id: 'a', priority: '1', due_date: '2025-06-10' }),
      makeBlock({ id: 'b', priority: '1', due_date: '2025-06-15' }),
      makeBlock({ id: 'c', priority: '1', due_date: '2025-06-20' }),
      makeBlock({ id: 'd', priority: '1', due_date: '2025-06-25' }),
    ]
    const sorted = sortByPriority(blocks)
    expect(sorted.map((b) => b.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('mutation coverage: sortByState date/priority tiebreak', () => {
  it('keeps an already-correctly-ordered, same-date pair in place when state ties', () => {
    const blocks = [
      makeBlock({ id: 'p1', todo_state: 'TODO', due_date: '2025-06-15', priority: '1' }),
      makeBlock({ id: 'p3', todo_state: 'TODO', due_date: '2025-06-15', priority: '3' }),
    ]
    const sorted = sortByState(blocks)
    expect(sorted.map((b) => b.id)).toEqual(['p1', 'p3'])
  })

  it('lets an earlier date win over a better priority when state ties', () => {
    const blocks = [
      makeBlock({ id: 'lateButP1', todo_state: 'TODO', due_date: '2025-06-20', priority: '1' }),
      makeBlock({ id: 'earlyButP3', todo_state: 'TODO', due_date: '2025-06-10', priority: '3' }),
    ]
    const sorted = sortByState(blocks)
    expect(sorted.map((b) => b.id)).toEqual(['earlyButP3', 'lateButP1'])
  })

  it('leaves 4 already-ascending distinct dates untouched when state ties (ternary direction)', () => {
    // agenda-sort.ts:284 — `dateA < dateB ? -1 : 1`.
    const blocks = [
      makeBlock({ id: 'a', todo_state: 'TODO', due_date: '2025-06-10' }),
      makeBlock({ id: 'b', todo_state: 'TODO', due_date: '2025-06-15' }),
      makeBlock({ id: 'c', todo_state: 'TODO', due_date: '2025-06-20' }),
      makeBlock({ id: 'd', todo_state: 'TODO', due_date: '2025-06-25' }),
    ]
    const sorted = sortByState(blocks)
    expect(sorted.map((b) => b.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('mutation coverage: groupByPage sortWithin priority tiebreak', () => {
  it('lets a better priority win over an earlier date when state ties', () => {
    const blocks = [
      makeBlock({
        id: 'lateButP1',
        page_id: 'pg',
        todo_state: 'TODO',
        priority: '1',
        due_date: '2025-06-20',
      }),
      makeBlock({
        id: 'earlyButP3',
        page_id: 'pg',
        todo_state: 'TODO',
        priority: '3',
        due_date: '2025-06-10',
      }),
    ]
    const pageTitles = new Map([['pg', 'Page']])
    const groups = groupByPage(blocks, pageTitles)
    // priority (2nd tiebreak) dominates date (3rd tiebreak) here.
    expect(groups[0]?.blocks.map((b) => b.id)).toEqual(['lateButP1', 'earlyButP3'])
  })

  it('falls through to the date tiebreak when state AND priority already tie', () => {
    // agenda-sort.ts:317 — `prioA !== prioB`. A ConditionalExpression(true)
    // mutant would force entry into `return prioA - prioB` even when the
    // priorities are equal (0), short-circuiting with 0 instead of falling
    // through to the date-based order below.
    const blocks = [
      makeBlock({
        id: 'late',
        page_id: 'pg',
        todo_state: 'TODO',
        priority: '1',
        due_date: '2025-06-20',
      }),
      makeBlock({
        id: 'early',
        page_id: 'pg',
        todo_state: 'TODO',
        priority: '1',
        due_date: '2025-06-10',
      }),
    ]
    const pageTitles = new Map([['pg', 'Page']])
    const groups = groupByPage(blocks, pageTitles)
    expect(groups[0]?.blocks.map((b) => b.id)).toEqual(['early', 'late'])
  })
})

describe('mutation coverage: groupByPage "No page" guard', () => {
  it('adds no "No page" group when every block has a page_id', () => {
    const blocks = [makeBlock({ id: 'b1', page_id: 'pg', todo_state: 'TODO' })]
    const pageTitles = new Map([['pg', 'Page']])
    const groups = groupByPage(blocks, pageTitles)
    expect(groups.map((g) => g.label)).toEqual(['Page'])
  })
})

describe('mutation coverage: groupByPage sortWithin date tiebreak', () => {
  it('leaves an already-ascending same-state/same-priority date run untouched (ternary direction)', () => {
    // agenda-sort.ts:307 col 33 — `dateA < dateB ? -1 : 1`. A
    // ConditionalExpression(true) mutant on `dateA < dateB` answers -1 for
    // EVERY differing-date pair ("a before b" even when b is the earlier
    // one), which reverses this already-ascending run. Only the `: 1` arm
    // keeps it in place, so the assertion pins the ternary's direction and
    // not merely the guard above it.
    //
    // Note: the assertion (ascending output) is correct and stable, but
    // whether it actually KILLS this mutant depends on an implementation
    // detail of `Array.prototype.sort` — specifically, that V8 reorders a
    // 3-element array when the comparator always answers -1. That is not
    // guaranteed by the spec. If a future engine/runtime stops doing so,
    // this test stays green on both the real code and the mutant, and the
    // mutant would silently go from killed to survived with no local signal
    // — a mutation run showing it alive again should be read as "the sort
    // implementation changed," not as a regression in this test.
    const blocks = [
      makeBlock({
        id: 'jun01',
        page_id: 'pg',
        todo_state: 'TODO',
        priority: '2',
        due_date: '2025-06-01',
      }),
      makeBlock({
        id: 'jun10',
        page_id: 'pg',
        todo_state: 'TODO',
        priority: '2',
        due_date: '2025-06-10',
      }),
      makeBlock({
        id: 'jun20',
        page_id: 'pg',
        todo_state: 'TODO',
        priority: '2',
        due_date: '2025-06-20',
      }),
    ]
    const pageTitles = new Map([['pg', 'Page']])
    const groups = groupByPage(blocks, pageTitles)
    expect(groups[0]?.blocks.map((b) => b.id)).toEqual(['jun01', 'jun10', 'jun20'])
  })
})

describe('mutation coverage: sortByPage no-page-id routing', () => {
  it('sorts a no-page-id block after a paged block regardless of input order or state', () => {
    const pageTitles = new Map([['pg', 'Page']])

    // Exercises the `titleA === null && titleB !== null` branch.
    const a = [
      makeBlock({ id: 'noPage', page_id: null }),
      makeBlock({ id: 'paged', page_id: 'pg' }),
    ]
    expect(sortByPage(a, pageTitles).map((b) => b.id)).toEqual(['paged', 'noPage'])

    // Exercises the `titleA !== null && titleB === null` branch. States are
    // set up so the (buggy) state/priority/date fallthrough would rank the
    // no-page block first — only the hardcoded `return -1` gives the right
    // (page-always-before-no-page) answer here.
    const b = [
      makeBlock({ id: 'paged', page_id: 'pg', todo_state: 'CANCELLED' }),
      makeBlock({ id: 'noPage', page_id: null, todo_state: 'DOING' }),
    ]
    expect(sortByPage(b, pageTitles).map((x) => x.id)).toEqual(['paged', 'noPage'])
  })

  it('falls through to state/priority/date when two blocks share the same page title', () => {
    const pageTitles = new Map([['pg', 'Same Page']])
    const blocks = [
      makeBlock({ id: 'worse', page_id: 'pg', todo_state: 'CANCELLED' }),
      makeBlock({ id: 'better', page_id: 'pg', todo_state: 'DOING' }),
    ]
    const sorted = sortByPage(blocks, pageTitles)
    expect(sorted.map((b) => b.id)).toEqual(['better', 'worse'])
  })

  it('falls through to state/priority/date when BOTH blocks have no page_id (not a blanket "b before a")', () => {
    // agenda-sort.ts:363/364 — `titleB !== null` / `titleA !== null`. Both
    // titles are null here, so neither of these clauses should ever fire on
    // its own (only when exactly one side is null). A mutant that drops
    // either null-check would force a return of 1 or -1 unconditionally
    // whenever ITS side is null, even when both sides are null, breaking the
    // state-based fallback below for two no-page blocks.
    const blocks = [
      makeBlock({ id: 'worse', page_id: null, todo_state: 'CANCELLED' }),
      makeBlock({ id: 'better', page_id: null, todo_state: 'DOING' }),
    ]
    const pageTitles = new Map<string, string>()
    const sorted = sortByPage(blocks, pageTitles)
    expect(sorted.map((b) => b.id)).toEqual(['better', 'worse'])
  })

  it('falls through correctly for two no-page blocks regardless of which one is passed first', () => {
    // agenda-sort.ts:364 — `titleA !== null`. Same reasoning as the test
    // above, but with the input array pre-ordered so the underlying
    // comparator ends up invoked with the opposite (a, b) assignment,
    // exercising line 364's clause instead of 363's.
    const blocks = [
      makeBlock({ id: 'better', page_id: null, todo_state: 'DOING' }),
      makeBlock({ id: 'worse', page_id: null, todo_state: 'CANCELLED' }),
    ]
    const pageTitles = new Map<string, string>()
    const sorted = sortByPage(blocks, pageTitles)
    expect(sorted.map((b) => b.id)).toEqual(['better', 'worse'])
  })

  it('falls through to the priority tiebreak when two same-page blocks tie on state', () => {
    // agenda-sort.ts:380 — `stateA !== stateB`. A ConditionalExpression(true)
    // mutant would force entry into `return stateA - stateB` even when the
    // states are equal (0), short-circuiting with 0 instead of falling
    // through to the priority-based order below.
    const pageTitles = new Map([['pg', 'Same Page']])
    const blocks = [
      makeBlock({ id: 'worseP', page_id: 'pg', todo_state: 'TODO', priority: '3' }),
      makeBlock({ id: 'betterP', page_id: 'pg', todo_state: 'TODO', priority: '1' }),
    ]
    const sorted = sortByPage(blocks, pageTitles)
    expect(sorted.map((b) => b.id)).toEqual(['betterP', 'worseP'])
  })
})

describe('mutation coverage: sortByPage date tiebreak', () => {
  const pageTitles = new Map([['pg', 'Same Page']])
  const sameKeyBlock = (id: string, due_date: string) =>
    makeBlock({ id, page_id: 'pg', todo_state: 'TODO', priority: '2', due_date })

  it('sorts same-page blocks by date ascending when state AND priority tie', () => {
    // agenda-sort.ts:370/374 — the last tiebreak of sortByPage, reached by no
    // test before (Stryker reported the whole line 374 as NoCoverage).
    // `prioA !== prioB` → true short-circuits with `prioA - prioB === 0`, and
    // deleting or inverting the date compare (`dateA !== dateB` → false /
    // `===`, `dateA < dateB` → false / `>=`, `-1` → `+1`) all answer "leave as
    // given" or "reverse" for this deliberately descending input.
    const blocks = [
      sameKeyBlock('jun20', '2025-06-20'),
      sameKeyBlock('jun10', '2025-06-10'),
      sameKeyBlock('jun01', '2025-06-01'),
    ]
    const sorted = sortByPage(blocks, pageTitles)
    expect(sorted.map((b) => b.id)).toEqual(['jun01', 'jun10', 'jun20'])
  })

  it('leaves an already-ascending same-page date run untouched (ternary direction)', () => {
    // agenda-sort.ts:374 col 33 — `dateA < dateB ? -1 : 1`. The mirror of the
    // test above: a ConditionalExpression(true) mutant answers -1 for every
    // differing-date pair and so reverses an input that is already correct.
    //
    // Note: as with the mirrored test above, the assertion is stable but
    // the kill depends on the same V8 sort-implementation detail (a
    // comparator that always returns -1 reordering a 3-element array) —
    // not guaranteed by spec. If that ever changes, this mutant would
    // survive while this test stays green.
    const blocks = [
      sameKeyBlock('jun01', '2025-06-01'),
      sameKeyBlock('jun10', '2025-06-10'),
      sameKeyBlock('jun20', '2025-06-20'),
    ]
    const sorted = sortByPage(blocks, pageTitles)
    expect(sorted.map((b) => b.id)).toEqual(['jun01', 'jun10', 'jun20'])
  })
})

describe('mutation coverage: sortAgendaBlocksBy dispatch', () => {
  it('dispatches "priority" to a genuinely priority-first order (not date-first)', () => {
    const blocks = [
      makeBlock({ id: 'p1-late', priority: '1', due_date: '2025-06-20' }),
      makeBlock({ id: 'p3-early', priority: '3', due_date: '2025-06-10' }),
    ]
    const sorted = sortAgendaBlocksBy(blocks, 'priority')
    expect(sorted.map((b) => b.id)).toEqual(['p1-late', 'p3-early'])
  })

  it('case "state" dispatches to sortByState and does not fall through to the page-sort branch', () => {
    // A BlockStatement mutant emptying the 'state' case body would fall
    // through to 'page', which resolves titles via the (empty) pageTitles
    // map and sorts alphabetically by raw page_id — the opposite order from
    // a genuine state-first sort for these two blocks.
    const blocks = [
      makeBlock({ id: 'doing-lowpage', todo_state: 'DOING', page_id: 'zzz-page' }),
      makeBlock({ id: 'todo-highpage', todo_state: 'TODO', page_id: 'aaa-page' }),
    ]
    const sorted = sortAgendaBlocksBy(blocks, 'state')
    expect(sorted.map((b) => b.id)).toEqual(['doing-lowpage', 'todo-highpage'])
  })

  it('falls back to an empty pageTitles map (raw page_id as title) when omitted for "page"', () => {
    const blocks = [
      makeBlock({ id: 'b1', page_id: 'zzz' }),
      makeBlock({ id: 'b2', page_id: 'aaa' }),
    ]
    const sorted = sortAgendaBlocksBy(blocks, 'page')
    expect(sorted.map((b) => b.id)).toEqual(['b2', 'b1'])
  })
})

describe('mutation coverage: formatGroupDate malformed input fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-15T12:00:00'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('falls back to the raw string when the date has the wrong number of parts', () => {
    const blocks = [makeBlock({ id: 'weird', due_date: '2025-06' })]
    const groups = groupByDate(blocks)
    expect(groups[0]?.label).toBe('2025-06')
  })

  it('falls back to the raw string when a date segment is non-numeric', () => {
    const blocks = [makeBlock({ id: 'weird', due_date: '2025-XX-15' })]
    const groups = groupByDate(blocks)
    expect(groups[0]?.label).toBe('2025-XX-15')
  })

  it('falls back to the raw string for a 4-segment date (too many parts, all numeric)', () => {
    // agenda-sort.ts:429 — `parts.length !== 3`. The 2-part case above
    // ('2025-06') doesn't actually distinguish a ConditionalExpression(false)
    // mutant here, because the resulting `d === undefined` is caught by the
    // (unmutated) guard on line 435 either way. A 4-part date parses into 3
    // fully-defined, non-NaN numbers via `.map(Number)` (the trailing part is
    // simply dropped by destructuring), so forcing this guard off would
    // proceed all the way to constructing a real (wrong) formatted date
    // instead of returning the raw string.
    const blocks = [makeBlock({ id: 'weird', due_date: '2025-06-15-extra' })]
    const groups = groupByDate(blocks)
    expect(groups[0]?.label).toBe('2025-06-15-extra')
  })
})
