// @vitest-environment jsdom
// Spies on `Storage.prototype.{getItem,setItem}` don't intercept under
// happy-dom (its Storage impl bypasses the prototype method). Pin to jsdom,
// matching useLocalStoragePreference.test.tsx / useBlockCollapse.test.ts.

/**
 * Tests for the preferences registry (`src/lib/preferences.ts`): the pure
 * `effectiveKey` / `readPreference` / `writePreference` helpers and the
 * `usePreference` hook. Reset conventions mirror
 * `hooks/__tests__/usePageBrowserDensity.test.ts` (localStorage.clear).
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { logger } from '../logger'
import {
  type PreferenceDefinition,
  effectiveKey,
  readPreference,
  usePreference,
  writePreference,
} from '../preferences'

type Flavor = 'a' | 'b' | 'c'
const ALL: ReadonlyArray<Flavor> = ['a', 'b', 'c']

function parseFlavor(raw: string): Flavor {
  if ((ALL as readonly string[]).includes(raw)) return raw as Flavor
  throw new Error(`invalid flavor: ${raw}`)
}

const DEVICE_DEF: PreferenceDefinition<Flavor> = {
  key: 'test-flavor',
  scope: 'device',
  version: 1,
  defaultValue: 'a',
  parse: parseFlavor,
  serialize: (v) => v,
}

const SPACE_DEF: PreferenceDefinition<Flavor> = {
  key: 'test-space-flavor',
  scope: 'space',
  version: 1,
  defaultValue: 'a',
  parse: parseFlavor,
  serialize: (v) => v,
}

// Legacy raw values `x`/`y` migrate to `b`; `drop` discards → default.
const MIGRATE_DEF: PreferenceDefinition<Flavor> = {
  key: 'test-migrate-flavor',
  scope: 'device',
  version: 2,
  defaultValue: 'a',
  parse: parseFlavor,
  serialize: (v) => v,
  migrate: (raw) => {
    if (raw === 'x' || raw === 'y') return 'b'
    if (raw === 'drop') return null
    return raw
  },
}

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('effectiveKey', () => {
  it('device scope returns the bare key', () => {
    expect(effectiveKey(DEVICE_DEF)).toBe('test-flavor')
    // spaceId is ignored for device scope.
    expect(effectiveKey(DEVICE_DEF, 'space-123')).toBe('test-flavor')
  })

  it('space scope returns `${key}:${spaceId}`', () => {
    expect(effectiveKey(SPACE_DEF, 'space-123')).toBe('test-space-flavor:space-123')
  })

  it('space scope without spaceId warns and falls back to the bare key', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    expect(effectiveKey(SPACE_DEF)).toBe('test-space-flavor')
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('readPreference / writePreference', () => {
  it('round-trips a device-scoped value', () => {
    writePreference(DEVICE_DEF, 'c')
    expect(localStorage.getItem('test-flavor')).toBe('c')
    expect(readPreference(DEVICE_DEF)).toBe('c')
  })

  it('returns the default when nothing is stored', () => {
    expect(readPreference(DEVICE_DEF)).toBe('a')
  })

  it('round-trips a space-scoped value under the namespaced key', () => {
    writePreference(SPACE_DEF, 'b', 'space-xyz')
    expect(localStorage.getItem('test-space-flavor:space-xyz')).toBe('b')
    expect(readPreference(SPACE_DEF, 'space-xyz')).toBe('b')
    // A different space does not see it.
    expect(readPreference(SPACE_DEF, 'other-space')).toBe('a')
  })

  it('falls back to default on an invalid stored value', () => {
    localStorage.setItem('test-flavor', 'not-a-flavor')
    expect(readPreference(DEVICE_DEF)).toBe('a')
  })

  it('runs migrate on read and transforms a legacy raw value', () => {
    localStorage.setItem('test-migrate-flavor', 'x')
    expect(readPreference(MIGRATE_DEF)).toBe('b')
  })

  it('runs migrate on read and discards (→ default) when migrate returns null', () => {
    localStorage.setItem('test-migrate-flavor', 'drop')
    expect(readPreference(MIGRATE_DEF)).toBe('a')
  })

  it('swallows a write throw and warns', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    expect(() => writePreference(DEVICE_DEF, 'c')).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    setItem.mockRestore()
  })

  it('swallows a read throw and warns', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(readPreference(DEVICE_DEF)).toBe('a')
    expect(warn).toHaveBeenCalledTimes(1)
    getItem.mockRestore()
  })
})

describe('usePreference', () => {
  it('defaults when nothing is stored', () => {
    const { result } = renderHook(() => usePreference(DEVICE_DEF))
    expect(result.current[0]).toBe('a')
  })

  it('reads a persisted bare value on mount', () => {
    localStorage.setItem('test-flavor', 'c')
    const { result } = renderHook(() => usePreference(DEVICE_DEF))
    expect(result.current[0]).toBe('c')
  })

  it('persists updates as a bare string', () => {
    const { result } = renderHook(() => usePreference(DEVICE_DEF))
    act(() => result.current[1]('b'))
    expect(result.current[0]).toBe('b')
    expect(localStorage.getItem('test-flavor')).toBe('b')
  })

  it('applies migrate on the initial read', () => {
    localStorage.setItem('test-migrate-flavor', 'y')
    const { result } = renderHook(() => usePreference(MIGRATE_DEF))
    expect(result.current[0]).toBe('b')
  })

  it('falls back to default on an invalid stored value', () => {
    localStorage.setItem('test-flavor', 'zzz')
    const { result } = renderHook(() => usePreference(DEVICE_DEF))
    expect(result.current[0]).toBe('a')
  })

  it('persists across remount', () => {
    const first = renderHook(() => usePreference(DEVICE_DEF))
    act(() => first.result.current[1]('c'))
    first.unmount()

    const second = renderHook(() => usePreference(DEVICE_DEF))
    expect(second.result.current[0]).toBe('c')
  })

  it('namespaces a space-scoped preference by spaceId', () => {
    const { result } = renderHook(() => usePreference(SPACE_DEF, 'space-42'))
    act(() => result.current[1]('b'))
    expect(localStorage.getItem('test-space-flavor:space-42')).toBe('b')
  })
})
