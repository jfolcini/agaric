/**
 * Tests for src/lib/guarded-storage.ts — the notify-free leaf that guards
 * `localStorage` access for zustand's `persist` middleware (#2925).
 *
 * `guardedPersistStorage` is used by stores that cannot import `notify`
 * without closing an import cycle (e.g. `useDebugStore`, which `error-display`
 * reads `getDebugMode` from). It must still swallow + log a `setItem` throw,
 * but — unlike `safePersistStorage` — must NOT reach into `notify`.
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

import { createGuardedStorage, guardedPersistStorage } from '@/lib/guarded-storage'
import { logger } from '@/lib/logger'

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

describe('guardedPersistStorage', () => {
  let mockStorage: ReturnType<typeof makeMockStorage>

  beforeEach(() => {
    vi.clearAllMocks()
    mockStorage = makeMockStorage()
    vi.stubGlobal('localStorage', mockStorage)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('setItem swallows a thrown QuotaExceededError and logs, without notifying', () => {
    mockStorage.setItem.mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    })

    expect(() => {
      guardedPersistStorage?.setItem('agaric:debug', { state: { debugMode: true }, version: 1 })
    }).not.toThrow()
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('agaric:debug'),
      undefined,
      expect.any(DOMException),
    )
  })

  it('setItem writes through to localStorage on success', () => {
    guardedPersistStorage?.setItem('agaric:debug', { state: { debugMode: true }, version: 1 })

    expect(mockStorage.backing.get('agaric:debug')).toBe(
      JSON.stringify({ state: { debugMode: true }, version: 1 }),
    )
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('getItem returns null and logs instead of throwing when localStorage.getItem fails', () => {
    mockStorage.getItem.mockImplementation(() => {
      throw new DOMException('boom', 'SecurityError')
    })

    let result: unknown
    expect(() => {
      result = guardedPersistStorage?.getItem('agaric:debug')
    }).not.toThrow()
    expect(result).toBeNull()
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('createGuardedStorage invokes the onWriteError callback after logging a setItem failure', () => {
    const onWriteError = vi.fn()
    const storage = createGuardedStorage(onWriteError)
    mockStorage.setItem.mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    })

    storage?.setItem('agaric:tabs', { state: { tabs: [] }, version: 1 })

    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(onWriteError).toHaveBeenCalledTimes(1)
    expect(onWriteError).toHaveBeenCalledWith(expect.any(DOMException), 'agaric:tabs')
  })
})
