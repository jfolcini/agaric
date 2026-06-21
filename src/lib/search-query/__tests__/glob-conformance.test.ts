/**
 * Cross-impl conformance test for the tauri-mock's Pages `PathGlob` filter
 * re-implementation (#1910).
 *
 * `pageGlobFilterMatches` (in `../glob-validate`) re-implements the backend's
 * SQLite-`GLOB`-dialect page-path filter in TypeScript. This test drives it
 * from the SHARED golden fixture
 * `conformance/pages-metadata/path-glob.vectors.json`, which the Rust query
 * path asserts against too (driving the real `list_pages_with_metadata_inner`
 * through `LOWER(title) GLOB ?`). If backend glob semantics change, the
 * fixture is regenerated from the Rust side and this test fails until
 * `glob-validate.ts` is realigned — that is the whole point of the cross-impl
 * gate. See `conformance/pages-metadata/README.md`.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { asciiLowercase, globToRegExp, pageGlobFilterMatches, prepareGlobs } from '../glob-validate'

interface Row {
  id: string
  title: string
}

interface Scenario {
  name: string
  pattern: string
  exclude: boolean
  expectedMatchingIds: string[]
}

interface Invalid {
  name: string
  pattern: string
}

interface Vectors {
  rows: Row[]
  scenarios: Scenario[]
  invalid: Invalid[]
}

const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'conformance',
  'pages-metadata',
  'path-glob.vectors.json',
)
const vectors = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Vectors

/** Sorted ids of the rows the scenario predicate admits. */
function matchingIds(scenario: Scenario): string[] {
  return vectors.rows
    .filter((r) => pageGlobFilterMatches(scenario.pattern, r.title, scenario.exclude))
    .map((r) => r.id)
    .toSorted()
}

describe('PathGlob cross-impl conformance', () => {
  for (const scenario of vectors.scenarios) {
    it(scenario.name, () => {
      expect(matchingIds(scenario)).toEqual(scenario.expectedMatchingIds.toSorted())
    })
  }

  for (const bad of vectors.invalid) {
    it(`rejects invalid glob: ${bad.name}`, () => {
      // The backend rejects the whole query (AppError::Validation); the mock's
      // closest per-row approximation is "matches nothing" — every row drops
      // for an include filter.
      const anyMatch = vectors.rows.some((r) => pageGlobFilterMatches(bad.pattern, r.title, false))
      expect(anyMatch).toBe(false)
      // prepareGlobs surfaces the shared `InvalidGlob:` prefix (the contract
      // the frontend chip keys on), mirroring the backend error.
      expect(() => prepareGlobs([bad.pattern])).toThrow(/InvalidGlob:/)
    })
  }
})

describe('prepareGlobs pipeline shape', () => {
  it('substring-wraps bare tokens and ASCII-lowercases', () => {
    expect(prepareGlobs(['Journal'])).toEqual(['*journal*'])
  })

  it('does NOT substring-wrap patterns carrying * ? or [', () => {
    expect(prepareGlobs(['Journal/*'])).toEqual(['journal/*'])
    expect(prepareGlobs(['a?b'])).toEqual(['a?b'])
    expect(prepareGlobs(['[ab]c'])).toEqual(['[ab]c'])
  })

  it('brace-expands then wraps each alternative', () => {
    expect(prepareGlobs(['{foo,bar}'])).toEqual(['*foo*', '*bar*'])
  })

  it('splits on top-level commas but not commas inside braces', () => {
    expect(prepareGlobs(['{a,b}/*'])).toEqual(['a/*', 'b/*'])
    expect(prepareGlobs(['a,b'])).toEqual(['*a*', '*b*'])
  })

  it('drops whitespace-only entries to an empty list', () => {
    expect(prepareGlobs(['   '])).toEqual([])
    expect(prepareGlobs([''])).toEqual([])
  })

  it('folds ASCII case only, preserving non-ASCII letters (#381)', () => {
    expect(prepareGlobs(['CAFÉ'])).toEqual(['*cafÉ*'])
    expect(asciiLowercase('CAFÉ')).toBe('cafÉ')
  })
})

describe('globToRegExp — SQLite GLOB dialect', () => {
  it('* matches any run, ? matches exactly one char', () => {
    expect(globToRegExp('a*').test('abc')).toBe(true)
    expect(globToRegExp('a?').test('ab')).toBe(true)
    expect(globToRegExp('a?').test('abc')).toBe(false)
  })

  it('is whole-string anchored', () => {
    expect(globToRegExp('foo').test('foobar')).toBe(false)
    expect(globToRegExp('*foo*').test('a foo b')).toBe(true)
  })

  it('character classes and ranges', () => {
    expect(globToRegExp('[ab]').test('a')).toBe(true)
    expect(globToRegExp('[ab]').test('c')).toBe(false)
    expect(globToRegExp('[a-c]').test('b')).toBe(true)
    expect(globToRegExp('[a-c]').test('d')).toBe(false)
  })

  it('leading ^ negates a class', () => {
    expect(globToRegExp('[^a]').test('b')).toBe(true)
    expect(globToRegExp('[^a]').test('a')).toBe(false)
  })
})
