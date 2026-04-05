/**
 * Tests for block-events constants and helpers.
 *
 * Validates:
 *  - BLOCK_EVENTS has the expected keys and string values
 *  - dispatchBlockEvent dispatches on document with correct event name
 *  - onBlockEvent adds listener and cleanup removes it
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { BLOCK_EVENTS, dispatchBlockEvent, onBlockEvent } from '../block-events'

describe('BLOCK_EVENTS', () => {
  it('contains all 10 expected event keys', () => {
    const expectedKeys = [
      'OPEN_DATE_PICKER',
      'OPEN_DUE_DATE_PICKER',
      'OPEN_SCHEDULED_DATE_PICKER',
      'TOGGLE_TODO_STATE',
      'OPEN_BLOCK_PROPERTIES',
      'DISCARD_BLOCK_EDIT',
      'CYCLE_PRIORITY',
      'SET_PRIORITY_1',
      'SET_PRIORITY_2',
      'SET_PRIORITY_3',
    ]
    expect(Object.keys(BLOCK_EVENTS).sort()).toEqual(expectedKeys.sort())
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

describe('dispatchBlockEvent', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('dispatches a CustomEvent on document with the correct event name', () => {
    const handler = vi.fn()
    document.addEventListener('open-date-picker', handler)

    dispatchBlockEvent('OPEN_DATE_PICKER')

    expect(handler).toHaveBeenCalledTimes(1)
    const event = handler.mock.calls[0]?.[0] as CustomEvent
    expect(event).toBeInstanceOf(CustomEvent)
    expect(event.type).toBe('open-date-picker')

    document.removeEventListener('open-date-picker', handler)
  })

  it('passes detail payload through', () => {
    const handler = vi.fn()
    document.addEventListener('cycle-priority', handler)

    dispatchBlockEvent('CYCLE_PRIORITY', { foo: 42 })

    expect(handler).toHaveBeenCalledTimes(1)
    const event = handler.mock.calls[0]?.[0] as CustomEvent
    expect(event.detail).toEqual({ foo: 42 })

    document.removeEventListener('cycle-priority', handler)
  })
})

describe('onBlockEvent', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('adds a listener that receives the event', () => {
    const handler = vi.fn()
    const el = document.createElement('div')

    onBlockEvent(el, 'TOGGLE_TODO_STATE', handler)
    el.dispatchEvent(new CustomEvent('toggle-todo-state'))

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('returns a cleanup function that removes the listener', () => {
    const handler = vi.fn()
    const el = document.createElement('div')

    const cleanup = onBlockEvent(el, 'DISCARD_BLOCK_EDIT', handler)
    cleanup()

    el.dispatchEvent(new CustomEvent('discard-block-edit'))
    expect(handler).not.toHaveBeenCalled()
  })

  it('works with document as the target', () => {
    const handler = vi.fn()

    const cleanup = onBlockEvent(document, 'SET_PRIORITY_1', handler)
    document.dispatchEvent(new CustomEvent('set-priority-1'))

    expect(handler).toHaveBeenCalledTimes(1)
    cleanup()

    document.dispatchEvent(new CustomEvent('set-priority-1'))
    expect(handler).toHaveBeenCalledTimes(1) // still 1 — no new call
  })
})
