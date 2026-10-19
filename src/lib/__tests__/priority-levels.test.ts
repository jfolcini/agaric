/**
 * Tests for priority-levels — the fixed priority levels (#5841), their cycle
 * and their sort rank.
 */

import { describe, expect, it } from 'vitest'

import { PRIORITY_CYCLE, PRIORITY_LEVELS, priorityRank } from '@/lib/priority-levels'

describe('priority-levels', () => {
  it('the levels are 1 / 2 / 3', () => {
    expect(PRIORITY_LEVELS).toEqual(['1', '2', '3'])
  })

  it('the cycle is none, then each level', () => {
    expect(PRIORITY_CYCLE).toEqual([null, '1', '2', '3'])
  })
})

describe('priority-levels: priorityRank', () => {
  it('returns 0 / 1 / 2 for 1 / 2 / 3', () => {
    expect(priorityRank('1')).toBe(0)
    expect(priorityRank('2')).toBe(1)
    expect(priorityRank('3')).toBe(2)
  })

  it('returns 3, after every level, for null', () => {
    expect(priorityRank(null)).toBe(3)
  })

  it('sorts an out-of-range level like P0 last', () => {
    expect(priorityRank('P0')).toBe(3)
    expect(['P0', '3', '1'].toSorted((a, b) => priorityRank(a) - priorityRank(b))).toEqual([
      '1',
      '3',
      'P0',
    ])
  })
})
