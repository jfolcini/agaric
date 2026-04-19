/**
 * Tests for priorityColor — index-based colour mapping driven by the
 * user-configurable priority levels (UX-201b).
 *
 * Validates:
 *  - Default levels (1/2/3) map to urgent / high / normal (regression).
 *  - `null` returns empty string (no classes).
 *  - Unknown levels fall back to `normal`.
 *  - Custom levels at index 0/1/2 get urgent/high/normal; levels 4+ fall back.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { priorityColor } from '../priority-color'
import { __resetPriorityLevelsForTests, setPriorityLevels } from '../priority-levels'

beforeEach(() => {
  __resetPriorityLevelsForTests()
})

afterEach(() => {
  __resetPriorityLevelsForTests()
})

describe('priorityColor: default levels', () => {
  it('returns urgent classes for "1"', () => {
    expect(priorityColor('1')).toBe('bg-priority-urgent text-priority-foreground')
  })

  it('returns high classes for "2"', () => {
    expect(priorityColor('2')).toBe('bg-priority-high text-priority-foreground')
  })

  it('returns normal classes for "3"', () => {
    expect(priorityColor('3')).toBe('bg-priority-normal text-priority-foreground')
  })

  it('returns empty string for null', () => {
    expect(priorityColor(null)).toBe('')
  })

  it('returns normal (fallback) for an unknown level', () => {
    expect(priorityColor('999')).toBe('bg-priority-normal text-priority-foreground')
  })
})

describe('priorityColor: custom levels', () => {
  it('assigns urgent/high/normal to index 0/1/2', () => {
    setPriorityLevels(['A', 'B', 'C', 'D', 'E'])
    expect(priorityColor('A')).toBe('bg-priority-urgent text-priority-foreground')
    expect(priorityColor('B')).toBe('bg-priority-high text-priority-foreground')
    expect(priorityColor('C')).toBe('bg-priority-normal text-priority-foreground')
  })

  it('falls back to normal for levels at index 3+', () => {
    setPriorityLevels(['A', 'B', 'C', 'D', 'E'])
    expect(priorityColor('D')).toBe('bg-priority-normal text-priority-foreground')
    expect(priorityColor('E')).toBe('bg-priority-normal text-priority-foreground')
  })

  it('returns normal fallback for unknown value with custom levels', () => {
    setPriorityLevels(['A', 'B'])
    expect(priorityColor('Z')).toBe('bg-priority-normal text-priority-foreground')
  })

  it('single-level config still assigns urgent to the only level', () => {
    setPriorityLevels(['ONLY'])
    expect(priorityColor('ONLY')).toBe('bg-priority-urgent text-priority-foreground')
  })
})
