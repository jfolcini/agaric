import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('openUrl', () => {
  const mockOpen = vi.fn()

  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('calls open() from @tauri-apps/plugin-shell when available and resolves true', async () => {
    mockOpen.mockResolvedValueOnce(undefined)
    vi.doMock('@tauri-apps/plugin-shell', () => ({ open: mockOpen }))
    const { openUrl } = await import('../open-url')

    const result = await openUrl('https://example.com')

    expect(mockOpen).toHaveBeenCalledWith('https://example.com')
    expect(result).toBe(true)
  })

  it('falls back to window.open when @tauri-apps/plugin-shell import fails (handle non-null → true)', async () => {
    vi.doMock('@tauri-apps/plugin-shell', () => {
      throw new Error('Module not available')
    })
    const fakeWindow = {} as Window
    const windowOpenSpy = vi.spyOn(window, 'open').mockImplementation(() => fakeWindow)
    const { openUrl } = await import('../open-url')

    const result = await openUrl('https://fallback.com')

    expect(windowOpenSpy).toHaveBeenCalledWith(
      'https://fallback.com',
      '_blank',
      'noopener,noreferrer',
    )
    expect(result).toBe(true)
  })

  it('falls back to window.open when the Tauri shell rejects (handle non-null → true)', async () => {
    mockOpen.mockRejectedValueOnce(new Error('shell refused'))
    vi.doMock('@tauri-apps/plugin-shell', () => ({ open: mockOpen }))
    const fakeWindow = {} as Window
    const windowOpenSpy = vi.spyOn(window, 'open').mockImplementation(() => fakeWindow)
    const { openUrl } = await import('../open-url')

    const result = await openUrl('https://shell-fail.com')

    expect(mockOpen).toHaveBeenCalledWith('https://shell-fail.com')
    expect(windowOpenSpy).toHaveBeenCalledWith(
      'https://shell-fail.com',
      '_blank',
      'noopener,noreferrer',
    )
    expect(result).toBe(true)
  })

  it('resolves false when the Tauri shell rejects AND window.open returns null (popup blocked)', async () => {
    mockOpen.mockRejectedValueOnce(new Error('shell refused'))
    vi.doMock('@tauri-apps/plugin-shell', () => ({ open: mockOpen }))
    const windowOpenSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    const { openUrl } = await import('../open-url')

    const result = await openUrl('https://blocked.com')

    expect(windowOpenSpy).toHaveBeenCalledWith(
      'https://blocked.com',
      '_blank',
      'noopener,noreferrer',
    )
    expect(result).toBe(false)
  })

  it('never rejects across all three branches', async () => {
    // (1) happy path
    mockOpen.mockResolvedValueOnce(undefined)
    vi.doMock('@tauri-apps/plugin-shell', () => ({ open: mockOpen }))
    let mod = await import('../open-url')
    await expect(mod.openUrl('https://ok.com')).resolves.not.toThrow()

    // (2) shell rejects, window.open returns handle
    vi.resetModules()
    mockOpen.mockRejectedValueOnce(new Error('boom'))
    vi.doMock('@tauri-apps/plugin-shell', () => ({ open: mockOpen }))
    vi.spyOn(window, 'open').mockImplementation(() => ({}) as Window)
    mod = await import('../open-url')
    await expect(mod.openUrl('https://retry.com')).resolves.not.toThrow()

    // (3) shell rejects, window.open returns null
    vi.resetModules()
    mockOpen.mockRejectedValueOnce(new Error('boom'))
    vi.doMock('@tauri-apps/plugin-shell', () => ({ open: mockOpen }))
    vi.spyOn(window, 'open').mockImplementation(() => null)
    mod = await import('../open-url')
    await expect(mod.openUrl('https://blocked.com')).resolves.not.toThrow()
  })
})
