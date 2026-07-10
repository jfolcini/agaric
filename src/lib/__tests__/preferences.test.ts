/**
 * Tests for the typed preferences registry (#2466).
 *
 * Validates:
 *  - round-trip get/set for a static PrefDef
 *  - default fallback when the key is absent
 *  - default fallback when the stored value is corrupt / fails to parse
 *  - removePref clears the stored value
 *  - keyed families (getKeyedPref/setKeyedPref/removeKeyedPref) partition
 *    correctly by argument and don't collide
 *  - a read/write error (localStorage throwing) degrades to the default /
 *    is swallowed, never thrown
 *  - PREF_CATALOG has no duplicate keys and every 'migrated' entry has a
 *    matching PREFS definition with the same key
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getKeyedPref,
  getPref,
  hasKeyedPref,
  hasPref,
  type PrefDef,
  type PrefFamily,
  PREF_CATALOG,
  PREFS,
  removeKeyedPref,
  removePref,
  setKeyedPref,
  setPref,
} from '../preferences'

const testPref: PrefDef<{ n: number }> = {
  key: 'test:pref:v1',
  version: 1,
  scope: 'device',
  defaultValue: { n: 0 },
  parse: (raw) => JSON.parse(raw) as { n: number },
  serialize: (value) => JSON.stringify(value),
  source: 'preferences.test',
}

const testFamily: PrefFamily<string[], [scope: string]> = {
  keyFor: (scope) => `test:family:${scope}`,
  version: 1,
  scope: 'device',
  defaultValue: [],
  parse: (raw) => JSON.parse(raw) as string[],
  serialize: (value) => JSON.stringify(value),
  source: 'preferences.test',
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('getPref / setPref', () => {
  it('returns the default when the key is absent', () => {
    expect(getPref(testPref)).toEqual({ n: 0 })
  })

  it('round-trips a value written by setPref', () => {
    setPref(testPref, { n: 42 })
    expect(getPref(testPref)).toEqual({ n: 42 })
  })

  it('writes the exact serialized wire format', () => {
    setPref(testPref, { n: 7 })
    expect(localStorage.getItem('test:pref:v1')).toBe('{"n":7}')
  })

  it('falls back to the default on corrupt (unparseable) JSON', () => {
    localStorage.setItem('test:pref:v1', 'not-json{{{')
    expect(getPref(testPref)).toEqual({ n: 0 })
  })

  it('falls back to the default when parse throws for a valid-but-rejected shape', () => {
    const enumPref: PrefDef<'a' | 'b'> = {
      key: 'test:enum:v1',
      version: 1,
      scope: 'device',
      defaultValue: 'a',
      parse: (raw) => {
        if (raw === 'a' || raw === 'b') return raw
        throw new Error('invalid')
      },
      serialize: (v) => v,
    }
    localStorage.setItem('test:enum:v1', 'z')
    expect(getPref(enumPref)).toBe('a')
  })

  it('does not let a caller mutate the shared default in place across calls (array default)', () => {
    const arrPref: PrefDef<string[]> = {
      key: 'test:arr:v1',
      version: 1,
      scope: 'device',
      defaultValue: [],
      parse: (raw) => JSON.parse(raw) as string[],
      serialize: (value) => JSON.stringify(value),
    }
    const first = getPref(arrPref)
    first.push('mutated')
    expect(getPref(arrPref)).toEqual([])
  })

  it('does not let a caller mutate the shared default in place across calls (object default)', () => {
    const objPref: PrefDef<Record<string, string>> = {
      key: 'test:obj:v1',
      version: 1,
      scope: 'device',
      defaultValue: {},
      parse: (raw) => JSON.parse(raw) as Record<string, string>,
      serialize: (value) => JSON.stringify(value),
    }
    const first = getPref(objPref)
    first['x'] = 'mutated'
    expect(getPref(objPref)).toEqual({})
  })

  it('removePref clears the stored value so a later read returns the default', () => {
    setPref(testPref, { n: 5 })
    removePref(testPref)
    expect(localStorage.getItem('test:pref:v1')).toBeNull()
    expect(getPref(testPref)).toEqual({ n: 0 })
  })

  it('a read error degrades to the default instead of throwing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    expect(() => getPref(testPref)).not.toThrow()
    expect(getPref(testPref)).toEqual({ n: 0 })
  })

  it('a write error is swallowed instead of throwing', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError')
    })
    expect(() => setPref(testPref, { n: 1 })).not.toThrow()
  })
})

describe('hasPref', () => {
  it('is false when the key was never stored', () => {
    expect(hasPref(testPref)).toBe(false)
  })

  it('is true once written, even when the value equals the default', () => {
    setPref(testPref, { n: 0 })
    expect(hasPref(testPref)).toBe(true)
  })

  it('is true even when the stored value fails to parse (distinct from getPref)', () => {
    localStorage.setItem('test:pref:v1', 'not-json{{{')
    expect(hasPref(testPref)).toBe(true)
    expect(getPref(testPref)).toEqual({ n: 0 })
  })

  it('is false again after removePref', () => {
    setPref(testPref, { n: 1 })
    removePref(testPref)
    expect(hasPref(testPref)).toBe(false)
  })
})

describe('getKeyedPref / setKeyedPref / removeKeyedPref', () => {
  it('returns the default for an unseen argument', () => {
    expect(getKeyedPref(testFamily, 'space-a')).toEqual([])
  })

  it('round-trips per-argument and does not collide across arguments', () => {
    setKeyedPref(testFamily, ['x'], 'space-a')
    setKeyedPref(testFamily, ['y', 'z'], 'space-b')
    expect(getKeyedPref(testFamily, 'space-a')).toEqual(['x'])
    expect(getKeyedPref(testFamily, 'space-b')).toEqual(['y', 'z'])
  })

  it('writes under the key produced by keyFor', () => {
    setKeyedPref(testFamily, ['x'], 'space-a')
    expect(localStorage.getItem('test:family:space-a')).toBe('["x"]')
  })

  it('falls back to the default on corrupt stored data for one argument only', () => {
    localStorage.setItem('test:family:space-a', 'not-json')
    setKeyedPref(testFamily, ['ok'], 'space-b')
    expect(getKeyedPref(testFamily, 'space-a')).toEqual([])
    expect(getKeyedPref(testFamily, 'space-b')).toEqual(['ok'])
  })

  it('removeKeyedPref clears only the targeted argument', () => {
    setKeyedPref(testFamily, ['x'], 'space-a')
    setKeyedPref(testFamily, ['y'], 'space-b')
    removeKeyedPref(testFamily, 'space-a')
    expect(getKeyedPref(testFamily, 'space-a')).toEqual([])
    expect(getKeyedPref(testFamily, 'space-b')).toEqual(['y'])
  })

  it('hasKeyedPref distinguishes "never stored" from "stored empty" per argument', () => {
    expect(hasKeyedPref(testFamily, 'space-a')).toBe(false)
    setKeyedPref(testFamily, [], 'space-a')
    expect(hasKeyedPref(testFamily, 'space-a')).toBe(true)
    expect(getKeyedPref(testFamily, 'space-a')).toEqual([])
    expect(hasKeyedPref(testFamily, 'space-b')).toBe(false)
  })
})

describe('PREF_CATALOG', () => {
  it('has no duplicate keys', () => {
    const keys = PREF_CATALOG.map((e) => e.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('every migrated catalog entry with a plain (non-templated) key has a matching PREFS definition', () => {
    const prefKeys = new Set(
      Object.values(PREFS)
        .map((def) => ('key' in def ? def.key : null))
        .filter((k): k is string => k !== null),
    )
    for (const entry of PREF_CATALOG) {
      if (entry.status !== 'migrated') continue
      if (entry.key.includes('<')) continue // keyed family — documented via notes, not a literal key
      expect(prefKeys.has(entry.key)).toBe(true)
    }
  })

  it('documents at least one entry per migrated PREFS definition', () => {
    const catalogKeys = new Set(PREF_CATALOG.map((e) => e.key))
    for (const def of Object.values(PREFS)) {
      if ('key' in def) {
        expect(catalogKeys.has(def.key)).toBe(true)
      }
    }
  })
})

describe('a representative real preference (starredPages)', () => {
  it('defaults to an empty array', () => {
    expect(getPref(PREFS.starredPages)).toEqual([])
  })

  it('round-trips', () => {
    setPref(PREFS.starredPages, ['P1', 'P2'])
    expect(getPref(PREFS.starredPages)).toEqual(['P1', 'P2'])
  })

  it('drops non-string entries from a hand-edited value', () => {
    localStorage.setItem(PREFS.starredPages.key, JSON.stringify(['P1', 42, null, 'P2']))
    expect(getPref(PREFS.starredPages)).toEqual(['P1', 'P2'])
  })
})
