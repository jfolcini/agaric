/**
 * Tests for block-events constants and helpers.
 *
 * Validates:
 *  - BLOCK_EVENTS has the expected keys and string values
 *
 * (#2222 — `dispatchBlockEvent` is now a thin alias of the focus-keyed
 * `dispatchBlockCommand` bus; its routing is covered by the block-command-bus
 * tests. The dead document-broadcast path and the `onBlockEvent` listener
 * helper were removed, so their tests are gone with them.)
 */

import { describe, expect, it } from 'vitest'

import { BLOCK_EVENTS } from '../block-events'

describe('BLOCK_EVENTS', () => {
  it('contains all 17 expected event keys', () => {
    const expectedKeys = [
      'OPEN_DATE_PICKER',
      'OPEN_DUE_DATE_PICKER',
      'OPEN_SCHEDULED_DATE_PICKER',
      'TOGGLE_TODO_STATE',
      'OPEN_BLOCK_PROPERTIES',
      'OPEN_EMOJI_PICKER',
      'OPEN_QUERY_BUILDER',
      'PASTE_HTML_BLOCKS',
      'DISCARD_BLOCK_EDIT',
      'CYCLE_PRIORITY',
      'SET_PRIORITY_1',
      'SET_PRIORITY_2',
      'SET_PRIORITY_3',
      'INSERT_ORDERED_LIST',
      'INSERT_DIVIDER',
      'INSERT_CALLOUT',
      'TURN_INTO_BLOCK',
    ]
    expect(Object.keys(BLOCK_EVENTS).toSorted()).toEqual(expectedKeys.toSorted())
  })

  it('maps keys to kebab-case string values', () => {
    expect(BLOCK_EVENTS.OPEN_DATE_PICKER).toBe('open-date-picker')
    expect(BLOCK_EVENTS.OPEN_DUE_DATE_PICKER).toBe('open-due-date-picker')
    expect(BLOCK_EVENTS.OPEN_SCHEDULED_DATE_PICKER).toBe('open-scheduled-date-picker')
    expect(BLOCK_EVENTS.TOGGLE_TODO_STATE).toBe('toggle-todo-state')
    expect(BLOCK_EVENTS.OPEN_BLOCK_PROPERTIES).toBe('open-block-properties')
    expect(BLOCK_EVENTS.DISCARD_BLOCK_EDIT).toBe('discard-block-edit')
    expect(BLOCK_EVENTS.CYCLE_PRIORITY).toBe('cycle-priority')
    expect(BLOCK_EVENTS.SET_PRIORITY_1).toBe('set-priority-1')
    expect(BLOCK_EVENTS.SET_PRIORITY_2).toBe('set-priority-2')
    expect(BLOCK_EVENTS.SET_PRIORITY_3).toBe('set-priority-3')
  })

  it('values are all unique strings', () => {
    const values = Object.values(BLOCK_EVENTS)
    expect(new Set(values).size).toBe(values.length)
    for (const v of values) {
      expect(typeof v).toBe('string')
    }
  })
})
