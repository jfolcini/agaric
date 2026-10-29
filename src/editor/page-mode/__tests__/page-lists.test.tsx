/**
 * Page mode's lists (#5743, #5915): the styles and markers `PageLists` holds,
 * the list keys and input rules over them, the marker each block's view
 * draws, and, through `PageModeEditor`, a style write the backend refuses.
 *
 * Equivalent mutants, accepted:
 * - `sameItems` made always false or blind to `id` or `depth`, its `?.`
 *   dropped, and `layout`'s return on it or the plugin's `doc !== previous.doc`
 *   dropped: each only spares a redraw, and a redraw over the same blocks
 *   changes no marker and tells no listener. `b[i]` is read only past the
 *   length check.
 * - `'none'` kept as a read style (`take`, `settle`) or as a marker
 *   (`redraw`): `styleOf` and `markerOf` read it as no style.
 * - A stray entry in `layout`'s new list: with no id and no style it breaks
 *   no run of numbered siblings.
 * - An empty listener set kept once its last listener unsubscribes: nothing
 *   reads it.
 * - `id === null` (`idsIn`, Enter, Backspace, the input rule), and `made !==
 *   undefined` → `true`: every page block has an id, a split makes exactly one
 *   new one, and `styleOf(null)` is `'none'`.
 * - The extension's name: nothing looks it up.
 * - `$` dropped from either rule's pattern: TipTap applies a rule only where
 *   its match ends at the text typed.
 *
 * Not reached: the `''` id of a block with none, and the `?? ''` after a
 * group that always matches.
 */

import type { InvokeArgs } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { act } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import { closeHistory, undoDepth } from '@tiptap/pm/history'
import { AllSelection, NodeSelection } from '@tiptap/pm/state'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { EnteringIntersectionObserver } from '@/__tests__/helpers/viewport-observer-mocks'
import {
  blockId,
  caret,
  idMinter,
  openPage,
  posIn,
  press,
  type Row,
  rowsOf,
  type as typeText,
} from '@/editor/page-mode/__tests__/page-mode-fixtures'
import {
  editorIn,
  listSource,
  mountNodeViews,
  renderPageMode,
  SCOPE,
  seedPage,
} from '@/editor/page-mode/__tests__/page-node-view-fixtures'
import { REMOTE_PATCH } from '@/editor/page-mode/page-document'
import { pickerOpen } from '@/editor/page-mode/page-keys'
import { PageLists } from '@/editor/page-mode/page-lists'
import { blockText } from '@/editor/page-mode/page-slash-commands'
import type { BlockRow, PropertyRow } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { seedBlocks } from '@/lib/tauri-mock/seed'
import { useSpaceStore } from '@/stores/space'

const A = blockId(1)
const B = blockId(2)
const C = blockId(3)
const D = blockId(4)

const style = (value: string): PropertyRow[] => [
  {
    key: 'listStyle',
    value_text: value,
    value_num: null,
    value_date: null,
    value_ref: null,
    value_bool: null,
  },
]

const flat = (...ids: string[]) => ids.map((id) => ({ id, depth: 0 }))

let teardown: (() => void) | null = null

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('IntersectionObserver', undefined)
})

afterEach(() => {
  teardown?.()
  teardown = null
  vi.unstubAllGlobals()
})

describe('PageLists', () => {
  it('numbers a run of numbered siblings, a bullet `•`, and a plain block nothing', () => {
    const lists = new PageLists(
      { [A]: style('ordered'), [B]: style('ordered'), [D]: style('bullet'), [C]: [] },
      [
        { id: A, depth: 0 },
        { id: B, depth: 0 },
        { id: C, depth: 0 },
        { id: D, depth: 0 },
      ],
      () => false,
    )

    expect([A, B, C, D].map((id) => lists.markerOf(id))).toEqual(['1.', '2.', '', '•'])
    expect([A, B, C, D].map((id) => lists.styleOf(id))).toEqual([
      'ordered',
      'ordered',
      'none',
      'bullet',
    ])
  })

  it('a read replaces what the last read held', () => {
    const lists = new PageLists({ [A]: style('bullet') }, flat(A, B), () => false)

    lists.take({ [B]: style('ordered') })

    expect([lists.styleOf(A), lists.styleOf(B)]).toEqual(['none', 'ordered'])
    expect([lists.markerOf(A), lists.markerOf(B)]).toEqual(['', '1.'])
  })

  it('a style given shows at once and stays once its write settles; a refused one shows the read', () => {
    const lists = new PageLists({ [A]: style('bullet') }, flat(A, B), () => false)

    const first = lists.want(A, 'ordered')
    const second = lists.want(B, 'bullet')
    expect([first, second]).toEqual([1, 2])
    expect([lists.markerOf(A), lists.markerOf(B)]).toEqual(['1.', '•'])

    lists.settle(A, first, null)
    lists.settle(B, second, 'bullet')
    expect([lists.styleOf(A), lists.styleOf(B)]).toEqual(['bullet', 'bullet'])
  })

  it('an older write settling leaves the newer style shown; `none` written clears the read', () => {
    const lists = new PageLists({ [A]: style('bullet') }, flat(A), () => false)

    const older = lists.want(A, 'ordered')
    const newer = lists.want(A, 'none')
    lists.settle(A, older, 'ordered')
    expect(lists.styleOf(A)).toBe('none')

    lists.settle(A, newer, 'none')
    expect(lists.styleOf(A)).toBe('none')
    lists.take({})
    lists.want(A, 'bullet')
    lists.settle(A, 99, 'ordered')
    expect(lists.styleOf(A)).toBe('bullet')
  })

  it('tells a block’s listeners when its marker changes, and only then, until they unsubscribe', () => {
    const lists = new PageLists({ [A]: style('ordered') }, flat(A, B), () => false)
    const onA = vi.fn()
    const onB = vi.fn()
    const offA = lists.subscribe(A, onA)
    lists.subscribe(B, onB)
    const alsoA = vi.fn()
    const offAlsoA = lists.subscribe(A, alsoA)

    lists.want(B, 'ordered')
    expect([onA.mock.calls.length, onB.mock.calls.length]).toEqual([0, 1])

    lists.want(A, 'none')
    expect([onA.mock.calls.length, onB.mock.calls.length]).toEqual([1, 2])

    offA()
    lists.want(A, 'bullet')
    expect([onA.mock.calls.length, alsoA.mock.calls.length]).toEqual([1, 2])

    offAlsoA()
    lists.want(A, 'none')
    expect(alsoA).toHaveBeenCalledTimes(2)
  })

  it('takes the order and depths from the document, and numbers by them', () => {
    const lists = new PageLists(
      { [A]: style('ordered'), [B]: style('ordered') },
      flat(A, B),
      () => false,
    )
    const listener = vi.fn()
    lists.subscribe(B, listener)
    const editor = openPage([
      [A, 0, 'one'],
      [B, 1, 'two'],
    ])
    teardown = () => editor.destroy()

    lists.layout(editor.state.doc)
    expect([lists.markerOf(A), lists.markerOf(B)]).toEqual(['1.', '1.'])
    expect(listener).toHaveBeenCalledTimes(1)

    lists.layout(editor.state.doc)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('follows blocks moved or deleted in the document', () => {
    const lists = new PageLists(
      { [A]: style('ordered'), [B]: style('ordered') },
      flat(A, B, C),
      () => false,
    )
    expect([A, B, C].map((id) => lists.markerOf(id))).toEqual(['1.', '2.', ''])
    const moved = openPage([
      [A, 0, 'one'],
      [C, 0, 'plain'],
      [B, 0, 'two'],
    ])
    const deleted = openPage([[A, 0, 'one']])
    teardown = () => {
      moved.destroy()
      deleted.destroy()
    }

    lists.layout(moved.state.doc)
    expect([A, B].map((id) => lists.markerOf(id))).toEqual(['1.', '1.'])

    lists.layout(deleted.state.doc)
    expect([A, B].map((id) => lists.markerOf(id))).toEqual(['1.', ''])
  })

  it('a write settling with no style given for its block takes what it wrote', () => {
    const lists = new PageLists({}, flat(A), () => false)

    lists.settle(A, 7, 'bullet')

    expect(lists.markerOf(A)).toBe('•')
  })
})

describe('the list keys and input rules', () => {
  function open(rows: readonly Row[], styles: Record<string, PropertyRow[]> = {}) {
    const lists = new PageLists(
      styles,
      rows.map(([id, depth]) => ({ id, depth })),
      () => false,
    )
    const source = listSource(lists)
    const editor = openPage(rows, idMinter(), undefined, source)
    teardown = () => editor.destroy()
    return { editor, lists, setStyle: source.setStyle }
  }

  const styles = (editor: Editor, lists: PageLists) =>
    rowsOf(editor.state.doc).map(([id]) => lists.styleOf(id))

  it('`- `, `* `, `+ ` and `1. ` then a character make the block a list, without the prefix', () => {
    const { editor, lists } = open([
      [A, 0, 'one'],
      [B, 0, 'two'],
      [C, 0, 'three'],
      [D, 0, 'four'],
    ])

    caret(editor, 0, 0)
    typeText(editor, '- a')
    caret(editor, 1, 0)
    typeText(editor, '* b')
    caret(editor, 2, 0)
    typeText(editor, '+ c')
    caret(editor, 3, 0)
    typeText(editor, '12. d')

    expect(rowsOf(editor.state.doc).map(([, , md]) => md)).toEqual([
      'aone',
      'btwo',
      'cthree',
      'dfour',
    ])
    expect(styles(editor, lists)).toEqual(['bullet', 'bullet', 'bullet', 'ordered'])
  })

  it('`- [` waits for a task marker; a prefix after the block’s first paragraph stays text', () => {
    const { editor, lists } = open([
      [A, 0, 'one'],
      [B, 0, 'two\n\nthree'],
    ])

    caret(editor, 0, 0)
    typeText(editor, '- [')
    const second = posIn(editor, 1, 0) + editor.state.doc.child(1).child(0).nodeSize
    editor.commands.setTextSelection(second)
    typeText(editor, '- x')

    expect(rowsOf(editor.state.doc).map(([, , md]) => md)).toEqual([
      '\\- \\[one',
      'two\n\n\\- xthree',
    ])
    expect(styles(editor, lists)).toEqual(['none', 'none'])
  })

  it('a prefix typed in a block’s own list item stays that list’s', () => {
    const { editor, lists, setStyle } = open([[A, 0, '- item']])
    let start = -1
    editor.state.doc.descendants((node, pos) => {
      if (start === -1 && node.type.name === 'paragraph') start = pos + 1
    })

    editor.commands.setTextSelection(start)
    typeText(editor, '- x')

    expect(setStyle).not.toHaveBeenCalled()
    expect(lists.styleOf(A)).toBe('none')
  })

  it('a list block whose text stops opening with a paragraph leaves the list; one that never did keeps its style', () => {
    const { editor, lists, setStyle } = open(
      [
        [A, 0, 'one'],
        [B, 0, 'two'],
        [C, 0, '# Title'],
        [D, 0, 'four'],
      ],
      { [A]: style('bullet'), [B]: style('ordered'), [C]: style('bullet'), [D]: style('bullet') },
    )

    caret(editor, 0, 0)
    typeText(editor, '# ')
    caret(editor, 1, 0)
    typeText(editor, '``` ')
    caret(editor, 2, 5)
    typeText(editor, '!')
    caret(editor, 3, 4)
    typeText(editor, '!')

    expect(rowsOf(editor.state.doc).map(([, , md]) => md)).toEqual([
      '# one',
      '```\ntwo\n```',
      '# Title!',
      'four!',
    ])
    expect(styles(editor, lists)).toEqual(['none', 'none', 'bullet', 'bullet'])
    expect(setStyle.mock.calls).toEqual([
      [A, 'none'],
      [B, 'none'],
    ])
  })

  it('a change brought in from elsewhere that makes a list block a heading writes no style; the same change made here does', () => {
    const { editor, lists, setStyle } = open(
      [
        [A, 0, 'one'],
        [B, 0, 'two'],
      ],
      { [A]: style('bullet'), [B]: style('bullet') },
    )
    const toHeading = (index: number) =>
      editor.state.tr.setNodeMarkup(posIn(editor, index, 0) - 1, editor.schema.nodes['heading'], {
        level: 1,
      })

    editor.view.dispatch(toHeading(0).setMeta('addToHistory', false).setMeta(REMOTE_PATCH, true))
    editor.view.dispatch(toHeading(1))

    expect(rowsOf(editor.state.doc).map(([, , md]) => md)).toEqual(['# one', '# two'])
    expect(styles(editor, lists)).toEqual(['bullet', 'none'])
    expect(setStyle.mock.calls).toEqual([[B, 'none']])
  })

  it('Enter continues the list into the block it makes; on an empty list block it leaves the list', () => {
    const { editor, lists, setStyle } = open([[A, 0, 'one']], { [A]: style('ordered') })

    caret(editor, 0, 3)
    expect(press(editor, 'Enter')).toBe(true)
    const made = rowsOf(editor.state.doc)[1]?.[0] as string
    expect(rowsOf(editor.state.doc)).toEqual([
      [A, 0, 'one'],
      [made, 0, ''],
    ])
    expect(styles(editor, lists)).toEqual(['ordered', 'ordered'])
    expect(lists.markerOf(made)).toBe('2.')

    expect(press(editor, 'Enter')).toBe(true)
    expect(rowsOf(editor.state.doc)).toEqual([
      [A, 0, 'one'],
      [made, 0, ''],
    ])
    expect(styles(editor, lists)).toEqual(['ordered', 'none'])
    expect(setStyle.mock.calls).toEqual([
      [made, 'ordered'],
      [made, 'none'],
    ])
  })

  it('Enter on a list block holding only spaces leaves the list', () => {
    const { editor, lists } = open([[A, 0, 'one']], { [A]: style('bullet') })
    editor.commands.insertContentAt({ from: posIn(editor, 0, 0), to: posIn(editor, 0, 3) }, '   ')

    caret(editor, 0, 3)
    expect(press(editor, 'Enter')).toBe(true)

    expect(rowsOf(editor.state.doc)).toHaveLength(1)
    expect(lists.styleOf(A)).toBe('none')
  })

  it('Enter on a list block whose rule the caret selects continues the list', () => {
    const { editor, lists } = open([[A, 0, 'one\n\n---']], { [A]: style('bullet') })
    const rule = posIn(editor, 0, 0) - 1 + editor.state.doc.child(0).child(0).nodeSize
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, rule)))

    expect(press(editor, 'Enter')).toBe(true)

    expect(styles(editor, lists)).toEqual(['bullet', 'bullet'])
  })

  it('Enter with a picker open is the picker’s, and with the whole page selected the editor’s', () => {
    const { editor, lists, setStyle } = open([[A, 0, 'one']], { [A]: style('bullet') })

    caret(editor, 0, 3)
    typeText(editor, ' [[')
    expect(pickerOpen(editor.state)).toBe(true)
    press(editor, 'Enter')
    expect(rowsOf(editor.state.doc)).toHaveLength(1)

    editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)))
    expect(press(editor, 'Enter')).toBe(true)
    expect(rowsOf(editor.state.doc).map(([, , md]) => md)).toEqual(['', ''])
    expect(setStyle).not.toHaveBeenCalled()
    expect(lists.styleOf(A)).toBe('bullet')
  })

  it('Enter in a list block’s code block is the code block’s new line, not a new block', () => {
    const { editor, lists, setStyle } = open([[A, 0, '```\ncode\n```']], { [A]: style('bullet') })

    caret(editor, 0, 4)
    expect(press(editor, 'Enter')).toBe(true)

    expect(rowsOf(editor.state.doc)).toEqual([[A, 0, '```\ncode\n\n```']])
    expect(setStyle).not.toHaveBeenCalled()
    expect(lists.styleOf(A)).toBe('bullet')
  })

  it('Enter on a plain block is page mode’s own split, which gives no style', () => {
    const { editor, lists, setStyle } = open([[A, 0, 'one']])

    caret(editor, 0, 3)
    expect(press(editor, 'Enter')).toBe(true)

    expect(rowsOf(editor.state.doc)).toHaveLength(2)
    expect(styles(editor, lists)).toEqual(['none', 'none'])
    expect(setStyle).not.toHaveBeenCalled()
  })

  it('Backspace at a list block’s start takes its style off, and its text stays', () => {
    const { editor, lists } = open(
      [
        [A, 0, 'one'],
        [B, 0, 'two'],
      ],
      { [B]: style('bullet') },
    )

    caret(editor, 1, 0)
    expect(press(editor, 'Backspace')).toBe(true)

    expect(rowsOf(editor.state.doc)).toEqual([
      [A, 0, 'one'],
      [B, 0, 'two'],
    ])
    expect(styles(editor, lists)).toEqual(['none', 'none'])
  })

  it('Backspace elsewhere in a list block, over a selection or in a plain block is not the list’s', () => {
    const { editor, lists, setStyle } = open(
      [
        [A, 0, 'one\n\ntwo'],
        [B, 0, 'plain'],
        [C, 0, '- item'],
      ],
      { [A]: style('bullet'), [C]: style('bullet') },
    )

    const taken: boolean[] = []
    caret(editor, 0, 2)
    taken.push(press(editor, 'Backspace'))
    editor.commands.setTextSelection({ from: posIn(editor, 0, 0), to: posIn(editor, 0, 1) })
    taken.push(press(editor, 'Backspace'))
    const second = posIn(editor, 0, 0) + editor.state.doc.child(0).child(0).nodeSize
    editor.commands.setTextSelection(second)
    taken.push(press(editor, 'Backspace'))
    caret(editor, 1, 0)
    taken.push(press(editor, 'Backspace'))
    // Mid-line the browser's; the rest the editor's own delete and joins.
    expect(taken).toEqual([false, true, true, true])
    expect(rowsOf(editor.state.doc)).toEqual([
      [A, 0, 'netwoplain'],
      [C, 0, '- item'],
    ])

    expect(setStyle).not.toHaveBeenCalled()
    expect(lists.styleOf(A)).toBe('bullet')
  })

  it('Backspace after a rule’s character deletes it, and the style stays', () => {
    const { editor, lists } = open([[A, 0, '']])

    caret(editor, 0, 0)
    typeText(editor, '- a')
    expect(rowsOf(editor.state.doc)).toEqual([[A, 0, 'a']])
    editor.commands.keyboardShortcut('Backspace')

    // Not the input rule undone, which would give the prefix back.
    expect(rowsOf(editor.state.doc)).toEqual([[A, 0, 'a']])
    expect(lists.styleOf(A)).toBe('bullet')
  })

  it('a prefix after other text, or in a heading, stays text', () => {
    const E = blockId(5)
    const { editor, lists } = open([
      [A, 0, 'a'],
      [B, 0, ''],
      [C, 0, ''],
      [D, 0, '# Title'],
      [E, 0, '\\- bc'],
    ])

    caret(editor, 0, 1)
    typeText(editor, ' - b')
    caret(editor, 1, 0)
    typeText(editor, 'x- y')
    caret(editor, 2, 0)
    typeText(editor, 'x1. y')
    caret(editor, 3, 0)
    typeText(editor, '- z')
    caret(editor, 4, 4)
    typeText(editor, 'd')

    expect(rowsOf(editor.state.doc).map(([, , md]) => md)).toEqual([
      'a - b',
      'x- y',
      'x1. y',
      '# \\- zTitle',
      '\\- bcd',
    ])
    expect(styles(editor, lists)).toEqual(['none', 'none', 'none', 'none', 'none'])
  })

  it('takes the document’s blocks as the editor opens on them', () => {
    const lists = new PageLists({ [A]: style('ordered'), [B]: style('ordered') }, [], () => false)
    expect(lists.markerOf(B)).toBe('')

    const editor = openPage(
      [
        [A, 0, 'one'],
        [B, 0, 'two'],
      ],
      idMinter(),
      undefined,
      listSource(lists),
    )
    teardown = () => editor.destroy()

    expect([lists.markerOf(A), lists.markerOf(B)]).toEqual(['1.', '2.'])
  })

  it('Tab numbers a block again at its new depth', () => {
    const { editor, lists } = open(
      [
        [A, 0, 'one'],
        [B, 0, 'two'],
      ],
      { [A]: style('ordered'), [B]: style('ordered') },
    )
    expect(lists.markerOf(B)).toBe('2.')

    caret(editor, 1, 0)
    press(editor, 'Tab')

    expect(lists.markerOf(B)).toBe('1.')
  })

  describe('Ctrl+Z in the editor after a list block left its list (#6156)', () => {
    /** End the history's event, as a pause in typing does: the next change is an undo step of its own. */
    const pause = (editor: Editor) => editor.view.dispatch(closeHistory(editor.state.tr))
    const texts = (editor: Editor) => rowsOf(editor.state.doc).map(([, , md]) => md)
    /** Make block `index` a paragraph, as a Backspace on its heading's `#` run does. */
    const toParagraph = (editor: Editor, index: number) =>
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(
          posIn(editor, index, 0) - 1,
          editor.schema.nodes['paragraph'],
        ),
      )

    it('the undo gives back the style the change took off, and a redo takes it off again', () => {
      const { editor, lists, setStyle } = open(
        [
          [A, 0, 'one'],
          [B, 0, 'two'],
        ],
        { [A]: style('bullet'), [B]: style('ordered') },
      )
      caret(editor, 0, 0)
      typeText(editor, '# ')
      pause(editor)
      caret(editor, 1, 0)
      typeText(editor, '``` ')
      pause(editor)
      expect(texts(editor)).toEqual(['# one', '```\ntwo\n```'])
      expect(styles(editor, lists)).toEqual(['none', 'none'])

      // An undo takes back an input rule first: the marker typed stays as text.
      editor.commands.undo()
      expect(texts(editor)).toEqual(['# one', '\\`\\`\\` two'])
      expect(styles(editor, lists)).toEqual(['none', 'ordered'])
      editor.commands.undo()
      editor.commands.undo()
      expect(texts(editor)).toEqual(['\\# one', 'two'])
      expect(styles(editor, lists)).toEqual(['bullet', 'ordered'])

      editor.commands.redo()
      expect(texts(editor)).toEqual(['# one', 'two'])
      expect(styles(editor, lists)).toEqual(['none', 'ordered'])
      editor.commands.undo()
      expect(styles(editor, lists)).toEqual(['bullet', 'ordered'])
      expect(setStyle.mock.calls).toEqual([
        [A, 'none'],
        [B, 'none'],
        [B, 'ordered'],
        [A, 'bullet'],
        [A, 'none'],
        [A, 'bullet'],
      ])
    })

    it('a Backspace or a Turn into back to a paragraph gives nothing back', () => {
      const { editor, lists, setStyle } = open(
        [
          [A, 0, 'one'],
          [B, 0, 'two'],
        ],
        { [A]: style('bullet'), [B]: style('bullet') },
      )
      caret(editor, 0, 0)
      typeText(editor, '# ')
      caret(editor, 1, 0)
      typeText(editor, '# ')
      pause(editor)

      toParagraph(editor, 0)
      blockText(editor, B).write('two')

      expect(texts(editor)).toEqual(['one', 'two'])
      expect(styles(editor, lists)).toEqual(['none', 'none'])
      expect(setStyle.mock.calls).toEqual([
        [A, 'none'],
        [B, 'none'],
      ])
    })

    it('the undo of a later change gives nothing back; the undo of the change itself does', () => {
      const { editor, lists } = open([[A, 0, 'one']], { [A]: style('bullet') })
      caret(editor, 0, 0)
      typeText(editor, '# ')
      pause(editor)
      toParagraph(editor, 0)
      pause(editor)
      caret(editor, 0, 0)
      typeText(editor, '## ')
      pause(editor)

      editor.commands.undo()
      expect(texts(editor)).toEqual(['\\## one'])
      editor.commands.undo()
      expect(texts(editor)).toEqual(['one'])
      expect(lists.styleOf(A)).toBe('none')
      editor.commands.undo()
      expect(texts(editor)).toEqual(['# one'])
      editor.commands.undo()
      expect(texts(editor)).toEqual(['\\# one'])
      expect(lists.styleOf(A)).toBe('bullet')
    })

    it('a block deleted after it left its list, and brought back, gets the style with the undo of that change', () => {
      const { editor, lists } = open(
        [
          [A, 0, 'one'],
          [B, 0, 'two'],
        ],
        { [A]: style('bullet') },
      )
      caret(editor, 0, 0)
      typeText(editor, '# ')
      pause(editor)
      editor.view.dispatch(editor.state.tr.delete(0, editor.state.doc.child(0).nodeSize))
      pause(editor)
      expect(texts(editor)).toEqual(['two'])

      editor.commands.undo()
      expect(texts(editor)).toEqual(['# one', 'two'])
      expect(styles(editor, lists)).toEqual(['none', 'none'])
      editor.commands.undo()
      expect(texts(editor)).toEqual(['\\# one', 'two'])

      expect(styles(editor, lists)).toEqual(['bullet', 'none'])
    })

    it('a list picked on a heading, undone, and the heading’s own change undone after it, leave no style the block never had', () => {
      const { editor, lists } = open([[A, 0, 'one']])
      caret(editor, 0, 0)
      typeText(editor, '# ')
      pause(editor)
      // As `/bullet-list` makes the heading a bullet paragraph: its text, then a read of the page's styles.
      blockText(editor, A).write('one')
      lists.take({ [A]: style('bullet') })
      pause(editor)
      expect(texts(editor)).toEqual(['one'])

      editor.commands.undo()
      expect(texts(editor)).toEqual(['# one'])
      expect(lists.styleOf(A)).toBe('none')
      editor.commands.undo()
      expect(texts(editor)).toEqual(['\\# one'])

      expect(lists.styleOf(A)).toBe('none')
    })

    it('a list picked on a heading and undone comes back with the redo, each time', () => {
      const { editor, lists } = open([[A, 0, 'one']])
      caret(editor, 0, 0)
      typeText(editor, '# ')
      pause(editor)
      // As `/bullet-list` makes the heading a bullet paragraph: its text, then a read of the page's styles.
      blockText(editor, A).write('one')
      lists.take({ [A]: style('bullet') })
      pause(editor)

      for (let round = 0; round < 2; round += 1) {
        editor.commands.undo()
        expect(texts(editor)).toEqual(['# one'])
        expect(lists.styleOf(A)).toBe('none')
        editor.commands.redo()
        expect(texts(editor)).toEqual(['one'])
        expect(lists.styleOf(A)).toBe('bullet')
      }
    })

    it('a new change after the undo drops its redo: a later redo of another change gives no style', () => {
      const { editor, lists } = open([[A, 0, 'one']])
      caret(editor, 0, 0)
      typeText(editor, '# ')
      pause(editor)
      // As `/bullet-list` makes the heading a bullet paragraph: its text, then a read of the page's styles.
      blockText(editor, A).write('one')
      lists.take({ [A]: style('bullet') })
      pause(editor)

      editor.commands.undo()
      expect(texts(editor)).toEqual(['# one'])
      editor.commands.insertContent('x')
      pause(editor)
      toParagraph(editor, 0)
      pause(editor)
      editor.commands.undo()
      expect(texts(editor)).toEqual(['# xone'])
      editor.commands.redo()

      expect(texts(editor)).toEqual(['xone'])
      expect(lists.styleOf(A)).toBe('none')
    })

    it('after the history dropped events, an undo that leaves a block alone gives it no style', () => {
      const { editor, lists } = open(
        [
          [A, 0, 'one'],
          [B, 0, 'two'],
        ],
        { [A]: style('bullet') },
      )
      const typeInB = (times: number) => {
        for (let i = 0; i < times; i += 1) {
          caret(editor, 1, 0)
          typeText(editor, 'x')
          pause(editor)
        }
      }
      typeInB(108)
      caret(editor, 0, 0)
      typeText(editor, '# ')
      pause(editor)
      toParagraph(editor, 0)
      pause(editor)
      // The history keeps 100 events and cuts back to them past 120, so the event `# ` left the
      // list in is numbered lower than the depth held for it.
      typeInB(20)

      while (undoDepth(editor.state) > 100) editor.commands.undo()

      expect(texts(editor)[0]).toBe('one')
      expect(lists.styleOf(A)).toBe('none')
    })
  })
})

describe('the marker each block draws', () => {
  function markers(container: HTMLElement): string[] {
    return [...container.querySelectorAll('[data-page-block]')].map(
      (block) => block.querySelector(':scope > [data-testid="list-marker"]')?.textContent ?? '',
    )
  }

  function mount(rows: readonly Row[], styles: Record<string, PropertyRow[]>) {
    const lists = new PageLists(
      styles,
      rows.map(([id, depth]) => ({ id, depth })),
      () => false,
    )
    const mounted = mountNodeViews(rows, undefined, lists)
    teardown = () => {
      mounted.unmount()
      mounted.editor.destroy()
    }
    return mounted
  }

  it('leads its first line, outside the text, hidden from assistive technology, with no a11y violations', async () => {
    const { container } = mount(
      [
        [A, 0, 'one'],
        [B, 0, 'two'],
        [C, 0, 'plain'],
        [D, 0, 'dot'],
      ],
      { [A]: style('ordered'), [B]: style('ordered'), [D]: style('bullet') },
    )

    expect(markers(container)).toEqual(['1.', '2.', '', '•'])
    const marker = container.querySelector('[data-testid="list-marker"]') as HTMLElement
    expect(marker).toHaveClass('list-marker')
    expect(marker).toHaveAttribute('aria-hidden', 'true')
    expect(marker.contentEditable).toBe('false')
    expect(marker.nextElementSibling).toHaveClass('page-block-content')
    expect(await axe(container)).toHaveNoViolations()
  })

  it('draws none on a heading or a code block, whatever its style; the list block keeps its own', () => {
    const { container } = mount(
      [
        [A, 0, '# Title'],
        [B, 0, '```\ncode\n```'],
        [C, 0, 'item'],
      ],
      { [A]: style('bullet'), [B]: style('ordered'), [C]: style('bullet') },
    )

    expect(markers(container)).toEqual(['', '', '•'])
  })
})

/** `PageModeEditor`'s IPC answered by the mock backend, with every block in view. */
function onTheMockBackend(): void {
  vi.stubGlobal('IntersectionObserver', EnteringIntersectionObserver)
  seedBlocks()
  useSpaceStore.setState({ currentSpaceId: SCOPE.space_id })
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: InvokeArgs) =>
    dispatch(cmd, args),
  )
}

function backendStyle(id: string): string | null {
  const rows = dispatch('get_properties', { blockId: id }) as PropertyRow[]
  return rows.find((row) => row.key === 'listStyle')?.value_text ?? null
}

describe('a style write the backend refuses (PageModeEditor)', () => {
  const mockedInvoke = vi.mocked(invoke)

  beforeEach(onTheMockBackend)

  it('a typed `1. ` the backend refuses says so, and the block shows the style it kept', async () => {
    const { pageId, ids } = seedPage(['first'])
    const { container, unmount } = renderPageMode(pageId)
    const editor = await editorIn(container)
    teardown = unmount
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'set_property') throw new Error('database locked')
      return dispatch(cmd, args)
    })
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})

    act(() => {
      caret(editor, 0, 0)
      typeText(editor, '1. a')
    })
    expect(container.querySelector('[data-testid="list-marker"]')?.textContent).toBe('1.')

    await vi.waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('blockTree.setListStyleFailed'))
    })
    expect(container.querySelector('[data-testid="list-marker"]')).toBeNull()
    expect(backendStyle(ids[0] as string)).toBeNull()
    expect(error).toHaveBeenCalledTimes(1)
  })
})

describe('Ctrl+Z in the editor on a block made a task since it left its list (PageModeEditor)', () => {
  beforeEach(onTheMockBackend)

  it('keeps the task, and gives back no style the task would hide', async () => {
    const { pageId, ids } = seedPage(['first'])
    const id = ids[0] as string
    dispatch('set_property', {
      blockId: id,
      key: 'listStyle',
      value: {
        value_text: 'bullet',
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
    })
    const { container, unmount, store, handle } = renderPageMode(pageId)
    const editor = await editorIn(container)
    teardown = unmount
    const backendRow = () => dispatch('get_block', { blockId: id }) as BlockRow

    act(() => {
      caret(editor, 0, 0)
      typeText(editor, '# ')
      editor.view.dispatch(closeHistory(editor.state.tr))
    })
    await vi.waitFor(() => expect(backendStyle(id)).toBeNull())
    act(() => {
      press(editor, 'Enter', { ctrlKey: true })
    })
    await vi.waitFor(() => expect(store.getState().blocksById.get(id)?.todo_state).toBe('TODO'))

    act(() => {
      editor.commands.undo()
    })
    await act(async () => {
      await handle.current?.flush()
    })

    expect(backendRow().content).toBe('\\# first')
    expect(backendRow().todo_state).toBe('TODO')
    expect(backendStyle(id)).toBeNull()
  })
})
