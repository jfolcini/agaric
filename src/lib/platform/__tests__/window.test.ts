import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { logger } from '@/lib/logger'
import { setWebviewZoom } from '@/lib/platform/window'

const mockSetZoom = vi.fn()
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ setZoom: mockSetZoom }),
}))
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0'

describe('setWebviewZoom', () => {
  const originalUA = navigator.userAgent

  beforeEach(() => {
    mockSetZoom.mockReset()
    vi.mocked(logger.warn).mockClear()
  })

  afterEach(() => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => originalUA })
  })

  it('sets the webview zoom to the factor', async () => {
    mockSetZoom.mockResolvedValueOnce(undefined)

    await setWebviewZoom(1.25)

    expect(mockSetZoom).toHaveBeenCalledExactlyOnceWith(1.25)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('logs a rejection instead of throwing', async () => {
    const err = new Error('webview.set_webview_zoom not allowed')
    mockSetZoom.mockRejectedValueOnce(err)

    await expect(setWebviewZoom(1.5)).resolves.toBeUndefined()

    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      'window',
      'setZoom() failed or webview API unavailable',
      { factor: 1.5 },
      err,
    )
  })

  it('never calls the desktop-only command on Android', async () => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => ANDROID_UA })

    await setWebviewZoom(1.5)

    expect(mockSetZoom).not.toHaveBeenCalled()
  })
})
