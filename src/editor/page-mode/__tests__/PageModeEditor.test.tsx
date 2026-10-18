/**
 * PageModeEditor (#5691) over the mock backend: every IPC goes to
 * `src/lib/tauri-mock`, so what a save wrote is read back from it.
 */

import type { InvokeArgs } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import { ReactRenderer } from '@tiptap/react'
import { createRef } from 'react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { getActiveEditor } from '@/editor/active-editor'
import { markdownOf } from '@/editor/page-mode/__tests__/page-mode-fixtures'
import { PAGE_MODE_BLOCK_CAP } from '@/editor/page-mode/page-mode-fit'
import { PageModeEditor, type PageModeEditorHandle } from '@/editor/page-mode/PageModeEditor'
import { blockIdOf } from '@/editor/token-ids'
import { flushActiveDraft } from '@/lib/active-draft-flush'
import type { BlockRow } from '@/lib/bindings'
import type { NavigateToPageFn } from '@/lib/block-events'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { seedBlocks } from '@/lib/tauri-mock/seed'
import { useNavigationStore } from '@/stores/navigation'
import { createPageBlockStore, PageBlockContext } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'
import { useUndoStore } from '@/stores/undo'

const mockedInvoke = vi.mocked(invoke)
const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' } as const

/** A page in the mock backend holding `texts`, one top-level block each; resolves its id. */
function seedPage(
  texts: readonly string[],
  title = 'Page mode',
): { pageId: string; ids: string[] } {
  const pageId = dispatch('create_page_in_space', {
    parentId: null,
    content: title,
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

/** The page's live blocks in the backend: id and text, in order. */
function backendPage(pageId: string): Array<[string, string]> {
  const { blocks } = dispatch('load_page_subtree', { rootBlockId: pageId, scope: SCOPE }) as {
    blocks: BlockRow[]
  }
  return blocks
    .toSorted((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((block) => [block.id, block.content ?? ''])
}

function renderPageMode(
  pageId: string,
  props: { onNavigateToPage?: NavigateToPageFn; cursorBlockId?: string } = {},
) {
  const store = createPageBlockStore(pageId)
  const handle = createRef<PageModeEditorHandle>()
  const onBlocked = vi.fn()
  const view = render(
    <PageBlockContext.Provider value={store}>
      <PageModeEditor pageId={pageId} onBlocked={onBlocked} ref={handle} {...props} />
    </PageBlockContext.Provider>,
  )
  return { ...view, store, handle, onBlocked }
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

function typeAt(editor: Editor, index: number, offset: number, text: string): void {
  act(() => {
    editor
      .chain()
      .setTextSelection(at(editor, index, offset))
      .insertContent(text)
      .run()
  })
}

function docTexts(editor: Editor): string[] {
  const out: string[] = []
  editor.state.doc.forEach((node) => out.push(markdownOf(node)))
  return out
}

const passThrough = async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args)

beforeEach(() => {
  vi.clearAllMocks()
  seedBlocks()
  useSpaceStore.setState({ currentSpaceId: SCOPE.space_id })
  useUndoStore.setState({ pages: new Map() })
  useNavigationStore.setState({ selectedBlockId: null })
  mockedInvoke.mockImplementation(passThrough)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('PageModeEditor', () => {
  it('shows the whole page as one labelled document, with no a11y violations', async () => {
    const { pageId } = seedPage(['first', 'second', 'third'])
    const { container } = renderPageMode(pageId)

    const editor = await editorIn(container)

    expect(screen.getByRole('textbox', { name: t('pageMode.editorLabel') })).toBeInTheDocument()
    expect(docTexts(editor)).toEqual(['first', 'second', 'third'])
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })

  it('saves typing through the block commands, one undo entry per block as block mode', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    const { container, handle } = renderPageMode(pageId)
    const editor = await editorIn(container)

    vi.useFakeTimers({ toFake: ['Date'] })
    typeAt(editor, 1, 6, '!')
    await act(async () => {
      await handle.current?.flush()
    })
    // Past the undo store's grouping window: only the block groups the two saves.
    vi.setSystemTime(Date.now() + 5_000)
    typeAt(editor, 1, 7, '?')
    await act(async () => {
      await handle.current?.flush()
    })

    expect(backendText(ids[1] as string)).toBe('second!?')
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

    typeAt(editor, 0, 5, '!')
    await act(async () => {
      await handle.current?.flush()
    })

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('pageMode.saveFailed'), {
      id: `page-mode-save-${pageId}`,
    })
    expect(backendText(ids[0] as string)).toBe('first')

    mockedInvoke.mockImplementation(passThrough)
    await act(async () => {
      await handle.current?.flush()
    })

    expect(backendText(ids[0] as string)).toBe('first!')
  })

  it('a block deleted elsewhere and then edited here keeps the text as a new block, with a notice', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    const { container, handle } = renderPageMode(pageId)
    const editor = await editorIn(container)
    // Deleted by an agent with no reload; the backend refuses an edit of a deleted block.
    dispatch('delete_block', { blockId: ids[1] })
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'edit_block' && (args as { blockId: string }).blockId === ids[1]) {
        throw new Error('block not found')
      }
      return dispatch(cmd, args)
    })

    typeAt(editor, 1, 6, ' kept')
    await act(async () => {
      await handle.current?.flush()
    })

    const page = backendPage(pageId)
    expect(page.map(([, text]) => text)).toEqual(['first', 'second kept'])
    expect(page[1]?.[0]).not.toBe(ids[1])
    expect(blockIdOf(editor.state.doc.child(1))).toBe(page[1]?.[0])
    expect(vi.mocked(toast.info)).toHaveBeenCalledWith(t('pageMode.keptAsNew', { count: 1 }), {
      id: `page-mode-kept-${pageId}`,
    })
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
  })

  it('brings in what a store reload shows: a peer’s edit, a new block, a deleted one', async () => {
    const { pageId, ids } = seedPage(['first', 'second', 'third'])
    const { container, store } = renderPageMode(pageId)
    const editor = await editorIn(container)

    dispatch('edit_block', { blockId: ids[0], toText: 'first, from a peer' })
    dispatch('delete_block', { blockId: ids[2] })
    const added = dispatch('create_block', {
      blockType: 'content',
      content: 'from a peer',
      parentId: pageId,
      index: 1,
      scope: SCOPE,
    }) as BlockRow
    await act(async () => {
      await store.getState().load()
    })

    await waitFor(() => {
      expect(docTexts(editor)).toEqual(['first, from a peer', 'from a peer', 'second'])
    })
    expect(blockIdOf(editor.state.doc.child(1))).toBe(added.id)
  })

  it('reads the store again when its reload overlapped a save, and reverts nothing typed', async () => {
    const { pageId, ids } = seedPage(['first'])
    const { container, store, handle } = renderPageMode(pageId)
    const editor = await editorIn(container)
    const stale = store.getState().blocks

    act(() => {
      store.setState({ loading: true })
    })
    typeAt(editor, 0, 5, '!')
    await act(async () => {
      await handle.current?.flush()
    })
    await act(async () => {
      store.setState({ loading: false, blocks: [...stale] })
      await handle.current?.flush()
    })

    expect(docTexts(editor)).toEqual(['first!'])
    expect(backendText(ids[0] as string)).toBe('first!')
  })

  it('saves pending text when an export asks, and when the window is hidden', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    act(() => {
      editor.view.focus()
    })

    typeAt(editor, 0, 5, '!')
    await act(async () => {
      await flushActiveDraft()
    })
    expect(backendText(ids[0] as string)).toBe('first!')

    typeAt(editor, 1, 6, '?')
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    try {
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'))
        // One task: the save's IPC answers settle, long before the 700 ms idle save.
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    } finally {
      hidden.mockRestore()
    }
    expect(backendText(ids[1] as string)).toBe('second?')
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

  it('opens a page link’s chip as block mode does', async () => {
    const other = seedPage(['elsewhere'], 'Other page')
    const { pageId } = seedPage([`see [[${other.pageId}]]`])
    const onNavigateToPage = vi.fn()
    const { container } = renderPageMode(pageId, { onNavigateToPage })
    await editorIn(container)

    const chip = await waitFor(() => {
      const found = container.querySelector('[data-testid="block-link-chip"]')
      if (found === null) throw new Error('no chip')
      return found
    })
    await act(async () => {
      fireEvent.click(chip)
    })

    await waitFor(() => {
      expect(onNavigateToPage).toHaveBeenCalledWith(other.pageId, 'Other page')
    })
  })

  it('a block reference to a block of this page moves the cursor there', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    dispatch('edit_block', { blockId: ids[0], toText: `see ((${ids[1]}))` })
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)

    const chip = await waitFor(() => {
      const found = container.querySelector('[data-testid="block-ref-chip"]')
      if (found === null) throw new Error('no chip')
      return found
    })
    await act(async () => {
      fireEvent.click(chip)
    })

    await waitFor(() => {
      expect(editor.state.selection.$head.index(0)).toBe(1)
    })
  })

  it('a link from elsewhere to a block of this page lands the cursor on it', async () => {
    const { pageId, ids } = seedPage(['first', 'second', 'third'])
    useNavigationStore.setState({ selectedBlockId: ids[2] as string })
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)

    await waitFor(() => {
      expect(editor.state.selection.$head.index(0)).toBe(2)
    })
    expect(useNavigationStore.getState().selectedBlockId).toBeNull()
  })

  it('opens with the cursor in the block block mode was editing', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    const { container } = renderPageMode(pageId, { cursorBlockId: ids[1] as string })
    const editor = await editorIn(container)

    await waitFor(() => {
      expect(editor.state.selection.$head.index(0)).toBe(1)
    })
  })

  it('does not open a page over the block cap, and says how many blocks it holds', async () => {
    const { pageId } = seedPage(Array.from({ length: PAGE_MODE_BLOCK_CAP + 1 }, (_, i) => `b${i}`))
    const { container, onBlocked } = renderPageMode(pageId)

    await waitFor(() => {
      expect(onBlocked).toHaveBeenCalledWith({ kind: 'overCap', count: PAGE_MODE_BLOCK_CAP + 1 })
    })
    expect(container.querySelector('[data-testid="page-mode-editor"]')).toBeNull()
  })

  it('does not open a page whose blocks hold a property', async () => {
    const { pageId, ids } = seedPage(['first'])
    dispatch('set_property', {
      blockId: ids[0],
      key: 'effort',
      value: {
        value_text: '1h',
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
    })
    const { container, onBlocked } = renderPageMode(pageId)

    await waitFor(() => {
      expect(onBlocked).toHaveBeenCalledWith({ kind: 'properties' })
    })
    expect(container.querySelector('[data-testid="page-mode-editor"]')).toBeNull()
  })

  it('leaves page mode when a reload brings in what it cannot show', async () => {
    const { pageId, ids } = seedPage(['first'])
    const { container, store, onBlocked } = renderPageMode(pageId)
    await editorIn(container)

    dispatch('set_priority', { blockId: ids[0], level: '1' })
    await act(async () => {
      await store.getState().load()
    })

    await waitFor(() => {
      expect(onBlocked).toHaveBeenCalledWith({ kind: 'priorities' })
    })
  })
})

describe('PageModeEditor typed tags (#5743)', () => {
  const TAG_REF = /#\[([0-9A-Z]{26})\]/
  /** The mock's seeded `work` tag (`src/lib/tauri-mock/seed.ts`). */
  const SEED_TAG_WORK = '000000000000000000000TAG01'

  /** The space's tags: id by name. */
  function tagIds(): Map<string, string> {
    const rows = dispatch('list_all_tags_in_space', { scope: SCOPE }) as Array<{
      tag_id: string
      name: string
    }>
    return new Map(rows.map((row) => [row.name, row.tag_id]))
  }

  function caretTo(editor: Editor, index: number): void {
    act(() => {
      editor.commands.setTextSelection(at(editor, index, 0))
    })
  }

  it('a #name typed and left for another block becomes the tag, its chip, and undoes', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    const { container, handle } = renderPageMode(pageId)
    const editor = await editorIn(container)

    typeAt(editor, 0, 5, ' #newtag')
    caretTo(editor, 1)

    await waitFor(() => {
      expect(backendText(ids[0] as string)).toMatch(/^first #\[[0-9A-Z]{26}\]$/)
    })
    const tagId = TAG_REF.exec(backendText(ids[0] as string) ?? '')?.[1]
    expect(tagIds().get('newtag')).toBe(tagId)
    await waitFor(() => {
      expect(docTexts(editor)).toEqual([`first #[${tagId}]`, 'second'])
    })
    expect(
      container.querySelector(`[data-page-block-id="${ids[0]}"] [data-testid="tag-ref-chip"]`),
    ).not.toBeNull()

    act(() => {
      editor.commands.undo()
    })
    await act(async () => {
      await handle.current?.flush()
    })
    expect(docTexts(editor)).toEqual(['first', 'second'])
    expect(backendPage(pageId)).toEqual([
      [ids[0], 'first'],
      [ids[1], 'second'],
    ])
  })

  it('a name the caret is still after stays text through a save, until the caret leaves', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    act(() => {
      editor.view.focus()
    })

    typeAt(editor, 0, 5, ' #proj')
    await act(async () => {
      await flushActiveDraft()
    })

    expect(backendText(ids[0] as string)).toBe('first #proj')
    expect(tagIds().has('proj')).toBe(false)
    expect(docTexts(editor)).toEqual(['first #proj', 'second'])

    caretTo(editor, 1)
    await waitFor(() => {
      expect(backendText(ids[0] as string)).toBe(`first #[${tagIds().get('proj')}]`)
    })
  })

  it('a name an existing tag has, in any case, is that tag', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    const before = tagIds().size

    typeAt(editor, 0, 5, ' #Work')
    caretTo(editor, 1)

    await waitFor(() => {
      expect(backendText(ids[0] as string)).toBe(`first #[${SEED_TAG_WORK}]`)
    })
    expect(tagIds().size).toBe(before)
  })

  it('leaving page mode, or the page, with the caret after a name makes it the tag', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    const { container, handle, unmount } = renderPageMode(pageId)
    const editor = await editorIn(container)

    typeAt(editor, 0, 5, ' #switched')
    await act(async () => {
      await handle.current?.flush()
    })
    expect(backendText(ids[0] as string)).toBe(`first #[${tagIds().get('switched')}]`)

    typeAt(editor, 1, 6, ' #left')
    unmount()
    await waitFor(() => {
      expect(backendText(ids[1] as string)).toBe(`second #[${tagIds().get('left')}]`)
    })
  })

  it('a block typed in again and left while its tag is being made is committed by the next save', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    let release = (): void => {}
    const created = new Promise<void>((resolve) => {
      release = resolve
    })
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'create_block' && (args as { blockType: string }).blockType === 'tag') {
        await created
      }
      return dispatch(cmd, args)
    })

    typeAt(editor, 0, 5, ' #newtag')
    caretTo(editor, 1)
    // The commit is now waiting on the tag's creation.
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('list_all_tags_in_space', expect.anything())
    })
    typeAt(editor, 0, 13, 'X')
    caretTo(editor, 1)
    release()

    await waitFor(() => {
      expect(backendText(ids[0] as string)).toBe(`first #[${tagIds().get('newtagX')}]`)
    })
    expect(docTexts(editor)).toEqual([`first #[${tagIds().get('newtagX')}]`, 'second'])
  })

  it('a tag that cannot be created leaves the name as text, and logs why', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    const warn = vi.spyOn(logger, 'warn')
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'create_block' && (args as { blockType: string }).blockType === 'tag') {
        throw new Error('disk full')
      }
      return dispatch(cmd, args)
    })

    typeAt(editor, 0, 5, ' #newtag')
    caretTo(editor, 1)

    await waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        'unmount-flush',
        'tag create failed, the tag stays text',
        { name: 'newtag' },
        expect.any(Error),
      )
    })
    expect(backendText(ids[0] as string)).toBe('first #newtag')
    expect(docTexts(editor)).toEqual(['first #newtag', 'second'])
    expect(tagIds().has('newtag')).toBe(false)
  })
})

describe('PageModeEditor tasks (#5743)', () => {
  function backendState(id: string): string | null {
    return (dispatch('get_block', { blockId: id }) as BlockRow).todo_state
  }

  /** Block `id`'s checkbox, once it shows. */
  async function checkbox(container: HTMLElement, id: string): Promise<HTMLElement> {
    return waitFor(() => {
      const found = container.querySelector<HTMLElement>(
        `[data-page-block-id="${id}"] [data-testid="task-marker"]`,
      )
      if (found === null) throw new Error(`no checkbox on ${id}`)
      return found
    })
  }

  function caretTo(editor: Editor, index: number): void {
    act(() => {
      editor.commands.setTextSelection(at(editor, index, 0))
    })
  }

  /** Press `key` in the editor; true when it took the key. */
  function press(editor: Editor, key: string, init: KeyboardEventInit = {}): boolean {
    let taken = false
    act(() => {
      taken =
        editor.view.someProp('handleKeyDown', (f) =>
          f(editor.view, new KeyboardEvent('keydown', { key, ...init })),
        ) ?? false
    })
    return taken
  }

  it('opens a page of tasks, each with block mode’s checkbox, with no a11y violations', async () => {
    const { pageId, ids } = seedPage(['todo', 'doing', 'done', 'plain'])
    dispatch('set_todo_state', { blockId: ids[0], state: 'TODO' })
    dispatch('set_todo_state', { blockId: ids[1], state: 'DOING' })
    dispatch('set_todo_state', { blockId: ids[2], state: 'DONE' })
    const { container, onBlocked } = renderPageMode(pageId)
    const editor = await editorIn(container)

    expect((await checkbox(container, ids[0] as string)).getAttribute('aria-label')).toBe(
      t('block.taskCycle', { state: 'TODO' }),
    )
    expect(
      (await checkbox(container, ids[2] as string)).querySelector(
        '[data-testid="task-checkbox-done"]',
      ),
    ).not.toBeNull()
    expect(
      container.querySelector(`[data-page-block-id="${ids[2]}"]`)?.getAttribute('data-todo-state'),
    ).toBe('DONE')
    expect(container.querySelector(`[data-page-block-id="${ids[3]}"] .task-marker`)).toBeNull()
    expect(docTexts(editor)).toEqual(['todo', 'doing', 'done', 'plain'])
    expect(onBlocked).not.toHaveBeenCalled()
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })

  it('a click cycles the state through the command, and the backend holds it', async () => {
    const { pageId, ids } = seedPage(['buy milk'])
    dispatch('set_todo_state', { blockId: ids[0], state: 'TODO' })
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)

    await act(async () => {
      fireEvent.click(await checkbox(container, ids[0] as string))
    })

    await waitFor(() => {
      expect(backendState(ids[0] as string)).toBe('DOING')
    })
    await waitFor(async () => {
      expect((await checkbox(container, ids[0] as string)).getAttribute('aria-label')).toBe(
        t('block.taskCycle', { state: 'DOING' }),
      )
    })
    expect(docTexts(editor)).toEqual(['buy milk'])
    expect(backendText(ids[0] as string)).toBe('buy milk')
  })

  it('a refused state write says so and shows the state the backend kept', async () => {
    const { pageId, ids } = seedPage(['buy milk'])
    dispatch('set_todo_state', { blockId: ids[0], state: 'TODO' })
    const { container } = renderPageMode(pageId)
    await editorIn(container)
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'set_todo_state') throw new Error('database locked')
      return dispatch(cmd, args)
    })

    await act(async () => {
      fireEvent.click(await checkbox(container, ids[0] as string))
    })

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('blockTree.setTaskStateFailed'))
    })
    expect((await checkbox(container, ids[0] as string)).getAttribute('aria-label')).toBe(
      t('block.taskCycle', { state: 'TODO' }),
    )
    expect(backendState(ids[0] as string)).toBe('TODO')
  })

  it('Ctrl+Enter cycles the task of the block the caret is in, a new empty one too', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)

    caretTo(editor, 1)
    expect(press(editor, 'Enter', { ctrlKey: true })).toBe(true)
    await waitFor(() => {
      expect(backendState(ids[1] as string)).toBe('TODO')
    })
    await checkbox(container, ids[1] as string)
    expect(docTexts(editor)).toEqual(['first', 'second'])
    expect(backendState(ids[0] as string)).toBeNull()

    // A new block holds nothing yet: the cycle creates it to hold the state.
    act(() => {
      editor.commands.setTextSelection(at(editor, 1, 6))
    })
    press(editor, 'Enter')
    const added = blockIdOf(editor.state.doc.child(2)) as string
    press(editor, 'Enter', { ctrlKey: true })
    await waitFor(() => {
      expect(backendPage(pageId)).toEqual([
        [ids[0], 'first'],
        [ids[1], 'second'],
        [added, ''],
      ])
    })
    await waitFor(() => {
      expect(backendState(added)).toBe('TODO')
    })
    await checkbox(container, added)
  })

  it('a typed marker becomes the task once the caret leaves the block, not before', async () => {
    const { pageId, ids } = seedPage(['first', 'buy milk'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    act(() => {
      editor.view.focus()
    })

    typeAt(editor, 1, 0, '[ ] ')
    await act(async () => {
      await flushActiveDraft()
    })
    expect(backendText(ids[1] as string)).toBe('\\[ \\] buy milk')
    expect(backendState(ids[1] as string)).toBeNull()
    expect(container.querySelector('[data-testid="task-marker"]')).toBeNull()

    caretTo(editor, 0)
    await waitFor(() => {
      expect(backendState(ids[1] as string)).toBe('TODO')
    })
    await waitFor(() => {
      expect(backendText(ids[1] as string)).toBe('buy milk')
    })
    await waitFor(() => {
      expect(docTexts(editor)).toEqual(['first', 'buy milk'])
    })
    await checkbox(container, ids[1] as string)
  })

  it('a marker the block already held stays text when the block is edited and left', async () => {
    const { pageId, ids } = seedPage(['first', '[x] means unknown'])
    const { container, handle } = renderPageMode(pageId)
    const editor = await editorIn(container)

    typeAt(editor, 1, 17, '!')
    caretTo(editor, 0)
    await act(async () => {
      await handle.current?.flush()
    })

    expect(backendState(ids[1] as string)).toBeNull()
    expect(docTexts(editor)).toEqual(['first', '\\[x\\] means unknown!'])
    expect(backendText(ids[1] as string)).toBe('\\[x\\] means unknown!')
    expect(container.querySelector('[data-testid="task-marker"]')).toBeNull()
  })

  it('a typed `- [x] ` gives DONE, and `TODO` stays a word, as in block mode', async () => {
    const { pageId, ids } = seedPage(['first', 'shipped', 'later'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)

    typeAt(editor, 1, 0, '- [x] ')
    typeAt(editor, 2, 0, 'TODO ')
    caretTo(editor, 0)

    await waitFor(() => {
      expect(backendState(ids[1] as string)).toBe('DONE')
    })
    await waitFor(() => {
      expect(docTexts(editor)).toEqual(['first', 'shipped', 'TODO later'])
    })
    expect(backendText(ids[1] as string)).toBe('shipped')
    expect(backendState(ids[2] as string)).toBeNull()
    expect(backendText(ids[2] as string)).toBe('TODO later')
  })

  it('pasted task lines each become a task once left', async () => {
    const { pageId, ids } = seedPage(['first', ''])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)

    act(() => {
      editor.commands.setTextSelection(at(editor, 1, 0))
      editor.view.pasteText('- [ ] one\n[/] two')
    })
    const pasted = blockIdOf(editor.state.doc.child(2)) as string
    caretTo(editor, 0)

    await waitFor(() => {
      expect(backendState(ids[1] as string)).toBe('TODO')
    })
    await waitFor(() => {
      expect(backendState(pasted)).toBe('DOING')
    })
    await waitFor(() => {
      expect(docTexts(editor)).toEqual(['first', 'one', 'two'])
    })
  })

  it('a marker whose state write is refused stays text, and says so', async () => {
    const { pageId, ids } = seedPage(['first', 'buy milk'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'set_todo_state') throw new Error('database locked')
      return dispatch(cmd, args)
    })

    typeAt(editor, 1, 0, '[ ] ')
    caretTo(editor, 0)

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('blockTree.setTaskStateFailed'))
    })
    expect(backendText(ids[1] as string)).toBe('\\[ \\] buy milk')
    expect(backendState(ids[1] as string)).toBeNull()
    expect(docTexts(editor)).toEqual(['first', '\\[ \\] buy milk'])
  })

  it('typing in a block draws no checkbox again', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    dispatch('set_todo_state', { blockId: ids[0], state: 'TODO' })
    dispatch('set_todo_state', { blockId: ids[1], state: 'DONE' })
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    await checkbox(container, ids[1] as string)
    const draw = vi.spyOn(ReactRenderer.prototype, 'render')

    typeAt(editor, 1, 6, ' typed')
    typeAt(editor, 0, 5, '!')

    expect(draw).not.toHaveBeenCalled()
  })

  /** How many checkboxes React holds for the editor: one portal each. */
  function liveCheckboxes(editor: Editor): number {
    const content = (editor as unknown as { contentComponent: { getSnapshot: () => object } })
      .contentComponent
    return Object.keys(content.getSnapshot()).length
  }

  it('Enter at the start of a task leaves the checkbox on the task, not on the new block', async () => {
    const { pageId, ids } = seedPage(['first', 'buy milk'])
    dispatch('set_todo_state', { blockId: ids[1], state: 'TODO' })
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    await checkbox(container, ids[1] as string)

    caretTo(editor, 1)
    press(editor, 'Enter')

    expect(editor.state.doc.childCount).toBe(3)
    expect(blockIdOf(editor.state.doc.child(2))).toBe(ids[1])
    await checkbox(container, ids[1] as string)
    expect(container.querySelectorAll('[data-testid="task-marker"]')).toHaveLength(1)
    expect(liveCheckboxes(editor)).toBe(1)
  })

  it('a checkbox goes with its block: deleted, brought back by undo, and page mode closed', async () => {
    const { pageId, ids } = seedPage(['a', 'b', 'c'])
    dispatch('set_todo_state', { blockId: ids[1], state: 'DOING' })
    const { container, unmount } = renderPageMode(pageId)
    const editor = await editorIn(container)
    await checkbox(container, ids[1] as string)
    expect(liveCheckboxes(editor)).toBe(1)
    const portals = (editor as unknown as { contentComponent: { getSnapshot: () => object } })
      .contentComponent

    act(() => {
      editor.commands.setTextSelection({ from: at(editor, 1, 0), to: at(editor, 2, 0) })
      editor.commands.deleteSelection()
    })
    await waitFor(() => {
      expect(liveCheckboxes(editor)).toBe(0)
    })
    expect(container.querySelector('.react-renderer')).toBeNull()

    act(() => {
      editor.commands.undo()
    })
    await checkbox(container, ids[1] as string)
    expect(liveCheckboxes(editor)).toBe(1)
    await act(async () => {
      await flushActiveDraft()
    })
    await waitFor(() => {
      expect(backendState(ids[1] as string)).toBe('DOING')
    })

    unmount()
    expect(Object.keys(portals.getSnapshot())).toHaveLength(0)
  })

  it('a peer’s text that starts like a marker stays text: only the user’s own changes are committed', async () => {
    const { pageId, ids } = seedPage(['a', 'b', 'c'])
    const { container, store } = renderPageMode(pageId)
    const editor = await editorIn(container)
    dispatch('edit_block', { blockId: ids[1], toText: '[ ] from a peer' })
    await act(async () => {
      await store.getState().load()
    })
    await waitFor(() => {
      expect(docTexts(editor)[1]).toBe('\\[ \\] from a peer')
    })

    // The user types in another block and leaves it: its save is the one that runs.
    typeAt(editor, 0, 1, '!')
    caretTo(editor, 2)
    await waitFor(() => {
      expect(backendText(ids[0] as string)).toBe('a!')
    })

    expect(backendText(ids[1] as string)).toBe('[ ] from a peer')
    expect(backendState(ids[1] as string)).toBeNull()
  })

  it('deleting a block turns no marker in the block after it into a task', async () => {
    const { pageId, ids } = seedPage(['a', '[ ] b', 'c'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)

    act(() => {
      editor.commands.setTextSelection({ from: at(editor, 0, 0), to: at(editor, 1, 0) })
      editor.commands.deleteSelection()
    })
    caretTo(editor, 1)
    await act(async () => {
      await flushActiveDraft()
    })
    await waitFor(() => {
      expect(backendPage(pageId).map(([id]) => id)).toEqual([ids[1], ids[2]])
    })

    expect(backendText(ids[1] as string)).toBe('[ ] b')
    expect(backendState(ids[1] as string)).toBeNull()
  })

  it('a peer’s state change shows on reload, outside the document and its undo', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    const { container, store } = renderPageMode(pageId)
    const editor = await editorIn(container)

    dispatch('set_todo_state', { blockId: ids[1], state: 'DONE' })
    await act(async () => {
      await store.getState().load()
    })

    await waitFor(() => {
      expect(
        container.querySelector(
          `[data-page-block-id="${ids[1]}"] [data-testid="task-checkbox-done"]`,
        ),
      ).not.toBeNull()
    })
    expect(docTexts(editor)).toEqual(['first', 'second'])
    expect(editor.can().undo()).toBe(false)
  })
})
