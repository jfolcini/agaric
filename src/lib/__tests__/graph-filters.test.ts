/**
 * Tests for graph-filters pure functions (UX-205).
 */

import { describe, expect, it } from 'vitest'
import {
  applyGraphFilters,
  GRAPH_FILTER_TYPES,
  GRAPH_PRIORITY_VALUES,
  GRAPH_STATUS_VALUES,
  type GraphFilter,
  type GraphFilterableNode,
  getGraphFilterKey,
  nodeMatchesFilter,
} from '../graph-filters'

// Test fixtures
const makeNode = (overrides: Partial<GraphFilterableNode> = {}): GraphFilterableNode => ({
  id: 'n1',
  ...overrides,
})

const nodes: GraphFilterableNode[] = [
  {
    id: 'todo-high',
    todo_state: 'TODO',
    priority: '1',
    due_date: '2025-01-15',
    scheduled_date: null,
    tag_ids: ['work'],
    is_template: false,
    backlink_count: 3,
  },
  {
    id: 'doing-med',
    todo_state: 'DOING',
    priority: '2',
    due_date: null,
    scheduled_date: '2025-02-01',
    tag_ids: ['work', 'home'],
    is_template: false,
    backlink_count: 0,
  },
  {
    id: 'done',
    todo_state: 'DONE',
    priority: null,
    due_date: null,
    scheduled_date: null,
    tag_ids: [],
    is_template: false,
    backlink_count: 5,
  },
  {
    id: 'cancelled',
    todo_state: 'CANCELLED',
    priority: '3',
    due_date: '2025-03-01',
    scheduled_date: '2025-03-05',
    tag_ids: ['home'],
    is_template: false,
    backlink_count: 0,
  },
  {
    id: 'plain',
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    tag_ids: [],
    is_template: false,
    backlink_count: 1,
  },
  {
    id: 'template',
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    tag_ids: ['tmpl'],
    is_template: true,
    backlink_count: 0,
  },
]

describe('applyGraphFilters', () => {
  describe('empty filter list', () => {
    it('returns a copy of all nodes when filters is empty', () => {
      const result = applyGraphFilters(nodes, [])
      expect(result).toHaveLength(nodes.length)
      expect(result).not.toBe(nodes)
    })
  })

  describe('status filter', () => {
    it('matches nodes with one of the selected statuses', () => {
      const result = applyGraphFilters(nodes, [{ type: 'status', values: ['TODO'] }])
      expect(result.map((n) => n.id)).toEqual(['todo-high'])
    })

    it('matches multiple statuses (OR within the filter)', () => {
      const result = applyGraphFilters(nodes, [{ type: 'status', values: ['TODO', 'DOING'] }])
      expect(result.map((n) => n.id)).toEqual(['todo-high', 'doing-med'])
    })

    it('excludes nodes with null todo_state', () => {
      const result = applyGraphFilters(nodes, [{ type: 'status', values: ['DONE'] }])
      expect(result.map((n) => n.id)).toEqual(['done'])
    })

    it('treats empty values array as no-op', () => {
      const result = applyGraphFilters(nodes, [{ type: 'status', values: [] }])
      expect(result).toHaveLength(nodes.length)
    })
  })

  describe('priority filter', () => {
    it('matches nodes with one of the selected priorities', () => {
      const result = applyGraphFilters(nodes, [{ type: 'priority', values: ['1'] }])
      expect(result.map((n) => n.id)).toEqual(['todo-high'])
    })

    it('matches multiple priorities', () => {
      const result = applyGraphFilters(nodes, [{ type: 'priority', values: ['1', '2'] }])
      expect(result.map((n) => n.id)).toEqual(['todo-high', 'doing-med'])
    })

    it('excludes nodes with null priority', () => {
      const result = applyGraphFilters(nodes, [{ type: 'priority', values: ['3'] }])
      expect(result.map((n) => n.id)).toEqual(['cancelled'])
    })
  })

  describe('hasDueDate filter', () => {
    it('returns only nodes with a non-null, non-empty due_date when value is true', () => {
      const result = applyGraphFilters(nodes, [{ type: 'hasDueDate', value: true }])
      expect(result.map((n) => n.id).sort()).toEqual(['cancelled', 'todo-high'])
    })

    it('returns only nodes WITHOUT a due_date when value is false', () => {
      const result = applyGraphFilters(nodes, [{ type: 'hasDueDate', value: false }])
      expect(result.map((n) => n.id).sort()).toEqual(['doing-med', 'done', 'plain', 'template'])
    })

    it('treats empty string as no due date', () => {
      const ns = [makeNode({ id: 'empty', due_date: '' })]
      const result = applyGraphFilters(ns, [{ type: 'hasDueDate', value: true }])
      expect(result).toHaveLength(0)
    })
  })

  describe('hasScheduledDate filter', () => {
    it('returns only nodes with scheduled_date when value is true', () => {
      const result = applyGraphFilters(nodes, [{ type: 'hasScheduledDate', value: true }])
      expect(result.map((n) => n.id).sort()).toEqual(['cancelled', 'doing-med'])
    })

    it('returns nodes without scheduled_date when value is false', () => {
      const result = applyGraphFilters(nodes, [{ type: 'hasScheduledDate', value: false }])
      expect(result.map((n) => n.id).sort()).toEqual(['done', 'plain', 'template', 'todo-high'])
    })
  })

  describe('hasBacklinks filter', () => {
    it('returns only nodes with backlink_count > 0 when value is true', () => {
      const result = applyGraphFilters(nodes, [{ type: 'hasBacklinks', value: true }])
      expect(result.map((n) => n.id).sort()).toEqual(['done', 'plain', 'todo-high'])
    })

    it('returns only nodes with backlink_count == 0 when value is false', () => {
      const result = applyGraphFilters(nodes, [{ type: 'hasBacklinks', value: false }])
      expect(result.map((n) => n.id).sort()).toEqual(['cancelled', 'doing-med', 'template'])
    })

    it('passes nodes through when backlink_count is undefined', () => {
      const ns = [makeNode({ id: 'unknown' })]
      const result = applyGraphFilters(ns, [{ type: 'hasBacklinks', value: true }])
      expect(result).toHaveLength(1)
    })
  })

  describe('excludeTemplates filter', () => {
    it('removes nodes where is_template === true when value is true', () => {
      const result = applyGraphFilters(nodes, [{ type: 'excludeTemplates', value: true }])
      expect(result.find((n) => n.id === 'template')).toBeUndefined()
      expect(result).toHaveLength(5)
    })

    it('is a no-op when value is false', () => {
      const result = applyGraphFilters(nodes, [{ type: 'excludeTemplates', value: false }])
      expect(result).toHaveLength(nodes.length)
    })

    it('keeps nodes where is_template is undefined (unknown)', () => {
      const ns = [makeNode({ id: 'unknown' })]
      const result = applyGraphFilters(ns, [{ type: 'excludeTemplates', value: true }])
      expect(result).toHaveLength(1)
    })
  })

  describe('tag filter', () => {
    it('matches nodes with at least one of the selected tags (OR)', () => {
      const result = applyGraphFilters(nodes, [{ type: 'tag', tagIds: ['work'] }])
      expect(result.map((n) => n.id).sort()).toEqual(['doing-med', 'todo-high'])
    })

    it('matches nodes with any of multiple selected tags', () => {
      const result = applyGraphFilters(nodes, [{ type: 'tag', tagIds: ['work', 'home'] }])
      expect(result.map((n) => n.id).sort()).toEqual(['cancelled', 'doing-med', 'todo-high'])
    })

    it('treats empty tagIds as no-op', () => {
      const result = applyGraphFilters(nodes, [{ type: 'tag', tagIds: [] }])
      expect(result).toHaveLength(nodes.length)
    })

    it('passes nodes through when tag_ids is undefined', () => {
      const ns = [makeNode({ id: 'unknown' })]
      const result = applyGraphFilters(ns, [{ type: 'tag', tagIds: ['work'] }])
      expect(result).toHaveLength(1)
    })
  })

  describe('multiple filters (AND)', () => {
    it('applies all filters in AND semantics', () => {
      const result = applyGraphFilters(nodes, [
        { type: 'status', values: ['TODO', 'DOING'] },
        { type: 'hasDueDate', value: true },
      ])
      expect(result.map((n) => n.id)).toEqual(['todo-high'])
    })

    it('combines status, priority, and tag', () => {
      const result = applyGraphFilters(nodes, [
        { type: 'status', values: ['TODO', 'DOING', 'DONE'] },
        { type: 'priority', values: ['1', '2'] },
        { type: 'tag', tagIds: ['work'] },
      ])
      expect(result.map((n) => n.id).sort()).toEqual(['doing-med', 'todo-high'])
    })

    it('returns empty when filters have no overlap', () => {
      const result = applyGraphFilters(nodes, [
        { type: 'status', values: ['TODO'] },
        { type: 'hasScheduledDate', value: true },
      ])
      expect(result).toHaveLength(0)
    })

    it('respects excludeTemplates alongside other filters', () => {
      const ns = [...nodes, makeNode({ id: 'tmpl-todo', todo_state: 'TODO', is_template: true })]
      const result = applyGraphFilters(ns, [
        { type: 'status', values: ['TODO'] },
        { type: 'excludeTemplates', value: true },
      ])
      expect(result.map((n) => n.id)).toEqual(['todo-high'])
    })
  })
})

describe('nodeMatchesFilter', () => {
  it('returns true for a matching status filter', () => {
    const node = makeNode({ todo_state: 'TODO' })
    expect(nodeMatchesFilter(node, { type: 'status', values: ['TODO'] })).toBe(true)
  })

  it('returns false for a non-matching status filter', () => {
    const node = makeNode({ todo_state: 'DONE' })
    expect(nodeMatchesFilter(node, { type: 'status', values: ['TODO'] })).toBe(false)
  })

  it('returns true when status filter values are empty (no-op)', () => {
    const node = makeNode()
    expect(nodeMatchesFilter(node, { type: 'status', values: [] })).toBe(true)
  })
})

describe('getGraphFilterKey', () => {
  it('produces the same key for equal tag filters regardless of order', () => {
    const a: GraphFilter = { type: 'tag', tagIds: ['a', 'b'] }
    const b: GraphFilter = { type: 'tag', tagIds: ['b', 'a'] }
    expect(getGraphFilterKey(a)).toBe(getGraphFilterKey(b))
  })

  it('distinguishes different filter types', () => {
    const status: GraphFilter = { type: 'status', values: ['TODO'] }
    const priority: GraphFilter = { type: 'priority', values: ['1'] }
    expect(getGraphFilterKey(status)).not.toBe(getGraphFilterKey(priority))
  })

  it('handles boolean dimensions', () => {
    expect(getGraphFilterKey({ type: 'hasDueDate', value: true })).toBe('hasDueDate:true')
    expect(getGraphFilterKey({ type: 'hasDueDate', value: false })).toBe('hasDueDate:false')
  })

  it('handles excludeTemplates', () => {
    expect(getGraphFilterKey({ type: 'excludeTemplates', value: true })).toBe(
      'excludeTemplates:true',
    )
  })
})

describe('constants', () => {
  it('GRAPH_FILTER_TYPES contains all discriminants', () => {
    expect(GRAPH_FILTER_TYPES).toContain('tag')
    expect(GRAPH_FILTER_TYPES).toContain('status')
    expect(GRAPH_FILTER_TYPES).toContain('priority')
    expect(GRAPH_FILTER_TYPES).toContain('hasDueDate')
    expect(GRAPH_FILTER_TYPES).toContain('hasScheduledDate')
    expect(GRAPH_FILTER_TYPES).toContain('hasBacklinks')
    expect(GRAPH_FILTER_TYPES).toContain('excludeTemplates')
    expect(GRAPH_FILTER_TYPES).toHaveLength(7)
  })

  it('GRAPH_STATUS_VALUES matches the locked task cycle', () => {
    expect(GRAPH_STATUS_VALUES).toEqual(['TODO', 'DOING', 'DONE', 'CANCELLED'])
  })

  it('GRAPH_PRIORITY_VALUES is 1-3', () => {
    expect(GRAPH_PRIORITY_VALUES).toEqual(['1', '2', '3'])
  })
})
