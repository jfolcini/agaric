/**
 * Page mode's paste of text only block mode's block path reads (#6033,
 * `page-paste.ts`): which pastes go there, the splice of the block pasted
 * into, the paste through `paste_blocks` against the mock backend, one line
 * and several, a refusal that keeps the text, and the caret once it landed.
 */

import { invoke } from '@tauri-apps/api/core'
import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { idMinter, posIn, rowsOf } from '@/editor/page-mode/__tests__/page-mode-fixtures'
import { pageDocContent } from '@/editor/page-mode/page-document'
import { pageModeExtensions } from '@/editor/page-mode/page-mode-extensions'
import {
  type BlockPathPaste,
  caretAtJoin,
  goesToBlockPath,
  landOnBlockPath,
  mapPaste,
  pageSplice,
} from '@/editor/page-mode/page-paste'
import type { BlockRow } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { seedBlocks } from '@/lib/tauri-mock/seed'
import { createPageBlockStore } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'

const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' } as const
const noPickerItems = () => Promise.resolve([])

let editor: Editor | null = null
const routed: BlockPathPaste[] = []

beforeEach(() => {
  vi.mocked(invoke).mockImplementation(async (cmd, args) => dispatch(cmd, args))
  useSpaceStore.setState({ currentSpaceId: SCOPE.space_id })
  routed.length = 0
})

afterEach(() => {
  editor?.destroy()
  editor = null
  vi.restoreAllMocks()
})

/** A page in the mock backend holding one top-level block per text, and their ids. */
function seedPage(texts: readonly string[]): { pageId: string; ids: string[] } {
  seedBlocks()
  const pageId = dispatch('create_page_in_space', {
    parentId: null,
    content: 'Pasted into',
    spaceId: SCOPE.space_id,
  }) as string
  const ids = texts.map(
    (content) =>
      (
        dispatch('create_block', {
          blockType: 'content',
          content,
          parentId: pageId,
          index: null,
          scope: SCOPE,
        }) as BlockRow
      ).id,
  )
  return { pageId, ids }
}

/** Page mode over `blocks`, its block-path pastes taken into `routed`. */
function open(blocks: ReadonlyArray<{ id: string; depth: number; content: string | null }>) {
  const mintId = idMinter()
  editor = new Editor({
    element: document.createElement('div'),
    extensions: pageModeExtensions({
      resolveTagName: (id) => `#${id}`,
      resolveBlockTitle: (id) => id,
      resolveBlockStatus: () => 'active',
      resolveTagStatus: () => 'active',
      searchTags: noPickerItems,
      searchPages: noPickerItems,
      searchBlockRefs: noPickerItems,
      onCreatePage: () => Promise.resolve(''),
      onCreateTag: () => Promise.resolve(''),
      onNavigate: () => {},
      onTagClick: () => {},
      placeholder: '',
      mintId,
      blockPath: (pasted) => routed.push(pasted),
    }),
    content: pageDocContent(blocks, mintId),
  })
  return editor
}

/** Page mode over the seeded `texts`, the caret `offset` characters into the first. */
function openSeeded(texts: readonly string[], offset: number) {
  const seeded = seedPage(texts)
  const ed = open(seeded.ids.map((id, i) => ({ id, depth: 0, content: texts[i] ?? '' })))
  ed.commands.setTextSelection(posIn(ed, 0, offset))
  return { ...seeded, ed }
}

/** Paste `text` as Ctrl+V does with only text on the clipboard. */
function paste(ed: Editor, text: string): void {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (type: string) => (type === 'text/plain' ? text : ''), files: [] },
  })
  ed.view.dom.dispatchEvent(event)
}

const contentOf = (id: string): string | null =>
  (dispatch('get_block', { blockId: id }) as BlockRow).content

/** The ids of the pages titled `title`. */
const pagesTitled = (title: string): string[] =>
  (dispatch('list_all_pages_in_space', { scope: SCOPE, tagIds: null }) as BlockRow[])
    .filter((p) => p.content === title)
    .map((p) => p.id)

/** The page's top-level blocks' texts as the backend holds them, in order. */
const storedTexts = (pageId: string): Array<string | null> =>
  (
    dispatch('load_page_subtree', { rootBlockId: pageId, scope: SCOPE }) as { blocks: BlockRow[] }
  ).blocks
    .filter((b) => b.parent_id === pageId)
    .toSorted((x, y) => (x.position ?? 0) - (y.position ?? 0))
    .map((b) => b.content)

describe('which pastes go to block mode’s block path', () => {
  // The caret is `at` characters into 'Hello': 5 is after it, 0 where the block starts.
  it.each([
    ['one line naming a page', 'see [[Fresh page]]', 5, true],
    ['one line holding a foreign form', 'a ^^mark^^', 5, true],
    ['lines naming a page', 'one\n\nsee [[Fresh page]]', 5, true],
    ['list lines naming a page, after text', '- one\n- see [[Fresh page]]', 5, true],
    ['one list line naming a page, where the block starts', '- see [[Fresh page]]', 0, true],
    ['one plain line', 'see me', 5, false],
    ['plain lines', 'one\n\ntwo', 5, false],
    ['one list line after text, which stays the text pasted', '- see [[Fresh page]]', 5, false],
  ])('%s: %s', (_, text, at, expected) => {
    const ed = open([{ id: 'A', depth: 0, content: 'Hello' }])
    ed.commands.setTextSelection(posIn(ed, 0, at))
    expect(goesToBlockPath(text, ed.state.selection)).toBe(expected)
  })

  it('takes none inside a table, which the splice would cut', () => {
    const ed = open([
      { id: 'A', depth: 0, content: '| a | b |\n| --- | --- |\n| c | d |' },
      { id: 'B', depth: 0, content: 'two' },
    ])
    ed.commands.setTextSelection(posIn(ed, 0, 3))
    expect(goesToBlockPath('see [[Fresh page]]', ed.state.selection)).toBe(false)
    ed.commands.setTextSelection({ from: posIn(ed, 1, 1), to: posIn(ed, 1, 2) })
    expect(goesToBlockPath('see [[Fresh page]]', ed.state.selection)).toBe(true)
  })

  it('takes none over two blocks, which the splice would join', () => {
    const ed = open([
      { id: 'A', depth: 0, content: 'one' },
      { id: 'B', depth: 0, content: 'two' },
    ])
    ed.commands.setTextSelection({ from: posIn(ed, 1, 1), to: posIn(ed, 1, 2) })
    expect(goesToBlockPath('see [[Fresh page]]', ed.state.selection)).toBe(true)
    ed.commands.setTextSelection({ from: posIn(ed, 0, 1), to: posIn(ed, 1, 2) })
    expect(goesToBlockPath('see [[Fresh page]]', ed.state.selection)).toBe(false)
  })

  it('hands such a paste over, with the range pasted over, and leaves the document alone', () => {
    const ed = open([{ id: 'A', depth: 0, content: 'Hello world' }])
    ed.commands.setTextSelection({ from: posIn(ed, 0, 6), to: posIn(ed, 0, 11) })

    paste(ed, 'see [[Fresh page]]')

    expect(routed).toEqual([
      { blockId: 'A', text: 'see [[Fresh page]]', from: posIn(ed, 0, 6), to: posIn(ed, 0, 11) },
    ])
    expect(rowsOf(ed.state.doc)).toEqual([['A', 0, 'Hello world']])
  })

  it('keeps a plain-text paste (Shift) and a paste naming nothing in the document', () => {
    const ed = open([{ id: 'A', depth: 0, content: 'Hello ' }])
    ed.commands.setTextSelection(posIn(ed, 0, 6))

    ed.view.pasteText('see [[Fresh page]]')
    paste(ed, ' and more')

    expect(routed).toEqual([])
    expect(rowsOf(ed.state.doc)).toEqual([['A', 0, 'Hello see \\[\\[Fresh page\\]\\] and more']])
  })
})

describe('the splice of the block pasted into', () => {
  it('is its text before and after the range, as block mode’s, and none once the range left it', () => {
    const ed = open([
      { id: 'A', depth: 0, content: 'Hello **bold** world' },
      { id: 'B', depth: 0, content: 'two' },
    ])
    const range = { blockId: 'A', text: 'x', from: posIn(ed, 0, 8), to: posIn(ed, 0, 9) }
    expect(pageSplice(ed.state.doc, range)).toEqual({
      before: 'Hello **bo**',
      after: '**d** world',
    })
    expect(pageSplice(ed.state.doc, { ...range, blockId: 'B' })).toBeNull()
  })

  it('is none once the block was split inside the range, whose end is then in the next block', () => {
    const ed = open([{ id: 'A', depth: 0, content: 'Hello world' }])
    const range: BlockPathPaste = {
      blockId: 'A',
      text: 'x',
      from: posIn(ed, 0, 2),
      to: posIn(ed, 0, 8),
    }
    const split = ed.state.tr.split(posIn(ed, 0, 5), 2)

    mapPaste(range, split.mapping)

    expect(pageSplice(split.doc, range)).toBeNull()
  })

  it('stays on the range pasted over, before text typed at it', () => {
    const ed = open([{ id: 'A', depth: 0, content: 'Hello world' }])
    const at = posIn(ed, 0, 6)
    const range: BlockPathPaste = { blockId: 'A', text: 'x', from: at, to: at }
    const typed = ed.state.tr.insertText('typed ', at).insertText('>> ', posIn(ed, 0, 0))

    mapPaste(range, typed.mapping)

    expect(range).toEqual({ ...range, from: at + 3, to: at + 3 })
  })
})

describe('a paste through paste_blocks', () => {
  it('one line: links a new page in the block pasted into, spliced where it was pasted', async () => {
    const { pageId, ids, ed } = openSeeded(['Hello world', 'next'], 'Hello '.length)
    const [anchor, next] = ids as [string, string]
    const store = createPageBlockStore(pageId)
    await store.getState().load()
    paste(ed, 'see [[Fresh page]] ')
    const [pasted] = routed as [BlockPathPaste]

    const landed = await landOnBlockPath(ed.view, pasted, store.getState().pasteBlocks)

    const [fresh] = pagesTitled('Fresh page')
    expect(fresh).toBeDefined()
    expect(storedTexts(pageId)).toEqual([`Hello see [[${fresh}]] world`, 'next'])
    expect(landed).toEqual({ ids: [anchor], after: 'world' })
    expect(contentOf(next)).toBe('next')
  })

  it('several lines: links the pages in the block pasted into and in the new one', async () => {
    const { pageId, ids, ed } = openSeeded(['Hello ', 'next'], 'Hello '.length)
    const store = createPageBlockStore(pageId)
    await store.getState().load()
    paste(ed, 'see [[Fresh page]]\n\nand [[Other page|other]]')

    const landed = await landOnBlockPath(
      ed.view,
      routed[0] as BlockPathPaste,
      store.getState().pasteBlocks,
    )

    const [fresh] = pagesTitled('Fresh page')
    const [other] = pagesTitled('Other page')
    expect(storedTexts(pageId)).toEqual([
      `Hello see [[${fresh}]]`,
      `and [[${other}|other]]`,
      'next',
    ])
    expect(landed?.ids).toHaveLength(2)
    expect(landed?.ids[0]).toBe(ids[0])
  })

  it.each([
    ['one line', 'see [[Fresh page]] ', ['Hello see \\[\\[Fresh page\\]\\] world', 'next']],
    [
      'several lines',
      'see [[Fresh page]]\n\nand [[Other page|other]] ',
      ['Hello see \\[\\[Fresh page\\]\\]', 'and \\[\\[Other page|other\\]\\] world', 'next'],
    ],
  ])(
    'refused, %s: logs it, and the text goes in as text, so none is lost',
    async (_, text, shown) => {
      const { pageId, ed } = openSeeded(['Hello world', 'next'], 'Hello '.length)
      const store = createPageBlockStore(pageId)
      await store.getState().load()
      const refusal = new Error('the paste would nest too deep')
      vi.mocked(invoke).mockImplementation(async (cmd, args) => {
        if (cmd === 'paste_blocks') throw refusal
        return dispatch(cmd, args)
      })
      const error = vi.spyOn(logger, 'error')
      paste(ed, text)

      const landed = await landOnBlockPath(
        ed.view,
        routed[0] as BlockPathPaste,
        store.getState().pasteBlocks,
      )

      expect(landed).toBeNull()
      expect(error).toHaveBeenCalledWith(
        'page-blocks',
        'Failed to paste blocks',
        expect.objectContaining({ anchorBlockId: routed[0]?.blockId }),
        refusal,
      )
      expect(rowsOf(ed.state.doc).map(([, , markdown]) => markdown)).toEqual(shown)
      expect(storedTexts(pageId)).toEqual(['Hello world', 'next'])
      expect(pagesTitled('Fresh page')).toEqual([])
    },
  )
})

describe('the caret once a paste landed', () => {
  /** The page as the store holds it once `text` landed `offset` characters into 'Hello world'. */
  async function landedPage(text: string) {
    const { pageId, ed } = openSeeded(['Hello world', 'next'], 'Hello '.length)
    const store = createPageBlockStore(pageId)
    await store.getState().load()
    paste(ed, text)
    const pasted = routed[0] as BlockPathPaste
    const landed = await landOnBlockPath(ed.view, pasted, store.getState().pasteBlocks)
    ed.destroy()
    const shown = open(store.getState().blocks)
    shown.commands.setTextSelection(posIn(shown, 0, 'Hello '.length))
    return { ed: shown, pasted, landed: landed as NonNullable<typeof landed> }
  }

  it('goes into the last block pasted, before the text that followed the range, in view', async () => {
    const { ed, pasted, landed } = await landedPage('one\n\ntwo [[Fresh page]] ')
    const dispatched = vi.spyOn(ed.view, 'dispatch')

    caretAtJoin(ed.view, pasted, landed)

    const { $head } = ed.state.selection
    expect($head.index(0)).toBe(1)
    expect($head.parent.textBetween(0, $head.parentOffset, '', '￼')).toBe('two ￼ ')
    expect(dispatched.mock.calls.map(([tr]) => tr.scrolledIntoView)).toEqual([true])
  })

  it('stays where it is once it left the block pasted into', async () => {
    const { ed, pasted, landed } = await landedPage('one\n\ntwo [[Fresh page]] ')
    ed.commands.setTextSelection(posIn(ed, 2, 1))

    caretAtJoin(ed.view, pasted, landed)

    expect(ed.state.selection.head).toBe(posIn(ed, 2, 1))
  })
})
