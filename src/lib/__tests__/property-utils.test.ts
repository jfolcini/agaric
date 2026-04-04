/**
 * Tests for src/lib/property-utils.ts — formatPropertyName, BUILTIN_PROPERTY_ICONS.
 */

import { describe, expect, it } from 'vitest'
import { BUILTIN_PROPERTY_ICONS, formatPropertyName } from '../property-utils'

describe('formatPropertyName', () => {
  it('replaces underscores with spaces and title-cases', () => {
    expect(formatPropertyName('created_at')).toBe('Created At')
  })

  it('replaces hyphens with spaces and title-cases', () => {
    expect(formatPropertyName('repeat-until')).toBe('Repeat Until')
  })

  it('handles single-word keys', () => {
    expect(formatPropertyName('effort')).toBe('Effort')
  })

  it('handles multi-segment underscore keys', () => {
    expect(formatPropertyName('my_custom_prop')).toBe('My Custom Prop')
  })

  it('handles already-capitalized keys', () => {
    expect(formatPropertyName('Due_Date')).toBe('Due Date')
  })

  it('handles empty string', () => {
    expect(formatPropertyName('')).toBe('')
  })
})

describe('BUILTIN_PROPERTY_ICONS', () => {
  it('has icons for core built-in properties', () => {
    const expected = [
      'due_date',
      'scheduled_date',
      'created_at',
      'completed_at',
      'effort',
      'assignee',
      'location',
      'repeat',
    ]
    for (const key of expected) {
      expect(BUILTIN_PROPERTY_ICONS[key], `missing icon for ${key}`).toBeDefined()
    }
  })

  it('returns undefined for custom properties', () => {
    expect(BUILTIN_PROPERTY_ICONS.my_custom_prop).toBeUndefined()
  })

  it('returns undefined for non-iconic built-in keys', () => {
    expect(BUILTIN_PROPERTY_ICONS.todo_state).toBeUndefined()
    expect(BUILTIN_PROPERTY_ICONS.priority).toBeUndefined()
  })
})
