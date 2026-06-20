/**
 * Tests for the block-subtree ⇄ indented-markdown serializer/parser (#913).
 */

import { describe, expect, it } from 'vitest'

import { makeBlock } from '../../__tests__/fixtures'
import {
  humanizeRefTokens,
  INDENT_UNIT,
  internalizeRefTokens,
  parseIndentedMarkdown,
  type RefInternalizers,
  serializeBlockSubtree,
} from '../block-clipboard'
import type { FlatBlock } from '../tree-utils'

// Canonical 26-char uppercase Crockford-base32 ULIDs (the only shape the
// reference-token regexes accept). Reused across the #1440 humanize tests.
const PAGE_ULID = '01HZ0PAGE0000000000000000A'
const TAG_ULID = '01HZ0TAG00000000000000000B'
const BLOCK_ULID = '01HZ0BLOCK000000000000000C'

/** Build a flat tree from `[id, depth, parentId, content]` rows. */
function tree(rows: Array<[string, number, string | null, string]>): FlatBlock[] {
  return rows.map(([id, depth, parent_id, content]) => makeBlock({ id, depth, parent_id, content }))
}

describe('serializeBlockSubtree', () => {
  it('returns empty string when nothing is selected', () => {
    const items = tree([['A', 0, null, 'a']])
    expect(serializeBlockSubtree(items, [])).toBe('')
  })

  it('serializes a single selected leaf as one line', () => {
    const items = tree([['A', 0, null, 'hello']])
    expect(serializeBlockSubtree(items, ['A'])).toBe('hello')
  })

  it('serializes a flat list of selected roots at indent 0', () => {
    const items = tree([
      ['A', 0, null, 'a'],
      ['B', 0, null, 'b'],
      ['C', 0, null, 'c'],
    ])
    expect(serializeBlockSubtree(items, ['A', 'B', 'C'])).toBe('a\nb\nc')
  })

  it('indents children under their parent (2 spaces per level)', () => {
    const items = tree([
      ['A', 0, null, 'parent'],
      ['B', 1, 'A', 'child'],
      ['C', 2, 'B', 'grandchild'],
    ])
    // Selecting only the root pulls the whole subtree along.
    expect(serializeBlockSubtree(items, ['A'])).toBe('parent\n  child\n    grandchild')
  })

  it('collapses a selected descendant into its selected ancestor (no double-emit)', () => {
    const items = tree([
      ['A', 0, null, 'parent'],
      ['B', 1, 'A', 'child'],
    ])
    // Both selected, but B is inside A — emit the subtree once.
    expect(serializeBlockSubtree(items, ['A', 'B'])).toBe('parent\n  child')
  })

  it('serializes mixed-depth sibling subtrees in document order', () => {
    const items = tree([
      ['A', 0, null, 'a'],
      ['A1', 1, 'A', 'a1'],
      ['B', 0, null, 'b'],
      ['B1', 1, 'B', 'b1'],
      ['B2', 2, 'B1', 'b2'],
    ])
    expect(serializeBlockSubtree(items, ['A', 'B'])).toBe('a\n  a1\nb\n  b1\n    b2')
  })

  it('normalizes a deeply-nested selection so the shallowest root sits at indent 0', () => {
    const items = tree([
      ['ROOT', 0, null, 'root'],
      ['MID', 1, 'ROOT', 'mid'],
      ['LEAF', 2, 'MID', 'leaf'],
    ])
    // Selecting MID copies MID (rebased to 0) + LEAF (one level under it).
    expect(serializeBlockSubtree(items, ['MID'])).toBe('mid\n  leaf')
  })

  it('emits an empty line for an empty-content block', () => {
    const items = tree([
      ['A', 0, null, ''],
      ['B', 1, 'A', 'child'],
    ])
    expect(serializeBlockSubtree(items, ['A'])).toBe('\n  child')
  })
})

describe('parseIndentedMarkdown', () => {
  it('returns [] for empty / whitespace-only input', () => {
    expect(parseIndentedMarkdown('')).toEqual([])
    expect(parseIndentedMarkdown('   \n\n  ')).toEqual([])
  })

  it('parses a single line as one top-level block', () => {
    expect(parseIndentedMarkdown('hello')).toEqual([{ content: 'hello', parentIndex: null }])
  })

  it('parses a flat list as top-level siblings', () => {
    expect(parseIndentedMarkdown('a\nb\nc')).toEqual([
      { content: 'a', parentIndex: null },
      { content: 'b', parentIndex: null },
      { content: 'c', parentIndex: null },
    ])
  })

  it('parses nested indentation into parent pointers', () => {
    const parsed = parseIndentedMarkdown('parent\n  child\n    grandchild')
    expect(parsed).toEqual([
      { content: 'parent', parentIndex: null },
      { content: 'child', parentIndex: 0 },
      { content: 'grandchild', parentIndex: 1 },
    ])
  })

  it('parses mixed depths with multiple subtrees', () => {
    const parsed = parseIndentedMarkdown('a\n  a1\nb\n  b1\n    b2')
    expect(parsed).toEqual([
      { content: 'a', parentIndex: null },
      { content: 'a1', parentIndex: 0 },
      { content: 'b', parentIndex: null },
      { content: 'b1', parentIndex: 2 },
      { content: 'b2', parentIndex: 3 },
    ])
  })

  it('skips blank interior lines', () => {
    const parsed = parseIndentedMarkdown('a\n\n  b\n\nc')
    expect(parsed).toEqual([
      { content: 'a', parentIndex: null },
      { content: 'b', parentIndex: 0 },
      { content: 'c', parentIndex: null },
    ])
  })

  it('clamps an over-indented jump to one level deeper (no orphan)', () => {
    // 'deep' is indented 4 levels under a top-level block — clamp to 1.
    const parsed = parseIndentedMarkdown(`top\n${' '.repeat(INDENT_UNIT * 4)}deep`)
    expect(parsed).toEqual([
      { content: 'top', parentIndex: null },
      { content: 'deep', parentIndex: 0 },
    ])
  })

  it('treats a tab as one indent unit', () => {
    const parsed = parseIndentedMarkdown('parent\n\tchild')
    expect(parsed).toEqual([
      { content: 'parent', parentIndex: null },
      { content: 'child', parentIndex: 0 },
    ])
  })
})

describe('round-trip serialize ⇄ parse', () => {
  it('flat list round-trips', () => {
    const items = tree([
      ['A', 0, null, 'a'],
      ['B', 0, null, 'b'],
    ])
    const md = serializeBlockSubtree(items, ['A', 'B'])
    expect(parseIndentedMarkdown(md)).toEqual([
      { content: 'a', parentIndex: null },
      { content: 'b', parentIndex: null },
    ])
  })

  it('nested subtree round-trips structure', () => {
    const items = tree([
      ['A', 0, null, 'parent'],
      ['B', 1, 'A', 'child'],
      ['C', 2, 'B', 'grandchild'],
    ])
    const md = serializeBlockSubtree(items, ['A'])
    expect(parseIndentedMarkdown(md)).toEqual([
      { content: 'parent', parentIndex: null },
      { content: 'child', parentIndex: 0 },
      { content: 'grandchild', parentIndex: 1 },
    ])
  })

  it('mixed-depth multi-subtree round-trips', () => {
    const items = tree([
      ['A', 0, null, 'a'],
      ['A1', 1, 'A', 'a1'],
      ['B', 0, null, 'b'],
      ['B1', 1, 'B', 'b1'],
    ])
    const md = serializeBlockSubtree(items, ['A', 'B'])
    expect(parseIndentedMarkdown(md)).toEqual([
      { content: 'a', parentIndex: null },
      { content: 'a1', parentIndex: 0 },
      { content: 'b', parentIndex: null },
      { content: 'b1', parentIndex: 2 },
    ])
  })
})

// #1440 — export/clipboard rendering of internal references as human-readable
// names, reusing the page-export resolver semantics (`resolve_ulids_for_export`
// in src-tauri): `[[ULID]]`→`[[Name]]`, `((ULID))`→`((Name))`, `#[ULID]`→`#tag`,
// with a graceful fallback to the opaque ULID token for dangling refs.
describe('humanizeRefTokens (#1440)', () => {
  // Mirrors the Rust resolver's pre-fetched name maps: a plain lookup that
  // returns the display name, or `undefined` for an unknown ULID.
  const names: Record<string, string> = {
    [PAGE_ULID]: 'My Page',
    [TAG_ULID]: 'todo',
    [BLOCK_ULID]: 'a referenced block',
  }
  const resolve = (ulid: string) => names[ulid]

  it('renders a page/block link [[ULID]] as [[Page Name]]', () => {
    expect(humanizeRefTokens(`see [[${PAGE_ULID}]] here`, resolve)).toBe('see [[My Page]] here')
  })

  it('renders a tag #[ULID] as #tag', () => {
    expect(humanizeRefTokens(`tagged #[${TAG_ULID}]`, resolve)).toBe('tagged #todo')
  })

  it('renders a block ref ((ULID)) as ((Name))', () => {
    expect(humanizeRefTokens(`quote ((${BLOCK_ULID}))`, resolve)).toBe(
      'quote ((a referenced block))',
    )
  })

  it('resolves every reference kind in one line', () => {
    const content = `[[${PAGE_ULID}]] #[${TAG_ULID}] ((${BLOCK_ULID}))`
    expect(humanizeRefTokens(content, resolve)).toBe('[[My Page]] #todo ((a referenced block))')
  })

  it('falls back to the opaque ULID token for a dangling/unresolvable ref', () => {
    const dangling = '01HZ0MISSING000000000000ZZ'
    // Unknown page link, tag, and block ref all keep their original token.
    expect(humanizeRefTokens(`[[${dangling}]]`, resolve)).toBe(`[[${dangling}]]`)
    expect(humanizeRefTokens(`#[${dangling}]`, resolve)).toBe(`#[${dangling}]`)
    expect(humanizeRefTokens(`((${dangling}))`, resolve)).toBe(`((${dangling}))`)
  })

  it('leaves content without reference tokens untouched', () => {
    expect(humanizeRefTokens('plain **bold** text, no refs', resolve)).toBe(
      'plain **bold** text, no refs',
    )
  })
})

describe('serializeBlockSubtree reference rendering (#1440)', () => {
  const names: Record<string, string> = {
    [PAGE_ULID]: 'My Page',
    [TAG_ULID]: 'todo',
    [BLOCK_ULID]: 'a referenced block',
  }
  const resolve = (ulid: string) => names[ulid]

  it('keeps stored ULID tokens verbatim when no resolver is passed (internal round-trip)', () => {
    // The duplicate / internal copy→paste paths call without a resolver — the
    // stored canonical content must NOT be rewritten so it re-imports as-is.
    const items = tree([['A', 0, null, `link [[${PAGE_ULID}]] and #[${TAG_ULID}]`]])
    expect(serializeBlockSubtree(items, ['A'])).toBe(`link [[${PAGE_ULID}]] and #[${TAG_ULID}]`)
  })

  it('renders references human-readably for the clipboard when a resolver is passed', () => {
    const items = tree([
      ['A', 0, null, `parent links [[${PAGE_ULID}]]`],
      ['B', 1, 'A', `child tags #[${TAG_ULID}] and quotes ((${BLOCK_ULID}))`],
    ])
    expect(serializeBlockSubtree(items, ['A'], resolve)).toBe(
      'parent links [[My Page]]\n  child tags #todo and quotes ((a referenced block))',
    )
  })

  it('falls back to the ULID token for a dangling ref while still humanizing the rest', () => {
    const dangling = '01HZ0MISSING000000000000ZZ'
    const items = tree([['A', 0, null, `[[${PAGE_ULID}]] then [[${dangling}]]`]])
    expect(serializeBlockSubtree(items, ['A'], resolve)).toBe(`[[My Page]] then [[${dangling}]]`)
  })

  it('does not mutate the source block content (storage canonical unchanged)', () => {
    const original = `link [[${PAGE_ULID}]]`
    const items = tree([['A', 0, null, original]])
    serializeBlockSubtree(items, ['A'], resolve)
    // The FlatBlock in `items` still carries the ULID-based stored content.
    expect(items[0]?.content).toBe(original)
  })
})

// #1484 — import/paste resolution of human-readable wiki-links back to internal
// refs: `[[Page Name]]`→`[[ULID]]` (create if missing), `#tag`→`#[ULID]` (create
// if missing), leaving canonical tokens, unresolvable names, and `((Name))`
// block refs as-is. The injected resolvers mock the page/tag lookup + creation
// IPC the production wiring (`buildImportRefInternalizers` in page-blocks)
// performs.
describe('internalizeRefTokens (#1484)', () => {
  const EXISTING_PAGE = '01HZ0PAGE0000000000000000A'
  const NEW_PAGE = '01HZ0NEWPAGE00000000000NEW'
  const EXISTING_TAG = '01HZ0TAG00000000000000000B'
  const NEW_TAG = '01HZ0NEWTAG0000000000NEWTG'

  /**
   * A scriptable resolver pair: `pages`/`tags` map an EXISTING name to its ULID;
   * any other name is "created" (recorded in `created`, assigned the matching
   * NEW_* ULID). A name listed in `ambiguous` resolves to `null` (left plain).
   */
  function makeResolvers(opts: {
    pages?: Record<string, string>
    tags?: Record<string, string>
    ambiguous?: Set<string>
  }): { resolvers: RefInternalizers; created: { pages: string[]; tags: string[] } } {
    const created = { pages: [] as string[], tags: [] as string[] }
    const resolvers: RefInternalizers = {
      page: async (name) => {
        if (opts.ambiguous?.has(name)) return null
        if (opts.pages && name in opts.pages) return opts.pages[name] ?? null
        created.pages.push(name)
        return NEW_PAGE
      },
      tag: async (name) => {
        if (opts.ambiguous?.has(name)) return null
        if (opts.tags && name in opts.tags) return opts.tags[name] ?? null
        created.tags.push(name)
        return NEW_TAG
      },
    }
    return { resolvers, created }
  }

  it('resolves an existing [[Page Name]] to its internal [[ULID]]', async () => {
    const { resolvers } = makeResolvers({ pages: { 'My Page': EXISTING_PAGE } })
    expect(await internalizeRefTokens('see [[My Page]] here', resolvers)).toBe(
      `see [[${EXISTING_PAGE}]] here`,
    )
  })

  it('creates a missing [[New Page]] and links to the created ULID', async () => {
    const { resolvers, created } = makeResolvers({})
    expect(await internalizeRefTokens('link [[New Page]]', resolvers)).toBe(`link [[${NEW_PAGE}]]`)
    expect(created.pages).toEqual(['New Page'])
  })

  it('resolves an existing #tag to its internal #[ULID]', async () => {
    const { resolvers } = makeResolvers({ tags: { todo: EXISTING_TAG } })
    expect(await internalizeRefTokens('tagged #todo today', resolvers)).toBe(
      `tagged #[${EXISTING_TAG}] today`,
    )
  })

  it('creates a missing #newtag and links to the created ULID', async () => {
    const { resolvers, created } = makeResolvers({})
    expect(await internalizeRefTokens('a #newtag here', resolvers)).toBe(`a #[${NEW_TAG}] here`)
    expect(created.tags).toEqual(['newtag'])
  })

  it('resolves a nested #parent/child tag name', async () => {
    const { resolvers, created } = makeResolvers({})
    expect(await internalizeRefTokens('#parent/child', resolvers)).toBe(`#[${NEW_TAG}]`)
    expect(created.tags).toEqual(['parent/child'])
  })

  it('leaves an ambiguous (duplicate-title) [[Name]] as plain text, no create', async () => {
    const { resolvers, created } = makeResolvers({ ambiguous: new Set(['Dup Title']) })
    expect(await internalizeRefTokens('see [[Dup Title]]', resolvers)).toBe('see [[Dup Title]]')
    expect(created.pages).toEqual([])
  })

  it('leaves a canonical [[ULID]] untouched (internal round-trip stays ULID)', async () => {
    const { resolvers, created } = makeResolvers({})
    expect(await internalizeRefTokens(`dup [[${EXISTING_PAGE}]]`, resolvers)).toBe(
      `dup [[${EXISTING_PAGE}]]`,
    )
    // A bare-ULID body is never treated as a name → no page created.
    expect(created.pages).toEqual([])
  })

  it('leaves a canonical #[ULID] tag untouched', async () => {
    const { resolvers, created } = makeResolvers({})
    expect(await internalizeRefTokens(`canon #[${EXISTING_TAG}]`, resolvers)).toBe(
      `canon #[${EXISTING_TAG}]`,
    )
    expect(created.tags).toEqual([])
  })

  it('leaves a ((Block Name)) block ref as plain text (no by-name creation)', async () => {
    const { resolvers } = makeResolvers({})
    expect(await internalizeRefTokens('quote ((Some Block))', resolvers)).toBe(
      'quote ((Some Block))',
    )
  })

  it('does not read an intraword #frag as a tag', async () => {
    const { resolvers, created } = makeResolvers({})
    expect(await internalizeRefTokens('color#fff and a#b', resolvers)).toBe('color#fff and a#b')
    expect(created.tags).toEqual([])
  })

  it('creates a repeated new name exactly once across one line', async () => {
    const { resolvers, created } = makeResolvers({})
    const out = await internalizeRefTokens('[[Repeat]] then [[Repeat]]', resolvers)
    expect(out).toBe(`[[${NEW_PAGE}]] then [[${NEW_PAGE}]]`)
    expect(created.pages).toEqual(['Repeat'])
  })

  it('resolves mixed page links and tags in one line', async () => {
    const { resolvers } = makeResolvers({
      pages: { 'My Page': EXISTING_PAGE },
      tags: { todo: EXISTING_TAG },
    })
    expect(await internalizeRefTokens('[[My Page]] is #todo', resolvers)).toBe(
      `[[${EXISTING_PAGE}]] is #[${EXISTING_TAG}]`,
    )
  })

  it('does not rewrite a #tag substring inside an UNRESOLVED [[Page Name]] (#1867 review)', async () => {
    // A page name containing a `#tag`-looking substring that doesn't resolve must
    // stay verbatim — its `#alpha` must NOT be internalized (which would corrupt
    // the link into `[[Project #[ULID]]]`). A real tag outside the brackets still resolves.
    const { resolvers, created } = makeResolvers({ ambiguous: new Set(['Project #alpha']) })
    expect(await internalizeRefTokens('[[Project #alpha]] and #realtag', resolvers)).toBe(
      `[[Project #alpha]] and #[${NEW_TAG}]`,
    )
    // Only the outside tag was created; the in-bracket `alpha` was skipped.
    expect(created.tags).toEqual(['realtag'])
  })
})

// Full human-readable → internal → human-readable round-trip (#1440 + #1484):
// export renders names, re-import resolves them back to the right internal
// refs, and a second export renders the names again — a stable fixed point.
describe('wiki-link round-trip: humanize ⇄ internalize', () => {
  const PAGE = '01HZ0PAGE0000000000000000A'
  const TAG = '01HZ0TAG00000000000000000B'

  it('internal → human → internal recovers the canonical ULID tokens', async () => {
    const internal = `link [[${PAGE}]] tagged #[${TAG}]`
    // Export direction (#1440): ULIDs → names.
    const names: Record<string, string> = { [PAGE]: 'My Page', [TAG]: 'todo' }
    const humanized = humanizeRefTokens(internal, (u) => names[u])
    expect(humanized).toBe('link [[My Page]] tagged #todo')

    // Import direction (#1484): names → ULIDs (these pages/tags already exist).
    const resolvers: RefInternalizers = {
      page: async (n) => (n === 'My Page' ? PAGE : null),
      tag: async (n) => (n === 'todo' ? TAG : null),
    }
    expect(await internalizeRefTokens(humanized, resolvers)).toBe(internal)
  })
})
