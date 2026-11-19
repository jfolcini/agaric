/**
 * #6755 — a typed `[[Tag/x]]` naming no page links tag `x`'s page, made with
 * the tag as `#x` makes a tag: the block editor's `[[` input rule creates
 * through `useBlockResolve().onCreatePage`, against the mock backend. A name
 * holding whitespace is dashed, tag and title, and a toast says so.
 */

import { type InvokeArgs, invoke } from '@tauri-apps/api/core'
import { renderHook } from '@testing-library/react'
import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useBlockResolve } from '@/components/block-tree/use-block-resolve'
import { BlockLink } from '@/editor/extensions/block-link'
import { BlockLinkPicker } from '@/editor/extensions/block-link-picker'
import { t } from '@/lib/i18n'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'
import { useSpaceStore } from '@/stores/space'

const SPACE = SEED_IDS.SPACE_PERSONAL

/** The live block of `type` in the space whose content is `content`, read back from the mock. */
function liveIds(type: 'page' | 'tag', content: string): string[] {
  return [...blocks.values()]
    .filter(
      (b) =>
        b['block_type'] === type &&
        !b['deleted_at'] &&
        b['space_id'] === SPACE &&
        b['content'] === content,
    )
    .map((b) => b['id'] as string)
}

/** The ids of the page links the editor holds. */
function linkIds(editor: Editor): string[] {
  const ids: string[] = []
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'block_link') ids.push(node.attrs['id'] as string)
  })
  return ids
}

/** Type `typed` so the input rules see its last character, as a keystroke does. */
function typeText(editor: Editor, typed: string): void {
  editor.chain().focus().insertContent(typed.slice(0, -1)).run()
  const last = typed.slice(-1)
  const { from } = editor.state.selection
  const handled = editor.view.someProp('handleTextInput', (f) =>
    f(editor.view, from, from, last, () => editor.state.tr.insertText(last, from)),
  )
  if (!handled) editor.commands.insertContent(last)
}

let editor: Editor | undefined

function blockEditor(): Editor {
  const { result } = renderHook(() => useBlockResolve())
  editor = new Editor({
    extensions: [
      Document,
      Paragraph,
      Text,
      BlockLink,
      BlockLinkPicker.configure({
        items: (query) => result.current.searchPages(query),
        onCreate: (label) => result.current.onCreatePage(label),
      }),
    ],
    content: '<p></p>',
  })
  return editor
}

beforeEach(() => {
  vi.clearAllMocks()
  seedBlocks()
  useSpaceStore.setState({
    currentSpaceId: SPACE,
    availableSpaces: [{ id: SPACE, name: 'Personal', accent_color: null }],
    isReady: true,
  })
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: InvokeArgs) =>
    dispatch(cmd, args),
  )
})

afterEach(() => {
  editor?.destroy()
  editor = undefined
})

describe('a typed [[Tag/x]] link', () => {
  it('makes tag x and its page, and links that page, as #x makes the tag', async () => {
    const ed = blockEditor()
    expect(liveIds('tag', 'quokka')).toEqual([])

    typeText(ed, 'see [[Tag/quokka]]')

    await vi.waitFor(() => expect(linkIds(ed)).toHaveLength(1))
    expect(liveIds('tag', 'quokka')).toHaveLength(1)
    expect(linkIds(ed)).toEqual(liveIds('page', 'Tag/quokka'))
    expect(toast.info).not.toHaveBeenCalled()
  })

  it('pairs with the tag the space holds, making no second one', async () => {
    const ed = blockEditor()

    typeText(ed, '[[Tag/Work]]')

    await vi.waitFor(() => expect(linkIds(ed)).toHaveLength(1))
    expect(liveIds('tag', 'work')).toEqual([SEED_IDS.TAG_WORK])
    expect(liveIds('tag', 'Work')).toEqual([])
    expect(linkIds(ed)).toEqual(liveIds('page', 'Tag/Work'))
  })

  it('dashes a spaced name, tag and title, and says so', async () => {
    const ed = blockEditor()

    typeText(ed, '[[Tag/deep work]]')

    await vi.waitFor(() => expect(linkIds(ed)).toHaveLength(1))
    expect(liveIds('tag', 'deep-work')).toHaveLength(1)
    expect(linkIds(ed)).toEqual(liveIds('page', 'Tag/deep-work'))
    expect(liveIds('page', 'Tag/deep work')).toEqual([])
    expect(toast.info).toHaveBeenCalledExactlyOnceWith(
      t('tags.linkPageDashed', { title: 'Tag/deep-work' }),
    )
  })

  it('leaves the text as typed when the create is refused', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'create_tag_page_titled') throw new Error('disk full')
      return dispatch(cmd, args)
    })
    const ed = blockEditor()

    typeText(ed, '[[Tag/quokka]]')

    await vi.waitFor(() => expect(ed.getText()).toBe('[[Tag/quokka]]'))
    expect(linkIds(ed)).toEqual([])
    expect(liveIds('page', 'Tag/quokka')).toEqual([])
  })
})
