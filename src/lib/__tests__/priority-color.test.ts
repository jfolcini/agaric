/**
 * Tests for priorityColor — the three levels map to urgent / high / normal,
 * `null` to no classes, and a level from before the levels were fixed
 * (#5841) to the neutral muted tokens.
 */

import { describe, expect, it } from 'vitest'

import { priorityColor } from '@/lib/priority-color'

describe('priorityColor', () => {
  it('returns urgent classes for "1"', () => {
    expect(priorityColor('1')).toBe('bg-priority-urgent text-priority-urgent-foreground')
  })

  it('returns high classes for "2"', () => {
    expect(priorityColor('2')).toBe('bg-priority-high text-priority-high-foreground')
  })

  it('returns normal classes for "3"', () => {
    expect(priorityColor('3')).toBe('bg-priority-normal text-priority-normal-foreground')
  })

  it('returns empty string for null', () => {
    expect(priorityColor(null)).toBe('')
  })

  it('returns the neutral colour for an out-of-range level like P0', () => {
    expect(priorityColor('P0')).toBe('bg-muted text-muted-foreground')
  })
})
