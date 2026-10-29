/**
 * Block mode's Ctrl+Z inside the editor after a list block left its list
 * (#6156, `ListStyleUndo`), on the roving editor: the undo of exactly that
 * change asks the block's tree to write back the style the block showed, and
 * nothing else does. The marker is pushed as `EditableBlock` pushes it: the
 * stored style, then none once the save that left the list cleared it.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { serialize } from '@/editor/markdown-serializer'
import { toggleCodeBlockSafely } from '@/editor/toggle-code-block-safely'
import type { DocNode } from '@/editor/types'
import { type RovingEditorHandle, useRovingEditor } from '@/editor/use-roving-editor'
import type { ListStyle } from '@/lib/list-style'
import { dispatchBlockCommand } from '@/stores/block-command-bus'

vi.mock('@/stores/block-command-bus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/block-command-bus')>()
  return { ...actual, dispatchBlockCommand: vi.fn() }
})

let roving: RovingEditorHandle
let editor: Editor
let unmountHook: () => void

beforeEach(async () => {
  vi.clearAllMocks()
  const hook = renderHook(() => useRovingEditor())
  await waitFor(() => expect(hook.result.current.editor).not.toBeNull())
  roving = hook.result.current
  editor = roving.editor as Editor
  unmountHook = hook.unmount
})

afterEach(() => {
  editor.destroy()
  unmountHook()
})

/** Focus block `id` holding `markdown`, showing `style`'s marker. */
function mount(id: string, markdown: string, style: ListStyle): void {
  act(() => {
    roving.mount(id, markdown)
    roving.updateListMarker(style, style === 'ordered' ? 1 : undefined)
  })
}

/** Type `text` at the caret as the keyboard does, input rules included. */
function typeText(text: string): void {
  for (const ch of text) {
    const { from, to } = editor.state.selection
    const insert = () => editor.state.tr.insertText(ch, from, to)
    const handled = editor.view.someProp('handleTextInput', (f) =>
      f(editor.view, from, to, ch, insert),
    )
    if (handled !== true) editor.view.dispatch(insert())
  }
}

/** End the history's event, as a pause in typing does. */
const pause = () => editor.view.dispatch(closeHistory(editor.state.tr))
const text = () => serialize(editor.getJSON() as DocNode)
/** What the extension asked for, once its queued request has run. */
async function asked(): Promise<unknown[][]> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  return vi.mocked(dispatchBlockCommand).mock.calls
}

describe('Ctrl+Z in the roving editor after a list block left its list', () => {
  // An undo takes back an input rule first: the `#` typed stays as text.
  it.each([
    ['a typed `# `', 'bullet', () => typeText('# '), '\\# one'],
    ['`/code`', 'ordered', () => toggleCodeBlockSafely(editor), 'one'],
  ] as const)(
    'the undo of %s asks for the style the block showed back',
    async (_, style, leave, undone) => {
      mount('BLOCK_1', 'one', style)
      editor.commands.setTextSelection(1)
      leave()
      roving.updateListMarker('none', undefined)
      expect(await asked()).toEqual([])

      editor.commands.undo()

      expect(text()).toBe(undone)
      expect(await asked()).toEqual([['RESTORE_LIST_STYLE', { style }]])
    },
  )

  it('a Backspace back to a paragraph, or the undo of a later change, asks nothing; the undo of the change itself does', async () => {
    mount('BLOCK_1', 'one', 'bullet')
    editor.commands.setTextSelection(1)
    typeText('# ')
    roving.updateListMarker('none', undefined)
    pause()
    // As a Backspace on the heading's `#` run does.
    editor.view.dispatch(editor.state.tr.setNodeMarkup(0, editor.schema.nodes['paragraph']))
    pause()
    editor.commands.setTextSelection(1)
    typeText('## ')
    pause()
    expect(text()).toBe('## one')

    editor.commands.undo()
    editor.commands.undo()
    expect(text()).toBe('one')
    expect(await asked()).toEqual([])

    editor.commands.undo()
    editor.commands.undo()
    expect(text()).toBe('\\# one')
    expect(await asked()).toEqual([['RESTORE_LIST_STYLE', { style: 'bullet' }]])
  })

  it('a redo leaves the list again, and the undo after it asks again', async () => {
    mount('BLOCK_1', 'one', 'bullet')
    editor.commands.setTextSelection(1)
    typeText('# ')
    roving.updateListMarker('none', undefined)
    editor.commands.undo()
    expect(await asked()).toHaveLength(1)
    roving.updateListMarker('bullet', undefined)

    editor.commands.redo()
    expect(text()).toBe('# one')
    roving.updateListMarker('none', undefined)
    editor.commands.undo()

    expect(await asked()).toEqual([
      ['RESTORE_LIST_STYLE', { style: 'bullet' }],
      ['RESTORE_LIST_STYLE', { style: 'bullet' }],
    ])
  })

  it('what it holds is its block’s: the next mount forgets it', async () => {
    mount('BLOCK_1', 'one', 'bullet')
    editor.commands.setTextSelection(1)
    typeText('# ')
    roving.updateListMarker('none', undefined)

    mount('BLOCK_2', 'two', 'none')
    editor.commands.setTextSelection(1)
    typeText('# ')
    editor.commands.undo()

    expect(text()).toBe('\\# two')
    expect(await asked()).toEqual([])
  })
})
