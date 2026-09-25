/**
 * #5160 Phase 3a — the mock's name pass (`resolveInboundNames`), through the
 * commands that run it: `paste_blocks` and `apply_page_source`. The rule is the
 * backend's (N4): exact title, then a unique case-insensitive title, then a
 * unique alias, else a new page, and a case tie is never guessed; tags resolve
 * by normalised name. Everything is read back through the mock's stores;
 * backend parity for the paste is pinned by
 * `conformance/fixtures/paste_blocks.json`.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import type { PageSourceReport } from '@/lib/bindings'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, makeBlock, pageAliases, properties, seedBlocks } from '@/lib/tauri-mock/seed'

const id = (label: string): string => label.padStart(26, '0')
const SPACE = id('SPACE')
const PAGE = id('PAGE')
const ANCHOR = id('ANCHOR')
const PLAN = id('PLAN')
const ROADMAP = id('ROADMAP')
const FOO = id('FOO')
const FOO_LOWER = id('FOOLOWER')
const WORK = id('WORK')
const NO_SPACE_PAGE = id('NOSPACEPAGE')
const NO_SPACE_ANCHOR = id('NOSPACEANCHOR')

interface Row {
  id: string
  block_type: string
  content: string | null
}

function put(
  blockId: string,
  type: string,
  content: string,
  parent: string | null,
): Record<string, unknown> {
  const row = makeBlock(blockId, type, content, parent, blocks.size)
  if (type === 'page' || type === 'tag') {
    row['space_id'] = SPACE
    properties.set(
      blockId,
      new Map([['space', { key: 'space', value_ref: SPACE, value_text: null }]]),
    )
  } else {
    row['page_id'] = parent
  }
  blocks.set(blockId, row)
  return row
}

function paste(anchor: string, text: string): Row[] {
  return (
    dispatch('paste_blocks', { anchorBlockId: anchor, input: { kind: 'text', text } }) as {
      blocks: Row[]
    }
  ).blocks
}

const livePages = (title: string): Row[] =>
  [...blocks.values()].filter(
    (b) => b['block_type'] === 'page' && b['content'] === title && b['deleted_at'] == null,
  ) as unknown as Row[]

beforeEach(() => {
  seedBlocks()
  blocks.clear()
  properties.clear()
  pageAliases.clear()
  put(SPACE, 'page', 'Space', null)
  put(PAGE, 'page', 'Home', null)
  put(ANCHOR, 'content', 'the anchor', PAGE)
  put(PLAN, 'page', 'Project Plan', null)
  put(ROADMAP, 'page', 'Roadmap', null)
  pageAliases.set(ROADMAP, ['rm'])
  put(FOO, 'page', 'Foo', null)
  put(FOO_LOWER, 'page', 'foo', null)
  put(WORK, 'tag', 'Work', null)
  put(NO_SPACE_PAGE, 'page', 'Elsewhere', null)['space_id'] = null
  properties.delete(NO_SPACE_PAGE)
  put(NO_SPACE_ANCHOR, 'content', 'spaceless', NO_SPACE_PAGE)
})

describe('paste_blocks resolves names in the anchor’s space (#5160 N4)', () => {
  it('links the exact title, a unique case variant and a unique alias without creating', () => {
    const rows = paste(ANCHOR, '- see [[Project Plan]] [[project plan]] [[RM]]')
    expect(rows.map((r) => r.block_type)).toEqual(['content'])
    expect(rows[0]?.content).toBe(`see [[${PLAN}]] [[${PLAN}]] [[${ROADMAP}]]`)
    expect(livePages('project plan')).toHaveLength(0)
  })

  it('creates a page for a name nothing matches and reports it first', () => {
    const rows = paste(ANCHOR, '- see [[Fresh Page]]')
    expect(rows.map((r) => r.block_type)).toEqual(['page', 'content'])
    const fresh = rows[0] as Row
    expect(fresh.content).toBe('Fresh Page')
    expect(blocks.get(fresh.id)?.['space_id']).toBe(SPACE)
    expect(rows[1]?.content).toBe(`see [[${fresh.id}]]`)
  })

  it('never guesses between two pages that differ only by case', () => {
    const rows = paste(ANCHOR, '- tie [[FOO]] and exact [[Foo]]')
    expect(rows.map((r) => r.block_type)).toEqual(['content'])
    expect(rows[0]?.content).toBe(`tie [[FOO]] and exact [[${FOO}]]`)
    expect(livePages('FOO')).toHaveLength(0)
  })

  it('resolves a tag by normalised name, creates the rest, and leaves non-tags as text', () => {
    const rows = paste(ANCHOR, '- #work #fresh #42 it&#39;s [#A] \\#no https://x.dev/#frag `#code`')
    expect(rows.map((r) => [r.block_type, r.content])).toEqual([
      ['tag', 'fresh'],
      [
        'content',
        `#[${WORK}] #[${rows[0]?.id}] #42 it&#39;s [#A] \\#no https://x.dev/#frag \`#code\``,
      ],
    ])
    const tags = [...blocks.values()].filter((b) => b['block_type'] === 'tag')
    expect(tags.map((b) => b['content'])).toEqual(['Work', 'fresh'])
  })

  it('leaves every name as text when the anchor is in no space', () => {
    const rows = paste(NO_SPACE_ANCHOR, '- see [[Project Plan]] #work')
    expect(rows.map((r) => [r.block_type, r.content])).toEqual([
      ['content', 'see [[Project Plan]] #work'],
    ])
  })
})

describe('apply_page_source resolves the names new bullets write (#5160 N4)', () => {
  it('reports the created page and links the folded title', () => {
    const base = dispatch('get_page_source', { pageId: PAGE }) as string
    const report = dispatch('apply_page_source', {
      pageId: PAGE,
      source: `${base}- new [[project plan]] [[Brand New]]\n`,
      baseSource: base,
      force: false,
      merge: false,
    }) as PageSourceReport
    expect(report.names_created.map((r) => r.content)).toEqual(['Brand New'])
    const created = report.names_created[0]?.id
    const bullet = [...blocks.values()].find((b) => (b['content'] as string).startsWith('new '))
    expect(bullet?.['content']).toBe(`new [[${PLAN}]] [[${created}]]`)
  })
})
