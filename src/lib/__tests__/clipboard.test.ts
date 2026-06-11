import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('writeText', () => {
  const mockPluginWriteText = vi.fn()

  beforeEach(() => {
    vi.resetModules()
    mockPluginWriteText.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('calls writeText() from @tauri-apps/plugin-clipboard-manager when available', async () => {
    vi.doMock('@tauri-apps/plugin-clipboard-manager', () => ({
      writeText: mockPluginWriteText,
    }))
    mockPluginWriteText.mockResolvedValueOnce(undefined)
    const { writeText } = await import('../clipboard')

    await writeText('hello world')

    expect(mockPluginWriteText).toHaveBeenCalledWith('hello world')
  })

  it('falls back to navigator.clipboard.writeText when plugin import fails', async () => {
    vi.doMock('@tauri-apps/plugin-clipboard-manager', () => {
      throw new Error('Module not available')
    })
    vi.doMock('@/lib/logger', () => ({
      logger: { warn: vi.fn(), error: vi.fn() },
    }))
    const navigatorWriteText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: navigatorWriteText },
    })
    const { writeText } = await import('../clipboard')

    await writeText('fallback text')

    expect(navigatorWriteText).toHaveBeenCalledWith('fallback text')
  })

  it('falls back to navigator.clipboard.writeText when plugin writeText rejects', async () => {
    vi.doMock('@tauri-apps/plugin-clipboard-manager', () => ({
      writeText: mockPluginWriteText,
    }))
    mockPluginWriteText.mockRejectedValueOnce(new Error('IPC failure'))
    vi.doMock('@/lib/logger', () => ({
      logger: { warn: vi.fn(), error: vi.fn() },
    }))
    const navigatorWriteText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: navigatorWriteText },
    })
    const { writeText } = await import('../clipboard')

    await writeText('fallback after reject')

    expect(mockPluginWriteText).toHaveBeenCalledWith('fallback after reject')
    expect(navigatorWriteText).toHaveBeenCalledWith('fallback after reject')
  })

  it('propagates the navigator rejection when both paths fail (graceful degradation)', async () => {
    vi.doMock('@tauri-apps/plugin-clipboard-manager', () => {
      throw new Error('Module not available')
    })
    vi.doMock('@/lib/logger', () => ({
      logger: { warn: vi.fn(), error: vi.fn() },
    }))
    const navigatorWriteText = vi.fn().mockRejectedValue(new Error('clipboard blocked'))
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: navigatorWriteText },
    })
    const { writeText } = await import('../clipboard')

    // Wrapper does not silently swallow the failure — the caller's
    // existing try/catch + toast UI must see the rejection.
    await expect(writeText('both fail')).rejects.toThrow('clipboard blocked')
    expect(navigatorWriteText).toHaveBeenCalledWith('both fail')
  })
})

describe('readText', () => {
  const mockPluginReadText = vi.fn()

  beforeEach(() => {
    vi.resetModules()
    mockPluginReadText.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('calls readText() from @tauri-apps/plugin-clipboard-manager when available', async () => {
    vi.doMock('@tauri-apps/plugin-clipboard-manager', () => ({
      readText: mockPluginReadText,
    }))
    mockPluginReadText.mockResolvedValueOnce('clipboard contents')
    const { readText } = await import('../clipboard')

    await expect(readText()).resolves.toBe('clipboard contents')
    expect(mockPluginReadText).toHaveBeenCalled()
  })

  it('falls back to navigator.clipboard.readText when the plugin import fails', async () => {
    vi.doMock('@tauri-apps/plugin-clipboard-manager', () => {
      throw new Error('Module not available')
    })
    vi.doMock('@/lib/logger', () => ({
      logger: { warn: vi.fn(), error: vi.fn() },
    }))
    const navigatorReadText = vi.fn().mockResolvedValue('from navigator')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: navigatorReadText },
    })
    const { readText } = await import('../clipboard')

    await expect(readText()).resolves.toBe('from navigator')
    expect(navigatorReadText).toHaveBeenCalled()
  })

  it('propagates the navigator rejection when both paths fail', async () => {
    vi.doMock('@tauri-apps/plugin-clipboard-manager', () => {
      throw new Error('Module not available')
    })
    vi.doMock('@/lib/logger', () => ({
      logger: { warn: vi.fn(), error: vi.fn() },
    }))
    const navigatorReadText = vi.fn().mockRejectedValue(new Error('clipboard blocked'))
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: navigatorReadText },
    })
    const { readText } = await import('../clipboard')

    await expect(readText()).rejects.toThrow('clipboard blocked')
    expect(navigatorReadText).toHaveBeenCalled()
  })
})
