import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('relaunchApp', () => {
  const mockRelaunch = vi.fn()
  const originalLocation = window.location

  beforeEach(() => {
    vi.resetModules()
    mockRelaunch.mockReset()
  })

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation,
    })
    vi.restoreAllMocks()
  })

  it('calls relaunch() from @tauri-apps/plugin-process when available', async () => {
    vi.doMock('@tauri-apps/plugin-process', () => ({ relaunch: mockRelaunch }))
    mockRelaunch.mockResolvedValueOnce(undefined)
    const { relaunchApp } = await import('../relaunch-app')

    await relaunchApp()

    expect(mockRelaunch).toHaveBeenCalledTimes(1)
  })

  it('falls back to window.location.reload when plugin import fails', async () => {
    vi.doMock('@tauri-apps/plugin-process', () => {
      throw new Error('Module not available')
    })
    const reloadMock = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: reloadMock },
      writable: true,
    })
    vi.doMock('@/lib/logger', () => ({
      logger: { warn: vi.fn(), error: vi.fn() },
    }))
    const { relaunchApp } = await import('../relaunch-app')

    await relaunchApp()

    expect(reloadMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to window.location.reload when relaunch() rejects', async () => {
    vi.doMock('@tauri-apps/plugin-process', () => ({ relaunch: mockRelaunch }))
    mockRelaunch.mockRejectedValueOnce(new Error('IPC failure'))
    const reloadMock = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: reloadMock },
      writable: true,
    })
    vi.doMock('@/lib/logger', () => ({
      logger: { warn: vi.fn(), error: vi.fn() },
    }))
    const { relaunchApp } = await import('../relaunch-app')

    await relaunchApp()

    expect(mockRelaunch).toHaveBeenCalledTimes(1)
    expect(reloadMock).toHaveBeenCalledTimes(1)
  })
})
