/**
 * Tests for the aria-live announcer utility.
 *
 * Validates:
 *  - Creates the #sr-announcer element on first call
 *  - Sets correct aria attributes
 *  - Sets textContent via requestAnimationFrame
 *  - Handles repeated calls (clears then sets)
 *  - Reuses existing element on subsequent calls
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { announce } from '../announcer'

/** Helper that fetches the announcer element, failing if absent. */
function getAnnouncer(): HTMLElement {
  const el = document.getElementById('sr-announcer')
  expect(el).not.toBeNull()
  return el as HTMLElement
}

describe('announce', () => {
  beforeEach(() => {
    // Remove any existing announcer element
    document.getElementById('sr-announcer')?.remove()
    vi.useFakeTimers()
  })

  afterEach(() => {
    document.getElementById('sr-announcer')?.remove()
    vi.useRealTimers()
  })

  it('creates a #sr-announcer element on first call', () => {
    expect(document.getElementById('sr-announcer')).toBeNull()

    announce('Hello')

    const el = document.getElementById('sr-announcer')
    expect(el).not.toBeNull()
    expect(el).toBeInstanceOf(HTMLElement)
  })

  it('sets aria-live="polite", aria-atomic="true", and role="status"', () => {
    announce('Test')

    const el = getAnnouncer()
    expect(el.getAttribute('aria-live')).toBe('polite')
    expect(el.getAttribute('aria-atomic')).toBe('true')
    expect(el.getAttribute('role')).toBe('status')
  })

  it('applies visually-hidden styles', () => {
    announce('Test')

    const el = getAnnouncer()
    expect(el.style.position).toBe('absolute')
    expect(el.style.width).toBe('1px')
    expect(el.style.height).toBe('1px')
    expect(el.style.overflow).toBe('hidden')
  })

  it('clears textContent immediately, then sets message in rAF', () => {
    announce('First message')

    const el = getAnnouncer()

    // Before rAF fires, textContent should be empty (cleared)
    expect(el.textContent).toBe('')

    // Flush requestAnimationFrame callbacks
    vi.advanceTimersByTime(16)

    expect(el.textContent).toBe('First message')
  })

  it('reuses the same element on subsequent calls', () => {
    announce('Message 1')
    const el1 = getAnnouncer()

    // Flush first rAF
    vi.advanceTimersByTime(16)

    announce('Message 2')
    const el2 = getAnnouncer()

    expect(el1).toBe(el2)

    vi.advanceTimersByTime(16)
    expect(el2.textContent).toBe('Message 2')
  })

  it('handles repeated calls with the same message', () => {
    announce('Same message')
    vi.advanceTimersByTime(16)
    expect(getAnnouncer().textContent).toBe('Same message')

    // Call again with the same message — should clear and re-set
    announce('Same message')
    expect(getAnnouncer().textContent).toBe('')

    vi.advanceTimersByTime(16)
    expect(getAnnouncer().textContent).toBe('Same message')
  })

  it('recreates element if it was removed from DOM', () => {
    announce('Initial')
    const el1 = getAnnouncer()

    // Simulate removal
    el1.remove()
    expect(document.getElementById('sr-announcer')).toBeNull()

    announce('After removal')
    const el2 = getAnnouncer()
    expect(el2).not.toBe(el1)
  })

  it('handles empty string message', () => {
    announce('')
    vi.advanceTimersByTime(16)

    const el = getAnnouncer()
    expect(el.textContent).toBe('')
  })
})
