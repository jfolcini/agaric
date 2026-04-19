/**
 * Tests for priority-levels — the single source of truth for the active
 * priority level list (UX-201b).
 *
 * Validates:
 *  - Default levels match historic `['1', '2', '3']`.
 *  - setPriorityLevels normalises (trim / dedupe / empty-filter).
 *  - setPriorityLevels with empty/bad input keeps the current value.
 *  - setPriorityLevels is a no-op when the new array equals the current one.
 *  - Subscribers fire on change and stop firing after unsubscribe.
 *  - A throwing listener does not block other listeners (logger.warn fires).
 *  - priorityRank matches the pre-UX-201b constants for default levels.
 *  - getPriorityCycle returns `[null, ...levels]`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// NOTE: logger is a soft dep — mock it so tests can assert on warn calls.
vi.mock('../logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { logger } from '../logger'
import {
  __resetPriorityLevelsForTests,
  DEFAULT_PRIORITY_LEVELS,
  getPriorityCycle,
  getPriorityLevels,
  priorityRank,
  setPriorityLevels,
  subscribePriorityLevels,
} from '../priority-levels'

beforeEach(() => {
  vi.clearAllMocks()
  __resetPriorityLevelsForTests()
})

afterEach(() => {
  __resetPriorityLevelsForTests()
})

describe('priority-levels: defaults', () => {
  it('DEFAULT_PRIORITY_LEVELS matches historic ["1", "2", "3"]', () => {
    expect(DEFAULT_PRIORITY_LEVELS).toEqual(['1', '2', '3'])
  })

  it('getPriorityLevels returns the default before any set call', () => {
    expect(getPriorityLevels()).toEqual(['1', '2', '3'])
  })
})

describe('priority-levels: setPriorityLevels normalisation', () => {
  it('accepts a valid array and round-trips', () => {
    setPriorityLevels(['A', 'B', 'C', 'D'])
    expect(getPriorityLevels()).toEqual(['A', 'B', 'C', 'D'])
  })

  it('trims whitespace from each level', () => {
    setPriorityLevels([' A ', 'B', '  C'])
    expect(getPriorityLevels()).toEqual(['A', 'B', 'C'])
  })

  it('drops empty strings (after trim)', () => {
    setPriorityLevels(['A', '', '   ', 'B'])
    expect(getPriorityLevels()).toEqual(['A', 'B'])
  })

  it('dedupes while preserving first-seen order', () => {
    setPriorityLevels(['A', 'B', 'A', 'C', 'B'])
    expect(getPriorityLevels()).toEqual(['A', 'B', 'C'])
  })

  it('keeps current value when input is entirely empty/whitespace', () => {
    setPriorityLevels(['A', 'B'])
    setPriorityLevels(['', '   '])
    expect(getPriorityLevels()).toEqual(['A', 'B'])
  })

  it('keeps current value when input is an empty array', () => {
    setPriorityLevels(['A', 'B'])
    setPriorityLevels([])
    expect(getPriorityLevels()).toEqual(['A', 'B'])
  })
})

describe('priority-levels: setPriorityLevels no-op behaviour', () => {
  it('does not notify subscribers when the new array equals the current one', () => {
    const listener = vi.fn()
    subscribePriorityLevels(listener)
    setPriorityLevels(['1', '2', '3']) // same as default
    expect(listener).not.toHaveBeenCalled()
  })

  it('notifies subscribers when order changes', () => {
    setPriorityLevels(['A', 'B', 'C'])
    const listener = vi.fn()
    subscribePriorityLevels(listener)
    setPriorityLevels(['A', 'C', 'B']) // different order
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('notifies subscribers when length changes', () => {
    setPriorityLevels(['A', 'B', 'C'])
    const listener = vi.fn()
    subscribePriorityLevels(listener)
    setPriorityLevels(['A', 'B'])
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('no-op when normalised input equals current (trim / dedupe)', () => {
    setPriorityLevels(['A', 'B', 'C'])
    const listener = vi.fn()
    subscribePriorityLevels(listener)
    setPriorityLevels([' A ', 'B', 'C', 'A'])
    expect(listener).not.toHaveBeenCalled()
    expect(getPriorityLevels()).toEqual(['A', 'B', 'C'])
  })
})

describe('priority-levels: subscribe / unsubscribe', () => {
  it('subscribers fire on change', () => {
    const a = vi.fn()
    const b = vi.fn()
    subscribePriorityLevels(a)
    subscribePriorityLevels(b)
    setPriorityLevels(['A', 'B', 'C', 'D'])
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('unsubscribe stops notifications', () => {
    const listener = vi.fn()
    const unsub = subscribePriorityLevels(listener)
    unsub()
    setPriorityLevels(['A', 'B'])
    expect(listener).not.toHaveBeenCalled()
  })

  it('one throwing listener does not prevent others from firing', () => {
    const good = vi.fn()
    const bad = vi.fn(() => {
      throw new Error('boom')
    })
    subscribePriorityLevels(bad)
    subscribePriorityLevels(good)
    setPriorityLevels(['X', 'Y'])
    expect(bad).toHaveBeenCalledTimes(1)
    expect(good).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(
      'priority-levels',
      'listener threw',
      undefined,
      expect.any(Error),
    )
  })
})

describe('priority-levels: priorityRank', () => {
  it('returns 0 / 1 / 2 for default 1 / 2 / 3 (regression vs UX-201b)', () => {
    expect(priorityRank('1')).toBe(0)
    expect(priorityRank('2')).toBe(1)
    expect(priorityRank('3')).toBe(2)
  })

  it('returns levels.length (=3) for null (default set)', () => {
    expect(priorityRank(null)).toBe(3)
  })

  it('returns levels.length for unknown priority string', () => {
    expect(priorityRank('UNKNOWN')).toBe(3)
  })

  it('reflects custom levels', () => {
    setPriorityLevels(['A', 'B', 'C', 'D'])
    expect(priorityRank('A')).toBe(0)
    expect(priorityRank('B')).toBe(1)
    expect(priorityRank('C')).toBe(2)
    expect(priorityRank('D')).toBe(3)
    expect(priorityRank(null)).toBe(4) // sorts to bottom
    expect(priorityRank('Z')).toBe(4) // unknown also sorts to bottom
  })
})

describe('priority-levels: getPriorityCycle', () => {
  it('has null first then each level (default)', () => {
    expect(getPriorityCycle()).toEqual([null, '1', '2', '3'])
  })

  it('has null first then each level (custom)', () => {
    setPriorityLevels(['A', 'B', 'C'])
    expect(getPriorityCycle()).toEqual([null, 'A', 'B', 'C'])
  })
})
