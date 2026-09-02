import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import {
  compareGroupSortKeys,
  getAgendaGroupKey,
  GROUP_RANK,
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
import { getAppLocaleTag } from '@/lib/date-locale'
import { i18n } from '@/lib/i18n'
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

  it('keeps an earlier date first even when the later-dated block wins every later tiebreak', () => {
    // `compareDateStrings` — the `a > b ? 1 : 0` arm. A
    // ConditionalExpression(false) mutant answers 0 ("equal") instead of 1 for
    // an a-after-b pair, which falls through to the state tiebreak. Every
    // other date test either ties on state or is ordered by the `a < b` arm,
    // so only a pair whose later date carries the STRONGER state can tell 1
    // apart from 0 here.
    const sorted = sortAgendaBlocks([
      makeBlock({ id: 'earlyWeakState', due_date: '2025-06-10', todo_state: 'TODO' }),
      makeBlock({ id: 'lateStrongState', due_date: '2025-06-20', todo_state: 'DOING' }),
    ])
    expect(sorted.map((b) => b.id)).toEqual(['earlyWeakState', 'lateStrongState'])
  })

  it('keeps an already-dated-first pair in order, and orders two undated blocks by state', () => {
    // Exercises the other two arms of the date rank: `a` undated / `b` dated
    // (must return "after", leaving the pair alone) and both undated (must
    // return "equal" so the state tiebreak decides). The `no date to bottom`
    // test above only reaches the `b` undated arm, because V8 invokes the
    // comparator as `compare(arr[1], arr[0])` for a two-element array.
    const datedFirst = sortAgendaBlocks([
      makeBlock({ id: 'dated', due_date: '2025-06-15', todo_state: 'DONE' }),
      makeBlock({ id: 'undated', todo_state: 'DOING' }),
    ])
    expect(datedFirst.map((b) => b.id)).toEqual(['dated', 'undated'])

    const bothUndated = sortAgendaBlocks([
      makeBlock({ id: 'undatedTodo', todo_state: 'TODO' }),
      makeBlock({ id: 'undatedDoing', todo_state: 'DOING' }),
    ])
    expect(bothUndated.map((b) => b.id)).toEqual(['undatedDoing', 'undatedTodo'])
  })

  it('sorts a block genuinely due 9999-12-31 above an undated block (#3806)', () => {
    // Undated blocks used to borrow '9999-12-31' as their sort key, so a real
    // 9999-12-31 due date merely TIED with them and the state/priority
    // tiebreaks decided the order. Here the undated block would win that
    // tiebreak (DOING > TODO), so a tie surfaces as the wrong order.
    const blocks = [
      makeBlock({ id: 'undated', todo_state: 'DOING' }),
      makeBlock({ id: 'farFuture', due_date: '9999-12-31', todo_state: 'TODO' }),
    ]
    const sorted = sortAgendaBlocks(blocks)
    expect(sorted.map((b) => b.id)).toEqual(['farFuture', 'undated'])
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

  it('treats an empty-string due_date as no date, not as an overdue one', () => {
    // `''` is falsy but not nullish, so `effectiveDate`'s old `??` chain
    // accepted it as a date — and `'' < todayStr` holds for every real today,
    // so a blank due_date bucketed as OVERDUE and rendered in the destructive
    // style. `validate_date_format` rejects `''`, so this is hand-edited or
    // imported data (the same class as '0000-00-00'), but it was the last
    // not-a-date value that could still reach the date half of a sort key.
    const blocks = [
      makeBlock({ id: 'emptyDue', due_date: '', todo_state: 'TODO' }),
      makeBlock({ id: 'realOverdue', due_date: '2020-01-01', todo_state: 'TODO' }),
    ]
    const groups = groupByDate(blocks)
    expect(groups.find((g) => g.label === 'Overdue')?.blocks.map((b) => b.id)).toEqual([
      'realOverdue',
    ])
    expect(groups.at(-1)?.label).toBe('No date')
    expect(groups.at(-1)?.blocks.map((b) => b.id)).toEqual(['emptyDue'])
  })

  it('falls through an empty-string due_date to scheduled_date', () => {
    // The fallback chain must SKIP a blank due_date rather than stop at it:
    // `''` means "absent", not "due, date unknown".
    const blocks = [makeBlock({ id: 'blankDue', due_date: '', scheduled_date: '2025-01-15' })]
    const groups = groupByDate(blocks)
    expect(groups.map((g) => g.label)).toEqual(['Today'])
    expect(groups[0]?.blocks.map((b) => b.id)).toEqual(['blankDue'])
  })

  it('does not merge a due_date that literally spells "Today" into the real Today group (#3814)', () => {
    // Unreachable through validated writes — `validate_date_format` rejects
    // a non-ISO string like `'Today'` at every write path, so this needs a
    // hand-edited database or a sync-protocol bug (same class as #3806's
    // sentinel and this file's blank-due_date fixes above). It pins the
    // bucket-KEY namespace itself: `groupByDate` used to key both real dates
    // and the four special labels in the same `Map<string, BlockRow[]>`, so
    // a due_date of the literal string "Today" collided with the "Today"
    // group's own key and merged into it, inheriting its label/semantics.
    const blocks = [
      makeBlock({ id: 'literalToday', due_date: 'Today', todo_state: 'TODO' }),
      makeBlock({ id: 'realToday', due_date: '2025-01-15', todo_state: 'TODO' }),
    ]
    const groups = groupByDate(blocks)

    // Two SEPARATE groups now — the collision is fixed at the bucket-key
    // level, which is what #3814 is about.
    expect(groups).toHaveLength(2)

    // The real "Today" group must hold ONLY the block genuinely due today.
    // Indexed positionally, NOT via `find(label === 'Today')`: see the
    // display-layer note below — both groups carry that label, so `find`
    // would silently match the first and hide the very thing being pinned.
    expect(groups[0]?.blocks.map((b) => b.id)).toEqual(['realToday'])

    // The literal-string block must not vanish — it lands in its own
    // separate bucket rather than being absorbed.
    expect(groups[1]?.blocks.map((b) => b.id)).toEqual(['literalToday'])

    // KNOWN, DELIBERATELY UNFIXED display-layer limit: `formatGroupDate`
    // falls back to the raw string for anything that is not three
    // dash-separated numeric parts, so the bogus bucket RENDERS as "Today"
    // too — the UI would show two groups under the same heading. #3814 is
    // about data integrity (which block lands in which bucket), and that is
    // fixed; disambiguating the two headings is a separate display concern
    // and is not claimed here. Pinned so the gap is visible rather than
    // implied by the test's silence.
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Today'])

    // #3845 — the duplicate LABEL pinned above is cosmetic; the duplicate
    // RENDER KEY it produces downstream is the more consequential half.
    // `AgendaResults` derives its React key from `getAgendaGroupKey`
    // (`header:${...}`, see `useVirtualizedGroupedRows`), which used to be
    // `(g) => g.label` — identical for both groups here, so React would
    // receive two `header:Today` siblings. `getAgendaGroupKey` must
    // disambiguate them using `special` (only the real "Today" bucket
    // carries it; the literal-string bucket is an ordinary date group with
    // `special: null`) even though their `label`s are the same string.
    const keys = groups.map(getAgendaGroupKey)
    expect(keys[0]).not.toBe(keys[1])
    expect(new Set(keys).size).toBe(2)
  })

  // Title narrowed (#3845): this covers only `groupByDate`'s bucket-KEY
  // namespace, not the display-layer label→i18n-key lookup one layer
  // downstream (`AgendaResults`'s `GROUP_I18N`) — that hazard is separate
  // and is pinned by AgendaResults.test.tsx's "renders 'constructor' as a
  // literal group label" test instead.
  it('handles due_date values of "__proto__" / "constructor" without prototype pollution in the bucket-key Map (#3814)', () => {
    // Same unreachable-through-validated-writes class as the "Today" test
    // above. `specialGroups`/`specialSortKey` are keyed ONLY by the fixed
    // `SpecialLabel` union ('Overdue' | 'Today' | 'Tomorrow' | 'No date'), so
    // a raw due_date can only ever reach `dateGroups` — a Map, immune to
    // `Object.prototype` — never index the `specialSortKey` object literal.
    // This pins that at runtime, not just at the (erased) type level: these
    // two blocks must round-trip as ordinary dated groups, not silently
    // resolve to `Object.prototype.constructor` / vanish / throw.
    const blocks = [
      makeBlock({ id: 'protoDue', due_date: '__proto__', todo_state: 'TODO' }),
      makeBlock({ id: 'ctorDue', due_date: 'constructor', todo_state: 'TODO' }),
    ]
    const groups = groupByDate(blocks)

    const allIds = groups.flatMap((g) => g.blocks.map((b) => b.id))
    expect(allIds).toEqual(['protoDue', 'ctorDue'])

    // Neither string coincides with a real special label, so no group here
    // is (spuriously) classed as Overdue / No date.
    for (const group of groups) {
      expect(group.className).toBeUndefined()
    }

    // The labels themselves are the raw strings, unmolested by prototype
    // lookups (`formatGroupDate` falls back to the raw string for a
    // non-YYYY-MM-DD input).
    expect(groups.map((g) => g.label)).toEqual(['__proto__', 'constructor'])
  })

  it('keeps a block genuinely due 9999-12-31 in its own dated group, not "No date" (#3806)', () => {
    // `9999-12-31` used to be `effectiveDate`'s no-date sentinel, so a block
    // really due that day was routed into the `No date` bucket. It is a
    // calendar-valid ISO date that `set_due_date` accepts, so it is reachable.
    const blocks = [
      makeBlock({ id: 'farFuture', due_date: '9999-12-31', todo_state: 'TODO' }),
      makeBlock({ id: 'undated', todo_state: 'TODO' }),
    ]
    const groups = groupByDate(blocks)
    const noDate = groups.find((g) => g.label === 'No date')
    expect(noDate?.blocks.map((b) => b.id)).toEqual(['undated'])
    const farFutureGroup = groups.find((g) => g.blocks.some((b) => b.id === 'farFuture'))
    expect(farFutureGroup?.label).not.toBe('No date')
    expect(farFutureGroup?.className).toBeUndefined()
    // ...and it still sorts before the undated group, which stays last.
    expect(groups.at(-1)?.label).toBe('No date')
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

  // #757 — concrete date headers are formatted via the app locale
  // (`getAppLocaleTag()`, #4555 — was `toLocaleDateString(undefined, …)`
  // i.e. the OS/browser locale, until that was found to disagree with the
  // pinned-`'en'` UI catalog) instead of hardcoded English weekday/month
  // tables. Compute the expected labels with the same Intl options so
  // these assertions hold under any `i18n.language`. Weekday is always
  // included; the year only when it differs from the (fake-timer-pinned
  // 2025) current year.
  function expectedHeader(dateStr: string): string {
    const [y, m, d] = dateStr.split('-').map(Number)
    return new Date(y as number, (m as number) - 1, d).toLocaleDateString(getAppLocaleTag(), {
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

  // #4555 — pins the TRACKING behaviour end to end: `groupByDate`'s date
  // headers must follow a real `i18n.changeLanguage()`, not the OS/browser
  // locale (nothing here touches `navigator`) and not a hardcoded English
  // table. Fails if `formatGroupDate` reverts to `toLocaleDateString
  // (undefined, …)` or a literal.
  it('#4555: date group headers track i18n.language, and revert when it changes back', async () => {
    const blocks = [makeBlock({ id: 'mon', due_date: '2026-06-15', todo_state: 'TODO' })]
    try {
      await i18n.changeLanguage('es')
      expect(groupByDate(blocks).map((g) => g.label)).toEqual([expectedHeader('2026-06-15')])
      expect(groupByDate(blocks)[0]?.label).toBe('lun, 15 jun 2026')
    } finally {
      await i18n.changeLanguage('en')
    }
    expect(groupByDate(blocks)[0]?.label).toBe('Mon, Jun 15, 2026')
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
    // `compareDateStrings` (reached from `sortAgendaBlocks`'s date-ascending
    // tiebreak) — `dateA < dateB ? -1 : ...`. A mutant that forces
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
    // `groupByDate`'s `specialSortKey` map and `compareGroupSortKeys` — the
    // group-order sort key. `Overdue` must sort first regardless of how
    // recent its underlying (non-DONE, past) dates are. `doneOld` is DONE,
    // so it's excluded from the `Overdue` bucket and instead keyed by its
    // own raw (very old) date, landing in `dateGroups` rather than
    // `specialGroups`. The final `.toSorted(compareGroupSortKeys)` call is
    // what actually orders the two: `Overdue`'s `beforeDates` rank must beat
    // `doneOld`'s `dated` rank regardless of how the two dates themselves
    // compare — a broken rank in `specialSortKey`, or a broken 3-way compare
    // in `compareGroupSortKeys`, would let `doneOld`'s much-earlier raw date
    // invert the order.
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

  it('pins Overdue ahead of a raw-date group keyed "0000-00-00" rather than tying with it', () => {
    // `Overdue`'s group sort key USED TO BE the literal string '0000-00-00'.
    // A DONE block dated exactly '0000-00-00' is excluded from the Overdue
    // bucket (DONE) and forms its OWN raw-date group keyed '0000-00-00', which
    // therefore *tied* with Overdue — the rendered order fell out of `Map`
    // insertion order, and the raw-date group came first only because the
    // ascending date pass reached it first (#3790 finding 4).
    //
    // The composite `[rank, date]` key gives Overdue a rank no date string can
    // occupy, so it is now strictly first whatever the raw date is. Kills a
    // dropped/inverted `rankA !== rankB` comparison on the group comparator.
    //
    // Reachability: '0000-00-00' is rejected by the backend
    // (`validate_date_format` — month 00 is not a calendar date), so this
    // fixture models hand-edited or imported data rather than anything the UI
    // can write. The *reachable* member of this bug class is '9999-12-31'
    // (#3806), covered by the `groupByDate` suite above.
    const blocks = [
      makeBlock({ id: 'overdueBlock', due_date: '2020-01-01', todo_state: 'TODO' }),
      makeBlock({ id: 'zeroDateDone', due_date: '0000-00-00', todo_state: 'DONE' }),
    ]
    const groups = groupByDate(blocks)
    const overdueIdx = groups.findIndex((g) => g.label === 'Overdue')
    const zeroIdx = groups.findIndex((g) => g.blocks.some((b) => b.id === 'zeroDateDone'))
    expect(overdueIdx).toBeGreaterThanOrEqual(0)
    expect(zeroIdx).toBeGreaterThanOrEqual(0)
    expect(overdueIdx).toBeLessThan(zeroIdx)
  })

  it('sorts a past-dated raw group before Tomorrow, not after it', () => {
    // The Tomorrow entry of `specialSortKey` carries the date it stands for
    // (`[dated, tomorrowStr]`), which is what makes it participate in the
    // chronological ordering instead of riding on insertion order: every
    // special group is built BEFORE any raw-date group (`entries` concatenates
    // `specialGroups` first), so a past-dated DONE group — which keeps its own
    // raw date rather than joining Overdue — only overtakes Tomorrow if the
    // comparator actually reads Tomorrow's date. The Today analogue is covered
    // by "orders a past-dated DONE group before Today" above; this is the
    // Tomorrow half of the same pair.
    const blocks = [
      makeBlock({ id: 'tomorrow', due_date: '2025-06-06', todo_state: 'TODO' }),
      makeBlock({ id: 'pastDone', due_date: '2025-01-10', todo_state: 'DONE' }),
    ]
    const groups = groupByDate(blocks)
    // Assert on `special`, not the raw group's label: that label is a
    // locale-formatted date string.
    expect(groups.map((g) => g.special)).toEqual([null, 'Tomorrow'])
    expect(groups[0]?.blocks.map((b) => b.id)).toEqual(['pastDone'])
  })
})

describe('getAgendaGroupKey', () => {
  // `useVirtualizedGroupedRows` renders `header:${getAgendaGroupKey(g)}` as a
  // React key, so both halves of the returned string are load-bearing: the
  // `special:` / `label:` namespace tag is what keeps a raw `due_date` that
  // spells "Today" from colliding with the real Today bucket (#3845), and the
  // interpolated value is what keeps two groups within one namespace apart.
  it('namespaces a special bucket and a same-named raw date bucket into different keys', () => {
    expect(getAgendaGroupKey({ label: 'Today', blocks: [], special: 'Today' })).toBe(
      'special:Today',
    )
    expect(getAgendaGroupKey({ label: 'Today', blocks: [], special: null })).toBe('label:Today')
  })

  it('keys a group with no `special` field at all by its label', () => {
    // `groupByPriority` / `groupByState` / `groupByPage` omit `special`
    // entirely, so `undefined` — not just `null` — has to reach the `label:`
    // namespace.
    expect(getAgendaGroupKey({ label: 'No priority', blocks: [] })).toBe('label:No priority')
  })
})

describe('compareGroupSortKeys: the group-order contract', () => {
  // `groupByDate` builds its buckets from a date-ascending pass, so the
  // `dated` groups always ARRIVE chronologically and no reachable input makes
  // two of them reach the comparator out of order — the rank comparison is the
  // only half that reorders anything in production. Driving the comparator
  // directly is what turns the date half from an unreachable arm into a stated
  // contract: group order is a function of the KEYS, not of Map insertion
  // order. If the bucketing pass is ever restructured (built lazily, grouped
  // by something else first, merged with another pass), these tests are what
  // says the output is still chronological.
  const dated = (date: string) => [GROUP_RANK.dated, date] as const
  const overdue = [GROUP_RANK.beforeDates, null] as const
  const noDate = [GROUP_RANK.afterDates, null] as const

  it('orders two dated groups chronologically whichever way round they are fed', () => {
    expect(compareGroupSortKeys(dated('2025-06-10'), dated('2025-06-02'))).toBeGreaterThan(0)
    expect(compareGroupSortKeys(dated('2025-06-02'), dated('2025-06-10'))).toBeLessThan(0)
    expect(compareGroupSortKeys(dated('2025-06-02'), dated('2025-06-02'))).toBe(0)
  })

  it('sorts a scrambled list of dated keys chronologically', () => {
    const keys = ['2026-01-02', '2025-12-31', '2025-01-15'].map(dated)
    expect(keys.toSorted(compareGroupSortKeys).map(([, date]) => date)).toEqual([
      '2025-01-15',
      '2025-12-31',
      '2026-01-02',
    ])
  })

  it('pins Overdue before every dated key and No date after every one', () => {
    // The dates here are the two strings the OLD encoding used as position
    // sentinels in the date field itself: with a rank they are just dates, and
    // a real group keyed by either of them cannot tie with a special group.
    expect(compareGroupSortKeys(overdue, dated('0000-00-00'))).toBeLessThan(0)
    expect(compareGroupSortKeys(dated('0000-00-00'), overdue)).toBeGreaterThan(0)
    expect(compareGroupSortKeys(dated('9999-12-31'), noDate)).toBeLessThan(0)
    expect(compareGroupSortKeys(noDate, dated('9999-12-31'))).toBeGreaterThan(0)
    // Overdue vs No date directly: the two ranks furthest apart, which is the
    // pair that tells `rankA - rankB` from a same-sign arithmetic mutant.
    expect(compareGroupSortKeys(noDate, overdue)).toBeGreaterThan(0)
    expect(compareGroupSortKeys(overdue, noDate)).toBeLessThan(0)
  })

  it('reports the dateless ranks as equal to themselves', () => {
    // Both singleton ranks carry `null`, never a placeholder date, so the
    // date half must treat them as equal rather than compare a sentinel.
    expect(compareGroupSortKeys(overdue, overdue)).toBe(0)
    expect(compareGroupSortKeys(noDate, noDate)).toBe(0)
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
    // `compareDateStrings` (reached from `groupByPriority`'s `sortWithin`
    // date tiebreak) — `dateA < dateB ? -1 : ...`. A ConditionalExpression(true)
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
    // `compareDateStrings` (reached from `groupByState`'s `sortWithin`
    // date tiebreak) — same always-(-1)-reverses-a
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
    // `sortByPriority`'s state tiebreak — `stateA - stateB`. Unlike the equal-state tie
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
    // `sortByPriority`'s date-tiebreak guard — `byDate !== 0`. A ConditionalExpression(true)
    // mutant would force `return byDate` even though the dates are equal here,
    // returning 0 instead of falling through to the correct state-based order
    // below.
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
    // `compareDateStrings` (reached from `sortByPriority`'s date tiebreak) —
    // `dateA < dateB ? -1 : ...`.
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
    // `compareDateStrings` (reached from `sortByState`'s date tiebreak) —
    // `dateA < dateB ? -1 : ...`.
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
    // `groupByPage`'s `sortWithin` priority-tiebreak guard — `prioA !== prioB`. A ConditionalExpression(true)
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
    // `compareDateStrings` (reached from `groupByPage`'s `sortWithin`
    // date tiebreak) — `dateA < dateB ? -1 : ...`. A
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
    // `sortByPage`'s two no-page-id guards — `titleB !== null` / `titleA !== null`. Both
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
    // `sortByPage`'s second no-page-id guard — `titleA !== null`. Same
    // reasoning as the test above, but with the input array pre-ordered so
    // the underlying comparator ends up invoked with the opposite (a, b)
    // assignment, exercising that second guard (`titleA !== null && titleB
    // === null`) instead of the first (`titleA === null && titleB !== null`).
    const blocks = [
      makeBlock({ id: 'better', page_id: null, todo_state: 'DOING' }),
      makeBlock({ id: 'worse', page_id: null, todo_state: 'CANCELLED' }),
    ]
    const pageTitles = new Map<string, string>()
    const sorted = sortByPage(blocks, pageTitles)
    expect(sorted.map((b) => b.id)).toEqual(['better', 'worse'])
  })

  it('falls through to the priority tiebreak when two same-page blocks tie on state', () => {
    // `sortByPage`'s state-tiebreak guard — `stateA !== stateB`. A ConditionalExpression(true)
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
    // The last tiebreak of `sortByPage` (its final `compareByDate` call),
    // reached by no test before (Stryker once reported the whole
    // date-compare line as NoCoverage). `prioA !== prioB` → true
    // short-circuits with `prioA - prioB === 0`, and deleting or inverting
    // the date compare in `compareByDate` answers "leave as given" or
    // "reverse" for this deliberately descending input.
    const blocks = [
      sameKeyBlock('jun20', '2025-06-20'),
      sameKeyBlock('jun10', '2025-06-10'),
      sameKeyBlock('jun01', '2025-06-01'),
    ]
    const sorted = sortByPage(blocks, pageTitles)
    expect(sorted.map((b) => b.id)).toEqual(['jun01', 'jun10', 'jun20'])
  })

  it('leaves an already-ascending same-page date run untouched (ternary direction)', () => {
    // `compareDateStrings` (reached from `sortByPage`'s final date tiebreak) —
    // `dateA < dateB ? -1 : ...`. The mirror of the
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
    // `formatGroupDate`'s part-count guard — `parts.length !== 3`. The
    // 2-part case above ('2025-06') doesn't actually distinguish a
    // ConditionalExpression(false) mutant here, because the resulting
    // `d === undefined` is caught by `formatGroupDate`'s own (unmutated)
    // `y/m/d === undefined` narrowing guard either way. A 4-part date parses into 3
    // fully-defined, non-NaN numbers via `.map(Number)` (the trailing part is
    // simply dropped by destructuring), so forcing this guard off would
    // proceed all the way to constructing a real (wrong) formatted date
    // instead of returning the raw string.
    const blocks = [makeBlock({ id: 'weird', due_date: '2025-06-15-extra' })]
    const groups = groupByDate(blocks)
    expect(groups[0]?.label).toBe('2025-06-15-extra')
  })
})

/*
 * ---------------------------------------------------------------------------
 * EQUIVALENT-MUTANT LEDGER — src/lib/agenda-sort.ts (#3749)
 * ---------------------------------------------------------------------------
 * Mutants that survive the Stryker run and CANNOT be killed: each produces
 * output identical to the original for every reachable input. Recorded so the
 * next triage pass does not re-derive them. Line numbers are from the
 * 2026-08-31 run and will drift; the (col, mutator, replacement) triple is the
 * stable id. Format: line:col [mutator] verbatim replacement.
 *
 * 259:14 [ArrayDeclaration] "[]"  (`Overdue: [GROUP_RANK.beforeDates, null]`)
 *      The empty key destructures to `[undefined, undefined]`, so every
 *      comparison involving Overdue yields NaN, which SortCompare coerces to
 *      +0 — Overdue then compares equal to everything and a stable sort leaves
 *      it where it already is. Where it already is, is first: `beforeDates` is
 *      the minimum rank, and Overdue is also the first entry of the array
 *      being sorted, because `entries` lists every special group before every
 *      raw-date group and the date-ascending pass in `sortAgendaBlocks`
 *      reaches an overdue block (date < today) before any Today/Tomorrow/
 *      undated one. Correct position and mutated position coincide for every
 *      input. (The sibling `Today` and `Tomorrow` entries are NOT equivalent —
 *      both must overtake an earlier raw-date group — and both are killed.)
 *
 * 326:7  [ConditionalExpression] "true"  (`block.priority != null`, the LEFT
 *      operand of the `&&` — the mutants on the whole condition at 326:7-68
 *      and on the right operand at 326:33 are all killed)
 *      `levels` holds only trimmed non-empty strings (`priority-levels.ts`
 *      normalises them), so `levels.indexOf(null)` is -1 and the right operand
 *      already rejects a null priority on its own. The conjunct is kept for
 *      narrowing: `groupLabel` takes a `string`.
 *
 * 329:5  [OptionalChaining] "buckets.get(key).push"  (`groupByPriority`)
 * 385:5  [OptionalChaining] "buckets.get(key).push"  (`groupByState`)
 *      Both `?.` can never short-circuit: the key is drawn from exactly the
 *      set of keys `buckets` was pre-seeded with one loop earlier —
 *      `groupLabel(lv) for lv of levels` plus `NO_PRIORITY`, and
 *      `TASK_STATE_SORT_ORDER` (which covers every `TodoState` `isTodoState`
 *      admits) plus `NO_STATE`. `Map.get` therefore never returns undefined.
 *
 * 355:66 [StringLiteral] "\"Stryker was here!\""  (NoCoverage — the `?? ''` in
 *      `classForLevel`)
 *      Unreachable, hence uncovered: the one call site passes
 *      `label.replace(/^P/, '')` where `label` is `` `P${lv}` `` for an
 *      `lv` from `levels`, so `idx >= 0` and the clamped index is always in
 *      range. Kept for `noUncheckedIndexedAccess` (#3790 finding 1).
 *
 * 362:85 [Regex] "/P/"  (`label.replace(/^P/, '')`)
 *      Dropping the anchor cannot change the result: the ternary one line up
 *      routes `NO_PRIORITY` elsewhere, so every label reaching this branch is
 *      `` `P${lv}` `` and its first `P` IS at index 0 — which is the only
 *      occurrence a non-global `replace` touches.
 *
 * 542:9  [ConditionalExpression] "true" (×2 — whole condition and the
 *        `titleA !== null` operand)
 * 542:9  [LogicalOperator] "titleA !== null || titleB !== null"
 * 542:28 [ConditionalExpression] "true"  (the `titleB !== null` operand)
 *      Both `!== null` clauses are constantly true at this point: lines
 *      535-536 return for every one-sided-null pair, and the both-null pair
 *      falls through to the state/priority/date chain either way (`titleA !==
 *      titleB` is false when both are null). Kept for narrowing —
 *      `titleA.localeCompare` does not typecheck without them (#3790
 *      finding 3).
 *
 * 605:7  [ConditionalExpression] "false" (×3 — whole condition and two
 *        operands), [LogicalOperator] (×2)
 * 605:26 [ConditionalExpression] "false"  (`m === undefined`)
 * 605:45 [ConditionalExpression] "false"  (`d === undefined`)
 *      Same class, in `formatGroupDate`: `parts.length !== 3` returned two
 *      lines earlier, so all three destructured slots exist and no mutation of
 *      this guard can reach a different arm. Kept for
 *      `noUncheckedIndexedAccess` (#3790 finding 3).
 */
