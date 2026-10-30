/**
 * #5140 Phase 3b — mock `get_blocks_source` and `paste_blocks`, the clipboard
 * pair, both in the Document dialect (#6190). The copy approximates the
 * backend's (no anchors or names); the paste reads text as the backend does,
 * list markers as list styles and a checkbox as the task state, but keeps
 * property lines as text. What is pinned here is the shape the Playwright
 * specs rely on: a copied subtree pastes back as the same tree, list styles
 * included. Everything is read back through the mock's own read commands.
 * Backend parity for `paste_blocks` is pinned by
 * `conformance/fixtures/paste_blocks.json`.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import type { PasteInput, PasteSplice } from '@/lib/bindings'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, makeBlock, opLog, properties, seedBlocks } from '@/lib/tauri-mock/seed'

const id = (label: string): string => label.padStart(26, '0')
const SPACE = 'SPACE_PERSONAL'
const PAGE = id('PAGE')
const OTHER_PAGE = id('OTHERPAGE')
const A = id('A')
const CODE = id('CODE')
const CHILD = id('CHILD')
const GRANDCHILD = id('GRANDCHILD')
const NESTED_PAGE = id('NESTEDPAGE')
const B = id('B')
const TRASHED = id('TRASHED')
const ELSEWHERE = id('ELSEWHERE')
const MISSING = id('MISSING')

const FENCED = '```\nfirst line\nsecond line\n```'

interface Row {
  id: string
  content: string | null
  parent_id: string | null
  position: number | null
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
  // `childrenOf` lists the asked space only, and a page carries its blocks' space.
  if (type === 'page') row['space_id'] = SPACE
  return row
}

/** The list style block `blockId` stores, or null. */
function styleOf(blockId: string): unknown {
  return properties.get(blockId)?.get('listStyle')?.['value_text'] ?? null
}

function childrenOf(parentId: string): Row[] {
  const page = dispatch('list_blocks', {
    request: { parentId, limit: 100 },
    scope: { kind: 'active', space_id: SPACE },
  }) as { items: Row[] }
  return page.items
}

function source(blockIds: string[], withChildren: boolean): string {
  return dispatch('get_blocks_source', { blockIds, withChildren }) as string
}

function paste(anchorBlockId: string, input: PasteInput, splice?: PasteSplice): Row[] {
  return (dispatch('paste_blocks', { anchorBlockId, input, splice }) as { blocks: Row[] }).blocks
}

/** The `AppErrorKind` the paste refuses with, or `null` when it succeeds. */
function refusal(anchorBlockId: string, input: PasteInput): unknown {
  try {
    dispatch('paste_blocks', { anchorBlockId, input })
  } catch (err) {
    return (err as { kind?: unknown }).kind
  }
  return null
}

/** `parentId`'s subtree as `content` / nested `children`, in sibling order. */
function tree(parentId: string): unknown[] {
  return childrenOf(parentId).map((r) => ({ content: r.content, children: tree(r.id) }))
}

describe('tauri-mock clipboard pair', () => {
  beforeEach(() => {
    seedBlocks()
    blocks.clear()
    properties.clear()
    opLog.length = 0

    // PAGE > A, CODE > [CHILD > GRANDCHILD, NESTED_PAGE], B, TRASHED
    put(PAGE, 'page', 'Home', null, 1, PAGE)
    put(A, 'content', 'alpha', PAGE, 1, PAGE)
    put(CODE, 'content', FENCED, PAGE, 2, PAGE)
    put(CHILD, 'content', 'child', CODE, 1, PAGE)
    put(GRANDCHILD, 'content', 'grandchild', CHILD, 1, PAGE)
    put(NESTED_PAGE, 'page', 'Nested', CODE, 2, NESTED_PAGE)
    put(B, 'content', 'beta', PAGE, 3, PAGE)
    put(TRASHED, 'content', 'gone', PAGE, 4, PAGE)['deleted_at'] = 1
    put(OTHER_PAGE, 'page', 'Elsewhere', null, 2, OTHER_PAGE)
    put(ELSEWHERE, 'content', 'on another page', OTHER_PAGE, 1, OTHER_PAGE)
  })

  describe('get_blocks_source', () => {
    it('renders a plain root alone as its own paragraph, no children', () => {
      expect(source([CODE], false)).toBe(`${FENCED}\n`)
    })

    it('renders the content subtree two columns deeper per level, skipping a nested page', () => {
      expect(source([CODE], true)).toBe(`${FENCED}\n\n  child\n\n    grandchild\n`)
    })

    it('renders roots in document order and drops a selected descendant', () => {
      expect(source([B, CHILD, A, CODE], true)).toBe(
        `alpha\n\n${FENCED}\n\n  child\n\n    grandchild\n\nbeta\n`,
      )
    })

    it('writes a list marker, numbered by its run, a checkbox, and `+` for a plain block under a marked one (#6190)', () => {
      const style = (value: string) =>
        new Map([['listStyle', { key: 'listStyle', value_text: value }]])
      properties.set(A, style('bullet'))
      properties.set(CODE, style('ordered'))
      properties.set(B, style('ordered'))
      ;(blocks.get(CHILD) as Record<string, unknown>)['todo_state'] = 'TODO'

      expect(source([A, CODE, B], true)).toBe(
        '- alpha\n1. ```\n   first line\n   second line\n   ```\n   - [ ] child\n     + grandchild\n2. beta\n',
      )
    })

    it("skips trashed ids and ids off the first live id's page", () => {
      expect(source([TRASHED, A, ELSEWHERE, MISSING], false)).toBe('alpha\n')
    })

    it('answers the empty string when nothing is left to copy', () => {
      expect(source([], true)).toBe('')
      expect(source([PAGE, TRASHED, MISSING], true)).toBe('')
    })
  })

  describe('paste_blocks', () => {
    it('parses an outline: bullets nest by indentation, continuation lines join their block', () => {
      const text = '- parent\n  more of the parent\n\n  after a blank line\n  - child\n- next'
      const pasted = paste(A, { kind: 'text', text })

      expect(pasted.map((r) => r.content)).toEqual([
        'parent\nmore of the parent\n\nafter a blank line',
        'child',
        'next',
      ])
      expect(tree(PAGE).slice(0, 4)).toEqual([
        { content: 'alpha', children: [] },
        {
          content: 'parent\nmore of the parent\n\nafter a blank line',
          children: [{ content: 'child', children: [] }],
        },
        { content: 'next', children: [] },
        expect.objectContaining({ content: FENCED }),
      ])
    })

    it('counts a tab in bullet and continuation indentation as one level', () => {
      const text = '- a\n\t- b\n\t\t- c\n\t\t  more\n\t\t\t\tdeeper\n'

      expect(paste(A, { kind: 'text', text }).map((r) => r.content)).toEqual([
        'a',
        'b',
        'c\nmore\n\tdeeper',
      ])
    })

    it('reads text that does not open with a bullet by the same grammar: a heading owns nothing, lines join into a paragraph, `*` bullets nest', () => {
      const pasted = paste(A, {
        kind: 'text',
        text: '## Plan\n\nIntro line one\nline two\n\n* first\n  * nested\n\nAfter',
      })

      expect(pasted.map((r) => [r.content, r.parent_id])).toEqual([
        ['## Plan', PAGE],
        ['Intro line one\nline two', PAGE],
        ['first', PAGE],
        ['nested', pasted[2]?.id],
        ['After', PAGE],
      ])
    })

    it('starts a block at any list marker, nests by the content column, and stores its list style (#6190)', () => {
      const pasted = paste(A, { kind: 'text', text: '1. one\n   + two\n2) three\n-\tfour\n* five' })

      expect(pasted.map((r) => [r.content, r.parent_id])).toEqual([
        ['one', PAGE],
        ['two', pasted[0]?.id],
        ['three', PAGE],
        ['four', PAGE],
        ['five', PAGE],
      ])
      expect(childrenOf(PAGE).map((r) => [r.content, styleOf(r.id)])).toEqual([
        ['alpha', null],
        ['one', 'ordered'],
        ['three', 'ordered'],
        ['four', 'bullet'],
        ['five', 'bullet'],
        [FENCED, null],
        ['beta', null],
      ])
      expect(styleOf(pasted[1]?.id ?? '')).toBeNull()
    })

    it.each([
      ['The answer is\n42. That is all.', [['The answer is\n42. That is all.', 'Home']]],
      ['Year\n2024.\nmore', [['Year\n2024.\nmore', 'Home']]],
      [
        'Intro\n1. first',
        [
          ['Intro', 'Home'],
          ['first', 'Home'],
        ],
      ],
      [
        'Intro\n- a',
        [
          ['Intro', 'Home'],
          ['a', 'Home'],
        ],
      ],
      ['Intro\n-', [['Intro\n-', 'Home']]],
      [
        '- a\n-\n- b',
        [
          ['a', 'Home'],
          ['', 'Home'],
          ['b', 'Home'],
        ],
      ],
      [
        'Intro\n\n2. b',
        [
          ['Intro', 'Home'],
          ['b', 'Home'],
        ],
      ],
      [
        '# H\n2. b',
        [
          ['# H', 'Home'],
          ['b', 'Home'],
        ],
      ],
      // Inside a list item the same rule holds: a line at the item's content
      // column continues its paragraph unless the item starts at 1.
      [
        '- Numbers to remember:\n  42. That is all.',
        [['Numbers to remember:\n42. That is all.', 'Home']],
      ],
      [
        '- one\n  # H\n  para\n  2. x',
        [
          ['one', 'Home'],
          ['# H', 'one'],
          ['para\n2. x', 'one'],
        ],
      ],
      [
        '- one\n  # H\n  para\n  1. x',
        [
          ['one', 'Home'],
          ['# H', 'one'],
          ['para', 'one'],
          ['x', 'one'],
        ],
      ],
      // The export and clipboard shape of an empty child block.
      [
        '- parent\n  -\n  - b',
        [
          ['parent', 'Home'],
          ['', 'parent'],
          ['b', 'parent'],
        ],
      ],
    ])('starts a list after a paragraph only at a non-empty item numbered 1: %j', (text, want) => {
      const pasted = paste(A, { kind: 'text', text })
      const parentContent = (r: Row) => blocks.get(r.parent_id ?? '')?.['content']

      expect(pasted.map((r) => [r.content, parentContent(r)])).toEqual(want)
    })

    it('creates `blocks` input verbatim, a multi-line block staying ONE block', () => {
      const pasted = paste(B, {
        kind: 'blocks',
        blocks: [
          { content: FENCED, depth: 0 },
          { content: '- item', depth: 1 },
        ],
      })

      expect(pasted.map((r) => [r.content, r.parent_id])).toEqual([
        [FENCED, PAGE],
        ['- item', pasted[0]?.id],
      ])
    })

    it('lands the top-level blocks in order right after the anchor, before its next sibling', () => {
      paste(A, { kind: 'text', text: '- one\n- two\n- three' })

      expect(childrenOf(PAGE).map((r) => [r.content, r.position])).toEqual([
        ['alpha', 1],
        ['one', 2],
        ['two', 3],
        ['three', 4],
        [FENCED, 5],
        ['beta', 6],
      ])
    })

    it('pastes what get_blocks_source copied back as the same tree, list styles included', () => {
      properties.set(CHILD, new Map([['listStyle', { key: 'listStyle', value_text: 'ordered' }]]))
      paste(B, { kind: 'text', text: source([CODE], true) })

      const copy = childrenOf(PAGE).at(-1) as Row
      expect(tree(PAGE).at(-1)).toEqual({
        content: FENCED,
        children: [{ content: 'child', children: [{ content: 'grandchild', children: [] }] }],
      })
      const [child] = childrenOf(copy.id)
      const [grandchild] = childrenOf(child?.id ?? '')
      expect([copy.id, child?.id, grandchild?.id].map((at) => styleOf(at ?? ''))).toEqual([
        null,
        'ordered',
        null,
      ])
    })

    it("appends a create op per pasted block, then its list style's, and returns their refs", () => {
      const resp = dispatch('paste_blocks', {
        anchorBlockId: A,
        input: { kind: 'text', text: '- x\n  - y' },
      }) as { blocks: Row[]; op_refs: Array<{ device_id: string; seq: number }> }

      expect(resp.op_refs).toEqual(opLog.map((op) => ({ device_id: op.device_id, seq: op.seq })))
      expect(opLog.map((op) => op.op_type)).toEqual([
        'create_block',
        'set_property',
        'create_block',
        'set_property',
      ])
    })

    // #5160 D4 — a paste into the anchor's text.
    it('splices into the anchor: it becomes the first block, whose children follow its own, and the text after the cursor ends the last', () => {
      const resp = dispatch('paste_blocks', {
        anchorBlockId: CODE,
        input: { kind: 'text', text: '# Title\n\n  Intro\n\n# Next\n\n  Last' },
        splice: { before: 'Hello ', after: 'world' },
      }) as { blocks: Row[]; op_refs: Array<{ device_id: string; seq: number }> }

      expect(resp.blocks.map((r) => r.id)[0]).toBe(CODE)
      expect(tree(PAGE)).toEqual([
        { content: 'alpha', children: [] },
        {
          content: 'Hello # Title',
          children: [
            { content: 'child', children: [{ content: 'grandchild', children: [] }] },
            { content: 'Nested', children: [] },
            { content: 'Intro', children: [] },
          ],
        },
        { content: '# Next', children: [{ content: 'Lastworld', children: [] }] },
        { content: 'beta', children: [] },
      ])

      dispatch('undo_ops', { ops: resp.op_refs })

      expect(tree(PAGE).map((b) => (b as { content: string }).content)).toEqual([
        'alpha',
        FENCED,
        'beta',
      ])
    })

    it('splices a one-block paste between the two halves, creating nothing', () => {
      const pasted = paste(A, { kind: 'text', text: 'two\nlines' }, { before: 'Hi ', after: '!' })

      expect(pasted.map((r) => [r.id, r.content])).toEqual([[A, 'Hi two\nlines!']])
      expect(opLog.map((op) => op.op_type)).toEqual(['edit_block'])
    })

    it("reads a checkbox after the bullet as the row's todo_state, in text and in HTML-paste blocks (#5160 D6)", () => {
      const text = paste(A, {
        kind: 'text',
        text: '- [ ] open\n  - [x] done\n- [/] wip\n- [-] gone\n- [X] loud\n- [?] text',
      })
      expect(
        text.map((r) => [r.content, (r as Row & { todo_state: string | null }).todo_state]),
      ).toEqual([
        ['open', 'TODO'],
        ['done', 'DONE'],
        ['wip', 'DOING'],
        ['gone', 'CANCELLED'],
        ['loud', 'DONE'],
        ['[?] text', null],
      ])
      const html = paste(A, {
        kind: 'blocks',
        blocks: [
          { content: '- [ ] open task', depth: 0 },
          { content: '- [x] finished\nsecond line', depth: 1 },
          { content: '- plain item', depth: 0 },
        ],
      })
      expect(
        html.map((r) => [r.content, (r as Row & { todo_state: string | null }).todo_state]),
      ).toEqual([
        ['open task', 'TODO'],
        ['finished\nsecond line', 'DONE'],
        ['- plain item', null],
      ])
      // Re-queried: the state is on the stored row (the second paste landed
      // right after the anchor, ahead of the first), and each task wrote its
      // state op after its create.
      expect(
        childrenOf(PAGE).map((r) => (r as Row & { todo_state: string | null }).todo_state),
      ).toEqual([null, 'TODO', null, 'TODO', 'DOING', 'CANCELLED', 'DONE', null, null, null])
      expect(opLog.map((op) => op.op_type).slice(0, 4)).toEqual([
        'create_block',
        'set_property',
        'create_block',
        'set_property',
      ])
    })

    it("splices a first task block into the anchor: its state at the block's start, its checkbox as text after text", () => {
      const atStart = paste(A, { kind: 'text', text: '- [/] wip' }, { before: '', after: '' })
      expect(
        atStart.map((r) => [
          r.id,
          r.content,
          (r as Row & { todo_state: string | null }).todo_state,
        ]),
      ).toEqual([[A, 'wip', 'DOING']])
      const afterText = paste(B, { kind: 'text', text: '- [x] done' }, { before: 'Hi ', after: '' })
      expect(
        afterText.map((r) => [
          r.id,
          r.content,
          (r as Row & { todo_state: string | null }).todo_state,
        ]),
      ).toEqual([[B, 'Hi [x] done', null]])
    })

    it('refuses an unknown anchor as not_found, and a page, a trashed anchor or nothing to paste as validation', () => {
      const text: PasteInput = { kind: 'text', text: '- x' }
      expect(refusal(MISSING, text)).toBe('not_found')
      expect(refusal(PAGE, text)).toBe('validation')
      expect(refusal(TRASHED, text)).toBe('validation')
      expect(refusal(A, { kind: 'text', text: ' \n\n ' })).toBe('validation')
      expect(refusal(A, { kind: 'blocks', blocks: [] })).toBe('validation')
      // Nothing was written by any refusal.
      expect(opLog).toHaveLength(0)
    })
  })
})
