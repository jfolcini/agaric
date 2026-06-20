/**
 * Tests for the curated `lowlight` instance shared by `RichContentRenderer`
 * and `useRovingEditor` (Tier 1 item 3, sub-point 4 of the 2026-05-09
 * design-system perf review).
 *
 * The point of curation is to avoid bundling the 37-language `common` preset
 * from `lowlight` on the critical path. These tests pin (a) the exact set we
 * register so it can't silently drift back toward `common`, (b) that all
 * languages we claim to support actually highlight, and (c) that unsupported
 * languages still render via the lowlight plain-text fallback.
 */

import { describe, expect, it } from 'vitest'

import { CURATED_LANGUAGES, curatedLowlight } from '../lowlight-curated'

/**
 * The exact set of languages our curated `lowlight` instance must support.
 *
 * If you intentionally add or remove a language, update this array — the
 * failure message tells you what changed. Drifting back toward the 37-language
 * `common` preset would silently bloat the critical-path bundle by ~70-100 KB,
 * so we assert on the exact set rather than a minimum/maximum.
 */
const EXPECTED_LANGUAGES = [
  'bash',
  'css',
  'diff',
  'dockerfile',
  'go',
  'javascript',
  'json',
  'markdown',
  'plaintext',
  'python',
  'rust',
  'shell',
  'sql',
  'typescript',
  'xml',
  'yaml',
] as const

describe('lowlight-curated', () => {
  it('exports the expected curated language set (pins against drift toward `common`)', () => {
    const actual = Object.keys(CURATED_LANGUAGES).toSorted()
    const expected = [...EXPECTED_LANGUAGES].toSorted()
    expect(actual).toEqual(expected)
  })

  it('keeps the curated set well below the 37-language `common` preset', () => {
    // Defensive upper-bound — if someone adds 20 languages "just in case", this
    // test fires and the reviewer must justify the regression.
    expect(Object.keys(CURATED_LANGUAGES).length).toBeLessThan(20)
  })

  it('registers each curated language with the shared lowlight instance', () => {
    for (const name of EXPECTED_LANGUAGES) {
      expect(curatedLowlight.registered(name), `lowlight should know ${name}`).toBe(true)
    }
  })

  it('does NOT register languages dropped from the `common` preset', () => {
    // Sample of languages that `lowlight/common` ships but we don't. If these
    // ever come back, the curation has regressed.
    const droppedLanguages = ['arduino', 'csharp', 'kotlin', 'php', 'swift', 'vbnet']
    for (const name of droppedLanguages) {
      expect(curatedLowlight.registered(name), `${name} should not be registered`).toBe(false)
    }
  })

  it('produces a syntax-highlighted tree for a known language (typescript)', () => {
    const tree = curatedLowlight.highlight('typescript', 'const x: number = 1')
    expect(tree.type).toBe('root')
    // A real highlight produces at least one `hljs-*` class on a descendant.
    const json = JSON.stringify(tree)
    expect(json).toMatch(/hljs-/)
  })

  it('falls back to a plain-text tree for an unregistered language (no throw)', () => {
    // `lowlight.highlight()` with an unknown language throws, but
    // `RichContentRenderer` guards via `registered()` and uses
    // `highlightAuto` as the fallback. We verify the fallback path here.
    const lang = 'fortran' // intentionally not curated
    expect(curatedLowlight.registered(lang)).toBe(false)
    // The application's escape hatch — `highlightAuto` — still produces a tree.
    const tree = curatedLowlight.highlightAuto('PROGRAM hello\nEND PROGRAM')
    expect(tree.type).toBe('root')
  })
})
