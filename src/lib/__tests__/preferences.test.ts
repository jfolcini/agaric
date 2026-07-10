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
  hasPreference,
  PREFERENCES,
  readPreference,
  removePreference,
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

const PAGE_DEF: PreferenceDefinition<Flavor> = {
  key: 'test-page-flavor',
  scope: 'page',
  version: 1,
  defaultValue: 'a',
  parse: parseFlavor,
  serialize: (v) => v,
}

const ARR_DEF: PreferenceDefinition<string[]> = {
  key: 'test-arr',
  scope: 'device',
  version: 1,
  defaultValue: [],
  parse: (raw) => JSON.parse(raw) as string[],
  serialize: (value) => JSON.stringify(value),
}

const OBJ_DEF: PreferenceDefinition<Record<string, string>> = {
  key: 'test-obj',
  scope: 'device',
  version: 1,
  defaultValue: {},
  parse: (raw) => JSON.parse(raw) as Record<string, string>,
  serialize: (value) => JSON.stringify(value),
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

describe('page scope', () => {
  it('effectiveKey returns `${key}:${pageKey}`, same computation as space scope', () => {
    expect(effectiveKey(PAGE_DEF, 'page-123')).toBe('test-page-flavor:page-123')
  })

  it('page scope without a pageKey warns and falls back to the bare key', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    expect(effectiveKey(PAGE_DEF)).toBe('test-page-flavor')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('round-trips a page-scoped value under the namespaced key, partitioned per page', () => {
    writePreference(PAGE_DEF, 'b', 'page-a')
    writePreference(PAGE_DEF, 'c', 'page-b')
    expect(localStorage.getItem('test-page-flavor:page-a')).toBe('b')
    expect(readPreference(PAGE_DEF, 'page-a')).toBe('b')
    expect(readPreference(PAGE_DEF, 'page-b')).toBe('c')
    // A different page does not see it.
    expect(readPreference(PAGE_DEF, 'page-c')).toBe('a')
  })
})

describe('mutation safety (cloneDefault)', () => {
  it('does not let a caller mutate the shared default in place across calls (array default)', () => {
    const first = readPreference(ARR_DEF)
    first.push('mutated')
    expect(readPreference(ARR_DEF)).toEqual([])
  })

  it('does not let a caller mutate the shared default in place across calls (object default)', () => {
    const first = readPreference(OBJ_DEF)
    first['x'] = 'mutated'
    expect(readPreference(OBJ_DEF)).toEqual({})
  })
})

describe('hasPreference', () => {
  it('is false when the key was never stored', () => {
    expect(hasPreference(DEVICE_DEF)).toBe(false)
  })

  it('is true once written, even when the value equals the default', () => {
    writePreference(DEVICE_DEF, 'a')
    expect(hasPreference(DEVICE_DEF)).toBe(true)
  })

  it('is true even when the stored value fails to parse (distinct from readPreference)', () => {
    localStorage.setItem('test-flavor', 'not-a-flavor')
    expect(hasPreference(DEVICE_DEF)).toBe(true)
    expect(readPreference(DEVICE_DEF)).toBe('a')
  })

  it('distinguishes "never stored" from "stored empty" for a keyed (space/page) preference', () => {
    expect(hasPreference(SPACE_DEF, 'space-a')).toBe(false)
    writePreference(SPACE_DEF, 'a', 'space-a')
    expect(hasPreference(SPACE_DEF, 'space-a')).toBe(true)
    expect(hasPreference(SPACE_DEF, 'space-b')).toBe(false)
  })

  it('a read error degrades to false instead of throwing', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(() => hasPreference(DEVICE_DEF)).not.toThrow()
    expect(hasPreference(DEVICE_DEF)).toBe(false)
    expect(warn).toHaveBeenCalled()
    getItem.mockRestore()
  })
})

describe('removePreference', () => {
  it('clears a device-scoped stored value so a later read returns the default', () => {
    writePreference(DEVICE_DEF, 'c')
    removePreference(DEVICE_DEF)
    expect(localStorage.getItem('test-flavor')).toBeNull()
    expect(readPreference(DEVICE_DEF)).toBe('a')
  })

  it('clears only the targeted key/spaceId pair for a keyed preference', () => {
    writePreference(SPACE_DEF, 'b', 'space-a')
    writePreference(SPACE_DEF, 'c', 'space-b')
    removePreference(SPACE_DEF, 'space-a')
    expect(readPreference(SPACE_DEF, 'space-a')).toBe('a')
    expect(readPreference(SPACE_DEF, 'space-b')).toBe('c')
  })

  it('a write-side error is swallowed instead of throwing', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    expect(() => removePreference(DEVICE_DEF)).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    removeItem.mockRestore()
  })
})

describe('representative real preferences (#2466 migration)', () => {
  it('starredPages defaults to an empty array and drops non-string entries', () => {
    expect(readPreference(PREFERENCES.starredPages)).toEqual([])
    localStorage.setItem(PREFERENCES.starredPages.key, JSON.stringify(['P1', 42, null, 'P2']))
    expect(readPreference(PREFERENCES.starredPages)).toEqual(['P1', 'P2'])
  })

  it('blockCollapse (page-scoped) and blockCollapseLegacy (device-scoped) never collide despite sharing a base key', () => {
    writePreference(PREFERENCES.blockCollapse, ['b1'], 'page-1')
    writePreference(PREFERENCES.blockCollapseLegacy, ['legacy-1'])
    expect(localStorage.getItem('collapsed_ids:page-1')).toBe('["b1"]')
    expect(localStorage.getItem('collapsed_ids')).toBe('["legacy-1"]')
    expect(readPreference(PREFERENCES.blockCollapse, 'page-1')).toEqual(['b1'])
    expect(readPreference(PREFERENCES.blockCollapseLegacy)).toEqual(['legacy-1'])
  })

  it('recentCommandsPalette and recentCommandsSlash partition by distinct key prefixes for the same space', () => {
    const entry = { id: 'go-settings', runAt: '2026-01-01T00:00:00.000Z' }
    writePreference(PREFERENCES.recentCommandsPalette, [entry], 'space-1')
    expect(readPreference(PREFERENCES.recentCommandsSlash, 'space-1')).toEqual([])
    expect(readPreference(PREFERENCES.recentCommandsPalette, 'space-1')).toEqual([entry])
    expect(localStorage.getItem('recent_commands:space-1')).toBe(JSON.stringify([entry]))
  })

  it('pathHistory and recentSearches are space-keyed under their pre-registry key shapes', () => {
    writePreference(PREFERENCES.pathHistory, ['*.md'], 'space-1')
    writePreference(PREFERENCES.recentSearches, ['todo'], 'space-1')
    expect(localStorage.getItem('agaric:pathHistory:v1:space-1')).toBe('["*.md"]')
    expect(localStorage.getItem('recent_searches:space-1')).toBe('["todo"]')
  })
})
