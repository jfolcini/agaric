import { describe, expect, it } from 'vitest'

import {
  isTodoState,
  nextTaskState,
  TASK_CYCLE,
  TASK_MARKER_TO_STATE,
  TASK_STATE_AUTOCOMPLETE_VALUES,
  TASK_STATE_SORT_ORDER,
  TASK_STATE_TO_MARKER,
  TASK_STATES,
  taskStateFromMarker,
  taskStateRank,
} from '@/lib/task-states'

describe('task state vocabulary', () => {
  it('locks the persisted, cycle, agenda, and autocomplete orders independently', () => {
    expect(TASK_STATES).toEqual(['TODO', 'DOING', 'DONE', 'CANCELLED'])
    expect(TASK_CYCLE).toEqual([null, 'TODO', 'DOING', 'DONE', 'CANCELLED'])
    expect(TASK_STATE_SORT_ORDER).toEqual(['DOING', 'TODO', 'DONE', 'CANCELLED'])
    expect(TASK_STATE_AUTOCOMPLETE_VALUES).toEqual(['TODO', 'DOING', 'DONE', 'CANCELLED', 'none'])
  })

  it('agenda order contains every persisted state exactly once', () => {
    expect(TASK_STATE_SORT_ORDER).toHaveLength(TASK_STATES.length)
    expect(new Set(TASK_STATE_SORT_ORDER)).toEqual(new Set(TASK_STATES))
    expect(new Set(TASK_STATE_SORT_ORDER).size).toBe(TASK_STATE_SORT_ORDER.length)
  })

  it.each(TASK_STATES)('recognises persisted state %s', (state) => {
    expect(isTodoState(state)).toBe(true)
  })

  it.each([null, undefined, '', 'todo', 'WAITING', 'none', 1])(
    'rejects non-state value %j',
    (value) => {
      expect(isTodoState(value)).toBe(false)
    },
  )

  it.each([
    [null, 'TODO'],
    ['TODO', 'DOING'],
    ['DOING', 'DONE'],
    ['DONE', 'CANCELLED'],
    ['CANCELLED', null],
    ['WAITING', null],
    ['', null],
  ] as const)('cycles %s to %s', (current, expected) => {
    expect(nextTaskState(current)).toBe(expected)
  })

  it('ranks agenda states separately and sends null/unknown values last', () => {
    expect(TASK_STATE_SORT_ORDER.map(taskStateRank)).toEqual([0, 1, 2, 3])
    expect(taskStateRank(null)).toBe(4)
    expect(taskStateRank('WAITING')).toBe(4)
    expect(taskStateRank('')).toBe(4)
  })

  it('maps all supported checkbox markers in both directions', () => {
    expect(TASK_STATE_TO_MARKER).toEqual({
      TODO: ' ',
      DOING: '/',
      DONE: 'x',
      CANCELLED: '-',
    })
    expect(TASK_MARKER_TO_STATE).toEqual({
      ' ': 'TODO',
      '/': 'DOING',
      x: 'DONE',
      X: 'DONE',
      '-': 'CANCELLED',
    })
    expect(taskStateFromMarker(' ')).toBe('TODO')
    expect(taskStateFromMarker('/')).toBe('DOING')
    expect(taskStateFromMarker('x')).toBe('DONE')
    expect(taskStateFromMarker('X')).toBe('DONE')
    expect(taskStateFromMarker('-')).toBe('CANCELLED')
    expect(taskStateFromMarker('!')).toBeNull()
    expect(taskStateFromMarker('toString')).toBeNull()
  })
})
