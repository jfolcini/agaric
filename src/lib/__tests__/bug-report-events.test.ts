/**
 * Tests for the `bug-report-events` helper module (UX-279).
 *
 * Covers:
 *  - event name constant is the documented value
 *  - `dispatchBugReport` fires a `CustomEvent` on `window` with the
 *    expected name + detail payload
 *  - missing optional fields (no stack) survive the round-trip
 *  - helper is a no-op when `window` is undefined (SSR safety)
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BUG_REPORT_EVENT,
  type BugReportEventDetail,
  dispatchBugReport,
} from '../bug-report-events'

describe('BUG_REPORT_EVENT', () => {
  it('is the agreed-upon namespaced event name', () => {
    expect(BUG_REPORT_EVENT).toBe('agaric:report-bug')
  })
})

describe('dispatchBugReport', () => {
  const listener = vi.fn<(e: Event) => void>()
  const originalWindow = globalThis.window

  afterEach(() => {
    if (originalWindow !== undefined) {
      ;(globalThis as { window?: Window }).window = originalWindow
    }
    window.removeEventListener(BUG_REPORT_EVENT, listener)
    listener.mockReset()
  })

  it('dispatches a CustomEvent on window with the supplied detail', () => {
    window.addEventListener(BUG_REPORT_EVENT, listener)

    dispatchBugReport({ message: 'kaboom', stack: 'at frame:1' })

    expect(listener).toHaveBeenCalledTimes(1)
    const event = listener.mock.calls[0]?.[0] as CustomEvent<BugReportEventDetail>
    expect(event).toBeInstanceOf(CustomEvent)
    expect(event.type).toBe(BUG_REPORT_EVENT)
    expect(event.detail).toEqual({ message: 'kaboom', stack: 'at frame:1' })
  })

  it('omits the stack field when none was supplied', () => {
    window.addEventListener(BUG_REPORT_EVENT, listener)

    dispatchBugReport({ message: 'no stack' })

    expect(listener).toHaveBeenCalledTimes(1)
    const event = listener.mock.calls[0]?.[0] as CustomEvent<BugReportEventDetail>
    expect(event.detail).toEqual({ message: 'no stack' })
    expect(event.detail.stack).toBeUndefined()
  })

  it('is a no-op when window is undefined (SSR safety)', () => {
    // jsdom provides `window`; simulate SSR by deleting the global.
    // afterEach restores it from the captured originalWindow.
    delete (globalThis as { window?: Window }).window

    expect(() => dispatchBugReport({ message: 'ssr' })).not.toThrow()
  })
})
