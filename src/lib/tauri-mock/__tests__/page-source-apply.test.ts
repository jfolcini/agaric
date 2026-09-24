/**
 * #5140 Phase 4a — mock `apply_page_source`, the save of a page edited as its
 * source buffer, over the mock's own `get_page_source` render. Both are
 * approximations of the backend grammar (bullets, indentation, continuation
 * lines and `^ID` anchors; no markers, properties or names), so what is pinned
 * here is the diff the mock applies: edits, creates, moves and deletes by
 * anchor, and the refusals. Everything is read back through the mock's read
 * commands. Backend parity is pinned by
 * `conformance/fixtures/apply_page_source.json`.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import type { PageSourceReport } from '@/lib/bindings'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, makeBlock, opLog, properties, seedBlocks } from '@/lib/tauri-mock/seed'

const id = (label: string): string => label.padStart(26, '0')
const PAGE = id('PAGE')
const OTHER_PAGE = id('OTHERPAGE')
const A = id('A')
const B = id('B')
const B1 = id('B1')
const B11 = id('B11')
const C = id('C')
const NESTED_PAGE = id('NESTEDPAGE')
const UNDER_NESTED = id('UNDERNESTED')
const D = id('D')
const M = id('M')
const TRASHED = id('TRASHED')
const TRASHED_PAGE = id('TRASHEDPAGE')
const ELSEWHERE = id('ELSEWHERE')
const MISSING = id('MISSING')

const MULTI = 'multi\n\n  indented line'

type Report = PageSourceReport & { op_refs: Array<{ device_id: string; seq: number }> }

interface Row {
  id: string
  content: string | null
  parent_id: string | null
}

function put(
  blockId: string,
  type: string,
  content: string,
  parent: string | null,
  position: number,
  pageId: string | null,
): Record<string, unknown> {
  const row = makeBlock(blockId, type, content, parent, position)
  row['page_id'] = pageId
  blocks.set(blockId, row)
  return row
}

function source(pageId = PAGE): string {
  return dispatch('get_page_source', { pageId }) as string
}

function apply(buffer: string, force = false, baseSource = source()): Report {
  return dispatch('apply_page_source', {
    pageId: PAGE,
    source: buffer,
    baseSource,
    force,
  }) as Report
}

/** The refusal's `{ kind, code }`, or `null` when the command succeeds. */
function refusal(args: {
  source: string
  pageId?: string
  baseSource?: string
  force?: boolean
}): unknown {
  try {
    dispatch('apply_page_source', {
      pageId: args.pageId ?? PAGE,
      source: args.source,
      baseSource: args.baseSource ?? source(),
      force: args.force ?? false,
    })
  } catch (err) {
    const { kind, code } = err as { kind?: unknown; code?: unknown }
    return { kind, code: code ?? null }
  }
  return null
}

function children(parentId: string): Row[] {
  const page = dispatch('list_blocks', { request: { parentId, limit: 100 } }) as { items: Row[] }
  return page.items
}

/** `parentId`'s subtree as `content` / nested `children`, in sibling order. */
function tree(parentId: string): unknown[] {
  return children(parentId).map((r) => ({ content: r.content, children: tree(r.id) }))
}

function isLive(blockId: string): boolean {
  try {
    dispatch('get_block', { blockId })
    return true
  } catch {
    return false
  }
}

const COUNTS_NONE = { created: 0, edited: 0, moved: 0, deleted: 0 }

const INITIAL = [
  `- alpha ^${A}`,
  `- bravo ^${B}`,
  `  - bravo child ^${B1}`,
  `    - grandchild ^${B11}`,
  `- charlie ^${C}`,
  `- delta ^${D}`,
  `- multi`,
  ``,
  `    indented line ^${M}`,
  ``,
].join('\n')

describe('tauri-mock apply_page_source', () => {
  beforeEach(() => {
    seedBlocks()
    blocks.clear()
    properties.clear()
    opLog.length = 0

    // PAGE > A, B > B1 > B11, C > NESTED_PAGE > UNDER_NESTED, D, M, TRASHED
    put(PAGE, 'page', 'Home', null, 1, PAGE)
    put(A, 'content', 'alpha', PAGE, 1, PAGE)
    put(B, 'content', 'bravo', PAGE, 2, PAGE)
    put(B1, 'content', 'bravo child', B, 1, PAGE)
    put(B11, 'content', 'grandchild', B1, 1, PAGE)
    put(C, 'content', 'charlie', PAGE, 3, PAGE)
    put(NESTED_PAGE, 'page', 'Nested', C, 1, NESTED_PAGE)
    put(UNDER_NESTED, 'content', 'under the nested page', NESTED_PAGE, 1, NESTED_PAGE)
    put(D, 'content', 'delta', PAGE, 4, PAGE)
    put(M, 'content', MULTI, PAGE, 5, PAGE)
    put(TRASHED, 'content', 'gone', PAGE, 6, PAGE)['deleted_at'] = 1
    put(OTHER_PAGE, 'page', 'Elsewhere', null, 2, OTHER_PAGE)
    put(TRASHED_PAGE, 'page', 'Gone', null, 3, TRASHED_PAGE)['deleted_at'] = 1
    put(ELSEWHERE, 'content', 'on another page', OTHER_PAGE, 1, OTHER_PAGE)
  })

  it('renders content blocks only, continuation lines indented under their bullet', () => {
    expect(source()).toBe(INITIAL)
  })

  it('appends nothing for an unchanged buffer', () => {
    const report = apply(INITIAL)

    expect(report).toEqual({
      op_refs: [],
      ...COUNTS_NONE,
      properties_set: 0,
      properties_deleted: 0,
      names_created: [],
      warnings: [],
    })
    expect(opLog).toHaveLength(0)
    expect(source()).toBe(INITIAL)
  })

  it('edits a block whose text changed, and only that block', () => {
    const report = apply(INITIAL.replace('- bravo ^', '- bravo, edited ^'))

    expect(report).toMatchObject({ ...COUNTS_NONE, edited: 1 })
    expect(opLog.map((op) => op.op_type)).toEqual(['edit_block'])
    expect(report.op_refs).toEqual(opLog.map((op) => ({ device_id: op.device_id, seq: op.seq })))
    expect(children(PAGE).map((r) => r.content)).toEqual([
      'alpha',
      'bravo, edited',
      'charlie',
      'delta',
      MULTI,
    ])
  })

  it('creates an unanchored bullet where it stands, with its nested child under it', () => {
    const report = apply(
      INITIAL.replace(`- bravo ^${B}`, `- new one\n  - its child\n- bravo ^${B}`),
    )

    expect(report).toMatchObject({ ...COUNTS_NONE, created: 2 })
    expect(tree(PAGE).slice(0, 3)).toEqual([
      { content: 'alpha', children: [] },
      { content: 'new one', children: [{ content: 'its child', children: [] }] },
      expect.objectContaining({ content: 'bravo' }),
    ])
  })

  it('keeps a trailing caret word that is not a block id as text', () => {
    const report = apply(`${INITIAL}- x ^2\n`)

    expect(report).toMatchObject({ ...COUNTS_NONE, created: 1, warnings: [] })
    expect(children(PAGE).at(-1)?.content).toBe('x ^2')
  })

  it('keeps text typed above the first bullet as a block of its own', () => {
    const report = apply(`typed on top\n${INITIAL}`)

    expect(report).toMatchObject({ ...COUNTS_NONE, created: 1 })
    expect(children(PAGE).map((r) => r.content)).toEqual([
      'typed on top',
      'alpha',
      'bravo',
      'charlie',
      'delta',
      MULTI,
    ])
  })

  it('reorders with one move, keeping the longest run already in order', () => {
    const report = apply(
      INITIAL.replace(`- delta ^${D}\n`, '').replace(
        `- alpha ^${A}`,
        `- delta ^${D}\n- alpha ^${A}`,
      ),
    )

    expect(report).toMatchObject({ ...COUNTS_NONE, moved: 1 })
    expect(opLog.map((op) => op.op_type)).toEqual(['move_block'])
    expect(children(PAGE).map((r) => r.content)).toEqual([
      'delta',
      'alpha',
      'bravo',
      'charlie',
      MULTI,
    ])
    // The nested page, hidden from the buffer, stays under its parent.
    expect(children(C).map((r) => r.id)).toEqual([NESTED_PAGE])
  })

  it('reparents a block under the bullet it is indented beneath', () => {
    const report = apply(
      INITIAL.replace(`- delta ^${D}\n`, '').replace(
        `- alpha ^${A}`,
        `- alpha ^${A}\n  - delta ^${D}`,
      ),
    )

    expect(report).toMatchObject({ ...COUNTS_NONE, moved: 1 })
    expect(children(A).map((r) => r.content)).toEqual(['delta'])
    expect(children(PAGE).map((r) => r.content)).toEqual(['alpha', 'bravo', 'charlie', MULTI])
  })

  it('deletes a block left out of the buffer with its subtree, in one op', () => {
    const report = apply(
      INITIAL.replace(`- bravo ^${B}\n  - bravo child ^${B1}\n    - grandchild ^${B11}\n`, ''),
    )

    expect(report).toMatchObject({ ...COUNTS_NONE, deleted: 3 })
    expect(opLog.map((op) => op.op_type)).toEqual(['delete_block'])
    expect([B, B1, B11].map(isLive)).toEqual([false, false, false])
    expect(children(PAGE).map((r) => r.content)).toEqual(['alpha', 'charlie', 'delta', MULTI])
  })

  it('moves a kept child out before deleting its parent', () => {
    const report = apply(
      INITIAL.replace(
        `- bravo ^${B}\n  - bravo child ^${B1}\n    - grandchild ^${B11}`,
        `- bravo child ^${B1}\n  - grandchild ^${B11}`,
      ),
    )

    expect(report).toMatchObject({ ...COUNTS_NONE, moved: 1, deleted: 1 })
    expect(opLog.map((op) => op.op_type)).toEqual(['move_block', 'delete_block'])
    expect(isLive(B)).toBe(false)
    expect(tree(PAGE).slice(0, 2)).toEqual([
      { content: 'alpha', children: [] },
      { content: 'bravo child', children: [{ content: 'grandchild', children: [] }] },
    ])
  })

  it('refuses a stale base as RequiresRefresh even with force, writing nothing', () => {
    const stale = INITIAL.replace('- alpha ^', '- alpha, as it was ^')
    const buffer = INITIAL.replace('- alpha ^', '- alpha, edited ^')

    expect(refusal({ source: buffer, baseSource: stale })).toEqual({
      kind: 'validation',
      code: 'RequiresRefresh',
    })
    expect(refusal({ source: buffer, baseSource: stale, force: true })).toEqual({
      kind: 'validation',
      code: 'RequiresRefresh',
    })
    expect(opLog).toHaveLength(0)
    expect(source()).toBe(INITIAL)
  })

  it('refuses an anchor that is not a block of this page unless forced', () => {
    for (const foreign of [ELSEWHERE, TRASHED, NESTED_PAGE]) {
      expect(refusal({ source: `${INITIAL}- adopted ^${foreign}\n` })).toEqual({
        kind: 'validation',
        code: null,
      })
    }
    expect(opLog).toHaveLength(0)
  })

  it('with force, saves a foreign anchor as a new block and warns', () => {
    const report = apply(`${INITIAL}- adopted ^${ELSEWHERE}\n`, true)

    expect(report).toMatchObject({ ...COUNTS_NONE, created: 1 })
    expect(report.warnings).toEqual([`^${ELSEWHERE} no longer on this page; saved as a new block`])
    const created = children(PAGE).at(-1)
    expect(created?.content).toBe('adopted')
    expect(created?.id).not.toBe(ELSEWHERE)
    expect(children(OTHER_PAGE).map((r) => [r.id, r.content])).toEqual([
      [ELSEWHERE, 'on another page'],
    ])
  })

  it('refuses a buffer that names one anchor twice, even with force', () => {
    const buffer = `${INITIAL}- again ^${A}\n`

    expect(refusal({ source: buffer })).toEqual({ kind: 'validation', code: null })
    expect(refusal({ source: buffer, force: true })).toEqual({ kind: 'validation', code: null })
    expect(opLog).toHaveLength(0)
  })

  it('refuses a page whose source does not read back as its blocks', () => {
    // A continuation line that is itself a bullet: the mock writes no escape.
    put(D, 'content', 'delta\n- not a bullet', PAGE, 4, PAGE)

    expect(refusal({ source: source() })).toEqual({ kind: 'validation', code: null })
    expect(opLog).toHaveLength(0)
  })

  it('refuses to delete a block a nested page sits under', () => {
    expect(refusal({ source: INITIAL.replace(`- charlie ^${C}\n`, '') })).toEqual({
      kind: 'validation',
      code: null,
    })
    expect(opLog).toHaveLength(0)
  })

  it('refuses an unknown or trashed page as not_found and a content block as validation', () => {
    expect(refusal({ source: '', pageId: MISSING, baseSource: '' })).toEqual({
      kind: 'not_found',
      code: null,
    })
    expect(refusal({ source: '', pageId: TRASHED_PAGE, baseSource: '' })).toEqual({
      kind: 'not_found',
      code: null,
    })
    expect(refusal({ source: '', pageId: A, baseSource: '' })).toEqual({
      kind: 'validation',
      code: null,
    })
  })
})
