/**
 * Tests for src/lib/safe-persist-storage.ts — guarded localStorage backing
 * for Zustand's `persist` middleware (#2925).
 *
 * zustand calls `setItem()` synchronously after every `set()`; the default
 * JSON storage leaves that call unguarded, so a write-time failure (e.g.
 * `QuotaExceededError`) throws straight out of the triggering store action.
 * These tests pin the guard: `setItem` must swallow the throw, log it, and
 * surface exactly one deduped `notify.warning` across repeated failures.
 *
 * The real global `localStorage` is stubbed per-test via `vi.stubGlobal`
 * (rather than `vi.spyOn(Storage.prototype, ...)`) so behaviour doesn't
 * depend on how the happy-dom `Storage` class exposes its methods.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@/lib/notify', () => ({
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

import { i18n } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { PERSIST_WRITE_FAILED_TOAST_ID, safePersistStorage } from '@/lib/safe-persist-storage'

/** Minimal in-memory `Storage`-shaped mock so tests control failure per-call. */
function makeMockStorage() {
  const backing = new Map<string, string>()
  return {
    getItem: vi.fn((key: string) => backing.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      backing.set(key, value)
    }),
    removeItem: vi.fn((key: string) => {
      backing.delete(key)
    }),
    backing,
  }
}

describe('safePersistStorage', () => {
  let mockStorage: ReturnType<typeof makeMockStorage>

  beforeEach(() => {
    vi.clearAllMocks()
    mockStorage = makeMockStorage()
    vi.stubGlobal('localStorage', mockStorage)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('setItem swallows a thrown QuotaExceededError instead of re-throwing', () => {
    mockStorage.setItem.mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    })

    expect(() => {
      safePersistStorage?.setItem('agaric:tabs', { state: { tabs: [] }, version: 1 })
    }).not.toThrow()
  })

  it('logs a warning via the shared logger on setItem failure', () => {
    mockStorage.setItem.mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    })

    safePersistStorage?.setItem('agaric:tabs', { state: { tabs: [] }, version: 1 })

    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('agaric:tabs'),
      undefined,
      expect.any(DOMException),
    )
  })

  it('fires exactly one deduped notify.warning across repeated failures', () => {
    mockStorage.setItem.mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    })

    // Simulate a multi-store action chain: several stores' setItem calls
    // fail in the same burst (e.g. navigateToPage touching recent-pages,
    // tabs, and navigation). Every call gets logged...
    safePersistStorage?.setItem('agaric:tabs', { state: { tabs: [] }, version: 1 })
    safePersistStorage?.setItem('agaric:navigation', {
      state: { currentView: 'pages' },
      version: 3,
    })
    safePersistStorage?.setItem('agaric:recent-pages', { state: { recentPages: [] }, version: 1 })

    expect(logger.warn).toHaveBeenCalledTimes(3)
    // ...but every notify.warning call shares the same fixed `id` — sonner's
    // own dedup-by-id collapses these into a single visible toast,
    // regardless of how many stores fail to persist in the same tick.
    expect(notify.warning).toHaveBeenCalledTimes(3)
    const calls = vi.mocked(notify.warning).mock.calls
    for (const call of calls) {
      expect(call[1]).toEqual({ id: PERSIST_WRITE_FAILED_TOAST_ID })
    }
    expect(notify.warning).toHaveBeenCalledWith(
      i18n.t('error.settingsSaveFailed'),
      expect.objectContaining({ id: PERSIST_WRITE_FAILED_TOAST_ID }),
    )
  })

  it('setItem writes through to localStorage on success (no warning, no notify)', () => {
    safePersistStorage?.setItem('agaric:tabs', { state: { tabs: [] }, version: 1 })

    expect(mockStorage.backing.get('agaric:tabs')).toBe(
      JSON.stringify({ state: { tabs: [] }, version: 1 }),
    )
    expect(logger.warn).not.toHaveBeenCalled()
    expect(notify.warning).not.toHaveBeenCalled()
  })

  it('getItem returns null and logs instead of throwing when localStorage.getItem fails', () => {
    mockStorage.getItem.mockImplementation(() => {
      throw new DOMException('boom', 'SecurityError')
    })

    let result: unknown
    expect(() => {
      result = safePersistStorage?.getItem('agaric:tabs')
    }).not.toThrow()
    expect(result).toBeNull()
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })
})
