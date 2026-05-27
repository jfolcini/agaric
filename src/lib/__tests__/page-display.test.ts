/**
 * Tests for `getPageDisplayName` — the shared hierarchical page-name
 * formatter (PEND-83 Bug 1).
 *
 * Coverage targets the matrix from the module docstring plus the edge
 * cases the proposal called out: empty string, no slash, single slash,
 * deeply nested, leading slash, trailing slash, double slash.
 *
 * The `title` field is always the full path (verified per case) — the
 * tooltip contract every consuming surface relies on.
 */

import { describe, expect, it } from 'vitest'
import { getPageDisplayName, type PageDisplayMode } from '../page-display'

const MODES: PageDisplayMode[] = ['full', 'leaf', 'leaf-with-breadcrumb']

describe('getPageDisplayName — non-namespaced inputs collapse across all modes', () => {
  it.each(MODES)('empty string → { label: "", title: "" } (mode=%s)', (mode) => {
    const r = getPageDisplayName('', mode)
    expect(r).toEqual({ label: '', title: '' })
    expect(r.breadcrumb).toBeUndefined()
  })

  it.each(MODES)('no-slash title → { label, title } same as input (mode=%s)', (mode) => {
    const r = getPageDisplayName('Inbox', mode)
    expect(r).toEqual({ label: 'Inbox', title: 'Inbox' })
    expect(r.breadcrumb).toBeUndefined()
  })

  it.each(MODES)('a non-namespaced title never carries a breadcrumb (mode=%s)', (mode) => {
    expect(getPageDisplayName('Inbox', mode).breadcrumb).toBeUndefined()
  })
})

describe('getPageDisplayName — full mode preserves the input', () => {
  it('returns the full path as both label and title for a single slash', () => {
    expect(getPageDisplayName('Notes/2026', 'full')).toEqual({
      label: 'Notes/2026',
      title: 'Notes/2026',
    })
  })

  it('returns the full path as both label and title for a deeply nested path', () => {
    expect(getPageDisplayName('a/b/c/d/e', 'full')).toEqual({
      label: 'a/b/c/d/e',
      title: 'a/b/c/d/e',
    })
  })

  it('never sets breadcrumb in full mode', () => {
    expect(getPageDisplayName('a/b/c', 'full').breadcrumb).toBeUndefined()
  })
})

describe('getPageDisplayName — leaf mode returns the trailing segment', () => {
  it('single slash → leaf is the right side', () => {
    expect(getPageDisplayName('Notes/2026', 'leaf')).toEqual({
      label: '2026',
      title: 'Notes/2026',
    })
  })

  it('deeply nested → leaf is the final segment', () => {
    expect(getPageDisplayName('a/b/c/d/e', 'leaf')).toEqual({
      label: 'e',
      title: 'a/b/c/d/e',
    })
  })

  it('never sets breadcrumb in leaf mode', () => {
    expect(getPageDisplayName('a/b/c', 'leaf').breadcrumb).toBeUndefined()
  })

  it('title always reflects the original full path (not the leaf)', () => {
    expect(getPageDisplayName('a/b/c', 'leaf').title).toBe('a/b/c')
  })
})

describe('getPageDisplayName — leaf-with-breadcrumb returns leaf + " / "-joined ancestors', () => {
  it('single slash → breadcrumb is the single ancestor segment, no " / " inserted', () => {
    expect(getPageDisplayName('Notes/2026', 'leaf-with-breadcrumb')).toEqual({
      label: '2026',
      breadcrumb: 'Notes',
      title: 'Notes/2026',
    })
  })

  it('two slashes → breadcrumb joins the two ancestor segments with " / "', () => {
    expect(getPageDisplayName('work/projects/Quarterly', 'leaf-with-breadcrumb')).toEqual({
      label: 'Quarterly',
      breadcrumb: 'work / projects',
      title: 'work/projects/Quarterly',
    })
  })

  it('deeply nested → all ancestor segments joined with " / "', () => {
    expect(getPageDisplayName('a/b/c/d/e', 'leaf-with-breadcrumb')).toEqual({
      label: 'e',
      breadcrumb: 'a / b / c / d',
      title: 'a/b/c/d/e',
    })
  })
})

describe('getPageDisplayName — leading / trailing / double slash pathologies', () => {
  // Leading slash: the first segment is the empty string, which the
  // utility surfaces verbatim. Callers are responsible for sanitising
  // their inputs — the formatter must NOT silently normalise them away,
  // or a `/A/B` page would render identically to `A/B` and the user
  // would lose track of which one they typed.

  it('leading slash → leaf is the segment after the slash, breadcrumb has an empty leading segment', () => {
    expect(getPageDisplayName('/Notes', 'leaf-with-breadcrumb')).toEqual({
      label: 'Notes',
      breadcrumb: '',
      title: '/Notes',
    })
  })

  it('leading slash in leaf mode → leaf is the segment after the slash', () => {
    expect(getPageDisplayName('/Notes', 'leaf')).toEqual({
      label: 'Notes',
      title: '/Notes',
    })
  })

  it('trailing slash → leaf is the empty trailing segment', () => {
    // `'Notes/'.split('/')` is `['Notes', '']`; `pop()` returns the empty
    // string. We surface that verbatim — the caller is the one with the
    // dangling slash, not us.
    expect(getPageDisplayName('Notes/', 'leaf-with-breadcrumb')).toEqual({
      label: '',
      breadcrumb: 'Notes',
      title: 'Notes/',
    })
  })

  it('trailing slash in leaf mode → leaf is empty, title is preserved', () => {
    expect(getPageDisplayName('Notes/', 'leaf')).toEqual({
      label: '',
      title: 'Notes/',
    })
  })

  it('double slash in the middle → empty ancestor segment is preserved in the breadcrumb', () => {
    // `'a//b'.split('/')` is `['a', '', 'b']`. The leaf is `'b'`, the
    // breadcrumb joins `['a', '']` → `'a / '`. We do NOT collapse the
    // double slash — that would be silent input normalisation.
    expect(getPageDisplayName('a//b', 'leaf-with-breadcrumb')).toEqual({
      label: 'b',
      breadcrumb: 'a / ',
      title: 'a//b',
    })
  })

  it('only a slash (`/`) → both segments empty, no breadcrumb separator', () => {
    expect(getPageDisplayName('/', 'leaf-with-breadcrumb')).toEqual({
      label: '',
      breadcrumb: '',
      title: '/',
    })
  })
})

describe('getPageDisplayName — title contract: title is ALWAYS the full path', () => {
  // The tooltip contract: every consuming surface wires `title={result.title}`
  // on its visible chip / tab / chip-row so the full path stays available
  // on hover even when the visible label was trimmed to the leaf.
  // A regression here silently swallows the hover affordance.
  const fixtures = ['', 'Inbox', 'Notes/2026', 'a/b/c/d/e', '/Notes', 'Notes/', 'a//b', '/']

  for (const path of fixtures) {
    for (const mode of MODES) {
      it(`title === fullPath for ${JSON.stringify(path)} in ${mode} mode`, () => {
        expect(getPageDisplayName(path, mode).title).toBe(path)
      })
    }
  }
})
