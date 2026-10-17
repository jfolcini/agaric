/**
 * PageModeEditor (#5691) over the mock backend: every IPC goes to
 * `src/lib/tauri-mock`, so what a save wrote is read back from it.
 */

import type { InvokeArgs } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import { createRef } from 'react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { getActiveEditor } from '@/editor/active-editor'
import { markdownOf } from '@/editor/page-mode/__tests__/page-mode-fixtures'
import {
  PAGE_MODE_BLOCK_CAP,
  PageModeEditor,
  type PageModeEditorHandle,
} from '@/editor/page-mode/PageModeEditor'
import type { BlockRow } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { seedBlocks } from '@/lib/tauri-mock/seed'
import { createPageBlockStore, PageBlockContext } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'
import { useUndoStore } from '@/stores/undo'

const mockedInvoke = vi.mocked(invoke)
const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' } as const

/** A page in the mock backend holding `texts`, one top-level block each; resolves its id. */
function seedPage(texts: readonly string[]): { pageId: string; ids: string[] } {
  const pageId = dispatch('create_page_in_space', {
    parentId: null,
    content: 'Page mode',
    spaceId: SCOPE.space_id,
  }) as string
  const created = dispatch('create_blocks_batch', {
    specs: texts.map((content) => ({
      blockType: 'content',
      content,
      parentId: pageId,
      position: null,
    })),
  }) as { blocks: BlockRow[] }
  return { pageId, ids: created.blocks.map((block) => block.id) }
}

function backendText(id: string): string | null {
  return (dispatch('get_block', { blockId: id }) as BlockRow).content
}

function renderPageMode(pageId: string, onOverCap = vi.fn()) {
  const store = createPageBlockStore(pageId)
  const handle = createRef<PageModeEditorHandle>()
  const view = render(
    <PageBlockContext.Provider value={store}>
      <PageModeEditor pageId={pageId} onOverCap={onOverCap} ref={handle} />
    </PageBlockContext.Provider>,
  )
  return { ...view, store, handle, onOverCap }
}

async function editorIn(container: HTMLElement): Promise<Editor> {
  const dom = await waitFor(() => {
    const found = container.querySelector('[data-testid="page-mode-editor"]')
    if (found === null) throw new Error('page mode editor not mounted')
    return found as HTMLElement & { editor?: Editor }
  })
  if (dom.editor === undefined) throw new Error('no editor on the page mode surface')
  return dom.editor
}

/** The position `offset` characters into block `index`'s first textblock. */
function at(editor: Editor, index: number, offset: number): number {
  let pos = 0
  for (let i = 0; i < index; i += 1) pos += editor.state.doc.child(i).nodeSize
  return pos + 2 + offset
}

beforeEach(() => {
  vi.clearAllMocks()
  seedBlocks()
  useSpaceStore.setState({ currentSpaceId: SCOPE.space_id })
  useUndoStore.setState({ pages: new Map() })
  mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
})

describe('PageModeEditor', () => {
  it('shows the whole page as one labelled document, with no a11y violations', async () => {
    const { pageId } = seedPage(['first', 'second', 'third'])
    const { container } = renderPageMode(pageId)

    const editor = await editorIn(container)

    expect(screen.getByRole('textbox', { name: t('pageMode.editorLabel') })).toBeInTheDocument()
    const texts: string[] = []
    editor.state.doc.forEach((node) => texts.push(markdownOf(node)))
    expect(texts).toEqual(['first', 'second', 'third'])
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })

  it('saves typing through the block commands, and the page-level undo stack gets the ops', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    const { container, handle } = renderPageMode(pageId)
    const editor = await editorIn(container)

    act(() => {
      editor
        .chain()
        .setTextSelection(at(editor, 1, 6))
        .insertContent('!')
        .run()
    })
    await act(async () => {
      await handle.current?.flush()
    })

    expect(backendText(ids[1] as string)).toBe('second!')
    expect(backendText(ids[0] as string)).toBe('first')
    expect(useUndoStore.getState().pages.get(pageId)?.undoStack).toHaveLength(1)
  })

  it('tells the user when a save fails, and the next save writes the text', async () => {
    const { pageId, ids } = seedPage(['first'])
    const { container, handle } = renderPageMode(pageId)
    const editor = await editorIn(container)
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'edit_block') throw new Error('disk full')
      return dispatch(cmd, args)
    })

    act(() => {
      editor
        .chain()
        .setTextSelection(at(editor, 0, 5))
        .insertContent('!')
        .run()
    })
    await act(async () => {
      await handle.current?.flush()
    })

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('pageMode.saveFailed'), {
      id: `page-mode-save-${pageId}`,
    })
    expect(backendText(ids[0] as string)).toBe('first')

    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
    await act(async () => {
      await handle.current?.flush()
    })

    expect(backendText(ids[0] as string)).toBe('first!')
  })

  it('patches in a block a peer changed when the store reloads', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    const { container, store } = renderPageMode(pageId)
    const editor = await editorIn(container)

    dispatch('edit_block', { blockId: ids[0], toText: 'first, from a peer' })
    await act(async () => {
      await store.getState().load()
    })

    expect(markdownOf(editor.state.doc.child(0))).toBe('first, from a peer')
  })

  it('publishes itself as the active editor when it takes focus', async () => {
    const { pageId } = seedPage(['first'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)

    act(() => {
      editor.view.focus()
    })

    expect(getActiveEditor()).toBe(editor)
  })

  it('does not open a page over the block cap, and says how many blocks it holds', async () => {
    const { pageId } = seedPage(Array.from({ length: PAGE_MODE_BLOCK_CAP + 1 }, (_, i) => `b${i}`))
    const { container, onOverCap } = renderPageMode(pageId)

    await waitFor(() => {
      expect(onOverCap).toHaveBeenCalledWith(PAGE_MODE_BLOCK_CAP + 1, PAGE_MODE_BLOCK_CAP)
    })
    expect(container.querySelector('[data-testid="page-mode-editor"]')).toBeNull()
  })
})
