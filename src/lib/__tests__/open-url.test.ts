import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('openUrl', () => {
  const mockOpen = vi.fn()

  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('calls openUrl() from @tauri-apps/plugin-opener when available and resolves true', async () => {
    mockOpen.mockResolvedValueOnce(undefined)
    vi.doMock('@tauri-apps/plugin-opener', () => ({ openUrl: mockOpen }))
    const { openUrl } = await import('@/lib/open-url')

    const result = await openUrl('https://example.com')

    expect(mockOpen).toHaveBeenCalledWith('https://example.com')
    expect(result).toBe(true)
  })

  it('falls back to window.open when @tauri-apps/plugin-opener import fails (handle non-null → true)', async () => {
    vi.doMock('@tauri-apps/plugin-opener', () => {
      throw new Error('Module not available')
    })
    const fakeWindow = {} as Window
    const windowOpenSpy = vi.spyOn(window, 'open').mockImplementation(() => fakeWindow)
    const { openUrl } = await import('@/lib/open-url')

    const result = await openUrl('https://fallback.com')

    expect(windowOpenSpy).toHaveBeenCalledWith(
      'https://fallback.com',
      '_blank',
      'noopener,noreferrer',
    )
    expect(result).toBe(true)
  })

  it('falls back to window.open when the Tauri opener rejects (handle non-null → true)', async () => {
    mockOpen.mockRejectedValueOnce(new Error('opener refused'))
    vi.doMock('@tauri-apps/plugin-opener', () => ({ openUrl: mockOpen }))
    const fakeWindow = {} as Window
    const windowOpenSpy = vi.spyOn(window, 'open').mockImplementation(() => fakeWindow)
    const { openUrl } = await import('@/lib/open-url')

    const result = await openUrl('https://opener-fail.com')

    expect(mockOpen).toHaveBeenCalledWith('https://opener-fail.com')
    expect(windowOpenSpy).toHaveBeenCalledWith(
      'https://opener-fail.com',
      '_blank',
      'noopener,noreferrer',
    )
    expect(result).toBe(true)
  })

  it('resolves false when the Tauri opener rejects AND window.open returns null (popup blocked)', async () => {
    mockOpen.mockRejectedValueOnce(new Error('opener refused'))
    vi.doMock('@tauri-apps/plugin-opener', () => ({ openUrl: mockOpen }))
    const windowOpenSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    const { openUrl } = await import('@/lib/open-url')

    const result = await openUrl('https://blocked.com')

    expect(windowOpenSpy).toHaveBeenCalledWith(
      'https://blocked.com',
      '_blank',
      'noopener,noreferrer',
    )
    expect(result).toBe(false)
  })

  // #2960 — `openUrl` is the single choke point every caller (context menu,
  // long-press "Open link", editor click sinks) funnels through, so it must
  // reject disallowed schemes even if an upstream caller forgot to check.
  it.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,evil',
    'vbscript:msgbox(1)',
  ])(
    'resolves false and never calls the Tauri opener or window.open for a disallowed scheme (%s)',
    async (disallowedUrl) => {
      mockOpen.mockClear()
      vi.doMock('@tauri-apps/plugin-opener', () => ({ openUrl: mockOpen }))
      const windowOpenSpy = vi.spyOn(window, 'open')
      const { openUrl } = await import('@/lib/open-url')

      const result = await openUrl(disallowedUrl)

      expect(result).toBe(false)
      expect(mockOpen).not.toHaveBeenCalled()
      expect(windowOpenSpy).not.toHaveBeenCalled()
    },
  )

  it('still opens an allowed https url after the scheme check', async () => {
    mockOpen.mockResolvedValueOnce(undefined)
    vi.doMock('@tauri-apps/plugin-opener', () => ({ openUrl: mockOpen }))
    const { openUrl } = await import('@/lib/open-url')

    const result = await openUrl('https://example.com')

    expect(mockOpen).toHaveBeenCalledWith('https://example.com')
    expect(result).toBe(true)
  })

  it('never rejects across all three branches', async () => {
    // (1) happy path
    mockOpen.mockResolvedValueOnce(undefined)
    vi.doMock('@tauri-apps/plugin-opener', () => ({ openUrl: mockOpen }))
    let mod = await import('@/lib/open-url')
    await expect(mod.openUrl('https://ok.com')).resolves.not.toThrow()

    // (2) opener rejects, window.open returns handle
    vi.resetModules()
    mockOpen.mockRejectedValueOnce(new Error('boom'))
    vi.doMock('@tauri-apps/plugin-opener', () => ({ openUrl: mockOpen }))
    vi.spyOn(window, 'open').mockImplementation(() => ({}) as Window)
    mod = await import('@/lib/open-url')
    await expect(mod.openUrl('https://retry.com')).resolves.not.toThrow()

    // (3) opener rejects, window.open returns null
    vi.resetModules()
    mockOpen.mockRejectedValueOnce(new Error('boom'))
    vi.doMock('@tauri-apps/plugin-opener', () => ({ openUrl: mockOpen }))
    vi.spyOn(window, 'open').mockImplementation(() => null)
    mod = await import('@/lib/open-url')
    await expect(mod.openUrl('https://blocked.com')).resolves.not.toThrow()
  })
})
