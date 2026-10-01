/**
 * #5140 Phase 4a — mock `apply_page_source`, the save of a page edited as its
 * source buffer, over the mock's own `get_page_source` render. Both are
 * approximations of the backend grammar (bullets, indentation and continuation
 * lines; no markers or properties; names are `names.test.ts`), so what is
 * pinned here is the diff the mock applies: edits, creates, moves and deletes
 * by the id beside each line (#5160 A), and the refusals; Phase 5 adds the
 * merge of a stale buffer. Everything is read back through the mock's read
 * commands. Backend parity is pinned by the `apply_page_source*.json`
 * conformance fixtures.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import type { PageSourceReport } from '@/lib/bindings'
import { dispatch } from '@/lib/tauri-mock/handlers'
import {
  blockTags,
  blocks,
  makeBlock,
  opLog,
  pageAliases,
  properties,
  seedBlocks,
} from '@/lib/tauri-mock/seed'

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

/**
 * `buffer`, written as the page's source writes it, each block's ` ^ID` ending
 * its last line, as the editor holds it: the text less those anchors, each id
 * beside the line its block starts on.
 */
function byLine(buffer: string): { source: string; lineIds: Array<string | null> } {
  const lines = buffer.split('\n')
  const lineIds: Array<string | null> = lines.map(() => null)
  let start = 0
  lines.forEach((line, i) => {
    if (/^\s*- /.test(line)) start = i
    const anchor = / \^([0-9A-Z]{26})$/.exec(line)
    if (anchor === null) return
    lines[i] = line.slice(0, anchor.index)
    lineIds[start] = anchor[1] ?? null
  })
  return { source: lines.join('\n'), lineIds }
}

function apply(buffer: string, baseSource = source()): Report {
  return dispatch('apply_page_source', {
    pageId: PAGE,
    ...byLine(buffer),
    baseSource,
    merge: false,
  }) as Report
}

/** The refusal's `{ kind, code }`, or `null` when the command succeeds. */
function refusal(args: { source: string; pageId?: string; baseSource?: string }): unknown {
  try {
    dispatch('apply_page_source', {
      pageId: args.pageId ?? PAGE,
      ...byLine(args.source),
      baseSource: args.baseSource ?? source(),
      merge: false,
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

  it('refuses a stale base as RequiresRefresh, writing nothing', () => {
    const stale = INITIAL.replace('- alpha ^', '- alpha, as it was ^')
    const buffer = INITIAL.replace('- alpha ^', '- alpha, edited ^')

    expect(refusal({ source: buffer, baseSource: stale })).toEqual({
      kind: 'validation',
      code: 'RequiresRefresh',
    })
    expect(opLog).toHaveLength(0)
    expect(source()).toBe(INITIAL)
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

describe('tauri-mock apply_page_source with merge (#5140 Phase 5)', () => {
  /** Save `buffer`, written against `INITIAL`, over whatever the page holds now. */
  function merge(buffer: string, baseSource = INITIAL): Report {
    return dispatch('apply_page_source', {
      pageId: PAGE,
      ...byLine(buffer),
      baseSource,
      merge: true,
    }) as Report
  }

  const editThere = (blockId: string, toText: string): unknown =>
    dispatch('edit_block', { blockId, toText })
  const moveThere = (blockId: string, newParentId: string, newIndex: number): unknown =>
    dispatch('move_block', { blockId, newParentId, newIndex })
  const deleteThere = (blockId: string): unknown => dispatch('delete_block', { blockId })

  const contents = (parentId: string): Array<string | null> =>
    children(parentId).map((r) => r.content)

  beforeEach(() => {
    seedBlocks()
    blocks.clear()
    properties.clear()
    opLog.length = 0
    put(PAGE, 'page', 'Home', null, 1, PAGE)
    put(A, 'content', 'alpha', PAGE, 1, PAGE)
    put(B, 'content', 'bravo', PAGE, 2, PAGE)
    put(B1, 'content', 'bravo child', B, 1, PAGE)
    put(B11, 'content', 'grandchild', B1, 1, PAGE)
    put(C, 'content', 'charlie', PAGE, 3, PAGE)
    put(NESTED_PAGE, 'page', 'Nested', C, 1, NESTED_PAGE)
    put(D, 'content', 'delta', PAGE, 4, PAGE)
    put(M, 'content', MULTI, PAGE, 5, PAGE)
  })

  it('saves the buffer on a fresh base as a plain save does', () => {
    const buffer = `- delta ^${D}\n${INITIAL.replace(`- delta ^${D}\n`, '').replace('- bravo ^', '- bravo, edited ^')}- new\n`

    const report = merge(buffer, source())

    expect(report).toMatchObject({ created: 1, edited: 1, moved: 1, deleted: 0, warnings: [] })
    expect(contents(PAGE)).toEqual(['delta', 'alpha', 'bravo, edited', 'charlie', MULTI, 'new'])
  })

  it('a buffer left at its base keeps every change made on the page and writes nothing', () => {
    editThere(A, 'alpha, edited there')
    moveThere(D, PAGE, 0)
    deleteThere(B)
    moveThere(M, C, 1)
    const changed = source()
    const ops = opLog.length

    const report = merge(INITIAL)

    expect(report).toMatchObject({ ...COUNTS_NONE, warnings: [] })
    expect(opLog).toHaveLength(ops)
    expect(source()).toBe(changed)
  })

  it('writes an edit made in the buffer and keeps a different block the page edited', () => {
    editThere(B, 'bravo, edited there')

    const report = merge(INITIAL.replace('- delta ^', '- delta, edited here ^'))

    expect(report).toMatchObject({ ...COUNTS_NONE, edited: 1, warnings: [] })
    expect(contents(PAGE)).toEqual([
      'alpha',
      'bravo, edited there',
      'charlie',
      'delta, edited here',
      MULTI,
    ])
  })

  it("keeps both versions of a block both sides changed, the buffer's as a new block right before the page's", () => {
    editThere(B, 'bravo, edited there')

    const report = merge(INITIAL.replace('- bravo ^', '- bravo, edited here ^'))

    expect(report).toMatchObject({ ...COUNTS_NONE, created: 1 })
    expect(report.warnings).toEqual([
      "'bravo, edited there' was changed here and on the page; both versions kept",
    ])
    expect(tree(PAGE).slice(0, 3)).toEqual([
      { content: 'alpha', children: [] },
      { content: 'bravo, edited here', children: [] },
      {
        content: 'bravo, edited there',
        children: [{ content: 'bravo child', children: [{ content: 'grandchild', children: [] }] }],
      },
    ])
  })

  it('deletes what the buffer removed, except a block the page changed, which stays with a warning', () => {
    editThere(D, 'delta, edited there')

    const report = merge(INITIAL.replace(`- alpha ^${A}\n`, '').replace(`- delta ^${D}\n`, ''))

    expect(report).toMatchObject({ ...COUNTS_NONE, deleted: 1 })
    expect(report.warnings).toEqual([
      "'delta, edited there' changed on the page; your delete was not applied",
    ])
    expect(isLive(A)).toBe(false)
    expect(contents(PAGE)).toEqual(['bravo', 'charlie', 'delta, edited there', MULTI])
  })

  it('keeps what the page deleted deleted, except a block the buffer changed, saved as a new block with a warning', () => {
    deleteThere(A)
    deleteThere(D)

    const report = merge(INITIAL.replace('- delta ^', '- delta, edited here ^'))

    expect(report).toMatchObject({ ...COUNTS_NONE, created: 1 })
    expect(report.warnings).toEqual([
      "'delta, edited here' was deleted on the page; saved as a new block",
    ])
    expect([A, D].map(isLive)).toEqual([false, false])
    expect(contents(PAGE)).toEqual(['bravo', 'charlie', 'delta, edited here', MULTI])
  })

  it("keeps the page's order when only the page reordered", () => {
    moveThere(D, PAGE, 0)

    const report = merge(INITIAL.replace('- bravo ^', '- bravo, edited here ^'))

    expect(report).toMatchObject({ ...COUNTS_NONE, edited: 1, warnings: [] })
    expect(contents(PAGE)).toEqual(['delta', 'alpha', 'bravo, edited here', 'charlie', MULTI])
  })

  it("keeps the buffer's order when only the buffer reordered", () => {
    editThere(A, 'alpha, edited there')

    const report = merge(`- delta ^${D}\n${INITIAL.replace(`- delta ^${D}\n`, '')}`)

    expect(report).toMatchObject({ ...COUNTS_NONE, moved: 1, warnings: [] })
    expect(contents(PAGE)).toEqual(['delta', 'alpha, edited there', 'bravo', 'charlie', MULTI])
  })

  it("keeps the buffer's order, with a warning, when both sides reordered the same children differently", () => {
    moveThere(D, PAGE, 0)
    const multi = INITIAL.slice(INITIAL.indexOf('- multi'))

    const report = merge(`${multi}${INITIAL.replace(multi, '')}`)

    expect(report.warnings).toEqual([
      "the page's blocks were reordered here and on the page; your order kept",
    ])
    expect(contents(PAGE)).toEqual([MULTI, 'alpha', 'bravo', 'charlie', 'delta'])
  })

  it("keeps the page's parent, with a warning, for a block each side moved under a different parent", () => {
    moveThere(D, A, 0)

    const report = merge(INITIAL.replace(`- delta ^${D}`, `  - delta ^${D}`))

    expect(report.warnings).toEqual([
      "'delta' was moved here and on the page; the page's place kept",
    ])
    expect(contents(A)).toEqual(['delta'])
    expect(contents(C)).toEqual(['Nested'])
  })

  it("keeps the page's parent, with a warning, where the buffer's would make a block its own ancestor", () => {
    moveThere(A, D, 0)

    const report = merge(
      INITIAL.replace(`- delta ^${D}\n`, '').replace(
        `- alpha ^${A}`,
        `- alpha ^${A}\n  - delta ^${D}`,
      ),
    )

    expect(report.warnings).toEqual([
      "'delta' was moved here and on the page; the page's place kept",
    ])
    expect(tree(PAGE)).toEqual([
      expect.objectContaining({ content: 'bravo' }),
      expect.objectContaining({ content: 'charlie' }),
      { content: 'delta', children: [{ content: 'alpha', children: [] }] },
      { content: MULTI, children: [] },
    ])
  })

  it('moves a block the buffer added under one the page deleted up to where that block was', () => {
    deleteThere(D)

    const report = merge(INITIAL.replace(`- delta ^${D}\n`, `- delta ^${D}\n  - under delta\n`))

    expect(report).toMatchObject({ ...COUNTS_NONE, created: 1, warnings: [] })
    expect(isLive(D)).toBe(false)
    expect(contents(PAGE)).toEqual(['alpha', 'bravo', 'charlie', 'under delta', MULTI])
  })

  it("keeps a block added on each side after the same block, the buffer's first", () => {
    dispatch('create_block', {
      blockType: 'content',
      content: 'added there',
      parentId: PAGE,
      index: 1,
    })

    const report = merge(INITIAL.replace(`- bravo ^${B}`, `- added here\n- bravo ^${B}`))

    expect(report).toMatchObject({ ...COUNTS_NONE, created: 1, warnings: [] })
    expect(contents(PAGE)).toEqual([
      'alpha',
      'added here',
      'added there',
      'bravo',
      'charlie',
      'delta',
      MULTI,
    ])
  })
})

describe('tauri-mock get_page_buffer and apply_page_source by line ids (#5160 A)', () => {
  type Line = [string, string | null]

  interface Buffer {
    source: string
    text: string
    line_ids: Array<string | null>
  }

  const buffer = (): Buffer => dispatch('get_page_buffer', { pageId: PAGE }) as Buffer

  /** The page's buffer as lines, each with the id it carries. */
  function lines(): Line[] {
    const { text, line_ids } = buffer()
    return text.split('\n').map((line, i) => [line, line_ids[i] ?? null])
  }

  /** The `{ kind, code }` `run` throws, or `null` when it returns. */
  function thrown(run: () => unknown): unknown {
    try {
      run()
    } catch (err) {
      const { kind, code } = err as { kind?: unknown; code?: unknown }
      return { kind, code: code ?? null }
    }
    return null
  }

  function applyByLine(edited: Line[], merge = false, baseSource = source()): Report {
    return dispatch('apply_page_source', {
      pageId: PAGE,
      source: edited.map(([line]) => line).join('\n'),
      baseSource,
      merge,
      lineIds: edited.map(([, carried]) => carried),
    }) as Report
  }

  beforeEach(() => {
    seedBlocks()
    blocks.clear()
    properties.clear()
    opLog.length = 0
    put(PAGE, 'page', 'Home', null, 1, PAGE)
    put(A, 'content', 'alpha', PAGE, 1, PAGE)
    put(B, 'content', 'bravo', PAGE, 2, PAGE)
    put(B1, 'content', 'bravo child', B, 1, PAGE)
    put(C, 'content', 'charlie', PAGE, 3, PAGE)
    put(M, 'content', MULTI, PAGE, 4, PAGE)
    put(OTHER_PAGE, 'page', 'Elsewhere', null, 2, OTHER_PAGE)
    put(ELSEWHERE, 'content', 'on another page', OTHER_PAGE, 1, OTHER_PAGE)
  })

  it('gives the source, the source less its anchors, and the id each line carries', () => {
    const { source: anchored, text, line_ids } = buffer()

    expect(anchored).toBe(source())
    expect(text).toBe(
      '- alpha\n- bravo\n  - bravo child\n- charlie\n- multi\n\n    indented line\n',
    )
    expect(line_ids).toEqual([A, B, B1, C, M, null, null, null])
  })

  it('appends nothing for the page’s own text', () => {
    const report = applyByLine(lines())

    expect(report).toMatchObject({ ...COUNTS_NONE, warnings: [] })
    expect(opLog).toHaveLength(0)
  })

  it('edits the block whose line changed, no anchor needed', () => {
    const edited = lines()
    edited[1] = ['- bravo, edited ^note', B]

    const report = applyByLine(edited)

    expect(report).toMatchObject({ ...COUNTS_NONE, edited: 1, warnings: [] })
    expect(children(PAGE).map((r) => r.content)).toEqual([
      'alpha',
      'bravo, edited ^note',
      'charlie',
      MULTI,
    ])
  })

  it('moves a line cut and pasted in the buffer, keeping its id', () => {
    const edited = lines()
    const [cut] = edited.splice(0, 1) as [Line]
    edited.splice(3, 0, [`  ${cut[0]}`, cut[1]])

    const report = applyByLine(edited)

    expect(report).toMatchObject({ ...COUNTS_NONE, moved: 1 })
    expect(children(C).map((r) => r.id)).toEqual([A])
  })

  it('saves a copied line as a new block, the first line keeping the id, with a warning', () => {
    const edited = lines()
    edited.splice(4, 0, ['- alpha again', A])

    const report = applyByLine(edited)

    expect(report).toMatchObject({
      ...COUNTS_NONE,
      created: 1,
      warnings: ['line 5: a copy of the block on line 1; saved as a new block'],
    })
    expect(children(PAGE).map((r) => [r.id === A, r.content])).toEqual([
      [true, 'alpha'],
      [false, 'bravo'],
      [false, 'charlie'],
      [false, 'alpha again'],
      [false, MULTI],
    ])
  })

  it('saves a line carrying another page’s id as a new block, with a warning', () => {
    const edited = lines()
    edited.splice(1, 0, ['- borrowed', ELSEWHERE])

    const report = applyByLine(edited)

    expect(report).toMatchObject({
      ...COUNTS_NONE,
      created: 1,
      warnings: ['line 2: not a block of this page; saved as a new block'],
    })
    expect(children(PAGE)[1]?.content).toBe('borrowed')
    expect(children(PAGE)[1]?.id).not.toBe(ELSEWHERE)
    expect(children(OTHER_PAGE).map((r) => r.id)).toEqual([ELSEWHERE])
  })

  it('refuses line ids that are not one per line, writing nothing', () => {
    const edited = lines()
    const lineIds = edited.map(([, carried]) => carried)
    for (const ids of [lineIds.slice(1), [...lineIds, null]]) {
      const refused = thrown(() =>
        dispatch('apply_page_source', {
          pageId: PAGE,
          source: edited.map(([line]) => line).join('\n'),
          baseSource: source(),
          merge: false,
          lineIds: ids,
        }),
      )
      expect(refused).toEqual({ kind: 'validation', code: null })
    }
    expect(opLog).toHaveLength(0)
  })

  it('ends a fence left open at the next line carrying an id, with a warning', () => {
    const edited = lines()
    edited[0] = ['- ```', A]
    edited.splice(1, 0, ['- not a block', null])

    const report = applyByLine(edited)

    expect(report).toMatchObject({
      ...COUNTS_NONE,
      edited: 1,
      warnings: [
        'the ``` code fence opened on line 1 is not closed; it ends before the block on line 3',
      ],
    })
    expect(children(PAGE).map((r) => r.content)).toEqual([
      '```\n- not a block',
      'bravo',
      'charlie',
      MULTI,
    ])
  })

  it('refuses a stale text, and folds the page’s change in with merge', () => {
    const base = source()
    const edited = lines()
    edited[0] = ['- alpha, in the buffer', A]
    dispatch('edit_block', { blockId: C, toText: 'charlie, on the page' })
    opLog.length = 0

    expect(thrown(() => applyByLine(edited, false, base))).toEqual({
      kind: 'validation',
      code: 'RequiresRefresh',
    })
    const report = applyByLine(edited, true, base)

    expect(report).toMatchObject({ ...COUNTS_NONE, edited: 1, warnings: [] })
    expect(children(PAGE).map((r) => r.content)).toEqual([
      'alpha, in the buffer',
      'bravo',
      'charlie, on the page',
      MULTI,
    ])
  })
})

describe('tauri-mock apply_page_source front matter (#5160 S8)', () => {
  const SPACE = id('SPACE')
  const WORK = id('WORK')
  const HEAD = '---\naliases: [Home base]\ntags: [work]\nstage: open\n---\n\n'
  const BODY = `- alpha ^${A}\n`

  const textRow = (key: string, value: string): Record<string, unknown> => ({
    key,
    value_text: value,
    value_num: null,
    value_date: null,
    value_ref: null,
    value_bool: null,
  })

  /** The refusal's message, or `null` when the save succeeds. */
  function refusedWith(buffer: string): unknown {
    try {
      apply(buffer)
    } catch (err) {
      return (err as { message?: unknown }).message
    }
    return null
  }

  const pageKeys = (): Record<string, unknown> =>
    Object.fromEntries(
      [...(properties.get(PAGE) ?? [])].map(([key, row]) => [key, row['value_text']]),
    )
  const pageTags = (): unknown[] =>
    [...(blockTags.get(PAGE) ?? [])].map((tagId) => blocks.get(tagId)?.['content'])

  beforeEach(() => {
    seedBlocks()
    blocks.clear()
    properties.clear()
    blockTags.clear()
    pageAliases.clear()
    opLog.length = 0
    put(PAGE, 'page', 'Home', null, 1, PAGE)['space_id'] = SPACE
    put(A, 'content', 'alpha', PAGE, 1, PAGE)['space_id'] = SPACE
    put(WORK, 'tag', 'work', null, 2, null)['space_id'] = SPACE
    properties.set(
      PAGE,
      new Map([
        ['stage', textRow('stage', 'open')],
        ['template', textRow('template', 'x')],
      ]),
    )
    pageAliases.set(PAGE, ['Home base'])
    blockTags.set(PAGE, new Set([WORK]))
  })

  it('heads the buffer with the aliases, tags and shown properties, and saving it writes nothing', () => {
    expect(source()).toBe(`${HEAD}${BODY}`)

    const report = apply(source())

    expect(report).toMatchObject({ ...COUNTS_NONE, properties_set: 0, properties_deleted: 0 })
    expect(opLog).toHaveLength(0)
  })

  it('sets, adds and deletes properties, and a key it does not show stays', () => {
    properties.get(PAGE)?.set('drop', textRow('drop', 'me'))

    const report = apply(
      source().replace('drop: me\n', '').replace('stage: open\n', 'stage: done\nowner: ann\n'),
    )

    expect(report).toMatchObject({ properties_set: 2, properties_deleted: 1 })
    expect(pageKeys()).toEqual({ stage: 'done', template: 'x', owner: 'ann' })
  })

  it('replaces the aliases and tags, creating a tag no tag of the space names', () => {
    const report = apply(
      source().replace('aliases: [Home base]', 'aliases: [HQ]').replace('[work]', '[idea]'),
    )

    expect(pageAliases.get(PAGE)).toEqual(['HQ'])
    expect(pageTags()).toEqual(['idea'])
    expect(report.names_created.map((row) => row.content)).toEqual(['idea'])
  })

  it('refuses unreadable front matter or a refused value by its line, writing nothing', () => {
    const typed = (line: string) => source().replace('stage: open\n', `stage: open\n${line}\n`)

    expect(refusedWith(typed('not a pair'))).toBe('line 5: `not a pair` is not a `key: value` line')
    expect(refusedWith(typed('space: x'))).toBe(
      'line 5: `space` is kept by the app, not the front matter',
    )
    expect(refusedWith(typed('stage: done'))).toBe('line 5: `stage` is written twice')
    expect(refusedWith(typed('status: nope'))).toMatch(/^line 5: `status: nope` cannot be saved: /)
    expect(refusedWith(source().replace('---\n\n', '\n'))).toBe(
      'line 1: the front matter this `---` opens has no closing `---`',
    )
    expect(opLog).toHaveLength(0)
  })

  it('merged, keeps what the page changed since the buffer was loaded', () => {
    const base = source()
    dispatch('set_property', {
      blockId: PAGE,
      key: 'owner',
      value: { value_text: 'bob', value_num: null, value_date: null, value_ref: null },
    })

    dispatch('apply_page_source', {
      pageId: PAGE,
      ...byLine(base.replace('stage: open', 'stage: done')),
      baseSource: base,
      merge: true,
    })

    expect(pageKeys()).toEqual({ stage: 'done', template: 'x', owner: 'bob' })
  })

  describe('by line ids (#5160 A)', () => {
    type Line = [string, string | null]

    const buffer = () =>
      dispatch('get_page_buffer', { pageId: PAGE }) as {
        source: string
        text: string
        line_ids: Array<string | null>
      }

    function lines(): Line[] {
      const { text, line_ids } = buffer()
      return text.split('\n').map((line, i) => [line, line_ids[i] ?? null])
    }

    function applyByLine(edited: Line[]): Report {
      return dispatch('apply_page_source', {
        pageId: PAGE,
        source: edited.map(([line]) => line).join('\n'),
        baseSource: source(),
        merge: false,
        lineIds: edited.map(([, carried]) => carried),
      }) as Report
    }

    it('keeps the front matter in the text, its lines carrying no id', () => {
      const { text, line_ids } = buffer()

      expect(text).toBe(`${HEAD}- alpha\n`)
      expect(line_ids).toEqual([null, null, null, null, null, null, A, null])
    })

    it('saves the page’s own text as nothing', () => {
      const report = applyByLine(lines())

      expect(report).toMatchObject({ ...COUNTS_NONE, properties_set: 0, warnings: [] })
      expect(opLog).toHaveLength(0)
    })

    it('writes a front matter property and a block edited in one save', () => {
      const edited = lines()
      edited[3] = ['stage: done', null]
      edited[6] = ['- alpha, edited', A]

      const report = applyByLine(edited)

      expect(report).toMatchObject({ ...COUNTS_NONE, edited: 1, properties_set: 1, warnings: [] })
      expect(pageKeys()).toEqual({ stage: 'done', template: 'x' })
      expect(blocks.get(A)?.['content']).toBe('alpha, edited')
    })

    it('names the buffer line of a copy below the front matter, and of a refusal in it', () => {
      const own = lines()
      const copied = [...own.slice(0, 7), own[6] as Line, ...own.slice(7)]
      const unreadable = [...own.slice(0, 4), ['not a pair', null] as Line, ...own.slice(4)]

      expect(() => applyByLine(unreadable)).toThrow(/^line 5: `not a pair` is not/)
      expect(applyByLine(copied).warnings).toEqual([
        'line 8: a copy of the block on line 7; saved as a new block',
      ])
    })
  })
})
