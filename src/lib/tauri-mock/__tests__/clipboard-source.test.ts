/**
 * #5140 Phase 3b — mock `get_blocks_source` and `paste_blocks`, the clipboard
 * pair. Both are approximations of the backend grammar (bullets, indentation,
 * continuation lines; no anchors, markers, properties or names), so what is
 * pinned here is the shape the Playwright specs rely on: a copied subtree
 * pastes back as the same tree. Everything is read back through the mock's own
 * read commands. Backend parity for `paste_blocks` is pinned by
 * `conformance/fixtures/paste_blocks.json`.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import type { PasteInput } from '@/lib/bindings'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, makeBlock, opLog, properties, seedBlocks } from '@/lib/tauri-mock/seed'

const id = (label: string): string => label.padStart(26, '0')
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
  return row
}

function childrenOf(parentId: string): Row[] {
  const page = dispatch('list_blocks', { request: { parentId, limit: 100 } }) as { items: Row[] }
  return page.items
}

function source(blockIds: string[], withChildren: boolean): string {
  return dispatch('get_blocks_source', { blockIds, withChildren }) as string
}

function paste(anchorBlockId: string, input: PasteInput): Row[] {
  return (dispatch('paste_blocks', { anchorBlockId, input }) as { blocks: Row[] }).blocks
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
    it('renders a root alone: its continuation lines indented under the bullet, no children', () => {
      expect(source([CODE], false)).toBe('- ```\n  first line\n  second line\n  ```\n')
    })

    it('renders the content subtree two columns deeper per level, skipping a nested page', () => {
      expect(source([CODE], true)).toBe(
        '- ```\n  first line\n  second line\n  ```\n  - child\n    - grandchild\n',
      )
    })

    it('renders roots in document order and drops a selected descendant', () => {
      expect(source([B, CHILD, A, CODE], true)).toBe(
        '- alpha\n- ```\n  first line\n  second line\n  ```\n  - child\n    - grandchild\n- beta\n',
      )
    })

    it("skips trashed ids and ids off the first live id's page", () => {
      expect(source([TRASHED, A, ELSEWHERE, MISSING], false)).toBe('- alpha\n')
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

    it('takes text that does not open with a bullet as one block per line, nested by indentation', () => {
      const pasted = paste(A, { kind: 'text', text: 'first\n  under first\n\nsecond' })

      expect(pasted.map((r) => [r.content, r.parent_id])).toEqual([
        ['first', PAGE],
        ['under first', pasted[0]?.id],
        ['second', PAGE],
      ])
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

    it('pastes what get_blocks_source copied back as the same tree', () => {
      paste(B, { kind: 'text', text: source([CODE], true) })

      expect(tree(PAGE).at(-1)).toEqual({
        content: FENCED,
        children: [{ content: 'child', children: [{ content: 'grandchild', children: [] }] }],
      })
    })

    it('appends one create op per pasted block and returns their refs', () => {
      const resp = dispatch('paste_blocks', {
        anchorBlockId: A,
        input: { kind: 'text', text: '- x\n  - y' },
      }) as { blocks: Row[]; op_refs: Array<{ device_id: string; seq: number }> }

      const creates = opLog.filter((op) => op.op_type === 'create_block')
      expect(resp.op_refs).toEqual(creates.map((op) => ({ device_id: op.device_id, seq: op.seq })))
      expect(creates).toHaveLength(2)
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
