/**
 * Tests for src/lib/agenda-filters.ts — pure filter execution engine.
 *
 * Verifies each filter dimension, intersection logic, empty filters,
 * and edge cases (blocks with no matching properties).
 */

import { invoke } from '@tauri-apps/api/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executeAgendaFilters, toFutureDatePreset, toPastDatePreset } from '../agenda-filters'
import type { BlockRow } from '../tauri'

const mockedInvoke = vi.mocked(invoke)

const emptyPage = { items: [], next_cursor: null, has_more: false }

function makeBlock(overrides: Partial<BlockRow> = {}): BlockRow {
  return {
    id: 'block-1',
    block_type: 'block',
    content: 'Test block',
    parent_id: null,
    position: null,
    deleted_at: null,
    is_conflict: false,
    conflict_type: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    ...overrides,
  }
}

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
// executeAgendaFilters
// ---------------------------------------------------------------------------

describe('executeAgendaFilters', () => {
  describe('empty filter list', () => {
    it('returns merged due_date and scheduled_date blocks', async () => {
      const dueBlock = makeBlock({ id: 'due-1', due_date: '2025-01-15' })
      const schedBlock = makeBlock({ id: 'sched-1', scheduled_date: '2025-01-16' })

      mockedInvoke.mockImplementation(async (_cmd: string, args: unknown) => {
        const a = args as Record<string, unknown>
        if (a.key === 'due_date') {
          return { items: [dueBlock], next_cursor: null, has_more: false }
        }
        if (a.key === 'scheduled_date') {
          return { items: [schedBlock], next_cursor: null, has_more: false }
        }
        return emptyPage
      })

      const result = await executeAgendaFilters([])

      expect(result.blocks).toHaveLength(2)
      expect(result.blocks.map((b) => b.id)).toEqual(['due-1', 'sched-1'])
      expect(result.hasMore).toBe(false)
      expect(result.cursor).toBeNull()
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

      const result = await executeAgendaFilters([])

      expect(result.blocks).toHaveLength(1)
      expect(result.blocks[0]?.id).toBe('both-1')
    })

    it('returns empty when no dated blocks exist', async () => {
      const result = await executeAgendaFilters([])
      expect(result.blocks).toHaveLength(0)
    })
  })

  describe('status filter', () => {
    it('queries by todo_state for each value', async () => {
      const todoBlock = makeBlock({ id: 'todo-1', todo_state: 'TODO' })
      const doingBlock = makeBlock({ id: 'doing-1', todo_state: 'DOING' })

      mockedInvoke.mockImplementation(async (_cmd: string, args: unknown) => {
        const a = args as Record<string, unknown>
        if (a.key === 'todo_state' && a.valueText === 'TODO') {
          return { items: [todoBlock], next_cursor: null, has_more: false }
        }
        if (a.key === 'todo_state' && a.valueText === 'DOING') {
          return { items: [doingBlock], next_cursor: null, has_more: false }
        }
        return emptyPage
      })

      const result = await executeAgendaFilters([
        { dimension: 'status', values: ['TODO', 'DOING'] },
      ])

      expect(result.blocks).toHaveLength(2)
      expect(result.blocks.map((b) => b.id).sort()).toEqual(['doing-1', 'todo-1'])
    })

    it('calls invoke with correct arguments', async () => {
      await executeAgendaFilters([{ dimension: 'status', values: ['TODO'] }])

      expect(mockedInvoke).toHaveBeenCalledWith('query_by_property', {
        key: 'todo_state',
        valueText: 'TODO',
        valueDate: null,
        cursor: null,
        limit: 500,
      })
    })
  })

  describe('priority filter', () => {
    it('queries by priority for each value', async () => {
      const p1Block = makeBlock({ id: 'p1-1', priority: '1' })
      const p2Block = makeBlock({ id: 'p2-1', priority: '2' })

      mockedInvoke.mockImplementation(async (_cmd: string, args: unknown) => {
        const a = args as Record<string, unknown>
        if (a.key === 'priority' && a.valueText === '1') {
          return { items: [p1Block], next_cursor: null, has_more: false }
        }
        if (a.key === 'priority' && a.valueText === '2') {
          return { items: [p2Block], next_cursor: null, has_more: false }
        }
        return emptyPage
      })

      const result = await executeAgendaFilters([{ dimension: 'priority', values: ['1', '2'] }])

      expect(result.blocks).toHaveLength(2)
      expect(result.blocks.map((b) => b.id).sort()).toEqual(['p1-1', 'p2-1'])
    })

    it('calls invoke with correct arguments', async () => {
      await executeAgendaFilters([{ dimension: 'priority', values: ['1'] }])

      expect(mockedInvoke).toHaveBeenCalledWith('query_by_property', {
        key: 'priority',
        valueText: '1',
        valueDate: null,
        cursor: null,
        limit: 500,
      })
    })
  })

  describe('dueDate filter', () => {
    it('handles Today by querying with agendaDate', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-03-15T12:00:00'))

      const block = makeBlock({ id: 'due-today', due_date: '2025-03-15' })
      mockedInvoke.mockResolvedValue({
        items: [block],
        next_cursor: null,
        has_more: false,
      })

      const result = await executeAgendaFilters([{ dimension: 'dueDate', values: ['Today'] }])

      expect(result.blocks).toHaveLength(1)
      expect(result.blocks[0]?.id).toBe('due-today')

      // Should have called list_blocks with agendaDate
      expect(mockedInvoke).toHaveBeenCalledWith(
        'list_blocks',
        expect.objectContaining({
          agendaDate: '2025-03-15',
          agendaSource: 'column:due_date',
        }),
      )
    })

    it('handles This week by querying with agendaDateRange', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-03-12T12:00:00')) // Wednesday

      mockedInvoke.mockResolvedValue(emptyPage)

      await executeAgendaFilters([{ dimension: 'dueDate', values: ['This week'] }])

      // Should have called list_blocks with agendaDateRange
      expect(mockedInvoke).toHaveBeenCalledWith(
        'list_blocks',
        expect.objectContaining({
          agendaDateRange: { start: '2025-03-10', end: '2025-03-16' },
          agendaSource: 'column:due_date',
        }),
      )
    })

    it('handles Overdue by client-filtering blocks before today', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-03-15T12:00:00'))

      const overdueBlock = makeBlock({
        id: 'overdue-1',
        due_date: '2025-03-10',
        todo_state: 'TODO',
      })
      const doneBlock = makeBlock({
        id: 'done-1',
        due_date: '2025-03-10',
        todo_state: 'DONE',
      })
      const futureBlock = makeBlock({
        id: 'future-1',
        due_date: '2025-03-20',
        todo_state: 'TODO',
      })

      mockedInvoke.mockResolvedValue({
        items: [overdueBlock, doneBlock, futureBlock],
        next_cursor: null,
        has_more: false,
      })

      const result = await executeAgendaFilters([{ dimension: 'dueDate', values: ['Overdue'] }])

      // Only overdue non-DONE blocks
      expect(result.blocks).toHaveLength(1)
      expect(result.blocks[0]?.id).toBe('overdue-1')
    })

    it('excludes DONE blocks from Overdue results', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-03-15T12:00:00'))

      const doneBlock = makeBlock({
        id: 'done-1',
        due_date: '2025-03-10',
        todo_state: 'DONE',
      })

      mockedInvoke.mockResolvedValue({
        items: [doneBlock],
        next_cursor: null,
        has_more: false,
      })

      const result = await executeAgendaFilters([{ dimension: 'dueDate', values: ['Overdue'] }])

      expect(result.blocks).toHaveLength(0)
    })

    it('skips unknown date values', async () => {
      const result = await executeAgendaFilters([
        { dimension: 'dueDate', values: ['Unknown period'] },
      ])

      expect(result.blocks).toHaveLength(0)
    })
  })

  describe('scheduledDate filter', () => {
    it('handles Today by querying with agendaDate for scheduled_date', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-03-15T12:00:00'))

      const block = makeBlock({ id: 'sched-today', scheduled_date: '2025-03-15' })
      mockedInvoke.mockResolvedValue({
        items: [block],
        next_cursor: null,
        has_more: false,
      })

      const result = await executeAgendaFilters([{ dimension: 'scheduledDate', values: ['Today'] }])

      expect(result.blocks).toHaveLength(1)
      expect(mockedInvoke).toHaveBeenCalledWith(
        'list_blocks',
        expect.objectContaining({
          agendaDate: '2025-03-15',
          agendaSource: 'column:scheduled_date',
        }),
      )
    })

    it('handles Overdue by client-filtering blocks with scheduled_date before today', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-03-15T12:00:00'))

      const overdueBlock = makeBlock({
        id: 'overdue-sched',
        scheduled_date: '2025-03-10',
        todo_state: 'TODO',
      })
      const doneBlock = makeBlock({
        id: 'done-sched',
        scheduled_date: '2025-03-10',
        todo_state: 'DONE',
      })

      mockedInvoke.mockResolvedValue({
        items: [overdueBlock, doneBlock],
        next_cursor: null,
        has_more: false,
      })

      const result = await executeAgendaFilters([
        { dimension: 'scheduledDate', values: ['Overdue'] },
      ])

      expect(result.blocks).toHaveLength(1)
      expect(result.blocks[0]?.id).toBe('overdue-sched')
    })
  })

  describe('completedDate filter', () => {
    it('queries completed_at property for each day in range', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-03-15T12:00:00'))

      const block = makeBlock({ id: 'completed-1', todo_state: 'DONE' })

      mockedInvoke.mockImplementation(async (_cmd: string, args: unknown) => {
        const a = args as Record<string, unknown>
        if (a.key === 'completed_at' && a.valueDate === '2025-03-15') {
          return { items: [block], next_cursor: null, has_more: false }
        }
        return emptyPage
      })

      const result = await executeAgendaFilters([{ dimension: 'completedDate', values: ['Today'] }])

      expect(result.blocks).toHaveLength(1)
      expect(result.blocks[0]?.id).toBe('completed-1')
      expect(mockedInvoke).toHaveBeenCalledWith('query_by_property', {
        key: 'completed_at',
        valueText: null,
        valueDate: '2025-03-15',
        cursor: null,
        limit: 500,
      })
    })

    it('skips unknown date values', async () => {
      const result = await executeAgendaFilters([
        { dimension: 'completedDate', values: ['Next 7 days'] },
      ])

      expect(result.blocks).toHaveLength(0)
    })
  })

  describe('createdDate filter', () => {
    it('queries created_at property for each day in range', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-03-15T12:00:00'))

      const block = makeBlock({ id: 'created-1' })

      mockedInvoke.mockImplementation(async (_cmd: string, args: unknown) => {
        const a = args as Record<string, unknown>
        if (a.key === 'created_at' && a.valueDate === '2025-03-15') {
          return { items: [block], next_cursor: null, has_more: false }
        }
        return emptyPage
      })

      const result = await executeAgendaFilters([{ dimension: 'createdDate', values: ['Today'] }])

      expect(result.blocks).toHaveLength(1)
      expect(result.blocks[0]?.id).toBe('created-1')
      expect(mockedInvoke).toHaveBeenCalledWith('query_by_property', {
        key: 'created_at',
        valueText: null,
        valueDate: '2025-03-15',
        cursor: null,
        limit: 500,
      })
    })
  })

  describe('tag filter', () => {
    it('resolves tag name to ID then queries blocks by tagId', async () => {
      const block = makeBlock({ id: 'tagged-1' })

      mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
        const a = args as Record<string, unknown>
        if (cmd === 'list_tags_by_prefix') {
          if (a.prefix === 'tag-abc') {
            return [{ tag_id: 'TAG_ID_ABC', name: 'tag-abc', usage_count: 1 }]
          }
          return []
        }
        if (cmd === 'list_blocks' && a.tagId === 'TAG_ID_ABC') {
          return { items: [block], next_cursor: null, has_more: false }
        }
        return emptyPage
      })

      const result = await executeAgendaFilters([{ dimension: 'tag', values: ['tag-abc'] }])

      expect(result.blocks).toHaveLength(1)
      expect(result.blocks[0]?.id).toBe('tagged-1')
      expect(mockedInvoke).toHaveBeenCalledWith(
        'list_tags_by_prefix',
        expect.objectContaining({ prefix: 'tag-abc' }),
      )
      expect(mockedInvoke).toHaveBeenCalledWith(
        'list_blocks',
        expect.objectContaining({ tagId: 'TAG_ID_ABC' }),
      )
    })

    it('merges results from multiple tag values', async () => {
      const block1 = makeBlock({ id: 'tagged-1' })
      const block2 = makeBlock({ id: 'tagged-2' })

      mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
        const a = args as Record<string, unknown>
        if (cmd === 'list_tags_by_prefix') {
          if (a.prefix === 'tag-1') return [{ tag_id: 'TID_1', name: 'tag-1', usage_count: 1 }]
          if (a.prefix === 'tag-2') return [{ tag_id: 'TID_2', name: 'tag-2', usage_count: 1 }]
          return []
        }
        if (cmd === 'list_blocks' && a.tagId === 'TID_1') {
          return { items: [block1], next_cursor: null, has_more: false }
        }
        if (cmd === 'list_blocks' && a.tagId === 'TID_2') {
          return { items: [block2], next_cursor: null, has_more: false }
        }
        return emptyPage
      })

      const result = await executeAgendaFilters([{ dimension: 'tag', values: ['tag-1', 'tag-2'] }])

      expect(result.blocks).toHaveLength(2)
    })
  })

  describe('property filter', () => {
    it('queries by key:value pairs', async () => {
      const block = makeBlock({ id: 'prop-1' })

      mockedInvoke.mockImplementation(async (_cmd: string, args: unknown) => {
        const a = args as Record<string, unknown>
        if (a.key === 'assignee' && a.valueText === 'Alice') {
          return { items: [block], next_cursor: null, has_more: false }
        }
        return emptyPage
      })

      const result = await executeAgendaFilters([
        { dimension: 'property', values: ['assignee:Alice'] },
      ])

      expect(result.blocks).toHaveLength(1)
      expect(result.blocks[0]?.id).toBe('prop-1')
    })

    it('queries by key only when no colon is present', async () => {
      const block = makeBlock({ id: 'prop-2' })

      mockedInvoke.mockImplementation(async (_cmd: string, args: unknown) => {
        const a = args as Record<string, unknown>
        if (a.key === 'custom_key' && a.valueText === null) {
          return { items: [block], next_cursor: null, has_more: false }
        }
        return emptyPage
      })

      const result = await executeAgendaFilters([{ dimension: 'property', values: ['custom_key'] }])

      expect(result.blocks).toHaveLength(1)
    })
  })

  describe('filter combinations (intersection)', () => {
    it('intersects results from two filter dimensions', async () => {
      const sharedBlock = makeBlock({ id: 'shared-1', todo_state: 'TODO', priority: '1' })
      const todoOnlyBlock = makeBlock({ id: 'todo-only', todo_state: 'TODO' })
      const prioOnlyBlock = makeBlock({ id: 'prio-only', priority: '1' })

      mockedInvoke.mockImplementation(async (_cmd: string, args: unknown) => {
        const a = args as Record<string, unknown>
        if (a.key === 'todo_state' && a.valueText === 'TODO') {
          return {
            items: [sharedBlock, todoOnlyBlock],
            next_cursor: null,
            has_more: false,
          }
        }
        if (a.key === 'priority' && a.valueText === '1') {
          return {
            items: [sharedBlock, prioOnlyBlock],
            next_cursor: null,
            has_more: false,
          }
        }
        return emptyPage
      })

      const result = await executeAgendaFilters([
        { dimension: 'status', values: ['TODO'] },
        { dimension: 'priority', values: ['1'] },
      ])

      // Only the block present in BOTH result sets
      expect(result.blocks).toHaveLength(1)
      expect(result.blocks[0]?.id).toBe('shared-1')
    })

    it('returns empty when intersection is empty', async () => {
      const todoBlock = makeBlock({ id: 'todo-1', todo_state: 'TODO' })
      const prioBlock = makeBlock({ id: 'prio-1', priority: '1' })

      mockedInvoke.mockImplementation(async (_cmd: string, args: unknown) => {
        const a = args as Record<string, unknown>
        if (a.key === 'todo_state') {
          return { items: [todoBlock], next_cursor: null, has_more: false }
        }
        if (a.key === 'priority') {
          return { items: [prioBlock], next_cursor: null, has_more: false }
        }
        return emptyPage
      })

      const result = await executeAgendaFilters([
        { dimension: 'status', values: ['TODO'] },
        { dimension: 'priority', values: ['1'] },
      ])

      expect(result.blocks).toHaveLength(0)
    })
  })

  describe('blocks with no matching properties', () => {
    it('returns empty for status filter when no blocks match', async () => {
      const result = await executeAgendaFilters([{ dimension: 'status', values: ['TODO'] }])
      expect(result.blocks).toHaveLength(0)
    })

    it('returns empty for priority filter when no blocks match', async () => {
      const result = await executeAgendaFilters([{ dimension: 'priority', values: ['1'] }])
      expect(result.blocks).toHaveLength(0)
    })

    it('returns empty for tag filter when no blocks match', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_tags_by_prefix') return []
        return emptyPage
      })
      const result = await executeAgendaFilters([{ dimension: 'tag', values: ['nonexistent-tag'] }])
      expect(result.blocks).toHaveLength(0)
    })
  })

  it('always returns hasMore=false and cursor=null', async () => {
    const block = makeBlock({ id: 'b1', todo_state: 'TODO' })
    mockedInvoke.mockResolvedValue({
      items: [block],
      next_cursor: null,
      has_more: false,
    })

    const result = await executeAgendaFilters([{ dimension: 'status', values: ['TODO'] }])

    expect(result.hasMore).toBe(false)
    expect(result.cursor).toBeNull()
  })
})
