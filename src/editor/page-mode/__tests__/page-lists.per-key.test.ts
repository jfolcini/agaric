/**
 * Page mode's lists on a key typed (#5691): `layout` and the check for a block
 * leaving its list derive only the block the key changed, so the work stays
 * flat with the page's length, and `layout` agrees with its full walk of the
 * document, its fallback for a change past one block, on random changes.
 */

import type { Editor } from '@tiptap/core'
import { Fragment, type Node as PMNode, type Schema } from '@tiptap/pm/model'
import { type EditorState, TextSelection, type Transaction } from '@tiptap/pm/state'
import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { docShowsListMarker } from '@/editor/extensions/list-marker-decoration'
import {
  blockId,
  caret,
  idMinter,
  openPage,
  type Row,
  type as typeText,
} from '@/editor/page-mode/__tests__/page-mode-fixtures'
import { listSource } from '@/editor/page-mode/__tests__/page-node-view-fixtures'
import { PAGE_BLOCK } from '@/editor/page-mode/page-document'
import { PageLists } from '@/editor/page-mode/page-lists'
import { blockIdOf } from '@/editor/token-ids'
import type { PropertyRow } from '@/lib/bindings'
import type { ListStyle } from '@/lib/list-style'

vi.mock('@/editor/extensions/list-marker-decoration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/editor/extensions/list-marker-decoration')>()
  return { ...actual, docShowsListMarker: vi.fn(actual.docShowsListMarker) }
})

const styleRows = (style: ListStyle): PropertyRow[] =>
  style === 'none'
    ? []
    : [
        {
          key: 'listStyle',
          value_text: style,
          value_num: null,
          value_date: null,
          value_ref: null,
          value_bool: null,
        },
      ]

let editors: Editor[] = []

afterEach(() => {
  for (const editor of editors) editor.destroy()
  editors = []
})

describe('a key typed', () => {
  /** The blocks whose list marker a key typed in the middle of an `n`-block list works out. */
  function derivedOnAKey(n: number): number {
    const rows: Row[] = Array.from({ length: n }, (_, i) => [blockId(i + 1), 0, `item ${i}`])
    const lists = new PageLists(
      Object.fromEntries(rows.map(([id]) => [id, styleRows('bullet')])),
      rows.map(([id, depth]) => ({ id, depth })),
      () => false,
    )
    const editor = openPage(rows, idMinter(), undefined, listSource(lists))
    editors.push(editor)
    caret(editor, n / 2, 2)
    vi.mocked(docShowsListMarker).mockClear()

    typeText(editor, 'x')

    return vi.mocked(docShowsListMarker).mock.calls.length
  }

  it('works out the marker of the block typed in alone, however long the page', () => {
    // Once for the layout, once for the check whether it left its list.
    expect(derivedOnAKey(1000)).toBe(2)
    expect(derivedOnAKey(2000)).toBe(2)
  })

  it('looks for a style to give back on an undo, never on a key, once a block left its list (#6156)', () => {
    const rows: Row[] = Array.from({ length: 1000 }, (_, i) => [blockId(i + 1), 0, `item ${i}`])
    const lists = new PageLists(
      Object.fromEntries(rows.map(([id]) => [id, styleRows('bullet')])),
      rows.map(([id, depth]) => ({ id, depth })),
      () => false,
    )
    const editor = openPage(rows, idMinter(), undefined, listSource(lists))
    editors.push(editor)
    caret(editor, 0, 0)
    typeText(editor, '# ')
    const undone = vi.spyOn(lists, 'undone')
    caret(editor, 500, 2)
    vi.mocked(docShowsListMarker).mockClear()

    typeText(editor, 'x')

    expect(vi.mocked(docShowsListMarker).mock.calls.length).toBe(2)
    expect(undone).not.toHaveBeenCalled()
    editor.commands.undo()
    expect(undone).toHaveBeenCalledTimes(1)
  })
})

type Change =
  | { kind: 'type'; at: number; text: string }
  | { kind: 'delete'; from: number; to: number }
  | { kind: 'heading'; block: number; on: boolean }
  | { kind: 'depth'; block: number; depth: number; asAttribute: boolean }
  | { kind: 'split'; at: number }
  | { kind: 'insert'; block: number; text: string }
  | { kind: 'id'; block: number }
  | { kind: 'mark'; from: number; to: number }
  | { kind: 'join'; block: number }
  | { kind: 'move'; block: number; to: number }
  | { kind: 'reload' }
  | { kind: 'none' }

const TEXTS = ['', 'a', '{{query tag:x}}', `{{embed ((${blockId(1)}))}}`, '{{', '## ']

const text = fc.constantFrom(...TEXTS)
const change: fc.Arbitrary<Change> = fc.oneof(
  fc.record({ kind: fc.constant('type'), at: fc.nat(), text }),
  fc.record({ kind: fc.constant('delete'), from: fc.nat(), to: fc.nat() }),
  fc.record({ kind: fc.constant('heading'), block: fc.nat(), on: fc.boolean() }),
  fc.record({
    kind: fc.constant('depth'),
    block: fc.nat(),
    depth: fc.nat(3),
    asAttribute: fc.boolean(),
  }),
  fc.record({ kind: fc.constant('split'), at: fc.nat() }),
  fc.record({ kind: fc.constant('insert'), block: fc.nat(), text }),
  fc.record({ kind: fc.constant('id'), block: fc.nat() }),
  fc.record({ kind: fc.constant('mark'), from: fc.nat(), to: fc.nat() }),
  fc.record({ kind: fc.constant('join'), block: fc.nat() }),
  fc.record({ kind: fc.constant('move'), block: fc.nat(), to: fc.nat() }),
  fc.constant({ kind: 'reload' as const }),
  fc.constant({ kind: 'none' as const }),
)

const CONTENTS = ['', 'plain text', '## heading', '{{query tag:x}}', '```\ncode\n```', 'a **b**']
const row = fc.record({
  depth: fc.nat(2),
  content: fc.constantFrom(...CONTENTS),
  style: fc.constantFrom<ListStyle>('none', 'bullet', 'ordered'),
})

function blockStart(doc: PMNode, index: number): number {
  let pos = 0
  for (let i = 0; i < index; i += 1) pos += doc.child(i).nodeSize
  return pos
}

function apply(tr: Transaction, schema: Schema, c: Change, mint: () => string): void {
  const { doc } = tr
  const at = (n: number) => n % (doc.content.size + 1)
  const block = (n: number) => blockStart(doc, n % doc.childCount)
  const paragraph = (t: string) =>
    schema.nodes['paragraph']?.create(null, t ? schema.text(t) : null)
  switch (c.kind) {
    case 'type': {
      if (c.text !== '') tr.insertText(c.text, TextSelection.near(doc.resolve(at(c.at))).from)
      return
    }
    case 'delete': {
      tr.delete(Math.min(at(c.from), at(c.to)), Math.max(at(c.from), at(c.to)))
      return
    }
    case 'heading': {
      const type = c.on ? schema.nodes['heading'] : schema.nodes['paragraph']
      if (type !== undefined)
        tr.setBlockType(block(c.block) + 1, block(c.block) + 2, type, { level: 2 })
      return
    }
    case 'depth': {
      const node = doc.nodeAt(block(c.block)) as PMNode
      if (c.asAttribute) tr.setNodeAttribute(block(c.block), 'depth', c.depth)
      else tr.setNodeMarkup(block(c.block), undefined, { ...node.attrs, depth: c.depth })
      return
    }
    case 'split': {
      tr.split(TextSelection.near(doc.resolve(at(c.at))).from, 2)
      return
    }
    case 'insert': {
      const node = schema.nodes[PAGE_BLOCK]?.create(
        { blockId: mint(), depth: 0 },
        paragraph(c.text),
      )
      tr.insert(block(c.block), node as PMNode)
      return
    }
    case 'id': {
      const node = doc.nodeAt(block(c.block)) as PMNode
      tr.setNodeMarkup(block(c.block), undefined, { ...node.attrs, blockId: mint() })
      return
    }
    case 'mark': {
      const bold = schema.marks['bold']
      if (bold === undefined) throw new Error('no bold mark')
      tr.addMark(Math.min(at(c.from), at(c.to)), Math.max(at(c.from), at(c.to)), bold.create())
      return
    }
    case 'join': {
      // Block `n` into the one before it, as Backspace at its start does.
      if (doc.childCount > 1) tr.join(blockStart(doc, 1 + (c.block % (doc.childCount - 1))))
      return
    }
    case 'move': {
      // The same number of blocks, more than one of them changed.
      const from = block(c.block)
      const node = doc.nodeAt(from) as PMNode
      tr.delete(from, from + node.nodeSize)
      tr.insert(blockStart(tr.doc, c.to % (tr.doc.childCount + 1)), node)
      return
    }
    case 'reload': {
      tr.replaceWith(0, doc.content.size, Fragment.fromJSON(schema, doc.content.toJSON()))
      return
    }
    case 'none': {
      return
    }
  }
}

/** What `lists` holds of `doc`'s blocks: its outline, and each block's marker. */
function laidOut(lists: PageLists, doc: PMNode) {
  const markers: string[] = []
  doc.forEach((node) => markers.push(lists.markerOf(blockIdOf(node) ?? '')))
  // The outline is private: the ordinals and markers are worked out from it.
  return { items: (lists as unknown as { items: unknown }).items, markers }
}

describe('layout', () => {
  it('holds what a full walk of the document holds, change after random change', () => {
    fc.assert(
      fc.property(
        fc.array(row, { minLength: 1, maxLength: 8 }),
        fc.array(fc.array(change, { minLength: 1, maxLength: 3 }), { maxLength: 12 }),
        (rows, steps) => {
          const ids = rows.map((_, i) => blockId(i + 1))
          const styles = Object.fromEntries(
            ids.map((id, i) => [id, styleRows(rows[i]?.style ?? 'none')]),
          )
          const editor = openPage(
            rows.map(({ depth, content }, i) => [ids[i] as string, depth, content]),
          )
          editors.push(editor)
          const mint = idMinter('01ADD')
          let state: EditorState = editor.state
          const lists = new PageLists(styles, [], () => false)
          lists.layout(state.doc)
          for (const step of steps) {
            const tr = state.tr
            for (const c of step) {
              try {
                apply(tr, editor.schema, c, mint)
              } catch {
                // A change the document cannot take: the rest of the step goes on.
              }
            }
            state = state.apply(tr)
            lists.layout(state.doc)
            const walked = new PageLists(styles, [], () => false)
            walked.layout(state.doc)
            expect(laidOut(lists, state.doc)).toEqual(laidOut(walked, state.doc))
          }
        },
      ),
    )
  })
})

/** The full walk `leftTheirList` falls back to: the styled blocks that showed a marker and no longer do. */
function leftByFullWalk(before: PMNode, doc: PMNode, styled: ReadonlySet<string>): string[] {
  const shown = new Map<string, boolean>()
  before.forEach((node) => shown.set(blockIdOf(node) ?? '', docShowsListMarker(node)))
  const left: string[] = []
  doc.forEach((node) => {
    const id = blockIdOf(node)
    if (id === null || !styled.has(id) || docShowsListMarker(node)) return
    if (shown.get(id) === true) left.push(id)
  })
  return left
}

describe('a list block leaving its list', () => {
  it('is found as a full walk of the document finds it, change after random change', () => {
    let left = 0
    fc.assert(
      fc.property(
        fc.array(row, { minLength: 1, maxLength: 8 }),
        fc.array(fc.array(change, { minLength: 1, maxLength: 3 }), { maxLength: 12 }),
        (rows, steps) => {
          const ids = rows.map((_, i) => blockId(i + 1))
          const lists = new PageLists(
            Object.fromEntries(ids.map((id, i) => [id, styleRows(rows[i]?.style ?? 'none')])),
            ids.map((id, i) => ({ id, depth: rows[i]?.depth ?? 0 })),
            () => false,
          )
          const source = listSource(lists)
          const editor = openPage(
            rows.map(({ depth, content }, i) => [ids[i] as string, depth, content]),
            idMinter(),
            undefined,
            source,
          )
          editors.push(editor)
          const mint = idMinter('01ADD')
          for (const step of steps) {
            const before = editor.state.doc
            const styled = new Set<string>()
            before.forEach((node) => {
              const id = blockIdOf(node)
              if (id !== null && lists.styleOf(id) !== 'none') styled.add(id)
            })
            const tr = editor.state.tr
            for (const c of step) {
              try {
                apply(tr, editor.schema, c, mint)
              } catch {
                // A change the document cannot take: the rest of the step goes on.
              }
            }
            source.setStyle.mockClear()
            editor.view.dispatch(tr)
            const expected = leftByFullWalk(before, editor.state.doc, styled)
            left += expected.length
            expect(source.setStyle.mock.calls).toEqual(expected.map((id) => [id, 'none']))
          }
        },
      ),
    )
    // The runs reach the case under test: some block leaves its list.
    expect(left).toBeGreaterThan(0)
  })
})
