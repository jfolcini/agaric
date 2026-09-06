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

    // `displayMarkdown` is null on the RESOLVED arm (#4719): a stored title
    // is an already-normalised one-line string, not markdown, so the row
    // renders `title` as text rather than parsing it.
    expect(result).toEqual({
      title: 'Resolved Title',
      displayMarkdown: null,
      pageTitle: 'My Page',
    })
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

/**
 * #4719 — the fallback arm is the NORMAL path for a cross-page query row, and
 * it used to hand the row a `truncateContent` string: brackets stripped, ULID
 * left behind, markdown flattened. `title` is still that string (a row needs
 * a plain accessible name), but the row now RENDERS `displayMarkdown`.
 */
describe('resolveBlockDisplay — displayMarkdown, the rich body of the row (#4719)', () => {
  const LINK_ID = '01KP36KDG2ABCDEFGHJKMNPQRS'

  it('carries the RAW content, brackets and all, on the fallback arm', () => {
    // The point of the field: `title` is lossy by design (it is a name), so
    // the row cannot re-derive the markdown from it. `[[…]]` is the shape the
    // issue names, and `truncateContent` is exactly what destroys it.
    const content = `follow up on [[${LINK_ID}]]`
    const block = makeBlock({ id: 'b1', parent_id: 'p1', page_id: 'p1', content })

    const result = resolveBlockDisplay(block, new Map())

    expect(result.displayMarkdown).toBe(content)
  })

  it('is null on the RESOLVED arm — a stored title is a title, not markdown', () => {
    // The counterweight to the test above: a cache hit hands back an
    // already-normalised one-line title (#4228). Parsing it would be a second
    // normalisation of a string that has had one, so the row renders it as
    // text and this field says so.
    const block = makeBlock({ id: 'b2', parent_id: 'p1', page_id: 'p1', content: '# raw markdown' })
    const resolveBlockTitle = vi.fn().mockReturnValue('A Real Title')

    const result = resolveBlockDisplay(block, new Map(), resolveBlockTitle)

    expect(result.displayMarkdown).toBeNull()
    expect(result.title).toBe('A Real Title')
  })

  it('is null for a block with no content, so the row renders the empty marker', () => {
    // `renderRichContent('')` returns null, which would leave the row with an
    // empty body instead of the marker — hence null rather than `''` here.
    const blank = makeBlock({ id: 'b3', parent_id: 'p1', page_id: 'p1', content: '' })
    const missing = makeBlock({ id: 'b4', parent_id: 'p1', page_id: 'p1', content: null })

    expect(resolveBlockDisplay(blank, new Map()).displayMarkdown).toBeNull()
    expect(resolveBlockDisplay(blank, new Map()).title).toBe('(empty)')
    expect(resolveBlockDisplay(missing, new Map()).displayMarkdown).toBeNull()
  })
})

/**
 * #4719 — the accessible name must NAME what the row shows.
 *
 * The row body renders `[[id]]` / `((id))` / `#[id]` as titled chips, so a
 * name still built by `truncateContent` alone ("follow up on
 * 01KP36KDG2ABCDEFGHJKMNPQRS") would be the reported bug relocated into the
 * accessible name, and would break WCAG 2.5.3 — the visible label would not
 * be contained in the name. The substitution runs BEFORE truncation so the
 * 80-char budget applies to the readable string.
 */
describe('resolveBlockDisplay — the name resolves inline references (#4719)', () => {
  const LINK_ID = '01KP36KDG2ABCDEFGHJKMNPQRS'
  const TAG_ID = '01KP36KDG2ZZZZZZZZZZZZZZZZ'

  const resolver = (id: string): string =>
    ({ [LINK_ID]: 'Quarterly Plan', [TAG_ID]: 'urgent' })[id] ?? unresolvedBlockLabel(id)

  it('names a block link by its target title, not by the bare ULID', () => {
    const block = makeBlock({
      id: 'B1',
      parent_id: 'p1',
      page_id: 'p1',
      content: `follow up on [[${LINK_ID}]]`,
    })

    const result = resolveBlockDisplay(block, new Map(), resolver)

    expect(result.title).toBe('follow up on Quarterly Plan')
    expect(result.title).not.toContain(LINK_ID)
  })

  it('covers block refs and tag refs too, and leaves a non-ULID alone', () => {
    // All three shapes carry a bare 26-char ULID that `truncateContent` would
    // otherwise expose (it strips `#` and `[[…]]`, and does not touch `((…))`
    // at all). The last assertion is the counterweight: the substitution is
    // gated on the canonical ULID shape, so ordinary bracketed prose survives.
    const refBlock = makeBlock({ id: 'B2', content: `see ((${LINK_ID}))` })
    const tagBlock = makeBlock({ id: 'B3', content: `ship it #[${TAG_ID}]` })
    const proseBlock = makeBlock({ id: 'B4', content: 'see [[the handbook]] first' })

    expect(resolveBlockDisplay(refBlock, new Map(), resolver).title).toBe('see Quarterly Plan')
    expect(resolveBlockDisplay(tagBlock, new Map(), resolver).title).toBe('ship it urgent')
    expect(resolveBlockDisplay(proseBlock, new Map(), resolver).title).toBe(
      'see the handbook first',
    )
  })

  it('leaves a 26-character NON-ULID alone — the gate, not the length', () => {
    // The counterweight to every substitution above, and the one that
    // exercises `ULID_RE` itself: `[[the handbook]]` above fails the loose
    // scan on LENGTH, so it says nothing about the gate. A 26-character
    // lowercase run matches the scan and must still be refused, or ordinary
    // bracketed prose of the wrong shape would be handed to the resolver.
    const notAUlid = 'abcdefghijklmnopqrstuvwxyz'
    expect(notAUlid).toHaveLength(26)
    const block = makeBlock({ id: 'B6', content: `see [[${notAUlid}]] first` })
    const resolveRef = vi.fn(() => 'SHOULD NOT BE USED')

    const result = resolveBlockDisplay(block, new Map(), undefined, resolveRef)

    // `truncateContent` still strips the brackets; the point is that the
    // resolver was never consulted for a non-ULID id.
    expect(result.title).toBe('see abcdefghijklmnopqrstuvwxyz first')
    expect(resolveRef).not.toHaveBeenCalledWith(notAUlid)
  })

  it('substitutes through the DEDICATED ref resolver when one is passed', () => {
    // #4719 follow-up: the row's own title and the reference substitution use
    // two different resolvers, because `AdvancedQueryView` renders the list
    // with no `resolveBlockTitle` at all while its chips still resolve. A
    // caller that passes only the fourth argument must still get a resolved
    // name.
    const block = makeBlock({ id: 'B7', content: `follow up on [[${LINK_ID}]]` })

    const result = resolveBlockDisplay(block, new Map(), undefined, resolver)

    expect(result.title).toBe('follow up on Quarterly Plan')
    // The block's OWN title was not resolved (no third argument), so the row
    // still renders the content markdown.
    expect(result.displayMarkdown).toBe(`follow up on [[${LINK_ID}]]`)
  })

  it('falls back to the resolver\'s own "[[id…]]" label for an unresolved target', () => {
    // Not every target resolves — the resolve store only preloads the current
    // page. The name then carries the same 8-character prefix the CHIP shows
    // (`renderBlockLink`'s fallback), rather than the full 26-char id.
    const unknown = '01KZZZZZZZZZZZZZZZZZZZZZZZ'
    const block = makeBlock({ id: 'B5', content: `blocked by [[${unknown}]]` })

    const result = resolveBlockDisplay(block, new Map(), resolver)

    expect(result.title).toBe('blocked by 01KZZZZZ...')
    expect(result.title).not.toContain(unknown)
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
