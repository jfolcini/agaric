/**
 * Tests for src/lib/agenda-filters.ts — pure filter execution engine.
 *
 * Verifies the AgendaFilter[] → `filtered_blocks_query` translation
 * (audit H3), the tag-id resolution path, the empty-filter default
 * branch, and edge cases.
 */

import { invoke } from '@tauri-apps/api/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlock } from '../../__tests__/fixtures'
import {
  AGENDA_QUERY_LIMIT,
  executeAgendaFilters,
  loadMoreAgendaFilters,
  loadMoreUnfilteredAgenda,
  toFutureDatePreset,
  toPastDatePreset,
} from '../agenda-filters'

const mockedInvoke = vi.mocked(invoke)

const emptyPage = { items: [], next_cursor: null, has_more: false, total_count: null }

beforeEach(() => {
  vi.clearAllMocks()
  mockedInvoke.mockResolvedValue(emptyPage)
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Preset mapping helpers
// ---------------------------------------------------------------------------

describe('AGENDA_QUERY_LIMIT', () => {
  it('is 200 (limit-clamp-followup Phase 1: pinned to PageRequest::new cap)', () => {
    expect(AGENDA_QUERY_LIMIT).toBe(200)
  })
})

describe('toFutureDatePreset', () => {
  it('maps known labels to presets', () => {
    expect(toFutureDatePreset('Today')).toBe('today')
    expect(toFutureDatePreset('This week')).toBe('this-week')
    expect(toFutureDatePreset('This month')).toBe('this-month')
    expect(toFutureDatePreset('Next 7 days')).toBe('next-7-days')
    expect(toFutureDatePreset('Next 14 days')).toBe('next-14-days')
    expect(toFutureDatePreset('Next 30 days')).toBe('next-30-days')
  })

  it('returns null for unknown labels', () => {
    expect(toFutureDatePreset('Unknown')).toBeNull()
    expect(toFutureDatePreset('')).toBeNull()
  })
})

describe('toPastDatePreset', () => {
  it('maps known labels to presets', () => {
    expect(toPastDatePreset('Today')).toBe('today')
    expect(toPastDatePreset('This week')).toBe('this-week')
    expect(toPastDatePreset('This month')).toBe('this-month')
    expect(toPastDatePreset('Last 7 days')).toBe('last-7-days')
    expect(toPastDatePreset('Last 30 days')).toBe('last-30-days')
  })

  it('returns null for unknown labels', () => {
    expect(toPastDatePreset('Unknown')).toBeNull()
    expect(toPastDatePreset('Next 7 days')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract every `filtered_blocks_query` invocation argument. */
function filteredCalls(): Array<Record<string, unknown>> {
  return mockedInvoke.mock.calls
    .filter(([cmd]) => cmd === 'filtered_blocks_query')
    .map(([, args]) => args as Record<string, unknown>)
}

// ---------------------------------------------------------------------------
// executeAgendaFilters — empty filter list (default unfiltered branch)
// ---------------------------------------------------------------------------

describe('executeAgendaFilters', () => {
  describe('empty filter list', () => {
    it('returns merged due_date and scheduled_date blocks', async () => {
      const dueBlock = makeBlock({ id: 'due-1', due_date: '2025-01-15' })
      const schedBlock = makeBlock({ id: 'sched-1', scheduled_date: '2025-01-16' })

      mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
        const a = args as Record<string, unknown>
        if (cmd === 'list_undated_tasks') return emptyPage
        if (a['key'] === 'due_date') {
          return { items: [dueBlock], next_cursor: null, has_more: false }
        }
        if (a['key'] === 'scheduled_date') {
          return { items: [schedBlock], next_cursor: null, has_more: false }
        }
        return emptyPage
      })

      const result = await executeAgendaFilters([], null)

      expect(result.blocks).toHaveLength(2)
      expect(result.blocks.map((b) => b.id)).toEqual(['due-1', 'sched-1'])
      expect(result.hasMore).toBe(false)
      expect(result.cursor).toBeNull()
    })

    it('does NOT dispatch filtered_blocks_query when filters are empty', async () => {
      await executeAgendaFilters([], null)
      expect(filteredCalls()).toHaveLength(0)
    })

    it('deduplicates blocks present in both due_date and scheduled_date results', async () => {
      const block = makeBlock({
        id: 'both-1',
        due_date: '2025-01-15',
        scheduled_date: '2025-01-14',
      })

      mockedInvoke.mockResolvedValue({
        items: [block],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      const result = await executeAgendaFilters([], null)

      expect(result.blocks).toHaveLength(1)
      expect(result.blocks[0]?.id).toBe('both-1')
    })

    it('returns empty when no dated blocks exist', async () => {
      const result = await executeAgendaFilters([], null)
      expect(result.blocks).toHaveLength(0)
    })

    it('includes undated tasks in results', async () => {
      const dueBlock = makeBlock({ id: 'due-1', due_date: '2025-01-15' })
      const undatedBlock = makeBlock({
        id: 'undated-1',
        todo_state: 'TODO',
        due_date: null,
        scheduled_date: null,
        page_id: 'PAGE1',
      })

      mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
        const a = args as Record<string, unknown>
        if (cmd === 'list_undated_tasks') {
          return { items: [undatedBlock], next_cursor: null, has_more: false }
        }
        if (a['key'] === 'due_date') {
          return { items: [dueBlock], next_cursor: null, has_more: false }
        }
        if (a['key'] === 'scheduled_date') {
          return emptyPage
        }
        return emptyPage
      })

      const result = await executeAgendaFilters([], null)

      expect(result.blocks).toHaveLength(2)
      expect(result.blocks.map((b) => b.id)).toEqual(['due-1', 'undated-1'])
    })

    // #721 — the no-filter branch previously walked every source to
    // exhaustion (paying the full IPC cost) and returned hasMore:false,
    // after which the view sliced to 200 rows and silently dropped the
    // rest with no load-more. It must now fetch ONE window per source
    // and surface the remainder via hasMore + a composite cursor.
    it('#721: fetches one window per source and surfaces the remainder via hasMore + cursor', async () => {
      const undatedPage1 = makeBlock({ id: 'undated-page-1', todo_state: 'TODO' })

      let undatedCallCount = 0
      mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
        if (cmd !== 'list_undated_tasks') return emptyPage
        undatedCallCount++
        expect((args as Record<string, unknown>)['cursor']).toBeNull()
        return { items: [undatedPage1], next_cursor: 'CURSOR_PAGE_2', has_more: true }
      })

      const result = await executeAgendaFilters([], null)

      // Exactly ONE window — no exhaustion walk.
      expect(undatedCallCount).toBe(1)
      expect(result.blocks.map((b) => b.id)).toEqual(['undated-page-1'])
      // The >200-row remainder is NOT silently dropped: load-more is offered.
      expect(result.hasMore).toBe(true)
      expect(result.cursor).not.toBeNull()
    })

    it('#721: load-more resumes only non-exhausted sources from their own cursors', async () => {
      const duePage1 = makeBlock({ id: 'due-1', due_date: '2025-01-15' })
      const duePage2 = makeBlock({ id: 'due-2', due_date: '2025-02-15' })
      const schedPage1 = makeBlock({ id: 'sched-1', scheduled_date: '2025-01-16' })

      mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
        const a = args as Record<string, unknown>
        if (cmd === 'list_undated_tasks') return emptyPage
        if (a['key'] === 'due_date') {
          if (a['cursor'] === 'DUE_CURSOR_2') {
            return { items: [duePage2], next_cursor: null, has_more: false }
          }
          return { items: [duePage1], next_cursor: 'DUE_CURSOR_2', has_more: true }
        }
        if (a['key'] === 'scheduled_date') {
          return { items: [schedPage1], next_cursor: null, has_more: false }
        }
        return emptyPage
      })

      const page1 = await executeAgendaFilters([], null)
      expect(page1.blocks.map((b) => b.id)).toEqual(['due-1', 'sched-1'])
      expect(page1.hasMore).toBe(true)
      expect(page1.cursor).not.toBeNull()

      mockedInvoke.mockClear()
      const page2 = await loadMoreUnfilteredAgenda(page1.cursor as string, null)

      // Only the due_date source had more pages — the exhausted
      // scheduled_date / undated sources are not re-queried.
      const calls = mockedInvoke.mock.calls as Array<[string, Record<string, unknown>]>
      expect(calls).toHaveLength(1)
      expect(calls[0]?.[0]).toBe('query_by_property')
      expect(calls[0]?.[1]?.['key']).toBe('due_date')
      expect(calls[0]?.[1]?.['cursor']).toBe('DUE_CURSOR_2')

      expect(page2.blocks.map((b) => b.id)).toEqual(['due-2'])
      expect(page2.hasMore).toBe(false)
      expect(page2.cursor).toBeNull()
    })

    it('#721: loadMoreUnfilteredAgenda rejects a foreign (non-composite) cursor', async () => {
      const result = await loadMoreUnfilteredAgenda('SOME_BACKEND_KEYSET_CURSOR', null)
      expect(result.blocks).toHaveLength(0)
      expect(result.hasMore).toBe(false)
      expect(result.cursor).toBeNull()
      expect(mockedInvoke).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // active-filter branch — single filtered_blocks_query call
  // -------------------------------------------------------------------------

  describe('active filters dispatch a single filtered_blocks_query IPC', () => {
    it('does not call listUndatedTasks / queryByProperty / listBlocks when filters are active', async () => {
      const block = makeBlock({ id: 'b1', todo_state: 'TODO' })
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'filtered_blocks_query') {
          return { items: [block], next_cursor: null, has_more: false }
        }
        return emptyPage
      })

      await executeAgendaFilters([{ dimension: 'status', values: ['TODO'] }], null)

      const cmds = mockedInvoke.mock.calls.map(([cmd]) => cmd)
      expect(cmds.filter((c) => c === 'list_undated_tasks')).toHaveLength(0)
      expect(cmds.filter((c) => c === 'query_by_property')).toHaveLength(0)
      expect(cmds.filter((c) => c === 'list_blocks')).toHaveLength(0)
      // Exactly ONE filtered_blocks_query.
      expect(filteredCalls()).toHaveLength(1)
    })
  })

  describe('status filter translation', () => {
    it('translates a multi-value status filter into ONE PropertyFilter with valueTextIn', async () => {
      const todoBlock = makeBlock({ id: 'todo-1', todo_state: 'TODO' })
      const doingBlock = makeBlock({ id: 'doing-1', todo_state: 'DOING' })

      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'filtered_blocks_query') {
          return { items: [todoBlock, doingBlock], next_cursor: null, has_more: false }
        }
        return emptyPage
      })

      const result = await executeAgendaFilters(
        [{ dimension: 'status', values: ['TODO', 'DOING'] }],
        null,
      )

      expect(result.blocks).toHaveLength(2)
      expect(filteredCalls()).toHaveLength(1)
      expect(mockedInvoke).toHaveBeenCalledWith(
        'filtered_blocks_query',
        expect.objectContaining({
          propertyFilters: [
            expect.objectContaining({
              key: 'todo_state',
              operator: 'eq',
              valueTextIn: ['TODO', 'DOING'],
            }),
          ],
          tagFilters: null,
          blockType: null,
          scope: { kind: 'active', space_id: '' },
          cursor: null,
          limit: 200,
        }),
      )
    })

    it('skips IPC entirely when status values list is empty', async () => {
      const result = await executeAgendaFilters([{ dimension: 'status', values: [] }], null)
      expect(result.blocks).toHaveLength(0)
      expect(filteredCalls()).toHaveLength(0)
    })
  })

  describe('priority filter translation', () => {
    it('translates a multi-value priority filter into ONE PropertyFilter with valueTextIn', async () => {
      const p1Block = makeBlock({ id: 'p1-1', priority: '1' })
      const p2Block = makeBlock({ id: 'p2-1', priority: '2' })

      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'filtered_blocks_query') {
          return { items: [p1Block, p2Block], next_cursor: null, has_more: false }
        }
        return emptyPage
      })

      const result = await executeAgendaFilters(
        [{ dimension: 'priority', values: ['1', '2'] }],
        null,
      )

      expect(result.blocks).toHaveLength(2)
      expect(filteredCalls()).toHaveLength(1)
      expect(mockedInvoke).toHaveBeenCalledWith(
        'filtered_blocks_query',
        expect.objectContaining({
          propertyFilters: [
            expect.objectContaining({
              key: 'priority',
              operator: 'eq',
              valueTextIn: ['1', '2'],
            }),
          ],
        }),
      )
    })

    it('skips IPC entirely when priority values list is empty', async () => {
      const result = await executeAgendaFilters([{ dimension: 'priority', values: [] }], null)
      expect(result.blocks).toHaveLength(0)
      expect(filteredCalls()).toHaveLength(0)
    })
  })

  describe('dueDate filter translation', () => {
    it('Today → PropertyFilter with valueDate=today, operator=eq', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-03-15T12:00:00'))

      const block = makeBlock({ id: 'due-today', due_date: '2025-03-15' })
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'filtered_blocks_query') {
          return { items: [block], next_cursor: null, has_more: false }
        }
        return emptyPage
      })

      const result = await executeAgendaFilters([{ dimension: 'dueDate', values: ['Today'] }], null)

      expect(result.blocks).toHaveLength(1)
      expect(mockedInvoke).toHaveBeenCalledWith(
        'filtered_blocks_query',
        expect.objectContaining({
          propertyFilters: [
            expect.objectContaining({
              key: 'due_date',
              operator: 'eq',
              valueDate: '2025-03-15',
            }),
          ],
        }),
      )
    })

    it('This week → PropertyFilter with half-open valueDateRange', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-03-12T12:00:00')) // Wednesday

      await executeAgendaFilters([{ dimension: 'dueDate', values: ['This week'] }], null)

      // Mon..Sun = 2025-03-10..2025-03-16; half-open: [2025-03-10, 2025-03-17).
      const call = filteredCalls()[0] as Record<string, unknown>
      const propertyFilters = call['propertyFilters'] as Array<Record<string, unknown>>
      expect(propertyFilters).toHaveLength(1)
      expect(propertyFilters[0]).toMatchObject({
        key: 'due_date',
        valueDateRange: ['2025-03-10', '2025-03-17'],
      })
    })

    it('Overdue → two AND PropertyFilters: due_date<today + todo_state!=DONE', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-03-15T12:00:00'))

      const overdueBlock = makeBlock({
        id: 'overdue-1',
        due_date: '2025-03-10',
        todo_state: 'TODO',
      })
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'filtered_blocks_query') {
          return { items: [overdueBlock], next_cursor: null, has_more: false }
        }
        return emptyPage
      })

      const result = await executeAgendaFilters(
        [{ dimension: 'dueDate', values: ['Overdue'] }],
        null,
      )

      expect(result.blocks).toHaveLength(1)
      const call = filteredCalls()[0] as Record<string, unknown>
      const propertyFilters = call['propertyFilters'] as Array<Record<string, unknown>>
      expect(propertyFilters).toHaveLength(2)
      expect(propertyFilters[0]).toMatchObject({
        key: 'due_date',
        operator: 'lt',
        valueDate: '2025-03-15',
      })
      expect(propertyFilters[1]).toMatchObject({
        key: 'todo_state',
        operator: 'neq',
        valueText: 'DONE',
      })
    })

    it('skips unknown date values entirely (no filter dispatched)', async () => {
      const result = await executeAgendaFilters(
        [{ dimension: 'dueDate', values: ['Unknown period'] }],
        null,
      )
      expect(result.blocks).toHaveLength(0)
      expect(filteredCalls()).toHaveLength(0)
    })
  })

  // #720 — multi-select values within ONE date dimension previously
  // emitted one AND filter per value: Today+Overdue became
  // `due_date = today AND due_date < today` (provably empty) and
  // Today+This-week silently collapsed to Today. Values within a
  // dimension must OR (range union / residual predicate); dimensions
  // still AND against each other.
  describe('#720: multi-select date values OR within a dimension', () => {
    it('Today + Overdue → single lt-filter superset, NOT an empty AND', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-03-15T12:00:00'))

      const overdueTodo = makeBlock({
        id: 'overdue-todo',
        due_date: '2025-03-10',
        todo_state: 'TODO',
      })
      const overdueDone = makeBlock({
        id: 'overdue-done',
        due_date: '2025-03-10',
        todo_state: 'DONE',
      })
      const todayDone = makeBlock({ id: 'today-done', due_date: '2025-03-15', todo_state: 'DONE' })
      const todayTodo = makeBlock({ id: 'today-todo', due_date: '2025-03-15', todo_state: 'TODO' })

      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'filtered_blocks_query') {
          return {
            items: [overdueTodo, overdueDone, todayDone, todayTodo],
            next_cursor: null,
            has_more: false,
          }
        }
        return emptyPage
      })

      const result = await executeAgendaFilters(
        [{ dimension: 'dueDate', values: ['Today', 'Overdue'] }],
        null,
      )

      // SQL fetches the superset `due_date < 2025-03-16` — exactly one
      // date filter, and NO unconditional todo_state != DONE filter
      // (that would wrongly hide DONE tasks due today).
      const call = filteredCalls()[0] as Record<string, unknown>
      const propertyFilters = call['propertyFilters'] as Array<Record<string, unknown>>
      expect(propertyFilters).toHaveLength(1)
      expect(propertyFilters[0]).toMatchObject({
        key: 'due_date',
        operator: 'lt',
        valueDate: '2025-03-16',
      })

      // Residual union semantics client-side: overdue non-DONE and
      // everything due today survive; an overdue DONE block (outside
      // both the Today range and Overdue's non-DONE predicate) is dropped.
      expect(result.blocks.map((b) => b.id)).toEqual(['overdue-todo', 'today-done', 'today-todo'])
    })

    it('Today + This week → ONE union range, not a Today-only collapse', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-03-12T12:00:00')) // Wednesday

      await executeAgendaFilters([{ dimension: 'dueDate', values: ['Today', 'This week'] }], null)

      // Union of [03-12, 03-12] and [03-10, 03-16] = [03-10, 03-17) —
      // a single range filter, not two AND-ed filters.
      const call = filteredCalls()[0] as Record<string, unknown>
      const propertyFilters = call['propertyFilters'] as Array<Record<string, unknown>>
      expect(propertyFilters).toHaveLength(1)
      expect(propertyFilters[0]).toMatchObject({
        key: 'due_date',
        valueDateRange: ['2025-03-10', '2025-03-17'],
      })
    })

    it('Overdue + range presets on scheduled_date post-filters on scheduled_date', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-03-15T12:00:00'))

      const overdueDone = makeBlock({
        id: 'sched-overdue-done',
        scheduled_date: '2025-03-01',
        todo_state: 'DONE',
      })
      const inRangeDone = makeBlock({
        id: 'sched-week-done',
        scheduled_date: '2025-03-15',
        todo_state: 'DONE',
      })
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'filtered_blocks_query') {
          return { items: [overdueDone, inRangeDone], next_cursor: null, has_more: false }
        }
        return emptyPage
      })

      const result = await executeAgendaFilters(
        [{ dimension: 'scheduledDate', values: ['Overdue', 'This week'] }],
        null,
      )

      const call = filteredCalls()[0] as Record<string, unknown>
      const propertyFilters = call['propertyFilters'] as Array<Record<string, unknown>>
      expect(propertyFilters).toHaveLength(1)
      expect(propertyFilters[0]).toMatchObject({ key: 'scheduled_date', operator: 'lt' })
      expect(result.blocks.map((b) => b.id)).toEqual(['sched-week-done'])
    })

    it('residual excludes NULL-todo_state blocks before the range start (matches single-select Overdue)', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-03-15T12:00:00'))

      // Single-select Overdue compiles to `b.todo_state IS NOT NULL AND
      // b.todo_state != 'DONE'` on the backend — a NULL-state block with
      // a past due date is excluded. The Overdue+Today residual must
      // reproduce that exactly, while still admitting NULL-state blocks
      // that fall inside the range arm.
      const nullStateOverdue = makeBlock({
        id: 'null-state-overdue',
        due_date: '2025-03-10',
        todo_state: null,
      })
      const nullStateToday = makeBlock({
        id: 'null-state-today',
        due_date: '2025-03-15',
        todo_state: null,
      })

      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'filtered_blocks_query') {
          return {
            items: [nullStateOverdue, nullStateToday],
            next_cursor: null,
            has_more: false,
          }
        }
        return emptyPage
      })

      const result = await executeAgendaFilters(
        [{ dimension: 'dueDate', values: ['Today', 'Overdue'] }],
        null,
      )

      expect(result.blocks.map((b) => b.id)).toEqual(['null-state-today'])
    })

    it('advances past a backend page fully consumed by the residual instead of returning an empty page with hasMore', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-03-15T12:00:00'))

      // Page 1 of the SQL superset is ALL overdue-DONE rows (residual
      // rejects every one); the survivors live on page 2. Returning
      // `blocks: []` + `hasMore: true` would render the "no matching
      // tasks" empty state with no LoadMoreButton — a permanent stall.
      const overdueDone = makeBlock({
        id: 'overdue-done',
        due_date: '2025-03-01',
        todo_state: 'DONE',
      })
      const survivor = makeBlock({ id: 'survivor', due_date: '2025-03-15', todo_state: 'DONE' })

      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'filtered_blocks_query') {
          const cursor = (args as Record<string, unknown>)['cursor']
          if (cursor === 'PAGE_2') {
            return { items: [survivor], next_cursor: 'PAGE_3', has_more: true }
          }
          return { items: [overdueDone], next_cursor: 'PAGE_2', has_more: true }
        }
        return emptyPage
      })

      const result = await executeAgendaFilters(
        [{ dimension: 'dueDate', values: ['Today', 'Overdue'] }],
        null,
      )

      expect(filteredCalls()).toHaveLength(2)
      expect(result.blocks.map((b) => b.id)).toEqual(['survivor'])
      expect(result.hasMore).toBe(true)
      expect(result.cursor).toBe('PAGE_3')
    })

    it('completedDate Today + Last 7 days → ONE union valueDateRange', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-03-15T12:00:00'))

      await executeAgendaFilters(
        [{ dimension: 'completedDate', values: ['Today', 'Last 7 days'] }],
        null,
      )

      const call = filteredCalls()[0] as Record<string, unknown>
      const propertyFilters = call['propertyFilters'] as Array<Record<string, unknown>>
      expect(propertyFilters).toHaveLength(1)
      expect(propertyFilters[0]).toMatchObject({
        key: 'completed_at',
        valueDateRange: ['2025-03-09', '2025-03-16'],
      })
    })

    it('date dimensions still AND against other dimensions', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-03-12T12:00:00'))

      await executeAgendaFilters(
        [
          { dimension: 'status', values: ['TODO'] },
          { dimension: 'dueDate', values: ['Today', 'This week'] },
        ],
        null,
      )

      const call = filteredCalls()[0] as Record<string, unknown>
      const propertyFilters = call['propertyFilters'] as Array<Record<string, unknown>>
      expect(propertyFilters).toHaveLength(2)
      expect(propertyFilters[0]).toMatchObject({ key: 'todo_state', valueTextIn: ['TODO'] })
      expect(propertyFilters[1]).toMatchObject({ key: 'due_date' })
    })

    it('multi-value same-key property filters collapse to ONE valueTextIn (OR)', async () => {
      await executeAgendaFilters(
        [{ dimension: 'property', values: ['assignee:Alice', 'assignee:Bob'] }],
        null,
      )

      const call = filteredCalls()[0] as Record<string, unknown>
      const propertyFilters = call['propertyFilters'] as Array<Record<string, unknown>>
      expect(propertyFilters).toHaveLength(1)
      expect(propertyFilters[0]).toMatchObject({
        key: 'assignee',
        operator: 'eq',
        valueTextIn: ['Alice', 'Bob'],
      })
    })

    it('bare key subsumes valued entries for the same key (is-set OR eq = is-set)', async () => {
      await executeAgendaFilters(
        [{ dimension: 'property', values: ['assignee:Alice', 'assignee'] }],
        null,
      )

      const call = filteredCalls()[0] as Record<string, unknown>
      const propertyFilters = call['propertyFilters'] as Array<Record<string, unknown>>
      expect(propertyFilters).toHaveLength(1)
      expect(propertyFilters[0]).toMatchObject({ key: 'assignee' })
      expect(propertyFilters[0]?.['valueText']).toBeNull()
      expect(propertyFilters[0]?.['valueTextIn']).toEqual([])
    })

    it('bare key subsumes MANY valued entries regardless of order (#1746)', async () => {
      // #1746 guard: an is-set entry sharing a key with one or more valued
      // entries must collapse to a single bare-key filter. Emitting the
      // valued entries as additional same-key PropertyFilters would AND in
      // the EXISTS composition (queries.rs) and produce a strictly NARROWER
      // result than the intended OR-within-dimension (#720) — the inverse of
      // the desired union. Order of values must not change the outcome.
      await executeAgendaFilters(
        [{ dimension: 'property', values: ['assignee:Alice', 'assignee', 'assignee:Bob'] }],
        null,
      )

      const call = filteredCalls()[0] as Record<string, unknown>
      const propertyFilters = call['propertyFilters'] as Array<Record<string, unknown>>
      expect(propertyFilters).toHaveLength(1)
      expect(propertyFilters[0]).toMatchObject({ key: 'assignee' })
      expect(propertyFilters[0]?.['valueText']).toBeNull()
      expect(propertyFilters[0]?.['valueTextIn']).toEqual([])
    })
  })

  describe('scheduledDate filter translation', () => {
    it('Today → PropertyFilter with valueDate on scheduled_date column', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-03-15T12:00:00'))

      const block = makeBlock({ id: 'sched-today', scheduled_date: '2025-03-15' })
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'filtered_blocks_query') {
          return { items: [block], next_cursor: null, has_more: false }
        }
        return emptyPage
      })

      const result = await executeAgendaFilters(
        [{ dimension: 'scheduledDate', values: ['Today'] }],
        null,
      )

      expect(result.blocks).toHaveLength(1)
      expect(mockedInvoke).toHaveBeenCalledWith(
        'filtered_blocks_query',
        expect.objectContaining({
          propertyFilters: [
            expect.objectContaining({
              key: 'scheduled_date',
              operator: 'eq',
              valueDate: '2025-03-15',
            }),
          ],
        }),
      )
    })

    it('Overdue → two AND PropertyFilters on scheduled_date + todo_state', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-03-15T12:00:00'))

      await executeAgendaFilters([{ dimension: 'scheduledDate', values: ['Overdue'] }], null)

      const call = filteredCalls()[0] as Record<string, unknown>
      const propertyFilters = call['propertyFilters'] as Array<Record<string, unknown>>
      expect(propertyFilters).toHaveLength(2)
      expect(propertyFilters[0]).toMatchObject({
        key: 'scheduled_date',
        operator: 'lt',
        valueDate: '2025-03-15',
      })
      expect(propertyFilters[1]).toMatchObject({
        key: 'todo_state',
        operator: 'neq',
        valueText: 'DONE',
      })
    })
  })

  describe('completedDate filter translation', () => {
    it('Today → PropertyFilter on completed_at with half-open valueDateRange', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-03-15T12:00:00'))

      const block = makeBlock({ id: 'completed-1', todo_state: 'DONE' })
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'filtered_blocks_query') {
          return { items: [block], next_cursor: null, has_more: false }
        }
        return emptyPage
      })

      const result = await executeAgendaFilters(
        [{ dimension: 'completedDate', values: ['Today'] }],
        null,
      )

      expect(result.blocks).toHaveLength(1)
      const call = filteredCalls()[0] as Record<string, unknown>
      const propertyFilters = call['propertyFilters'] as Array<Record<string, unknown>>
      expect(propertyFilters).toHaveLength(1)
      expect(propertyFilters[0]).toMatchObject({
        key: 'completed_at',
        valueDateRange: ['2025-03-15', '2025-03-16'],
      })
    })

    it('Last 7 days → half-open [day1, day8) valueDateRange', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-03-15T12:00:00'))

      await executeAgendaFilters([{ dimension: 'completedDate', values: ['Last 7 days'] }], null)

      const call = filteredCalls()[0] as Record<string, unknown>
      const propertyFilters = call['propertyFilters'] as Array<Record<string, unknown>>
      expect(propertyFilters).toHaveLength(1)
      expect(propertyFilters[0]).toMatchObject({
        key: 'completed_at',
        valueDateRange: ['2025-03-09', '2025-03-16'],
      })
    })

    it('rolls endExclusive across month boundaries', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-01-31T12:00:00'))

      await executeAgendaFilters([{ dimension: 'completedDate', values: ['Today'] }], null)

      const call = filteredCalls()[0] as Record<string, unknown>
      const propertyFilters = call['propertyFilters'] as Array<Record<string, unknown>>
      expect(propertyFilters[0]).toMatchObject({
        valueDateRange: ['2025-01-31', '2025-02-01'],
      })
    })

    it('skips unknown date values', async () => {
      const result = await executeAgendaFilters(
        [{ dimension: 'completedDate', values: ['Next 7 days'] }],
        null,
      )
      expect(result.blocks).toHaveLength(0)
      expect(filteredCalls()).toHaveLength(0)
    })
  })

  describe('createdDate filter translation', () => {
    it('Today → PropertyFilter on created_at with half-open valueDateRange', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-03-15T12:00:00'))

      const block = makeBlock({ id: 'created-1' })
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'filtered_blocks_query') {
          return { items: [block], next_cursor: null, has_more: false }
        }
        return emptyPage
      })

      const result = await executeAgendaFilters(
        [{ dimension: 'createdDate', values: ['Today'] }],
        null,
      )

      expect(result.blocks).toHaveLength(1)
      const call = filteredCalls()[0] as Record<string, unknown>
      const propertyFilters = call['propertyFilters'] as Array<Record<string, unknown>>
      expect(propertyFilters[0]).toMatchObject({
        key: 'created_at',
        valueDateRange: ['2025-03-15', '2025-03-16'],
      })
    })
  })

  describe('tag filter translation', () => {
    it('resolves a tag name to tagIds via listTagsByPrefix and rides through tagFilters', async () => {
      const block = makeBlock({ id: 'tagged-1' })

      mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
        const a = args as Record<string, unknown>
        if (cmd === 'list_tags_by_prefix' && a['prefix'] === 'tag-abc') {
          return [{ tag_id: 'TAG_ID_ABC', name: 'tag-abc', usage_count: 1 }]
        }
        if (cmd === 'filtered_blocks_query') {
          return { items: [block], next_cursor: null, has_more: false }
        }
        return emptyPage
      })

      const result = await executeAgendaFilters([{ dimension: 'tag', values: ['tag-abc'] }], null)

      expect(result.blocks).toHaveLength(1)
      expect(mockedInvoke).toHaveBeenCalledWith(
        'list_tags_by_prefix',
        expect.objectContaining({ prefix: 'tag-abc' }),
      )
      expect(mockedInvoke).toHaveBeenCalledWith(
        'filtered_blocks_query',
        expect.objectContaining({
          tagFilters: expect.objectContaining({
            tagIds: ['TAG_ID_ABC'],
            mode: 'or',
          }),
        }),
      )
    })

    // H3 — pin the exactly-once tag-resolution path. Each prefix should
    // round-trip listTagsByPrefix exactly once, not per-call-site.
    it('resolves each tag name exactly once', async () => {
      mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
        const a = args as Record<string, unknown>
        if (cmd === 'list_tags_by_prefix') {
          if (a['prefix'] === 'tag-1') return [{ tag_id: 'TID_1', name: 'tag-1', usage_count: 1 }]
          if (a['prefix'] === 'tag-2') return [{ tag_id: 'TID_2', name: 'tag-2', usage_count: 1 }]
          return []
        }
        return emptyPage
      })

      await executeAgendaFilters([{ dimension: 'tag', values: ['tag-1', 'tag-2'] }], null)

      const prefixCalls = mockedInvoke.mock.calls.filter(
        ([cmd]) => cmd === 'list_tags_by_prefix',
      ) as Array<[string, Record<string, unknown>]>
      // Exactly 2 lookups, one per distinct prefix.
      expect(prefixCalls).toHaveLength(2)
      const prefixes = prefixCalls.map(([, a]) => a['prefix']).sort()
      expect(prefixes).toEqual(['tag-1', 'tag-2'])
    })

    it('combines multiple tag values into a single tagFilters payload with mode=or', async () => {
      mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
        const a = args as Record<string, unknown>
        if (cmd === 'list_tags_by_prefix') {
          if (a['prefix'] === 'tag-1') return [{ tag_id: 'TID_1', name: 'tag-1', usage_count: 1 }]
          if (a['prefix'] === 'tag-2') return [{ tag_id: 'TID_2', name: 'tag-2', usage_count: 1 }]
          return []
        }
        return emptyPage
      })

      await executeAgendaFilters([{ dimension: 'tag', values: ['tag-1', 'tag-2'] }], null)

      const call = filteredCalls()[0] as Record<string, unknown>
      expect(call['tagFilters']).toMatchObject({
        tagIds: ['TID_1', 'TID_2'],
        mode: 'or',
      })
    })

    it('returns empty (no filtered_blocks_query) when tag resolution yields nothing', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_tags_by_prefix') return []
        return emptyPage
      })

      const result = await executeAgendaFilters(
        [{ dimension: 'tag', values: ['nonexistent-tag'] }],
        null,
      )

      expect(result.blocks).toHaveLength(0)
      // No filtered_blocks_query — empty input would be rejected by the
      // backend with Validation; the FE short-circuits.
      expect(filteredCalls()).toHaveLength(0)
    })

    // #1594 — an unresolved tag dimension must collapse the cross-dimension
    // AND to empty, EVEN WHEN another dimension survives. Previously the tag
    // payload was silently dropped (returned `undefined`), so this query
    // dispatched a status-ONLY filtered_blocks_query and returned the
    // status superset (a strict widening of the intended status-AND-tag set).
    it('#1594: status + unresolved tag → empty result, NOT the status-only superset', async () => {
      const statusOnlyBlock = makeBlock({ id: 'status-superset', todo_state: 'TODO' })
      mockedInvoke.mockImplementation(async (cmd: string) => {
        // Tag never resolves.
        if (cmd === 'list_tags_by_prefix') return []
        // If the bug were present, the status-only IPC would return this.
        if (cmd === 'filtered_blocks_query') {
          return { items: [statusOnlyBlock], next_cursor: null, has_more: false }
        }
        return emptyPage
      })

      const result = await executeAgendaFilters(
        [
          { dimension: 'status', values: ['TODO'] },
          { dimension: 'tag', values: ['nonexistent-tag'] },
        ],
        null,
      )

      // The AND with an unsatisfiable tag dimension is empty — and the
      // backend is never asked (dispatching status-only would widen).
      expect(result.blocks).toHaveLength(0)
      expect(filteredCalls()).toHaveLength(0)
    })

    // #1594 sibling: a tag dimension that DOES resolve still intersects
    // correctly with a surviving status dimension (no regression).
    it('#1594: status + resolved tag → correct AND-intersection IPC', async () => {
      const block = makeBlock({ id: 'intersection-1', todo_state: 'TODO' })
      mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
        const a = args as Record<string, unknown>
        if (cmd === 'list_tags_by_prefix' && a['prefix'] === 'tag-ok') {
          return [{ tag_id: 'TID_OK', name: 'tag-ok', usage_count: 1 }]
        }
        if (cmd === 'filtered_blocks_query') {
          return { items: [block], next_cursor: null, has_more: false }
        }
        return emptyPage
      })

      const result = await executeAgendaFilters(
        [
          { dimension: 'status', values: ['TODO'] },
          { dimension: 'tag', values: ['tag-ok'] },
        ],
        null,
      )

      expect(result.blocks.map((b) => b.id)).toEqual(['intersection-1'])
      expect(filteredCalls()).toHaveLength(1)
      const call = filteredCalls()[0] as Record<string, unknown>
      const propertyFilters = call['propertyFilters'] as Array<Record<string, unknown>>
      expect(propertyFilters).toHaveLength(1)
      expect(propertyFilters[0]).toMatchObject({ key: 'todo_state', valueTextIn: ['TODO'] })
      expect(call['tagFilters']).toMatchObject({ tagIds: ['TID_OK'], mode: 'or' })
    })

    // #1594 boundary: a tag dimension with NO values contributes nothing
    // and must NOT collapse a surviving status dimension to empty (the
    // unsatisfiable path is gated on "had values but none resolved", not
    // "had no values"). list_tags_by_prefix must not even be called.
    it('#1594: tag dimension with no values leaves the status dimension unaffected', async () => {
      const block = makeBlock({ id: 'status-survives', todo_state: 'TODO' })
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'filtered_blocks_query') {
          return { items: [block], next_cursor: null, has_more: false }
        }
        return emptyPage
      })

      const result = await executeAgendaFilters(
        [
          { dimension: 'status', values: ['TODO'] },
          { dimension: 'tag', values: [] },
        ],
        null,
      )

      expect(result.blocks.map((b) => b.id)).toEqual(['status-survives'])
      expect(filteredCalls()).toHaveLength(1)
      const call = filteredCalls()[0] as Record<string, unknown>
      // No tag predicate is sent (null after marshalling), and the status
      // dimension rides through unchanged.
      expect(call['tagFilters']).toBeNull()
      // An empty tag dimension performs no prefix lookups.
      const prefixCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_tags_by_prefix')
      expect(prefixCalls).toHaveLength(0)
    })
  })

  describe('property filter translation', () => {
    it('key:value → PropertyFilter with valueText', async () => {
      const block = makeBlock({ id: 'prop-1' })

      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'filtered_blocks_query') {
          return { items: [block], next_cursor: null, has_more: false }
        }
        return emptyPage
      })

      const result = await executeAgendaFilters(
        [{ dimension: 'property', values: ['assignee:Alice'] }],
        null,
      )

      expect(result.blocks).toHaveLength(1)
      const call = filteredCalls()[0] as Record<string, unknown>
      const propertyFilters = call['propertyFilters'] as Array<Record<string, unknown>>
      expect(propertyFilters[0]).toMatchObject({
        key: 'assignee',
        operator: 'eq',
        valueText: 'Alice',
      })
    })

    it('bare key (no colon) → PropertyFilter without a value field (is-set semantics)', async () => {
      const block = makeBlock({ id: 'prop-2' })

      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'filtered_blocks_query') {
          return { items: [block], next_cursor: null, has_more: false }
        }
        return emptyPage
      })

      const result = await executeAgendaFilters(
        [{ dimension: 'property', values: ['custom_key'] }],
        null,
      )

      expect(result.blocks).toHaveLength(1)
      const call = filteredCalls()[0] as Record<string, unknown>
      const propertyFilters = call['propertyFilters'] as Array<Record<string, unknown>>
      expect(propertyFilters[0]).toMatchObject({ key: 'custom_key' })
      // valueText / valueTextIn / valueDate / valueDateRange must all be
      // unset (null / empty after marshalling in tauri.ts).
      expect(propertyFilters[0]?.['valueText']).toBeNull()
      expect(propertyFilters[0]?.['valueDate']).toBeNull()
      expect(propertyFilters[0]?.['valueDateRange']).toBeNull()
      expect(propertyFilters[0]?.['valueTextIn']).toEqual([])
    })
  })

  describe('filter combinations (AND-intersection is now SQL-side)', () => {
    it('two dimensions ride in ONE filtered_blocks_query with both PropertyFilters', async () => {
      const sharedBlock = makeBlock({ id: 'shared-1', todo_state: 'TODO', priority: '1' })

      // Backend returns the post-intersection result directly; no JS fan-out.
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'filtered_blocks_query') {
          return { items: [sharedBlock], next_cursor: null, has_more: false }
        }
        return emptyPage
      })

      const result = await executeAgendaFilters(
        [
          { dimension: 'status', values: ['TODO'] },
          { dimension: 'priority', values: ['1'] },
        ],
        null,
      )

      expect(result.blocks).toHaveLength(1)
      expect(result.blocks[0]?.id).toBe('shared-1')
      // Exactly ONE IPC carries both filters — the SQL composed-EXISTS
      // shape does the AND server-side.
      expect(filteredCalls()).toHaveLength(1)
      const call = filteredCalls()[0] as Record<string, unknown>
      const propertyFilters = call['propertyFilters'] as Array<Record<string, unknown>>
      expect(propertyFilters).toHaveLength(2)
      expect(propertyFilters[0]).toMatchObject({
        key: 'todo_state',
        valueTextIn: ['TODO'],
      })
      expect(propertyFilters[1]).toMatchObject({
        key: 'priority',
        valueTextIn: ['1'],
      })
    })

    it('tag + property dimensions combine into one IPC with both propertyFilters and tagFilters', async () => {
      const block = makeBlock({ id: 'shared-1' })
      mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
        const a = args as Record<string, unknown>
        if (cmd === 'list_tags_by_prefix' && a['prefix'] === 'tag-x') {
          return [{ tag_id: 'TID_X', name: 'tag-x', usage_count: 1 }]
        }
        if (cmd === 'filtered_blocks_query') {
          return { items: [block], next_cursor: null, has_more: false }
        }
        return emptyPage
      })

      await executeAgendaFilters(
        [
          { dimension: 'status', values: ['TODO'] },
          { dimension: 'tag', values: ['tag-x'] },
        ],
        null,
      )

      expect(filteredCalls()).toHaveLength(1)
      const call = filteredCalls()[0] as Record<string, unknown>
      const propertyFilters = call['propertyFilters'] as Array<Record<string, unknown>>
      expect(propertyFilters).toHaveLength(1)
      expect(propertyFilters[0]).toMatchObject({ key: 'todo_state', valueTextIn: ['TODO'] })
      expect(call['tagFilters']).toMatchObject({ tagIds: ['TID_X'], mode: 'or' })
    })
  })

  describe('blocks with no matching properties', () => {
    it('returns empty for status filter when no blocks match', async () => {
      const result = await executeAgendaFilters([{ dimension: 'status', values: ['TODO'] }], null)
      expect(result.blocks).toHaveLength(0)
    })

    it('returns empty for priority filter when no blocks match', async () => {
      const result = await executeAgendaFilters([{ dimension: 'priority', values: ['1'] }], null)
      expect(result.blocks).toHaveLength(0)
    })

    it('returns empty for tag filter when no blocks match', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_tags_by_prefix') return []
        return emptyPage
      })
      const result = await executeAgendaFilters(
        [{ dimension: 'tag', values: ['nonexistent-tag'] }],
        null,
      )
      expect(result.blocks).toHaveLength(0)
    })
  })

  describe('pagination envelope', () => {
    it('forwards hasMore=true and the cursor from the backend response', async () => {
      const block = makeBlock({ id: 'b1', todo_state: 'TODO' })
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'filtered_blocks_query') {
          return { items: [block], next_cursor: 'CURSOR_NEXT', has_more: true }
        }
        return emptyPage
      })

      const result = await executeAgendaFilters([{ dimension: 'status', values: ['TODO'] }], null)

      expect(result.hasMore).toBe(true)
      expect(result.cursor).toBe('CURSOR_NEXT')
      expect(result.blocks).toHaveLength(1)
    })

    it('forwards hasMore=false / cursor=null when the page is exhausted', async () => {
      const block = makeBlock({ id: 'b1', todo_state: 'TODO' })
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'filtered_blocks_query') {
          return { items: [block], next_cursor: null, has_more: false }
        }
        return emptyPage
      })

      const result = await executeAgendaFilters([{ dimension: 'status', values: ['TODO'] }], null)
      expect(result.hasMore).toBe(false)
      expect(result.cursor).toBeNull()
    })
  })

  describe('spaceId normalization at the boundary (FE-L-12)', () => {
    it('normalizes a null spaceId to "" before dispatching filtered_blocks_query', async () => {
      mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
        const a = args as Record<string, unknown>
        if (cmd === 'list_tags_by_prefix' && a['prefix'] === 'tag-x') {
          return [{ tag_id: 'TID_X', name: 'tag-x', usage_count: 1 }]
        }
        return emptyPage
      })

      await executeAgendaFilters(
        [
          { dimension: 'status', values: ['TODO'] },
          { dimension: 'tag', values: ['tag-x'] },
        ],
        null,
      )

      // The filtered_blocks_query call carries the empty-string fallback.
      const call = filteredCalls()[0] as Record<string, unknown>
      expect(call['scope']).toEqual({ kind: 'active', space_id: '' })
    })
  })
})

// ---------------------------------------------------------------------------
// loadMoreAgendaFilters — page 2 of the active-filter agenda
// ---------------------------------------------------------------------------
//
// Pins the cursor-namespace fix: page 2 must continue the AND-intersection
// minted by page 1. The previous implementation called `query_by_property`
// with a `filtered_blocks_query` cursor — a silent namespace mismatch that
// returned the right *shape* but the wrong *set* (no AND across filters).
// See: pending/agenda-loadmore-cursor-namespace-2026-05-13.md (Option A).

describe('loadMoreAgendaFilters', () => {
  it('routes through filtered_blocks_query with the saved cursor (NOT query_by_property)', async () => {
    const page2Block = makeBlock({ id: 'b2', todo_state: 'TODO', priority: '1' })
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'filtered_blocks_query') {
        return { items: [page2Block], next_cursor: null, has_more: false }
      }
      return emptyPage
    })

    const result = await loadMoreAgendaFilters(
      [
        { dimension: 'status', values: ['TODO'] },
        { dimension: 'priority', values: ['1'] },
      ],
      'CURSOR_PAGE_2',
      null,
    )

    // Page 2 rides on filtered_blocks_query — the same IPC that minted
    // the cursor — so the keyset is consistent.
    expect(filteredCalls()).toHaveLength(1)
    const cmds = mockedInvoke.mock.calls.map(([cmd]) => cmd)
    expect(cmds.filter((c) => c === 'query_by_property')).toHaveLength(0)

    // Cursor is forwarded verbatim; every active filter is translated
    // into the IPC payload so the backend continues the AND-intersection.
    const call = filteredCalls()[0] as Record<string, unknown>
    expect(call['cursor']).toBe('CURSOR_PAGE_2')
    const propertyFilters = call['propertyFilters'] as Array<Record<string, unknown>>
    expect(propertyFilters).toHaveLength(2)
    expect(propertyFilters[0]).toMatchObject({ key: 'todo_state', valueTextIn: ['TODO'] })
    expect(propertyFilters[1]).toMatchObject({ key: 'priority', valueTextIn: ['1'] })

    // Page 2 result is forwarded as-is.
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0]?.id).toBe('b2')
    expect(result.hasMore).toBe(false)
    expect(result.cursor).toBeNull()
  })

  // #1594 — load-more mirrors executeAgendaFilters: an all-unresolved tag
  // dimension paired with a surviving status dimension collapses to empty
  // (and never dispatches a status-only IPC that would widen the page).
  it('#1594: status + unresolved tag short-circuits to empty (no widening IPC)', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_tags_by_prefix') return []
      if (cmd === 'filtered_blocks_query') {
        return {
          items: [makeBlock({ id: 'leak', todo_state: 'TODO' })],
          next_cursor: null,
          has_more: false,
        }
      }
      return emptyPage
    })

    const result = await loadMoreAgendaFilters(
      [
        { dimension: 'status', values: ['TODO'] },
        { dimension: 'tag', values: ['nonexistent-tag'] },
      ],
      'CURSOR_PAGE_2',
      null,
    )

    expect(result.blocks).toHaveLength(0)
    expect(result.hasMore).toBe(false)
    expect(result.cursor).toBeNull()
    expect(filteredCalls()).toHaveLength(0)
  })

  it("page 2's blocks satisfy every active filter (AND-intersection preserved)", async () => {
    // Returns three blocks; every one matches BOTH filters (todo_state in
    // ['TODO','DOING'] AND priority='1'). This is what the backend
    // composed-EXISTS shape guarantees — the assertion pins that
    // load-more does not silently drop AND-membership.
    const blocks = [
      makeBlock({ id: 'b10', todo_state: 'TODO', priority: '1' }),
      makeBlock({ id: 'b11', todo_state: 'DOING', priority: '1' }),
      makeBlock({ id: 'b12', todo_state: 'TODO', priority: '1' }),
    ]
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'filtered_blocks_query') {
        return { items: blocks, next_cursor: null, has_more: false }
      }
      return emptyPage
    })

    const filters: Parameters<typeof loadMoreAgendaFilters>[0] = [
      { dimension: 'status', values: ['TODO', 'DOING'] },
      { dimension: 'priority', values: ['1'] },
    ]
    const result = await loadMoreAgendaFilters(filters, 'CURSOR_PAGE_2', null)

    // Every returned block satisfies every active filter — the
    // AND-intersection that page 1 established carries through.
    for (const b of result.blocks) {
      expect(['TODO', 'DOING']).toContain(b.todo_state)
      expect(b.priority).toBe('1')
    }
  })

  it('resolves tag filters before dispatching (mirror executeAgendaFilters)', async () => {
    const block = makeBlock({ id: 'tagged-p2' })
    mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
      const a = args as Record<string, unknown>
      if (cmd === 'list_tags_by_prefix' && a['prefix'] === 'tag-x') {
        return [{ tag_id: 'TID_X', name: 'tag-x', usage_count: 1 }]
      }
      if (cmd === 'filtered_blocks_query') {
        return { items: [block], next_cursor: null, has_more: false }
      }
      return emptyPage
    })

    await loadMoreAgendaFilters(
      [
        { dimension: 'status', values: ['TODO'] },
        { dimension: 'tag', values: ['tag-x'] },
      ],
      'CURSOR_PAGE_2',
      null,
    )

    expect(filteredCalls()).toHaveLength(1)
    const call = filteredCalls()[0] as Record<string, unknown>
    expect(call['cursor']).toBe('CURSOR_PAGE_2')
    expect(call['tagFilters']).toMatchObject({ tagIds: ['TID_X'], mode: 'or' })
  })

  it('short-circuits with empty result when no dimension resolves to a payload', async () => {
    // status with empty values + tag that resolves to nothing → no
    // property filters, no tag filters. Must not dispatch
    // filtered_blocks_query (the backend would reject empty input).
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_tags_by_prefix') return []
      return emptyPage
    })

    const result = await loadMoreAgendaFilters(
      [
        { dimension: 'status', values: [] },
        { dimension: 'tag', values: ['nonexistent-tag'] },
      ],
      'CURSOR_PAGE_2',
      null,
    )

    expect(result.blocks).toHaveLength(0)
    expect(result.hasMore).toBe(false)
    expect(result.cursor).toBeNull()
    expect(filteredCalls()).toHaveLength(0)
  })

  // #720 — page 2 must reuse page 1's `today`, not recompute `new Date()`:
  // a load-more after midnight otherwise paginates a DIFFERENT predicate
  // than page 1 (e.g. "Today" shifts a day mid-pagination).
  it('#720: reuses the caller-provided today for date translation (page 2 after midnight)', async () => {
    vi.useFakeTimers()
    // The clock has rolled past midnight since page 1...
    vi.setSystemTime(new Date('2025-03-16T00:30:00'))

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'filtered_blocks_query') {
        return { items: [], next_cursor: null, has_more: false }
      }
      return emptyPage
    })

    // ...but the caller threads page 1's today through.
    await loadMoreAgendaFilters(
      [{ dimension: 'dueDate', values: ['Today'] }],
      'CURSOR_PAGE_2',
      null,
      new Date('2025-03-15T12:00:00'),
    )

    const call = filteredCalls()[0] as Record<string, unknown>
    const propertyFilters = call['propertyFilters'] as Array<Record<string, unknown>>
    expect(propertyFilters[0]).toMatchObject({
      key: 'due_date',
      operator: 'eq',
      valueDate: '2025-03-15', // page 1's today, NOT 2025-03-16
    })
  })

  it('#720: executeAgendaFilters returns the today it used so callers can thread it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-03-15T12:00:00'))

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'filtered_blocks_query') {
        return { items: [], next_cursor: null, has_more: true }
      }
      return emptyPage
    })

    const result = await executeAgendaFilters([{ dimension: 'dueDate', values: ['Today'] }], null)
    expect(result.today).toEqual(new Date('2025-03-15T12:00:00'))
  })

  it('#720: applies the Overdue-union residual predicate to load-more pages too', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-03-15T12:00:00'))

    const overdueDone = makeBlock({
      id: 'p2-overdue-done',
      due_date: '2025-03-01',
      todo_state: 'DONE',
    })
    const overdueTodo = makeBlock({
      id: 'p2-overdue-todo',
      due_date: '2025-03-02',
      todo_state: 'TODO',
    })
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'filtered_blocks_query') {
        return { items: [overdueDone, overdueTodo], next_cursor: null, has_more: false }
      }
      return emptyPage
    })

    const result = await loadMoreAgendaFilters(
      [{ dimension: 'dueDate', values: ['Today', 'Overdue'] }],
      'CURSOR_PAGE_2',
      null,
      new Date('2025-03-15T12:00:00'),
    )

    expect(result.blocks.map((b) => b.id)).toEqual(['p2-overdue-todo'])
  })

  it('normalizes a null spaceId to "" (FE-L-12 boundary)', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'filtered_blocks_query') {
        return { items: [], next_cursor: null, has_more: false, total_count: null }
      }
      return emptyPage
    })

    await loadMoreAgendaFilters([{ dimension: 'status', values: ['TODO'] }], 'CURSOR_PAGE_2', null)

    const call = filteredCalls()[0] as Record<string, unknown>
    expect(call['scope']).toEqual({ kind: 'active', space_id: '' })
  })

  it('forwards a non-null spaceId verbatim', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'filtered_blocks_query') {
        return { items: [], next_cursor: null, has_more: false, total_count: null }
      }
      return emptyPage
    })

    await loadMoreAgendaFilters(
      [{ dimension: 'status', values: ['TODO'] }],
      'CURSOR_PAGE_2',
      'space-abc',
    )

    const call = filteredCalls()[0] as Record<string, unknown>
    expect(call['scope']).toEqual({ kind: 'active', space_id: 'space-abc' })
  })
})
