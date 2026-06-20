/**
 * Tests for the aria-live announcer utility.
 *
 * Validates:
 *  - Creates the #sr-announcer element on first call
 *  - Sets correct aria attributes
 *  - Sets textContent via requestAnimationFrame
 *  - Handles repeated calls (clears then sets)
 *  - Reuses existing element on subsequent calls
 *  - Queues distinct messages so a rapid second message doesn't clobber the first (#1617)
 *  - Falls back to setTimeout when document.hidden so backgrounded tabs still flush (#1617)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetAnnouncerForTests, announce } from '../announcer'

/** Helper that fetches the announcer element, failing if absent. */
function getAnnouncer(): HTMLElement {
  const el = document.getElementById('sr-announcer')
  expect(el).not.toBeNull()
  return el as HTMLElement
}

describe('announce', () => {
  beforeEach(() => {
    // Reset the announcer's singleton + coalescing cache between tests.
    __resetAnnouncerForTests()
    vi.useFakeTimers()
  })

  afterEach(() => {
    __resetAnnouncerForTests()
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

    // Drain the queue (second message flushes after the inter-message gap).
    vi.advanceTimersByTime(200)
    expect(el2.textContent).toBe('Message 2')
  })

  it('coalesces repeated identical calls within the 500ms window', () => {
    announce('Same message')
    vi.advanceTimersByTime(16)
    expect(getAnnouncer().textContent).toBe('Same message')

    // Call again with the same message immediately — should be SUPPRESSED
    // (rapid Ctrl+Z mashing should not spam the screen reader).
    announce('Same message')
    // textContent stays at 'Same message' — second call was a no-op.
    expect(getAnnouncer().textContent).toBe('Same message')
  })

  it('does NOT coalesce distinct messages, even back-to-back', () => {
    announce('First')
    vi.advanceTimersByTime(16)
    expect(getAnnouncer().textContent).toBe('First')

    // Different message — should always go through (queued, flushed after gap).
    announce('Second')
    vi.advanceTimersByTime(200)
    expect(getAnnouncer().textContent).toBe('Second')
  })

  it('voices BOTH of two distinct rapid announcements — neither is clobbered (#1617)', () => {
    const seen: string[] = []
    const el = (() => {
      announce('Alpha')
      return getAnnouncer()
    })()

    // Second distinct message arrives before the first frame paints. With a
    // naive single-region implementation it would overwrite 'Alpha' before the
    // screen reader voices it. The queue must surface BOTH non-empty values.
    announce('Beta')

    // Observe every non-empty value the live region settles on as timers drain.
    const record = () => {
      if (el.textContent && el.textContent.length > 0) seen.push(el.textContent)
    }

    vi.advanceTimersByTime(16) // first rAF → 'Alpha'
    record()
    vi.advanceTimersByTime(150) // inter-message gap → clear
    record()
    vi.advanceTimersByTime(16) // second rAF → 'Beta'
    record()

    expect(seen).toContain('Alpha')
    expect(seen).toContain('Beta')
    expect(el.textContent).toBe('Beta')
  })

  it('voices ALL of three rapid distinct announcements in order, none dropped (#1617)', () => {
    announce('One')
    announce('Two')
    announce('Three')

    const el = getAnnouncer()
    const seen: string[] = []
    const record = () => {
      if (el.textContent && el.textContent.length > 0) seen.push(el.textContent)
    }

    // Drain the full chain: each message gets an rAF paint, then a 150ms gap
    // before the next is shifted. Sample after every step so no value is missed.
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(16) // rAF paint
      record()
      vi.advanceTimersByTime(150) // inter-message gap (clear)
      record()
    }

    expect(seen).toContain('One')
    expect(seen).toContain('Two')
    expect(seen).toContain('Three')
    expect(el.textContent).toBe('Three')
  })

  it('voices BOTH distinct messages via the setTimeout path when document.hidden (#1617)', () => {
    const hiddenSpy = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    try {
      announce('HiddenAlpha')
      announce('HiddenBeta')

      const el = getAnnouncer()
      const seen: string[] = []
      const record = () => {
        if (el.textContent && el.textContent.length > 0) seen.push(el.textContent)
      }

      // Backgrounded tab uses setTimeout(0) for the paint, not rAF, but the
      // queue must still sequence both messages without clobbering.
      for (let i = 0; i < 4; i++) {
        vi.advanceTimersByTime(0) // setTimeout(0) paint
        record()
        vi.advanceTimersByTime(150) // inter-message gap (clear)
        record()
      }

      expect(seen).toContain('HiddenAlpha')
      expect(seen).toContain('HiddenBeta')
      expect(el.textContent).toBe('HiddenBeta')
    } finally {
      hiddenSpy.mockRestore()
    }
  })

  it('resetting mid-flush drops the queued tail and does not stall a later announce (#1617)', () => {
    // Queue two messages, paint the first, then reset before the gap timer fires.
    announce('Stale1')
    announce('Stale2')
    vi.advanceTimersByTime(16) // 'Stale1' painted; 150ms gap pending for 'Stale2'

    __resetAnnouncerForTests()

    // Any in-flight timer firing post-reset must be inert (queue cleared,
    // flushScheduled cleared) — draining timers must not resurrect 'Stale2'.
    vi.advanceTimersByTime(500)
    expect(document.getElementById('sr-announcer')).toBeNull()

    // A fresh announce after reset must still flush (flushScheduled was cleared,
    // so the in-flight guard cannot be stuck true).
    announce('Fresh')
    vi.advanceTimersByTime(16)
    expect(getAnnouncer().textContent).toBe('Fresh')
  })

  it('repeats identical messages once the 500ms coalescing window has elapsed', () => {
    announce('Same message')
    vi.advanceTimersByTime(16)
    expect(getAnnouncer().textContent).toBe('Same message')

    // Wait past the coalescing window.
    vi.advanceTimersByTime(600)

    // Call with the same message again — now it goes through (clear + rAF set).
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

  describe('backgrounded-tab fallback (#1617)', () => {
    let hiddenSpy: ReturnType<typeof vi.spyOn> | null = null

    afterEach(() => {
      hiddenSpy?.mockRestore()
      hiddenSpy = null
    })

    it('flushes via setTimeout (not rAF) when document.hidden is true', () => {
      hiddenSpy = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
      const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame')

      announce('Hidden message')
      const el = getAnnouncer()

      // rAF is throttled/paused for backgrounded tabs — it must NOT be the path.
      expect(rafSpy).not.toHaveBeenCalled()
      // Still cleared synchronously.
      expect(el.textContent).toBe('')

      // The setTimeout(0) fallback paints the message.
      vi.advanceTimersByTime(0)
      expect(el.textContent).toBe('Hidden message')

      rafSpy.mockRestore()
    })

    it('uses rAF (not the timeout fallback) when document is visible', () => {
      hiddenSpy = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
      const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame')

      announce('Visible message')
      expect(rafSpy).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(16)
      expect(getAnnouncer().textContent).toBe('Visible message')

      rafSpy.mockRestore()
    })
  })
})
