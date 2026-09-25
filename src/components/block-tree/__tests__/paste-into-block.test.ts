/**
 * #5160 D4 — `pasteIntoBlock` against the REAL tauri-mock backend, the real
 * page store (registered as a provider registers it) and the real undo store:
 * the paste is spliced into the block, the editor is remounted on what the
 * block holds now and left with the caret at the join, and the toast's Undo /
 * Paste as text take the paste back.
 * The anchor is the focused block, as it is when the editor pastes: `load()`
 * keeps a focused block's text as the store holds it. Every effect is read
 * back through `load()`.
 */

import type { InvokeArgs } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { render } from '@testing-library/react'
import { Editor, type JSONContent } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import HardBreak from '@tiptap/extension-hard-break'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { createElement } from 'react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { pasteIntoBlock, type PasteIntoBlockTarget } from '@/components/block-tree/paste-into-block'
import { parse } from '@/editor/markdown-serializer'
import type { MountOptions, RovingEditorHandle } from '@/editor/use-roving-editor'
import { registerActiveDraftFlush } from '@/lib/active-draft-flush'
import { t } from '@/lib/i18n'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'
import { useBlockStore } from '@/stores/blocks'
import { getPageStore, PageBlockStoreProvider, type PageBlockState } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'
import { useUndoStore } from '@/stores/undo'

const mockedInvoke = vi.mocked(invoke)
const { PAGE_GETTING_STARTED: PAGE, BLOCK_GS_1: ANCHOR, BLOCK_GS_2: NEXT } = SEED_IDS

// PageBlockStoreProvider declares `children` as required; the cast keeps the
// createElement call free of an explicit children prop.
const Provider = PageBlockStoreProvider as unknown as (props: {
  pageId: string
}) => React.ReactElement

interface ToastOptions {
  action: { label: string; onClick: () => void }
  cancel?: { label: string; onClick: () => void }
}

let pageStore: StoreApi<PageBlockState>
let unmountProvider: () => void
let mount: ReturnType<typeof vi.fn>

function target(): PasteIntoBlockTarget {
  const editor = { activeBlockId: ANCHOR, editor: null, mount } as unknown as RovingEditorHandle
  return { blockId: ANCHOR, rootParentId: PAGE, pageStore, rovingEditor: () => editor }
}

const editors: Editor[] = []

/** The target over a real TipTap editor, whose `mount` loads a block's markdown. */
function liveTarget(): { target: PasteIntoBlockTarget; handle: RovingEditorHandle } {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [Document, Paragraph, Text, HardBreak],
  })
  editors.push(editor)
  const handle = {
    activeBlockId: ANCHOR as string | null,
    editor,
    mount: (blockId: string, markdown: string, opts?: MountOptions) => {
      handle.activeBlockId = blockId
      editor.commands.setContent(parse(markdown) as JSONContent)
      editor.commands.focus(opts?.cursorPlacement ?? null)
    },
  } as unknown as RovingEditorHandle
  return {
    target: { blockId: ANCHOR, rootParentId: PAGE, pageStore, rovingEditor: () => handle },
    handle,
  }
}

/**
 * The text before the caret of `handle`'s editor, a line per paragraph and
 * per hard break (a pasted `two\nlines` is one paragraph with a break, #5160 D2).
 */
function textBeforeCaret(handle: RovingEditorHandle): string {
  const { doc, selection } = (handle.editor as Editor).state
  expect(selection.empty).toBe(true)
  return doc.textBetween(0, selection.from, '\n', '\n')
}

/** The page's top-level blocks after a fresh load: `content` in order. */
async function topLevel(): Promise<Array<string | null>> {
  await pageStore.getState().load()
  return pageStore
    .getState()
    .blocks.filter((b) => b.parent_id === PAGE)
    .map((b) => b.content)
}

/** The options of the one "Pasted N blocks" toast. */
function pastedToast(): ToastOptions {
  const calls = vi.mocked(toast).mock.calls
  expect(calls).toHaveLength(1)
  return calls[0]?.[1] as ToastOptions
}

const PASTE = {
  input: { kind: 'text', text: 'First\n\nSecond' },
  splice: { before: 'Hello ', after: 'world' },
  asText: 'Hello First\\\n\\\nSecondworld',
} as const

describe('pasteIntoBlock (#5160 D4)', () => {
  beforeEach(async () => {
    seedBlocks()
    vi.clearAllMocks()
    useUndoStore.setState({ pages: new Map() })
    useSpaceStore.setState({ currentSpaceId: 'SPACE_PERSONAL' })
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
    dispatch('edit_block', { blockId: ANCHOR, toText: 'Hello world' })
    const view = render(createElement(Provider, { pageId: PAGE }))
    unmountProvider = view.unmount
    pageStore = getPageStore(PAGE) as StoreApi<PageBlockState>
    await pageStore.getState().load()
    useBlockStore.setState({ focusedBlockId: ANCHOR })
    mount = vi.fn()
  })

  afterEach(() => {
    unmountProvider()
    useBlockStore.setState({ focusedBlockId: null })
    for (const editor of editors.splice(0)) editor.destroy()
  })

  it('splices the paste into the block, remounts the editor on it, and offers Undo and Paste as text', async () => {
    const before = await topLevel()

    await pasteIntoBlock(target(), PASTE)

    const after = await topLevel()
    expect(after.slice(0, 3)).toEqual(['Hello First', 'Secondworld', before[1]])
    expect(after).toHaveLength(before.length + 1)
    expect(mount).toHaveBeenCalledWith(ANCHOR, 'Hello First', { cursorPlacement: 'end' })
    expect(vi.mocked(toast)).toHaveBeenCalledWith(
      t('block.pastedBlocks', { count: 2 }),
      expect.objectContaining({
        action: expect.objectContaining({ label: t('action.undo') }),
        cancel: expect.objectContaining({ label: t('block.pasteAsText') }),
      }),
    )
  })

  // The reload unmounts the focused block, which saves what the editor holds as
  // a draft: the editor must hold the pasted text by then.
  it('remounts the editor on the pasted text before the tree reloads', async () => {
    const order: string[] = []
    mount.mockImplementation(() => order.push('mount'))
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      order.push(cmd)
      return dispatch(cmd, args)
    })

    await pasteIntoBlock(target(), PASTE)

    expect(order.slice(0, 3)).toEqual(['paste_blocks', 'mount', 'load_page_subtree'])
  })

  it('flushes the pending draft commit before the paste, so it cannot land on top of it', async () => {
    const order: string[] = []
    const unregister = registerActiveDraftFlush(ANCHOR, async () => {
      order.push('flush')
    })
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      order.push(cmd)
      return dispatch(cmd, args)
    })

    await pasteIntoBlock(target(), PASTE)
    unregister()

    expect(order.slice(0, 2)).toEqual(['flush', 'paste_blocks'])
  })

  it('Undo leaves the block and reverts the whole paste', async () => {
    const before = await topLevel()
    await pasteIntoBlock(target(), PASTE)

    pastedToast().action.onClick()

    expect(useBlockStore.getState().focusedBlockId).toBeNull()
    await vi.waitFor(async () => expect(await topLevel()).toEqual(before))
  })

  // The draft flush commits what was typed just before the paste, inside the
  // undo grouping window: the paste must still be an undo entry of its own.
  it('Undo reverts the paste alone, not what was typed just before it', async () => {
    const typed = 'Hello typed world'
    const unregister = registerActiveDraftFlush(ANCHOR, async () => {
      await pageStore.getState().edit(ANCHOR, typed)
    })
    await pasteIntoBlock(target(), { ...PASTE, splice: { before: 'Hello typed ', after: 'world' } })
    unregister()
    expect((await topLevel())[0]).toBe('Hello typed First')

    pastedToast().action.onClick()

    await vi.waitFor(async () => expect((await topLevel())[0]).toBe(typed))
  })

  it('Paste as text reverts the paste and puts the text into the block as literal lines', async () => {
    const before = await topLevel()
    await pasteIntoBlock(target(), PASTE)

    pastedToast().cancel?.onClick()

    await vi.waitFor(async () =>
      expect(await topLevel()).toEqual([PASTE.asText, ...before.slice(1)]),
    )
    expect(dispatch('get_block', { blockId: ANCHOR })).toEqual(
      expect.objectContaining({ content: PASTE.asText }),
    )
  })

  it('takes nothing back once the page has changed after the paste', async () => {
    await pasteIntoBlock(target(), PASTE)
    const pasted = await topLevel()
    await pageStore.getState().edit(NEXT, 'changed later')

    pastedToast().action.onClick()

    await vi.waitFor(() =>
      expect(vi.mocked(toast)).toHaveBeenLastCalledWith(t('block.pasteUndoStale')),
    )
    const now = await topLevel()
    expect(now.slice(0, 2)).toEqual(pasted.slice(0, 2))
  })

  it('shows no toast for a paste that reads as one block', async () => {
    await pasteIntoBlock(target(), { ...PASTE, input: { kind: 'text', text: 'two\nlines' } })

    expect((await topLevel())[0]).toBe('Hello two\nlinesworld')
    expect(mount).toHaveBeenCalledWith(ANCHOR, 'Hello two\nlinesworld', {
      cursorPlacement: 'end',
    })
    expect(vi.mocked(toast)).not.toHaveBeenCalled()
  })

  it('leaves the caret in the last pasted block, just before the text that followed the cursor', async () => {
    const { target: live, handle } = liveTarget()

    await pasteIntoBlock(live, PASTE)

    const last = pageStore.getState().blocks.find((b) => b.content === 'Secondworld')?.id
    expect(last).toBeDefined()
    expect(useBlockStore.getState().focusedBlockId).toBe(last)
    expect(handle.activeBlockId).toBe(last)
    expect(textBeforeCaret(handle)).toBe('Second')
  })

  it('leaves the caret in the block, before the text that followed the cursor, for a paste of one block', async () => {
    const { target: live, handle } = liveTarget()

    await pasteIntoBlock(live, { ...PASTE, input: { kind: 'text', text: 'two\nlines' } })

    expect(useBlockStore.getState().focusedBlockId).toBe(ANCHOR)
    expect(handle.activeBlockId).toBe(ANCHOR)
    expect(textBeforeCaret(handle)).toBe('Hello two\nlines')
  })

  it('leaves the caret where it is when the editor left the block during the paste', async () => {
    const { target: live, handle } = liveTarget()
    handle.mount(NEXT, 'elsewhere', { cursorPlacement: 'start' })

    await pasteIntoBlock(live, PASTE)

    expect(useBlockStore.getState().focusedBlockId).toBe(ANCHOR)
    expect(handle.activeBlockId).toBe(NEXT)
    expect(textBeforeCaret(handle)).toBe('')
  })

  it('leaves the block and the editor alone when the paste is refused', async () => {
    const before = await topLevel()
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'paste_blocks') {
        return Promise.reject({ kind: 'validation', message: 'nothing to paste' })
      }
      return dispatch(cmd, args)
    })

    await pasteIntoBlock(target(), PASTE)

    expect(await topLevel()).toEqual(before)
    expect(mount).not.toHaveBeenCalled()
    expect(vi.mocked(toast)).not.toHaveBeenCalled()
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('error.pasteBlocksFailed'))
  })
})
