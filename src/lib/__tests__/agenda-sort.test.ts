import { describe, expect, it } from 'vitest'
import type { BlockRow } from '../tauri'
import { sortAgendaBlocks, groupByDate, groupByPriority, groupByState, sortByPriority, sortByState, sortAgendaBlocksBy } from '../agenda-sort'

function makeBlock(overrides: Partial<BlockRow> = {}): BlockRow {
  return {
    id: 'B1',
    block_type: 'block',
    content: 'test',
    parent_id: null,
    position: 0,
    deleted_at: null,
    archived_at: null,
    is_conflict: false,
    conflict_type: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    ...overrides,
  }
}

describe('sortAgendaBlocks', () => {
  it('sorts by date ascending', () => {
    const blocks = [
      makeBlock({ id: 'B2', due_date: '2025-06-20' }),
      makeBlock({ id: 'B1', due_date: '2025-06-15' }),
    ]
    const sorted = sortAgendaBlocks(blocks)
    expect(sorted[0].id).toBe('B1')
    expect(sorted[1].id).toBe('B2')
  })

  it('uses scheduled_date as fallback when no due_date', () => {
    const blocks = [
      makeBlock({ id: 'B2', scheduled_date: '2025-06-20' }),
      makeBlock({ id: 'B1', due_date: '2025-06-15' }),
    ]
    const sorted = sortAgendaBlocks(blocks)
    expect(sorted[0].id).toBe('B1')
    expect(sorted[1].id).toBe('B2')
  })

  it('sorts blocks with no date to bottom', () => {
    const blocks = [
      makeBlock({ id: 'B1' }),
      makeBlock({ id: 'B2', due_date: '2025-06-15' }),
    ]
    const sorted = sortAgendaBlocks(blocks)
    expect(sorted[0].id).toBe('B2')
    expect(sorted[1].id).toBe('B1')
  })

  it('within same date, sorts DOING > TODO > DONE > null', () => {
    const blocks = [
      makeBlock({ id: 'done', due_date: '2025-06-15', todo_state: 'DONE' }),
      makeBlock({ id: 'todo', due_date: '2025-06-15', todo_state: 'TODO' }),
      makeBlock({ id: 'doing', due_date: '2025-06-15', todo_state: 'DOING' }),
      makeBlock({ id: 'none', due_date: '2025-06-15', todo_state: null }),
    ]
    const sorted = sortAgendaBlocks(blocks)
    expect(sorted.map((b) => b.id)).toEqual(['doing', 'todo', 'done', 'none'])
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
    expect(sorted[0].id).toBe('B2')
    expect(sorted[1].id).toBe('B1')
  })

  it('does not mutate input array', () => {
    const blocks = [
      makeBlock({ id: 'B2', due_date: '2025-06-20' }),
      makeBlock({ id: 'B1', due_date: '2025-06-15' }),
    ]
    const copy = [...blocks]
    sortAgendaBlocks(blocks)
    expect(blocks[0].id).toBe(copy[0].id)
    expect(blocks[1].id).toBe(copy[1].id)
  })
})

describe('groupByDate', () => {
  it('puts overdue non-DONE tasks in Overdue group', () => {
    const blocks = [
      makeBlock({ id: 'B1', due_date: '2020-01-01', todo_state: 'TODO' }),
    ]
    const groups = groupByDate(blocks)
    expect(groups[0].label).toBe('Overdue')
    expect(groups[0].blocks.length).toBe(1)
  })

  it('does not put DONE tasks in Overdue', () => {
    const blocks = [
      makeBlock({ id: 'B1', due_date: '2020-01-01', todo_state: 'DONE' }),
    ]
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
    const lastGroup = groups[groups.length - 1]
    expect(lastGroup.label).toBe('No date')
    expect(lastGroup.blocks[0].id).toBe('B1')
  })

  it('includes count in group', () => {
    const blocks = [
      makeBlock({ id: 'B1', due_date: '2020-01-01', todo_state: 'TODO' }),
      makeBlock({ id: 'B2', due_date: '2020-01-02', todo_state: 'TODO' }),
    ]
    const groups = groupByDate(blocks)
    expect(groups[0].label).toBe('Overdue')
    expect(groups[0].blocks.length).toBe(2)
  })

  it('Overdue group is always first', () => {
    const now = new Date()
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const blocks = [
      makeBlock({ id: 'today', due_date: todayStr, todo_state: 'TODO' }),
      makeBlock({ id: 'overdue', due_date: '2020-01-01', todo_state: 'TODO' }),
    ]
    const groups = groupByDate(blocks)
    expect(groups[0].label).toBe('Overdue')
    expect(groups[1].label).toBe('Today')
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
    expect(groups[0].blocks[0].id).toBe('p1')
    expect(groups[1].blocks[0].id).toBe('p2')
    expect(groups[2].blocks[0].id).toBe('p3')
    expect(groups[3].blocks[0].id).toBe('pn')
  })

  it('sorts within groups by date then state', () => {
    const blocks = [
      makeBlock({ id: 'late-todo', priority: '1', due_date: '2025-06-20', todo_state: 'TODO' }),
      makeBlock({ id: 'early-done', priority: '1', due_date: '2025-06-10', todo_state: 'DONE' }),
      makeBlock({ id: 'early-doing', priority: '1', due_date: '2025-06-10', todo_state: 'DOING' }),
    ]
    const groups = groupByPriority(blocks)
    expect(groups.length).toBe(1)
    expect(groups[0].blocks.map((b) => b.id)).toEqual([
      'early-doing',
      'early-done',
      'late-todo',
    ])
  })

  it('omits empty priority groups', () => {
    const blocks = [
      makeBlock({ id: 'p1', priority: '1' }),
    ]
    const groups = groupByPriority(blocks)
    expect(groups.length).toBe(1)
    expect(groups[0].label).toBe('P1')
  })

  it('empty blocks returns empty groups', () => {
    const groups = groupByPriority([])
    expect(groups).toEqual([])
  })
})

describe('groupByState', () => {
  it('groups blocks by todo state', () => {
    const blocks = [
      makeBlock({ id: 'doing', todo_state: 'DOING' }),
      makeBlock({ id: 'todo', todo_state: 'TODO' }),
      makeBlock({ id: 'done', todo_state: 'DONE' }),
      makeBlock({ id: 'none', todo_state: null }),
    ]
    const groups = groupByState(blocks)
    expect(groups.map((g) => g.label)).toEqual(['DOING', 'TODO', 'DONE', 'No state'])
    expect(groups[0].blocks[0].id).toBe('doing')
    expect(groups[1].blocks[0].id).toBe('todo')
    expect(groups[2].blocks[0].id).toBe('done')
    expect(groups[3].blocks[0].id).toBe('none')
  })

  it('sorts within groups by date then priority', () => {
    const blocks = [
      makeBlock({ id: 'late-p1', todo_state: 'TODO', due_date: '2025-06-20', priority: '1' }),
      makeBlock({ id: 'early-p3', todo_state: 'TODO', due_date: '2025-06-10', priority: '3' }),
      makeBlock({ id: 'early-p1', todo_state: 'TODO', due_date: '2025-06-10', priority: '1' }),
    ]
    const groups = groupByState(blocks)
    expect(groups.length).toBe(1)
    expect(groups[0].blocks.map((b) => b.id)).toEqual([
      'early-p1',
      'early-p3',
      'late-p1',
    ])
  })

  it('omits empty state groups', () => {
    const blocks = [
      makeBlock({ id: 'doing', todo_state: 'DOING' }),
    ]
    const groups = groupByState(blocks)
    expect(groups.length).toBe(1)
    expect(groups[0].label).toBe('DOING')
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
      makeBlock({ id: 'p1-early-doing', priority: '1', due_date: '2025-06-10', todo_state: 'DOING' }),
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
    expect(sorted[0].id).toBe('p1')
    expect(sorted[1].id).toBe('pn')
  })

  it('does not mutate input array', () => {
    const blocks = [
      makeBlock({ id: 'p2', priority: '2' }),
      makeBlock({ id: 'p1', priority: '1' }),
    ]
    const copy = [...blocks]
    sortByPriority(blocks)
    expect(blocks[0].id).toBe(copy[0].id)
    expect(blocks[1].id).toBe(copy[1].id)
  })
})

describe('sortByState', () => {
  it('sorts state first, then date, then priority', () => {
    const blocks = [
      makeBlock({ id: 'done', todo_state: 'DONE', due_date: '2025-06-10', priority: '1' }),
      makeBlock({ id: 'doing-late', todo_state: 'DOING', due_date: '2025-06-20', priority: '1' }),
      makeBlock({ id: 'doing-early-p3', todo_state: 'DOING', due_date: '2025-06-10', priority: '3' }),
      makeBlock({ id: 'doing-early-p1', todo_state: 'DOING', due_date: '2025-06-10', priority: '1' }),
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
    expect(sorted[0].id).toBe('todo')
    expect(sorted[1].id).toBe('none')
  })

  it('does not mutate input array', () => {
    const blocks = [
      makeBlock({ id: 'done', todo_state: 'DONE' }),
      makeBlock({ id: 'doing', todo_state: 'DOING' }),
    ]
    const copy = [...blocks]
    sortByState(blocks)
    expect(blocks[0].id).toBe(copy[0].id)
    expect(blocks[1].id).toBe(copy[1].id)
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
    expect(sorted[0].id).toBe('p1-todo')
    expect(sorted[1].id).toBe('p3-doing')
  })

  it('dispatches to priority sort for sortBy=priority', () => {
    const sorted = sortAgendaBlocksBy(blocks, 'priority')
    // priority-first: p1 before p3
    expect(sorted[0].id).toBe('p1-todo')
    expect(sorted[1].id).toBe('p3-doing')
  })

  it('dispatches to state sort for sortBy=state', () => {
    const sorted = sortAgendaBlocksBy(blocks, 'state')
    // state-first: DOING (0) before TODO (1)
    expect(sorted[0].id).toBe('p3-doing')
    expect(sorted[1].id).toBe('p1-todo')
  })
})
