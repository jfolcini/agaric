/**
 * PageModeEditor's paste of text naming a page (#6033, `page-paste.ts`) over
 * the mock backend: once the page is saved it goes through `paste_blocks`,
 * whose pages and text the document then shows with the caret after the
 * paste; when the block pasted into could not be saved, its text goes in as
 * text instead.
 */

import type { InvokeArgs } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { act, waitFor } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EnteringIntersectionObserver } from '@/__tests__/helpers/viewport-observer-mocks'
import { markdownOf } from '@/editor/page-mode/__tests__/page-mode-fixtures'
import {
  editorIn,
  renderPageMode,
  SCOPE,
  seedPage,
} from '@/editor/page-mode/__tests__/page-node-view-fixtures'
import { blockIdOf } from '@/editor/token-ids'
import type { BlockRow } from '@/lib/bindings'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { seedBlocks } from '@/lib/tauri-mock/seed'
import { useBlockStore } from '@/stores/blocks'
import { useNavigationStore } from '@/stores/navigation'
import { useSpaceStore } from '@/stores/space'
import { useUndoStore } from '@/stores/undo'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('IntersectionObserver', EnteringIntersectionObserver)
  seedBlocks()
  useSpaceStore.setState({ currentSpaceId: SCOPE.space_id })
  useUndoStore.setState({ pages: new Map() })
  useNavigationStore.setState({ selectedBlockId: null })
  useBlockStore.setState({ focusedBlockId: null })
  mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The position `offset` characters into block `index`'s first textblock. */
function at(editor: Editor, index: number, offset: number): number {
  let pos = 0
  for (let i = 0; i < index; i += 1) pos += editor.state.doc.child(i).nodeSize
  return pos + 2 + offset
}

/** Paste `text` as Ctrl+V does with only text on the clipboard. */
function paste(editor: Editor, text: string): void {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (type: string) => (type === 'text/plain' ? text : ''), files: [] },
  })
  act(() => {
    editor.view.dom.dispatchEvent(event)
  })
}

function docTexts(editor: Editor): string[] {
  const out: string[] = []
  editor.state.doc.forEach((node) => out.push(markdownOf(node)))
  return out
}

/** The ids of the pages titled `title`. */
const pagesTitled = (title: string): string[] =>
  (dispatch('list_all_pages_in_space', { scope: SCOPE, tagIds: null }) as BlockRow[])
    .filter((p) => p.content === title)
    .map((p) => p.id)

const callsTo = (cmd: string): number =>
  mockedInvoke.mock.calls.filter(([name]) => name === cmd).length

describe('PageModeEditor’s paste of text naming a page (#6033)', () => {
  it('goes through paste_blocks once saved, shows what it made, and leaves the caret after it', async () => {
    const { pageId, ids } = seedPage(['Hello world', 'next'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    act(() => {
      editor.commands.setTextSelection(at(editor, 0, 'Hello '.length))
    })

    paste(editor, 'see [[Fresh page]]\n\nand [[Other page|other]] ')

    await waitFor(() => expect(docTexts(editor)).toHaveLength(3))
    const [fresh] = pagesTitled('Fresh page')
    const [other] = pagesTitled('Other page')
    expect(docTexts(editor)).toEqual([
      `Hello see [[${fresh}]]`,
      `and [[${other}|other]] world`,
      'next',
    ])
    expect(blockIdOf(editor.state.doc.child(0))).toBe(ids[0])
    const { $head } = editor.state.selection
    expect([
      $head.index(0),
      $head.parent.textBetween($head.parentOffset, $head.parent.content.size),
    ]).toEqual([1, 'world'])
    expect(useUndoStore.getState().pages.get(pageId)?.undoStack).toHaveLength(1)
  })

  it('lands where it was pasted, and keeps what was typed before it landed', async () => {
    const { pageId } = seedPage(['Hello world'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    act(() => {
      editor.commands.setTextSelection(at(editor, 0, 'Hello '.length))
    })

    paste(editor, 'see [[Fresh page]] ')
    act(() => {
      editor.commands.insertContentAt(at(editor, 0, 0), '>> ')
    })

    const fresh = await waitFor(() => {
      const [id] = pagesTitled('Fresh page')
      if (id === undefined) throw new Error('no page yet')
      return id
    })
    await waitFor(() => expect(docTexts(editor)).toEqual([`>> Hello see [[${fresh}]] world`]))
  })

  it('whose block could not be saved goes in as text, so none of it is lost', async () => {
    const { pageId } = seedPage(['alpha'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'create_block') throw new Error('refused')
      return dispatch(cmd, args)
    })
    act(() => {
      editor.commands.setTextSelection(at(editor, 0, 'alpha'.length))
      editor.view.someProp('handleKeyDown', (f) =>
        f(editor.view, new KeyboardEvent('keydown', { key: 'Enter' })),
      )
    })
    expect(docTexts(editor)).toEqual(['alpha', ''])

    paste(editor, 'see [[Fresh page]]')

    await waitFor(() => expect(docTexts(editor)).toEqual(['alpha', 'see \\[\\[Fresh page\\]\\]']))
    expect(callsTo('paste_blocks')).toBe(0)
    expect(pagesTitled('Fresh page')).toEqual([])
  })
})
