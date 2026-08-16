/**
 * #4022 — the backlink `Contains` filter and unlinked references read the same
 * `fts_blocks` stand-in `search_blocks` does (#3938), not raw `blocks.content`.
 *
 * Both handlers ran `matchesSearchFolded` (`@/lib/fold-for-search`) over raw
 * content. Neither backend query is a `LIKE` scan:
 *
 *  - `BacklinkFilter::Contains` is `sanitize_fts_query` + `WHERE fts_blocks
 *    MATCH ?1` (`src-tauri/agaric-store/src/backlink/filters.rs:381-421`, SQL
 *    at :398-407);
 *  - `eval_unlinked_references` is `WHERE fts_blocks MATCH ?1` over the same
 *    index (`src-tauri/agaric-store/src/backlink/grouped.rs:682-697`).
 *
 * So both carried the two #3938 divergences — a diacritic fold the trigram
 * tokenizer does not do (`tokenize = 'trigram case_sensitive 0'`, migration
 * `0006`, measured against a real fts5 table: `naive`/`naïve`,
 * `strasse`/`Straße`, `istanbul`/`İstanbul` are all MISSES there), and a
 * haystack that still has markup delimiters in it and lacks the tag / page
 * names `#[ULID]` / `[[ULID]]` resolve to.
 *
 * `eval_unlinked_references` carries a third one of its own: `AND b.block_type
 * != 'page'` (grouped.rs:688) drops title blocks from the base set globally,
 * because the trigram tokenizer is substring-based and a child page `Notes/2026`
 * would otherwise surface as an unlinked reference to `Notes`.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { dispatch } from '@/lib/tauri-mock/handlers'
import {
  blockTags,
  blocks,
  makeBlock,
  opLog,
  properties,
  propertyDefs,
  seedBlocks,
} from '@/lib/tauri-mock/seed'

function id(label: string): string {
  return label.padStart(26, '0')
}

function clearMock(): void {
  seedBlocks()
  blocks.clear()
  blockTags.clear()
  properties.clear()
  propertyDefs.clear()
  opLog.length = 0
}

/** Insert a block of `type` under `parent`, returning its id. */
function put(blockId: string, type: string, content: string, parent: string | null): string {
  const b = makeBlock(blockId, type, content, parent, 1)
  if (type !== 'page') b['page_id'] = parent
  blocks.set(blockId, b)
  return blockId
}

interface ItemsResponse {
  items: Array<Record<string, unknown>>
}
interface GroupedResponse {
  groups: Array<{ blocks: Array<Record<string, unknown>> }>
  total_count: number
}

/** Every block id in a `Contains`-filtered backlink answer, sorted. */
function containsIds(targetId: string, query: string): string[] {
  const res = dispatch('query_backlinks_filtered', {
    blockId: targetId,
    filters: [{ type: 'Contains', query }],
  }) as ItemsResponse
  return res.items.map((b) => b['id'] as string).toSorted()
}

/** Every block id in an unlinked-references answer, sorted. */
function unlinkedIds(pageId: string): string[] {
  const res = dispatch('list_unlinked_references', { pageId }) as GroupedResponse
  return res.groups.flatMap((g) => g.blocks.map((b) => b['id'] as string)).toSorted()
}

// ---------------------------------------------------------------------------
// `query_backlinks_filtered` — the `Contains` leaf
// ---------------------------------------------------------------------------

describe('query_backlinks_filtered — Contains matches fts_blocks.stripped (#4022)', () => {
  const HOST = id('BHOST')
  const TARGET = id('BTARGET')
  const OTHER = id('BOTHER')
  const MARKUP = id('BMARK')
  const PLAIN = id('BPLAIN')
  const ACCENT = id('BACC')
  const LINKER = id('BLINK')

  beforeEach(() => {
    clearMock()
    put(HOST, 'page', 'Field Notes', null)
    put(TARGET, 'page', 'Quarterly Roadmap', null)
    put(OTHER, 'page', 'Zephyr Protocol', null)
    // Every row below is a backlink to TARGET — the candidate set the
    // `Contains` leaf narrows. They differ only in what their STRIPPED text
    // says.
    put(MARKUP, 'content', `Sprocket **gad**get inventory [[${TARGET}]]`, HOST)
    put(PLAIN, 'content', `plain gadget inventory [[${TARGET}]]`, HOST)
    put(ACCENT, 'content', `the naïve approach [[${TARGET}]]`, HOST)
    put(LINKER, 'content', `see [[${OTHER}]] for context [[${TARGET}]]`, HOST)
  })

  // Case 1 — the raw / stripped split. `gadget` is absent from
  // `blocks.content` (the delimiter splits the word) and present in
  // `fts_blocks.stripped`. PLAIN is the control: it spells the term the same
  // way in both columns, so the pair is a statement about the HAYSTACK rather
  // than about the matcher.
  it('finds a backlink whose term only the STRIPPED text spells out', () => {
    expect(containsIds(TARGET, 'gadget')).toEqual([MARKUP, PLAIN].toSorted())
  })

  // Case 2 — the diacritic arm. `matchesSearchFolded` answers TRUE here
  // (NFKD + combining-mark stripping); the trigram index answers false, so
  // reinstating it cannot pass this.
  it('does NOT match a diacritic-folded Contains query', () => {
    expect(containsIds(TARGET, 'naive')).toEqual([])
    // Not vacuous: the accented query finds the row.
    expect(containsIds(TARGET, 'naïve')).toEqual([ACCENT])
  })

  // Case 3 — text supplied by a resolved `[[ULID]]`. LINKER's raw content
  // never spells `Zephyr Protocol`; `fts_blocks.stripped` does, because
  // `strip_for_fts_with_maps` substitutes the page title. Discriminating
  // rather than universal: the OTHER link is on exactly one row of the
  // candidate set, so a mock that matched every backlink would fail too.
  it('finds a backlink by the TITLE its [[ULID]] resolves to', () => {
    expect(containsIds(TARGET, 'Zephyr Protocol')).toEqual([LINKER])
  })
})

// ---------------------------------------------------------------------------
// `list_unlinked_references`
// ---------------------------------------------------------------------------

describe('list_unlinked_references — matches fts_blocks.stripped (#4022)', () => {
  const HOST = id('UHOST')
  const UPAGE = id('UPAGE')
  const ARCHIVE = id('UARCH')
  const TWIN = id('UTWIN')
  const MARKUP = id('UMRKD')
  const PLAIN = id('UPLAIN')
  const REF = id('UREF')
  const LINKED = id('ULINKED')

  beforeEach(() => {
    clearMock()
    put(HOST, 'page', 'Field Notes', null)
    put(UPAGE, 'page', 'Quarterly Roadmap', null)
    // A PAGE whose title mentions the target title, and a CONTENT block whose
    // text is character-for-character that same title. The two differ in
    // `block_type` and in nothing else.
    put(ARCHIVE, 'page', 'Quarterly Roadmap Archive', null)
    put(TWIN, 'content', 'Quarterly Roadmap Archive', HOST)
    put(MARKUP, 'content', 'Quarterly **Road**map notes', HOST)
    put(PLAIN, 'content', 'Quarterly Roadmap notes', HOST)
    // Mentions the title only through the ARCHIVE title its `[[ULID]]`
    // resolves to.
    put(REF, 'content', `see [[${ARCHIVE}]] for history`, HOST)
    // Already links to the page — an unlinked reference is by definition one
    // WITHOUT the link, and the backend's `NOT IN (SELECT source_id FROM
    // block_links …)` is what drops it. Post-#4022 its stripped text
    // ("tracked in Quarterly Roadmap") DOES match the FTS query, so the link
    // exclusion is now the only thing keeping it out.
    put(LINKED, 'content', `tracked in [[${UPAGE}]]`, HOST)
  })

  // Cases 1 + 3 in the answer the handler actually returns: MARKUP is reachable
  // only through the markup strip, REF only through the resolved `[[ULID]]`
  // title, TWIN and PLAIN through the raw text as before, and ARCHIVE (a page)
  // and LINKED (already linked) are out.
  it('answers with the stripped-text mentions, and only those', () => {
    expect(unlinkedIds(UPAGE)).toEqual([MARKUP, PLAIN, REF, TWIN].toSorted())
  })

  // Case 4 — `AND b.block_type != 'page'` (grouped.rs:688) as its own case.
  // ARCHIVE and TWIN carry IDENTICAL content, so the only thing that can
  // separate them is the exclusion; a mock that dropped both (or kept both)
  // fails one half of the pair.
  it("excludes page blocks, and only for being pages (b.block_type != 'page')", () => {
    const ids = unlinkedIds(UPAGE)
    expect(blocks.get(ARCHIVE)?.['content']).toBe(blocks.get(TWIN)?.['content'])
    expect(ids).not.toContain(ARCHIVE)
    expect(ids).toContain(TWIN)
  })

  // Case 2 — the diacritic arm, where the QUERY is the page title rather than
  // a caller-supplied string.
  describe('the page title is matched by the index fold, not the search fold', () => {
    const ACCPAGE = id('UACCP')
    const BARE = id('UBARE')
    const ACCENTED = id('UACCB')

    beforeEach(() => {
      put(ACCPAGE, 'page', 'naïve', null)
      put(BARE, 'content', 'the naive approach', HOST)
      put(ACCENTED, 'content', 'the naïve approach', HOST)
    })

    it('does NOT surface a mention that differs from the title by a diacritic', () => {
      // BARE is the row `matchesSearchFolded` admits and the trigram index
      // does not; ACCENTED is the control that keeps the assertion from
      // passing on a handler that returns nothing.
      expect(unlinkedIds(ACCPAGE)).toEqual([ACCENTED])
    })
  })
})
