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
  toFutureDatePreset,
  toPastDatePreset,
} from '../agenda-filters'

const mockedInvoke = vi.mocked(invoke)

const emptyPage = { items: [], next_cursor: null, has_more: false }

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

    it('paginates undated_tasks across multiple pages and merges all items', async () => {
      const page1Block = makeBlock({ id: 'undated-page-1', todo_state: 'TODO' })
      const page2Block = makeBlock({ id: 'undated-page-2', todo_state: 'TODO' })

      let undatedCallCount = 0
      mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
        if (cmd !== 'list_undated_tasks') return emptyPage
        undatedCallCount++
        if (undatedCallCount === 1) {
          expect((args as Record<string, unknown>)['cursor']).toBeNull()
          return { items: [page1Block], next_cursor: 'CURSOR_PAGE_2', has_more: true }
        }
        expect((args as Record<string, unknown>)['cursor']).toBe('CURSOR_PAGE_2')
        return { items: [page2Block], next_cursor: null, has_more: false }
      })

      const result = await executeAgendaFilters([], null)

      expect(undatedCallCount).toBe(2)
      expect(result.blocks.map((b) => b.id).sort()).toEqual(['undated-page-1', 'undated-page-2'])
      expect(result.hasMore).toBe(false)
      expect(result.cursor).toBeNull()
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
