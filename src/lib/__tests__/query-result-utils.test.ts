/**
 * Tests for src/lib/query-result-utils.ts — resolveBlockDisplay & handleBlockNavigation.
 */

import { describe, expect, it, vi } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import { unresolvedBlockLabel, untitledOr } from '@/lib/block-title'
import { handleBlockNavigation, resolveBlockDisplay } from '@/lib/query-result-utils'

// ---------------------------------------------------------------------------
// resolveBlockDisplay
// ---------------------------------------------------------------------------
describe('resolveBlockDisplay — the "Untitled" synthetic arm (#4228)', () => {
  // #4228 moved title normalisation to the SEED, so a newline-leading or
  // blank block is now STORED as the localised placeholder rather than as
  // the `[[id...]]` cache-miss shape. `isSyntheticTitle` was widened to treat
  // that placeholder as synthetic too, otherwise a query row that used to
  // show the block's real text would show "Untitled" instead — a row is not
  // a chip and has an 80-char budget with no one-line constraint.
  //
  // That widening was the change reaching furthest outside this PR's stated
  // scope and was the only production change here with no falsifying test:
  // deleting the clause reverted the behaviour with every other test still
  // green. These pin it, in both directions.

  it('falls back to the block content when the stored title is the placeholder', () => {
    const block = makeBlock({ id: 'b1', parent_id: 'p1', page_id: 'p1', content: '\nreal text' })
    const pageTitles = new Map([['p1', 'My Page']])
    const resolveBlockTitle = vi.fn().mockReturnValue(untitledOr(null))

    const result = resolveBlockDisplay(block, pageTitles, resolveBlockTitle)

    // The fallback is the block's RAW content, newline included — it is not
    // re-normalised, because a row has an 80-char budget and no one-line
    // constraint. Pinned exactly rather than loosely, so a future change to
    // the fallback's shape is a decision and not a silent drift.
    expect(result.title).toBe('\nreal text')
    expect(result.title).not.toBe(untitledOr(null))
  })

  it('does NOT fall back when the block is genuinely titled "Untitled" plus more', () => {
    // The synthetic test is on the RESOLVED string, not the content, so a
    // block whose first line happens to read "Untitled" still resolves to
    // whatever the seeder stored for it.
    const block = makeBlock({ id: 'b2', parent_id: 'p1', page_id: 'p1', content: 'Untitled\nmore' })
    const pageTitles = new Map([['p1', 'My Page']])
    const resolveBlockTitle = vi.fn().mockReturnValue('a real stored title')

    const result = resolveBlockDisplay(block, pageTitles, resolveBlockTitle)

    expect(result.title).toBe('a real stored title')
  })

  it('renders the empty marker for a cached BLANK block, not the placeholder', () => {
    // Undocumented consequence of the same clause, pinned so it is a decision
    // rather than a surprise: a cached blank block used to render "Untitled"
    // and now takes the content fallback, which yields the empty marker. The
    // UNCACHED blank block already rendered that, so this makes the two agree.
    const block = makeBlock({ id: 'b3', parent_id: 'p1', page_id: 'p1', content: '' })
    const pageTitles = new Map([['p1', 'My Page']])
    const resolveBlockTitle = vi.fn().mockReturnValue(untitledOr(null))

    const result = resolveBlockDisplay(block, pageTitles, resolveBlockTitle)

    // Pinned by VALUE, not merely "not the placeholder": this is the marker
    // the UNCACHED blank row already rendered, so the two agree — and if the
    // marker changes, the disagreement with every other surface (which shows
    // the placeholder) should be re-decided rather than drift.
    expect(result.title).toBe('(empty)')
  })

  it('a null-content PAGE row takes the same fallback — the marker, not the placeholder', () => {
    // `preload` stores a null-content page as "Untitled", which the widened
    // synthetic test now catches, so a query row shows the marker while every
    // other surface shows the placeholder. Recorded as a decision.
    const block = makeBlock({ id: 'b4', parent_id: 'p1', page_id: 'p1', content: null })
    const pageTitles = new Map([['p1', 'My Page']])
    const resolveBlockTitle = vi.fn().mockReturnValue(untitledOr(null))

    const result = resolveBlockDisplay(block, pageTitles, resolveBlockTitle)

    expect(result.title).toBe('(empty)')
  })
})

/**
 * #4238 — the cache-miss arm, pinned against the SHARED label helper rather
 * than a hand-typed `[[...]]` string.
 *
 * `CACHE_MISS_FALLBACK_PATTERN` is private to `query-result-utils`, while the
 * only thing that now emits the shape is `unresolvedBlockLabel` over in
 * `@/lib/block-title` — two modules that must agree with nothing but a
 * comment holding them together. Before #4238 a resolved-but-blank row also
 * emitted the shape, so the pattern had a second producer keeping it honest
 * by accident; it does not any more, which makes this the test standing
 * between the two.
 */
describe('resolveBlockDisplay — the cache-miss arm still fires (#4238)', () => {
  const ULID = '01HAAAAA0000000000000000AA'

  it('falls back to the block content for a genuinely unresolved target', () => {
    const block = makeBlock({ id: ULID, parent_id: 'p1', page_id: 'p1', content: 'the real text' })
    const pageTitles = new Map([['p1', 'My Page']])
    // Exactly what every resolver hands back for an id that is absent from
    // the cache, or present with `resolved: false`.
    const resolveBlockTitle = vi.fn().mockReturnValue(unresolvedBlockLabel(ULID))

    const result = resolveBlockDisplay(block, pageTitles, resolveBlockTitle)

    expect(result.title).toBe('the real text')
    expect(result.title).not.toBe(unresolvedBlockLabel(ULID))
  })

  it('does NOT treat a real title that merely contains brackets as a miss', () => {
    // The counterweight: the pattern is anchored, so a block whose text opens
    // with `[[` is still shown. A widened pattern would swallow it, and the
    // test above alone would not notice.
    const block = makeBlock({ id: ULID, parent_id: 'p1', page_id: 'p1', content: 'raw' })
    const resolveBlockTitle = vi.fn().mockReturnValue('[[01HAAAAA...]] and then some')

    const result = resolveBlockDisplay(block, new Map(), resolveBlockTitle)

    expect(result.title).toBe('[[01HAAAAA...]] and then some')
  })
})

describe('resolveBlockDisplay', () => {
  it('returns the resolved block title and page title (happy path)', () => {
    const block = makeBlock({ id: 'b1', parent_id: 'p1', page_id: 'p1', content: 'raw content' })
    const pageTitles = new Map([['p1', 'My Page']])
    const resolveBlockTitle = vi.fn().mockReturnValue('Resolved Title')

    const result = resolveBlockDisplay(block, pageTitles, resolveBlockTitle)

    expect(result).toEqual({ title: 'Resolved Title', pageTitle: 'My Page' })
    expect(resolveBlockTitle).toHaveBeenCalledWith('b1')
  })

  it('returns undefined pageTitle when page_id is null', () => {
    const block = makeBlock({ parent_id: null, page_id: null, content: 'some content' })
    const pageTitles = new Map<string, string>()

    const result = resolveBlockDisplay(block, pageTitles)

    expect(result.pageTitle).toBeUndefined()
  })

  it('returns undefined pageTitle when page_id is not in the map', () => {
    const block = makeBlock({ parent_id: 'unknown-page', page_id: 'unknown-page' })
    const pageTitles = new Map<string, string>()

    const result = resolveBlockDisplay(block, pageTitles)

    expect(result.pageTitle).toBeUndefined()
  })

  it('falls back to truncateContent when resolveBlockTitle returns empty string', () => {
    const block = makeBlock({ content: 'fallback content' })
    const pageTitles = new Map<string, string>()
    const resolveBlockTitle = vi.fn().mockReturnValue('')

    const result = resolveBlockDisplay(block, pageTitles, resolveBlockTitle)

    expect(result.title).toBe('fallback content')
  })

  it('falls back to truncateContent when resolveBlockTitle is not provided', () => {
    const block = makeBlock({ content: 'plain content' })
    const pageTitles = new Map<string, string>()

    const result = resolveBlockDisplay(block, pageTitles)

    expect(result.title).toBe('plain content')
  })

  it('truncates long content to 80 characters when falling back', () => {
    const longContent = 'a'.repeat(100)
    const block = makeBlock({ content: longContent })
    const pageTitles = new Map<string, string>()

    const result = resolveBlockDisplay(block, pageTitles)

    // truncateContent(content, 80) appends "..." when content exceeds max
    expect(result.title).toBe(`${'a'.repeat(80)}...`)
  })
})

// ---------------------------------------------------------------------------
// handleBlockNavigation
// ---------------------------------------------------------------------------
describe('handleBlockNavigation', () => {
  it('calls onNavigate with page_id when both are present', () => {
    const block = makeBlock({ parent_id: 'page-42', page_id: 'page-42' })
    const onNavigate = vi.fn()

    handleBlockNavigation(block, onNavigate)

    expect(onNavigate).toHaveBeenCalledWith('page-42')
  })

  it('does not call onNavigate when page_id is null', () => {
    const block = makeBlock({ parent_id: null, page_id: null })
    const onNavigate = vi.fn()

    handleBlockNavigation(block, onNavigate)

    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('does nothing when onNavigate is undefined', () => {
    const block = makeBlock({ parent_id: 'page-1', page_id: 'page-1' })

    // Should not throw
    expect(() => handleBlockNavigation(block, undefined)).not.toThrow()
  })

  it('does nothing when both page_id and onNavigate are missing', () => {
    const block = makeBlock({ parent_id: null, page_id: null })

    expect(() => handleBlockNavigation(block)).not.toThrow()
  })
})
