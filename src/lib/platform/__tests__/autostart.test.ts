import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Autostart
// ---------------------------------------------------------------------------
//
// `enableAutostart`, `disableAutostart`, and `isAutostartEnabled` thin-wrap
// `@tauri-apps/plugin-autostart`'s three exports.  Unlike the rest of the
// `tauri.ts` wrappers (which call `invoke()` directly), these use a dynamic
// `import('@tauri-apps/plugin-autostart')` so the tests follow the
// `clipboard.test.ts` / `relaunch-app.test.ts` pattern: `vi.doMock(...)`
// before re-importing the wrappers via `vi.resetModules()`.

describe('autostart wrappers', () => {
  const mockEnable = vi.fn()
  const mockDisable = vi.fn()
  const mockIsEnabled = vi.fn()

  beforeEach(() => {
    vi.resetModules()
    mockEnable.mockReset()
    mockDisable.mockReset()
    mockIsEnabled.mockReset()
  })

  describe('isAutostartEnabled', () => {
    it('returns the boolean from the plugin when available', async () => {
      vi.doMock('@tauri-apps/plugin-autostart', () => ({
        isEnabled: mockIsEnabled,
        enable: mockEnable,
        disable: mockDisable,
      }))
      mockIsEnabled.mockResolvedValueOnce(true)

      const { isAutostartEnabled } = await import('@/lib/platform/autostart')
      const result = await isAutostartEnabled()

      expect(mockIsEnabled).toHaveBeenCalledOnce()
      expect(result).toBe(true)
    })

    it('returns false when the plugin reports disabled', async () => {
      vi.doMock('@tauri-apps/plugin-autostart', () => ({
        isEnabled: mockIsEnabled,
        enable: mockEnable,
        disable: mockDisable,
      }))
      mockIsEnabled.mockResolvedValueOnce(false)

      const { isAutostartEnabled } = await import('@/lib/platform/autostart')
      const result = await isAutostartEnabled()

      expect(result).toBe(false)
    })

    it('propagates rejections so callers can detect plugin unavailability', async () => {
      vi.doMock('@tauri-apps/plugin-autostart', () => ({
        isEnabled: mockIsEnabled,
        enable: mockEnable,
        disable: mockDisable,
      }))
      mockIsEnabled.mockRejectedValueOnce(new Error('plugin not registered'))

      const { isAutostartEnabled } = await import('@/lib/platform/autostart')

      await expect(isAutostartEnabled()).rejects.toThrow('plugin not registered')
    })
  })

  describe('enableAutostart', () => {
    it('calls enable() from the plugin and resolves on success', async () => {
      vi.doMock('@tauri-apps/plugin-autostart', () => ({
        isEnabled: mockIsEnabled,
        enable: mockEnable,
        disable: mockDisable,
      }))
      mockEnable.mockResolvedValueOnce(undefined)

      const { enableAutostart } = await import('@/lib/platform/autostart')
      await enableAutostart()

      expect(mockEnable).toHaveBeenCalledOnce()
      expect(mockDisable).not.toHaveBeenCalled()
      expect(mockIsEnabled).not.toHaveBeenCalled()
    })

    it('propagates the rejection when enable() fails (caller surfaces toast)', async () => {
      vi.doMock('@tauri-apps/plugin-autostart', () => ({
        isEnabled: mockIsEnabled,
        enable: mockEnable,
        disable: mockDisable,
      }))
      vi.doMock('@/lib/logger', () => ({
        logger: { warn: vi.fn(), error: vi.fn() },
      }))
      mockEnable.mockRejectedValueOnce(new Error('IPC denied'))

      const { enableAutostart } = await import('@/lib/platform/autostart')

      await expect(enableAutostart()).rejects.toThrow('IPC denied')
      expect(mockEnable).toHaveBeenCalledOnce()
    })
  })

  describe('disableAutostart', () => {
    it('calls disable() from the plugin and resolves on success', async () => {
      vi.doMock('@tauri-apps/plugin-autostart', () => ({
        isEnabled: mockIsEnabled,
        enable: mockEnable,
        disable: mockDisable,
      }))
      mockDisable.mockResolvedValueOnce(undefined)

      const { disableAutostart } = await import('@/lib/platform/autostart')
      await disableAutostart()

      expect(mockDisable).toHaveBeenCalledOnce()
      expect(mockEnable).not.toHaveBeenCalled()
      expect(mockIsEnabled).not.toHaveBeenCalled()
    })

    it('propagates the rejection when disable() fails', async () => {
      vi.doMock('@tauri-apps/plugin-autostart', () => ({
        isEnabled: mockIsEnabled,
        enable: mockEnable,
        disable: mockDisable,
      }))
      vi.doMock('@/lib/logger', () => ({
        logger: { warn: vi.fn(), error: vi.fn() },
      }))
      mockDisable.mockRejectedValueOnce(new Error('plugin unavailable'))

      const { disableAutostart } = await import('@/lib/platform/autostart')

      await expect(disableAutostart()).rejects.toThrow('plugin unavailable')
      expect(mockDisable).toHaveBeenCalledOnce()
    })
  })
})
