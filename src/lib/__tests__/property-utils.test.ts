/**
 * Tests for src/lib/property-utils.ts — formatPropertyName, selectOptionsJson,
 * BUILTIN_PROPERTY_ICONS.
 */

import { describe, expect, it } from 'vitest'

import { t } from '@/lib/i18n'
import {
  BUILTIN_PROPERTY_ICONS,
  formatPropertyName,
  selectOptionsJson,
  valueTypeLabel,
} from '@/lib/property-utils'

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
    expect(BUILTIN_PROPERTY_ICONS['my_custom_prop']).toBeUndefined()
  })

  it('returns undefined for non-iconic built-in keys', () => {
    expect(BUILTIN_PROPERTY_ICONS['todo_state']).toBeUndefined()
    expect(BUILTIN_PROPERTY_ICONS['priority']).toBeUndefined()
  })
})

describe('selectOptionsJson', () => {
  it('reads the trimmed, non-empty options of a comma-separated list', () => {
    expect(selectOptionsJson(' small, ,large ,')).toBe('["small","large"]')
  })

  it('is null when the list names no option', () => {
    expect(selectOptionsJson('')).toBeNull()
    expect(selectOptionsJson(' , ')).toBeNull()
  })
})

describe('valueTypeLabel (#6741)', () => {
  it('names a list by its item type and marks it', () => {
    expect(valueTypeLabel({ value_type: 'select', multiple: true }, t)).toBe(
      t('properties.severalValuesType', { type: 'select' }),
    )
  })

  it('names a key that holds one value by its type alone', () => {
    expect(valueTypeLabel({ value_type: 'select' }, t)).toBe('select')
    expect(valueTypeLabel({ value_type: 'number', multiple: false }, t)).toBe('number')
  })
})
