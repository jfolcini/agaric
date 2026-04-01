import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('openUrl', () => {
  const mockOpen = vi.fn()

  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('calls open() from @tauri-apps/plugin-shell when available', async () => {
    vi.doMock('@tauri-apps/plugin-shell', () => ({ open: mockOpen }))
    const { openUrl } = await import('../open-url')

    await openUrl('https://example.com')

    expect(mockOpen).toHaveBeenCalledWith('https://example.com')
  })

  it('falls back to window.open when @tauri-apps/plugin-shell import fails', async () => {
    vi.doMock('@tauri-apps/plugin-shell', () => {
      throw new Error('Module not available')
    })
    const windowOpenSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    const { openUrl } = await import('../open-url')

    await openUrl('https://fallback.com')

    expect(windowOpenSpy).toHaveBeenCalledWith(
      'https://fallback.com',
      '_blank',
      'noopener,noreferrer',
    )
  })
})
