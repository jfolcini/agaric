/**
 * #6278 I4 — the mock's twin of the tag-name whitespace rule on the paths no
 * fixture can drive: a paste or import creating a tag mints an id the command
 * leg cannot relabel in content (`paste_blocks.json`), and a create resolving
 * an existing spaced tag needs that tag seeded in a live space. The mock's
 * paste models no `warnings`, so the import carries the warning here. The
 * refusals are pinned by the backend-authored `tag_name_without_whitespace.json`.
 * Rust twins:
 * `import_dashes_a_multi_word_tag_naming_no_tag_6278`,
 * `paste_resolves_a_multi_word_tag_to_its_existing_tag_6278` and
 * `a_tag_named_before_the_rule_still_resolves_and_renames_6278`.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import type { PageBuffer, PageSourceReport } from '@/lib/bindings'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, makeBlock, pageAliases, properties, seedBlocks } from '@/lib/tauri-mock/seed'

const id = (label: string): string => label.padStart(26, '0')
const SPACE = id('SPACE')
const PAGE = id('PAGE')
const ANCHOR = id('ANCHOR')
const DASHED = id('DASHED')
const SPACED = id('SPACED')

interface Row {
  id: string
  block_type: string
  content: string | null
}

function put(blockId: string, type: string, content: string, parent: string | null): void {
  const row = makeBlock(blockId, type, content, parent, blocks.size)
  if (type === 'content') row['page_id'] = parent
  else row['space_id'] = SPACE
  blocks.set(blockId, row)
}

function paste(text: string): Row[] {
  return (
    dispatch('paste_blocks', { anchorBlockId: ANCHOR, input: { kind: 'text', text } }) as {
      blocks: Row[]
    }
  ).blocks
}

const liveTags = (): string[] =>
  [...blocks.values()]
    .filter((b) => b['block_type'] === 'tag' && b['deleted_at'] == null)
    .map((b) => b['content'] as string)

beforeEach(() => {
  seedBlocks()
  blocks.clear()
  properties.clear()
  pageAliases.clear()
  put(SPACE, 'page', 'Space', null)
  put(PAGE, 'page', 'Home', null)
  put(ANCHOR, 'content', 'the anchor', PAGE)
})

describe('a pasted or imported multi-word tag is spelled with dashes (#6278 I4)', () => {
  it('pastes `#[[multi word]]` naming no tag as a new `multi-word`', () => {
    const rows = paste('- a #[[multi word]] here')

    const created = rows[0] as Row
    expect(rows.map((r) => [r.block_type, r.content])).toEqual([
      ['tag', 'multi-word'],
      ['content', `a #[${created.id}] here`],
    ])
  })

  it('pastes to an existing dashed tag, and to an existing spaced one by its name', () => {
    put(DASHED, 'tag', 'multi-word', null)
    put(SPACED, 'tag', 'deep work', null)

    const rows = paste('- see #[[Multi Word]] and #[[Deep Work]]')

    expect(rows.map((r) => r.content)).toEqual([`see #[${DASHED}] and #[${SPACED}]`])
    expect(liveTags()).toEqual(['multi-word', 'deep work'])
  })

  it('names the respelled tag in an import’s warnings', () => {
    const result = dispatch('import_markdown', {
      content: '- a #[[multi word]] here',
      filename: 'Dashed.md',
      spaceId: SPACE,
    }) as { warnings: string[] }

    expect(liveTags()).toEqual(['multi-word'])
    expect(result.warnings).toContain(
      "tag 'multi word' was read as 'multi-word': a tag name holds no whitespace",
    )
  })
})

describe('create_block keeps resolving a tag named before the rule (#6278 I4)', () => {
  it('answers a spaced name a tag holds with that tag, creating nothing', () => {
    put(SPACED, 'tag', 'deep work', null)

    const row = dispatch('create_block', {
      blockType: 'tag',
      content: 'Deep Work',
      parentId: null,
      index: null,
      scope: { kind: 'active', space_id: SPACE },
      blockId: null,
    }) as Row

    expect(row.id).toBe(SPACED)
    expect(liveTags()).toEqual(['deep work'])
  })
})

describe('Edit as Markdown names the tag it respells (#6278 I4)', () => {
  it('names a new bullet’s `#[[multi word]]` in apply_page_source’s warnings', () => {
    const base = dispatch('get_page_buffer', { pageId: PAGE }) as PageBuffer
    const report = dispatch('apply_page_source', {
      pageId: PAGE,
      source: `${base.text}- b #[[multi word]] there\n`,
      baseSource: base.source,
      merge: false,
      lineIds: [...base.line_ids, null],
    }) as PageSourceReport

    expect(liveTags()).toEqual(['multi-word'])
    expect(report.warnings).toEqual([
      "tag 'multi word' was read as 'multi-word': a tag name holds no whitespace",
    ])
  })
})
