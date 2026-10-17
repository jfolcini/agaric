/**
 * `handleTurnIntoFocused` (the `turnIntoBlock` chord, #5733) against a real
 * TipTap editor carrying the real slash extension: the chord must open the
 * picker on a block whose caret follows a non-space character, and leave the
 * block text exactly as it was once a type is picked or the picker is closed.
 * The popup renderer is stubbed to capture the props the picker hands it.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { exitSuggestion, type SuggestionProps } from '@tiptap/suggestion'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useFocusedBlockActions } from '@/components/editor/useFocusedBlockActions'
import { SlashCommand, slashCommandPluginKey } from '@/editor/extensions/slash-command'
import type { PickerItem } from '@/editor/SuggestionList'
import type { RovingEditorHandle } from '@/editor/use-roving-editor'

const popup = vi.hoisted(() => ({ props: null as SuggestionProps | null }))

vi.mock('@/editor/suggestion-renderer', () => ({
  createSuggestionRenderer: () => ({
    onStart: (props: SuggestionProps) => {
      popup.props = props
    },
    onUpdate: (props: SuggestionProps) => {
      popup.props = props
    },
    onKeyDown: () => false,
    onExit: () => {
      popup.props = null
    },
  }),
}))

const TEXT = 'Create new blocks by pressing Enter at the end of any block.'
const QUOTE: PickerItem = { id: 'turn-quote', label: 'Quote' }

let editor: Editor | null = null

afterEach(() => {
  editor?.destroy()
  editor = null
  popup.props = null
})

function setup() {
  const textAtCommand: string[] = []
  const onCommand = vi.fn(() => {
    textAtCommand.push(ed.getText())
  })
  const ed = new Editor({
    element: document.createElement('div'),
    extensions: [
      Document,
      Paragraph,
      Text,
      SlashCommand.configure({ items: () => [QUOTE], onCommand }),
    ],
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: TEXT }] }],
    },
  })
  editor = ed
  const caret = ed.state.doc.content.size - 1
  ed.commands.setTextSelection(caret)
  const { result } = renderHook(() =>
    useFocusedBlockActions({
      focusedBlockId: 'BLOCK_1',
      handleToggleTodo: vi.fn(),
      toggleCollapse: vi.fn(),
      handleShowProperties: vi.fn(),
      handleShowHistory: vi.fn(),
      handleDuplicate: vi.fn(),
      rovingEditor: { editor: ed } as unknown as RovingEditorHandle,
    }),
  )
  return { ed, caret, onCommand, textAtCommand, turnInto: result.current.handleTurnIntoFocused }
}

describe('handleTurnIntoFocused', () => {
  it('opens the picker on `/turn` with the caret after a non-space character', async () => {
    const { ed, turnInto } = setup()
    act(() => turnInto())

    await waitFor(() => expect(popup.props?.query).toBe('turn'))
    expect(slashCommandPluginKey.getState(ed.state)).toMatchObject({ active: true, query: 'turn' })
  })

  it('runs the picked command with the block text exactly as before', async () => {
    const { onCommand, textAtCommand, turnInto } = setup()
    act(() => turnInto())
    await waitFor(() => expect(popup.props).not.toBeNull())

    act(() => popup.props?.command(QUOTE))

    expect(onCommand).toHaveBeenCalledWith(QUOTE)
    expect(textAtCommand).toEqual([TEXT])
  })

  it('closing the picker leaves the text unchanged and puts the caret back', async () => {
    const { ed, caret, turnInto } = setup()
    act(() => turnInto())
    await waitFor(() => expect(popup.props).not.toBeNull())

    act(() => exitSuggestion(ed.view, slashCommandPluginKey))

    expect(popup.props).toBeNull()
    expect(ed.getText()).toBe(TEXT)
    expect(ed.state.selection.from).toBe(caret)
  })

  it('a caret moved past the trigger into the first word closes the picker and keeps the word', async () => {
    const { ed, turnInto } = setup()
    act(() => turnInto())
    await waitFor(() => expect(popup.props).not.toBeNull())

    act(() => {
      ed.commands.setTextSelection(ed.state.selection.from + 3)
    })
    act(() => exitSuggestion(ed.view, slashCommandPluginKey))

    expect(ed.getText()).toBe(TEXT)
  })
})
