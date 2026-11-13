/**
 * `agaric://capture?text=…` (#6555): the link opens Quick Capture holding its
 * text and never saves. Covers both deliveries — the Rust router's
 * `deeplink:capture` event while the app runs (listened for by
 * `useAppDialogs`), and the launch URL a cold start backfills through
 * `dispatchLaunchUrl` — down to the dialog state `useAppDialogs` owns.
 */

import { act, renderHook } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppDialogs } from '@/hooks/useAppDialogs'
import {
  DEEPLINK_EVENT_CAPTURE,
  dispatchLaunchUrl,
  handleCapturePayload,
  MAX_CAPTURE_TEXT_BYTES,
} from '@/hooks/useDeepLinkRouter'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { OPEN_QUICK_CAPTURE_EVENT } from '@/lib/overlay-events'

const { mockListen } = vi.hoisted(() => ({ mockListen: vi.fn() }))

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}))

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const mockedToastError = vi.mocked(toast.error)

let hadTauriInternals: boolean

beforeEach(() => {
  vi.clearAllMocks()
  mockListen.mockResolvedValue(vi.fn())
  hadTauriInternals = '__TAURI_INTERNALS__' in window
  if (!hadTauriInternals) {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      writable: true,
      configurable: true,
    })
  }
})

afterEach(() => {
  if (!hadTauriInternals) delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

/** The texts `openQuickCapture` sent while `run` ran. */
function capturedTexts(run: () => void): string[] {
  const texts: string[] = []
  const onOpen = (e: Event) => texts.push((e as CustomEvent<string>).detail)
  window.addEventListener(OPEN_QUICK_CAPTURE_EVENT, onOpen)
  try {
    run()
  } finally {
    window.removeEventListener(OPEN_QUICK_CAPTURE_EVENT, onOpen)
  }
  return texts
}

describe('dispatchLaunchUrl — capture links on a cold start (#6555)', () => {
  it('opens Quick Capture with the percent-decoded text', () => {
    expect(capturedTexts(() => dispatchLaunchUrl('agaric://capture?text=a%20b'))).toEqual(['a b'])
  })

  it('keeps UTF-8, newlines, [[links]] and #tags as plain text', () => {
    const url = 'agaric://capture?text=caf%C3%A9%20%23tag%20%5B%5BPage%5D%5D%0Asecond%20line'
    expect(capturedTexts(() => dispatchLaunchUrl(url))).toEqual(['café #tag [[Page]]\nsecond line'])
  })

  it('reads + as a space and %2B as a plus, like the Rust router', () => {
    expect(capturedTexts(() => dispatchLaunchUrl('agaric://capture?text=1%2B1+is+2'))).toEqual([
      '1+1 is 2',
    ])
  })

  it('ignores unknown parameters and reads the first text', () => {
    const url = 'agaric://capture?source=bookmarklet&text=hi&text=again&flag'
    expect(capturedTexts(() => dispatchLaunchUrl(url))).toEqual(['hi'])
  })

  it('opens an empty dialog when the link has no text', () => {
    for (const url of ['agaric://capture', 'agaric://capture/', 'agaric://capture?text']) {
      expect(capturedTexts(() => dispatchLaunchUrl(url))).toEqual([''])
    }
  })

  it('refuses a malformed escape or non-UTF-8 text with a warning, opening nothing', () => {
    for (const url of [
      'agaric://capture?text=%ZZ',
      'agaric://capture?text=50%',
      'agaric://capture?text=%FF',
      'agaric://capture?text=caf%C3',
    ]) {
      expect(capturedTexts(() => dispatchLaunchUrl(url))).toEqual([])
    }
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(4)
    expect(mockedToastError).not.toHaveBeenCalled()
  })

  it('accepts text at the block content cap, counted in UTF-8 bytes', () => {
    const half = MAX_CAPTURE_TEXT_BYTES / 2
    const url = `agaric://capture?text=${'%C3%A9'.repeat(half)}`
    expect(capturedTexts(() => dispatchLaunchUrl(url))).toEqual(['é'.repeat(half)])
  })

  it('refuses text over the cap with an error toast, opening nothing', () => {
    const url = `agaric://capture?text=${'%C3%A9'.repeat(MAX_CAPTURE_TEXT_BYTES / 2 + 1)}`
    expect(capturedTexts(() => dispatchLaunchUrl(url))).toEqual([])
    expect(mockedToastError).toHaveBeenCalledWith(t('quickCapture.linkTooLong'))
  })
})

describe('handleCapturePayload — the Rust router event (#6555)', () => {
  it('opens Quick Capture with a prefill payload', () => {
    expect(capturedTexts(() => handleCapturePayload({ kind: 'prefill', text: 'x\ny' }))).toEqual([
      'x\ny',
    ])
  })

  it('shows the over-long toast for a tooLong payload', () => {
    expect(capturedTexts(() => handleCapturePayload({ kind: 'tooLong' }))).toEqual([])
    expect(mockedToastError).toHaveBeenCalledWith(t('quickCapture.linkTooLong'))
  })

  it('drops a payload of an unknown shape with a warning', () => {
    for (const payload of [null, {}, { kind: 'prefill' }, { kind: 'prefill', text: 3 }]) {
      expect(capturedTexts(() => handleCapturePayload(payload))).toEqual([])
    }
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(4)
  })
})

describe('useAppDialogs — capture links (#6555)', () => {
  function captureListener(): (event: { payload: unknown }) => void {
    const call = mockListen.mock.calls.find((c) => c[0] === DEEPLINK_EVENT_CAPTURE)
    if (call === undefined) throw new Error(`no listener for ${DEEPLINK_EVENT_CAPTURE}`)
    return call[1] as (event: { payload: unknown }) => void
  }

  it('opens Quick Capture holding the text of a deeplink:capture event', async () => {
    const { result } = renderHook(() => useAppDialogs())
    await vi.waitFor(() => expect(mockListen).toHaveBeenCalled())

    act(() => captureListener()({ payload: { kind: 'prefill', text: 'from a link' } }))

    expect(result.current.quickCaptureOpen).toBe(true)
    expect(result.current.quickCapturePrefill).toEqual({ text: 'from a link' })
  })

  it('opens Quick Capture holding the text of a launch URL', () => {
    const { result } = renderHook(() => useAppDialogs())

    act(() => dispatchLaunchUrl('agaric://capture?text=cold%20start'))

    expect(result.current.quickCaptureOpen).toBe(true)
    expect(result.current.quickCapturePrefill).toEqual({ text: 'cold start' })
  })

  it('hands a second link with the same text to the open dialog as a new prefill', () => {
    const { result } = renderHook(() => useAppDialogs())

    act(() => dispatchLaunchUrl('agaric://capture?text=again'))
    const first = result.current.quickCapturePrefill
    act(() => dispatchLaunchUrl('agaric://capture?text=again'))

    expect(result.current.quickCapturePrefill).toEqual({ text: 'again' })
    expect(result.current.quickCapturePrefill).not.toBe(first)
  })

  it('keeps Quick Capture closed when the link is refused as too long', async () => {
    const { result } = renderHook(() => useAppDialogs())
    await vi.waitFor(() => expect(mockListen).toHaveBeenCalled())

    act(() => captureListener()({ payload: { kind: 'tooLong' } }))

    expect(result.current.quickCaptureOpen).toBe(false)
    expect(result.current.quickCapturePrefill).toBeNull()
    expect(mockedToastError).toHaveBeenCalledWith(t('quickCapture.linkTooLong'))
  })

  it('registers no Tauri listener outside Tauri', () => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    renderHook(() => useAppDialogs())
    expect(mockListen).not.toHaveBeenCalled()
  })
})
