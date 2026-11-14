/**
 * Tests for useAndroidShareTarget (#6555): text another Android app shared
 * opens Quick Capture once, holding it.
 *
 * The bridge here takes as `MainActivity`'s does: reading the pending text
 * clears it. What the hook opens is read from the `OPEN_QUICK_CAPTURE_EVENT`
 * `useAppDialogs` listens for.
 */

import { renderHook } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAndroidShareTarget } from '@/hooks/useAndroidShareTarget'
import { MAX_CAPTURE_TEXT_BYTES } from '@/hooks/useDeepLinkRouter'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { OPEN_QUICK_CAPTURE_EVENT } from '@/lib/overlay-events'

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

let pending: string | null
let opened: string[]
let visibility: DocumentVisibilityState

function recordOpen(e: Event): void {
  opened.push((e as CustomEvent<string>).detail)
}

function setVisibility(state: DocumentVisibilityState): void {
  visibility = state
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  vi.clearAllMocks()
  pending = null
  opened = []
  visibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  window.AgaricShareBridge = {
    takePendingText: () => {
      const text = pending
      pending = null
      return text
    },
  }
  window.addEventListener(OPEN_QUICK_CAPTURE_EVENT, recordOpen)
})

afterEach(() => {
  window.removeEventListener(OPEN_QUICK_CAPTURE_EVENT, recordOpen)
  delete window.AgaricShareBridge
  vi.restoreAllMocks()
})

describe('useAndroidShareTarget', () => {
  it('opens Quick Capture once with the text a share started the app with', () => {
    pending = 'https://example.com/article'

    renderHook(() => useAndroidShareTarget())

    expect(opened).toEqual(['https://example.com/article'])
    expect(pending).toBeNull()

    // Coming back to the app later must not replay the same share.
    setVisibility('hidden')
    setVisibility('visible')
    expect(opened).toEqual(['https://example.com/article'])
  })

  it('opens Quick Capture when the running app comes back with a share', () => {
    renderHook(() => useAndroidShareTarget())
    expect(opened).toEqual([])

    setVisibility('hidden')
    pending = 'a paragraph'
    setVisibility('visible')

    expect(opened).toEqual(['a paragraph'])
  })

  it('leaves the text for the resume when the page only goes hidden', () => {
    renderHook(() => useAndroidShareTarget())

    pending = 'kept'
    setVisibility('hidden')

    expect(opened).toEqual([])
    expect(pending).toBe('kept')
  })

  it('stops reading once unmounted', () => {
    const { unmount } = renderHook(() => useAndroidShareTarget())
    unmount()

    pending = 'after unmount'
    setVisibility('visible')

    expect(opened).toEqual([])
    expect(pending).toBe('after unmount')
  })

  it('logs a warning and opens nothing when the bridge throws', () => {
    const failure = new Error('bridge gone')
    window.AgaricShareBridge = {
      takePendingText: () => {
        throw failure
      },
    }

    renderHook(() => useAndroidShareTarget())

    expect(opened).toEqual([])
    expect(logger.warn).toHaveBeenCalledWith(
      'share',
      'reading the text shared from another app failed',
      undefined,
      failure,
    )
  })

  it('refuses a text longer than a block can hold with the capture link toast', () => {
    pending = 'x'.repeat(MAX_CAPTURE_TEXT_BYTES + 1)

    renderHook(() => useAndroidShareTarget())

    expect(opened).toEqual([])
    expect(toast.error).toHaveBeenCalledWith(t('quickCapture.linkTooLong'))
  })

  it('does nothing where there is no bridge', () => {
    delete window.AgaricShareBridge

    renderHook(() => useAndroidShareTarget())
    setVisibility('visible')

    expect(opened).toEqual([])
    expect(logger.warn).not.toHaveBeenCalled()
  })
})
