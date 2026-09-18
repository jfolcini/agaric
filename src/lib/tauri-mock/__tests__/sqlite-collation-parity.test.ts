/**
 * Four probes for mock sites the conformance fixtures do not reach.
 *
 * SQLite's `BINARY` collation memcmps UTF-8 BYTES where JS `<` compares
 * UTF-16 CODE UNITS, and `COLLATE NOCASE` / `LIKE` fold ASCII `A`-`Z` only
 * where `toLowerCase()` folds all of Unicode. The page, alias, tag and
 * property-value sites the mock re-establishes are pinned by backend-authored
 * fixtures under `conformance/fixtures/` (`query_page_aliases`,
 * `page_alias_writes`, `query_tag_and_property_listings`,
 * `query_tag_and_property_boundaries`, `query_trash_and_page_listings`). The
 * four below are the sites no fixture drives: `filtered_blocks_query`'s tag
 * prefix, the backlink `PropertyText` LIKE, `list_spaces`, and the advanced
 * query's title sort. The two ordering probes seed the code-unit answer as the
 * insertion order, so a handler that dropped its sort reddens too.
 *
 * Not pinned anywhere: the property KEY tiebreaks (`list_property_keys`,
 * `list_property_definitions`), because the backend rejects a non-ASCII key
 * (`agaric-store/src/op.rs`, `commands/properties.rs`) and ASCII orders the
 * same under every compare; and the advanced query's cursor resume on a text
 * sort (`compareCursorValue`), which only shares its helper with the pinned
 * sort.
 *
 * Probe pairs: `Ärger` / `är` for the ASCII-only fold (`Ä` is C3 84, never
 * folded); `ｱ` (U+FF71, EF BD B1) and `🍎` (U+1F34E, F0 9F 8D 8E) for the
 * byte compare, where UTF-16 code units put the apple first (its leading
 * surrogate D83C is below FF71).
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { dispatch } from '@/lib/tauri-mock/handlers'
import { blockTags, blocks, makeBlock, properties } from '@/lib/tauri-mock/seed'

import { clearMock, id, setSpace } from './mock-store-helpers'

const SPACE = id('SPACE')
const GLOBAL = { kind: 'global' }

/** U+FF71 HALFWIDTH KATAKANA LETTER A — 3 UTF-8 bytes, code unit FF71. */
const KATAKANA = 'ｱ'
/** U+1F34E RED APPLE — 4 UTF-8 bytes, leading surrogate D83C. */
const APPLE = '\u{1F34E}'

function page(blockId: string, title: string): void {
  blocks.set(blockId, makeBlock(blockId, 'page', title, null, 1))
  setSpace(blockId, SPACE)
}

function tag(blockId: string, name: string): void {
  const b = makeBlock(blockId, 'tag', name, null, 1)
  b['space_id'] = SPACE
  blocks.set(blockId, b)
  setSpace(blockId, SPACE)
}

function setText(blockId: string, key: string, value: string): void {
  if (!properties.has(blockId)) properties.set(blockId, new Map())
  properties.get(blockId)?.set(key, {
    key,
    value_text: value,
    value_num: null,
    value_date: null,
    value_ref: null,
    value_bool: null,
  })
}

beforeEach(() => {
  clearMock()
})

describe('LIKE folds ASCII only', () => {
  it('a filtered_blocks_query tag prefix does not reach Ärger from är', () => {
    tag(id('T1'), 'Ärger')
    blocks.set(id('B1'), makeBlock(id('B1'), 'text', 'holder', null, 1))
    blockTags.set(id('B1'), new Set([id('T1')]))

    const ids = (prefix: string) =>
      (
        dispatch('filtered_blocks_query', {
          propertyFilters: [],
          tagFilters: { tagIds: [], prefixes: [prefix], mode: 'or' },
          blockType: null,
          scope: GLOBAL,
        }) as { items: Array<Record<string, unknown>> }
      ).items.map((b) => b['id'])

    // `tc.name LIKE 'är%'` (`commands/queries.rs`) folds `A`-`Z` only.
    expect(ids('är')).toEqual([])
    expect(ids('Är')).toEqual([id('B1')])
  })

  it('a backlink PropertyText Contains filter does not reach Ärger from är', () => {
    const target = id('T0')
    page(target, 'Target')
    page(id('SP'), 'Source page')
    const src = makeBlock(id('B1'), 'text', `[[${target}]]`, id('SP'), 1)
    src['page_id'] = id('SP')
    blocks.set(id('B1'), src)
    setText(id('B1'), 'note', 'Ärger')

    const matched = (value: string) =>
      (
        dispatch('list_backlinks_grouped', {
          blockId: target,
          scope: GLOBAL,
          filters: [{ type: 'PropertyText', key: 'note', value, op: 'Contains' }],
        }) as { filtered_count: number }
      ).filtered_count

    // `value_text LIKE '%…%'` (`backlink/filters.rs`) — the same ASCII-only fold.
    expect(matched('är')).toBe(0)
    expect(matched('Är')).toBe(1)
  })
})

describe('BINARY memcmps UTF-8 bytes, not UTF-16 code units', () => {
  it('list_spaces orders a halfwidth katakana name below an emoji one', () => {
    // Apple first, so the code-unit answer is also the insertion order.
    for (const [blockId, name] of [
      [id('S2'), APPLE],
      [id('S1'), KATAKANA],
    ] as const) {
      blocks.set(blockId, makeBlock(blockId, 'page', name, null, 1))
      setText(blockId, 'is_space', 'true')
    }

    const rows = dispatch('list_spaces', {}) as Array<{ name: string }>

    // `ORDER BY COALESCE(b.content, '') ASC, b.id ASC` (`list_spaces_inner`).
    expect(rows.map((r) => r.name)).toEqual([KATAKANA, APPLE])
  })

  it('a run_advanced_query title sort orders by UTF-8 bytes', () => {
    // Apple first, so the code-unit answer is also the insertion order.
    page(id('P2'), APPLE)
    page(id('P1'), KATAKANA)

    const rows = (
      dispatch('run_advanced_query', {
        request: { spaceId: SPACE, sort: [{ source: { type: 'Column', name: 'title' } }] },
      }) as { rows: Array<Record<string, unknown>> }
    ).rows

    // `ORDER BY pc.title` (`query/engine.rs`), `pages_cache.title` is BINARY.
    expect(rows.map((r) => r['content'])).toEqual([KATAKANA, APPLE])
  })
})
