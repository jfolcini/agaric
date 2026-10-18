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
import {
  EnteringIntersectionObserver,
  MockIntersectionObserver,
} from '@/__tests__/helpers/viewport-observer-mocks'
import { getActiveEditor } from '@/editor/active-editor'
import { markdownOf } from '@/editor/page-mode/__tests__/page-mode-fixtures'
import { PAGE_MODE_BLOCK_CAP } from '@/editor/page-mode/page-mode-fit'
import { PageModeEditor, type PageModeEditorHandle } from '@/editor/page-mode/PageModeEditor'
import { blockIdOf } from '@/editor/token-ids'
import { flushActiveDraft } from '@/lib/active-draft-flush'
import type { BlockRow } from '@/lib/bindings'
import type { NavigateToPageFn } from '@/lib/block-events'
import { formatCompactDate } from '@/lib/date-utils'
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

/** How many controls (checkboxes, badge and chip rows) React holds for the editor: one portal each. */
function liveControls(editor: Editor): number {
  const content = (editor as unknown as { contentComponent: { getSnapshot: () => object } })
    .contentComponent
  return Object.keys(content.getSnapshot()).length
}

function docTexts(editor: Editor): string[] {
  const out: string[] = []
  editor.state.doc.forEach((node) => out.push(markdownOf(node)))
  return out
}

const passThrough = async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args)

beforeEach(() => {
  vi.clearAllMocks()
  // jsdom lays nothing out: every block is in view.
  vi.stubGlobal('IntersectionObserver', EnteringIntersectionObserver)
  seedBlocks()
  useSpaceStore.setState({ currentSpaceId: SCOPE.space_id })
  useUndoStore.setState({ pages: new Map() })
  useNavigationStore.setState({ selectedBlockId: null })
  mockedInvoke.mockImplementation(passThrough)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
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

    dispatch('set_property', {
      blockId: ids[0],
      key: 'repeat',
      value: {
        value_text: '+1w',
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
    })
    await act(async () => {
      await store.getState().load()
    })

    await waitFor(() => {
      expect(onBlocked).toHaveBeenCalledWith({ kind: 'properties' })
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

  it('typing, its save and a reload draw no checkbox, badge or chip again', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    dispatch('set_todo_state', { blockId: ids[0], state: 'TODO' })
    dispatch('set_todo_state', { blockId: ids[1], state: 'DONE' })
    dispatch('set_priority', { blockId: ids[0], level: '1' })
    dispatch('set_due_date', { blockId: ids[0], date: '2026-10-20' })
    dispatch('set_scheduled_date', { blockId: ids[1], date: '2026-10-21' })
    const { container, handle, store } = renderPageMode(pageId)
    const editor = await editorIn(container)
    await checkbox(container, ids[1] as string)
    await waitFor(() => {
      expect(container.querySelectorAll('.block-metadata-row')).toHaveLength(2)
    })
    const draw = vi.spyOn(ReactRenderer.prototype, 'render')

    typeAt(editor, 1, 6, ' typed')
    typeAt(editor, 0, 5, '!')
    await act(async () => {
      await handle.current?.flush()
      await store.getState().load()
    })

    expect(backendText(ids[0] as string)).toBe('first!')
    expect(draw).not.toHaveBeenCalled()
  })

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
    expect(liveControls(editor)).toBe(1)
  })

  it('a checkbox goes with its block: deleted, brought back by undo, and page mode closed', async () => {
    const { pageId, ids } = seedPage(['a', 'b', 'c'])
    dispatch('set_todo_state', { blockId: ids[1], state: 'DOING' })
    const { container, unmount } = renderPageMode(pageId)
    const editor = await editorIn(container)
    await checkbox(container, ids[1] as string)
    expect(liveControls(editor)).toBe(1)
    const portals = (editor as unknown as { contentComponent: { getSnapshot: () => object } })
      .contentComponent

    act(() => {
      editor.commands.setTextSelection({ from: at(editor, 1, 0), to: at(editor, 2, 0) })
      editor.commands.deleteSelection()
    })
    await waitFor(() => {
      expect(liveControls(editor)).toBe(0)
    })
    expect(container.querySelector('.react-renderer')).toBeNull()

    act(() => {
      editor.commands.undo()
    })
    await checkbox(container, ids[1] as string)
    expect(liveControls(editor)).toBe(1)
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

describe('PageModeEditor priorities and dates (#5743)', () => {
  function backendRow(id: string): BlockRow {
    return dispatch('get_block', { blockId: id }) as BlockRow
  }

  /** What `selector` finds in block `id`, once it shows. */
  async function inBlock(container: HTMLElement, id: string, selector: string) {
    return waitFor(() => {
      const found = container.querySelector<HTMLElement>(`[data-page-block-id="${id}"] ${selector}`)
      if (found === null) throw new Error(`no ${selector} in ${id}`)
      return found
    })
  }

  const BADGE = '[data-testid="priority-badge"]'
  const badgeLabel = (level: string) => t('block.priorityCycle', { level: `P${level}` })

  /** Type `text` into the open date picker's field and press Enter. */
  async function pickDate(text: string): Promise<void> {
    const field = await screen.findByRole('textbox', { name: t('journal.typeDateLabel') })
    fireEvent.change(field, { target: { value: text } })
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' })
    })
  }

  it('shows block mode’s badge and chips under the text, outside it, with no a11y violations', async () => {
    const { pageId, ids } = seedPage(['pay rent', 'plan trip', 'plain'])
    dispatch('set_todo_state', { blockId: ids[0], state: 'TODO' })
    dispatch('set_priority', { blockId: ids[0], level: '1' })
    dispatch('set_due_date', { blockId: ids[0], date: '2026-10-20' })
    dispatch('set_scheduled_date', { blockId: ids[1], date: '2026-11-01' })
    const { container, onBlocked } = renderPageMode(pageId)
    const editor = await editorIn(container)

    expect((await inBlock(container, ids[0] as string, BADGE)).getAttribute('aria-label')).toBe(
      badgeLabel('1'),
    )
    expect(
      (await inBlock(container, ids[0] as string, '.due-date-chip')).getAttribute('aria-label'),
    ).toBe(t('block.dueDate', { date: formatCompactDate('2026-10-20') }))
    expect(
      (await inBlock(container, ids[1] as string, '.scheduled-chip')).getAttribute('aria-label'),
    ).toBe(t('block.scheduledDate', { date: formatCompactDate('2026-11-01') }))
    expect(
      container.querySelector(`[data-page-block-id="${ids[2]}"] .block-metadata-row`),
    ).toBeNull()
    expect(container.querySelector('.page-block-content .block-metadata-row')).toBeNull()
    expect(docTexts(editor)).toEqual(['pay rent', 'plan trip', 'plain'])
    expect(onBlocked).not.toHaveBeenCalled()
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })

  it('a click on the badge cycles the priority through the command; a refusal says so', async () => {
    const { pageId, ids } = seedPage(['pay rent'])
    dispatch('set_priority', { blockId: ids[0], level: '1' })
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)

    await act(async () => {
      fireEvent.click(await inBlock(container, ids[0] as string, BADGE))
    })
    await waitFor(() => {
      expect(backendRow(ids[0] as string).priority).toBe('2')
    })
    await waitFor(async () => {
      expect((await inBlock(container, ids[0] as string, BADGE)).getAttribute('aria-label')).toBe(
        badgeLabel('2'),
      )
    })

    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'set_priority') throw new Error('database locked')
      return dispatch(cmd, args)
    })
    await act(async () => {
      fireEvent.click(await inBlock(container, ids[0] as string, BADGE))
    })
    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('blockTree.setPriorityFailed'))
    })
    expect((await inBlock(container, ids[0] as string, BADGE)).getAttribute('aria-label')).toBe(
      badgeLabel('2'),
    )
    expect(backendRow(ids[0] as string).priority).toBe('2')
    expect(docTexts(editor)).toEqual(['pay rent'])
  })

  it('Ctrl+Shift+1–3 set the priority of the caret’s block, a new empty one too; a refusal says so', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)

    caretTo(editor, 1)
    expect(press(editor, '3', { ctrlKey: true, shiftKey: true })).toBe(true)
    await waitFor(() => {
      expect(backendRow(ids[1] as string).priority).toBe('3')
    })
    expect((await inBlock(container, ids[1] as string, BADGE)).getAttribute('aria-label')).toBe(
      badgeLabel('3'),
    )
    expect(backendRow(ids[0] as string).priority).toBeNull()

    // A new block holds nothing yet: the change creates it to hold the priority.
    act(() => {
      editor.commands.setTextSelection(at(editor, 1, 6))
    })
    press(editor, 'Enter')
    const added = blockIdOf(editor.state.doc.child(2)) as string
    press(editor, '1', { ctrlKey: true, shiftKey: true })
    await waitFor(() => {
      expect(backendPage(pageId)).toEqual([
        [ids[0], 'first'],
        [ids[1], 'second'],
        [added, ''],
      ])
    })
    await waitFor(() => {
      expect(backendRow(added).priority).toBe('1')
    })
    await inBlock(container, added, BADGE)

    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'set_priority') throw new Error('database locked')
      return dispatch(cmd, args)
    })
    caretTo(editor, 0)
    press(editor, '2', { ctrlKey: true, shiftKey: true })
    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('blockTree.setPriorityFailed'))
    })
    expect(backendRow(ids[0] as string).priority).toBeNull()
    expect(container.querySelector(`[data-page-block-id="${ids[0]}"] ${BADGE}`)).toBeNull()
  })

  it('a chip opens block mode’s date picker, and the date chosen is the block’s', async () => {
    const { pageId, ids } = seedPage(['pay rent', 'plan trip'])
    dispatch('set_due_date', { blockId: ids[0], date: '2026-10-20' })
    dispatch('set_scheduled_date', { blockId: ids[1], date: '2026-11-01' })
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)

    fireEvent.click(await inBlock(container, ids[0] as string, '.due-date-chip'))
    expect(await screen.findByTestId('date-picker-popup')).toHaveAttribute('data-editor-portal')
    await pickDate('2026-12-24')

    await waitFor(() => {
      expect(backendRow(ids[0] as string).due_date).toBe('2026-12-24')
    })
    await waitFor(async () => {
      expect(
        (await inBlock(container, ids[0] as string, '.due-date-chip')).getAttribute('aria-label'),
      ).toBe(t('block.dueDate', { date: formatCompactDate('2026-12-24') }))
    })
    expect(screen.queryByTestId('date-picker-popup')).toBeNull()

    fireEvent.click(await inBlock(container, ids[1] as string, '.scheduled-chip'))
    await pickDate('2026-12-31')
    await waitFor(() => {
      expect(backendRow(ids[1] as string).scheduled_date).toBe('2026-12-31')
    })
    expect(backendRow(ids[1] as string).due_date).toBeNull()
    expect(backendRow(ids[0] as string).scheduled_date).toBeNull()
    expect(docTexts(editor)).toEqual(['pay rent', 'plan trip'])
  })

  it('a date the command refuses says so, and the chip keeps the date the backend holds', async () => {
    const { pageId, ids } = seedPage(['pay rent'])
    dispatch('set_due_date', { blockId: ids[0], date: '2026-10-20' })
    const { container } = renderPageMode(pageId)
    await editorIn(container)
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'set_due_date') throw new Error('database locked')
      return dispatch(cmd, args)
    })

    fireEvent.click(await inBlock(container, ids[0] as string, '.due-date-chip'))
    await pickDate('2026-12-24')

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('blockTree.setDueDateFailed'))
    })
    expect(backendRow(ids[0] as string).due_date).toBe('2026-10-20')
    expect(
      (await inBlock(container, ids[0] as string, '.due-date-chip')).getAttribute('aria-label'),
    ).toBe(t('block.dueDate', { date: formatCompactDate('2026-10-20') }))
  })

  it('opening the picker neither leaves the block nor commits what is typed in it', async () => {
    const { pageId, ids } = seedPage(['pay rent', 'buy milk'])
    dispatch('set_due_date', { blockId: ids[0], date: '2026-10-20' })
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    act(() => {
      editor.view.focus()
    })
    typeAt(editor, 1, 0, '[ ] ')
    const caret = editor.state.selection.from

    fireEvent.click(await inBlock(container, ids[0] as string, '.due-date-chip'))
    const field = await screen.findByRole('textbox', { name: t('journal.typeDateLabel') })
    await waitFor(() => {
      expect(field).toHaveFocus()
    })
    // The blur's save has run: the text is saved, the marker not committed.
    await waitFor(() => {
      expect(backendText(ids[1] as string)).toBe('\\[ \\] buy milk')
    })
    expect(backendRow(ids[1] as string).todo_state).toBeNull()
    expect(editor.state.selection.from).toBe(caret)

    await act(async () => {
      fireEvent.keyDown(field, { key: 'Escape' })
    })
    await waitFor(() => {
      expect(screen.queryByTestId('date-picker-popup')).toBeNull()
    })
    await waitFor(() => {
      expect(editor.view.hasFocus()).toBe(true)
    })
    await act(async () => {
      await flushActiveDraft()
    })
    expect(backendRow(ids[1] as string).todo_state).toBeNull()
    expect(docTexts(editor)).toEqual(['pay rent', '\\[ \\] buy milk'])
    expect(editor.state.selection.from).toBe(caret)
  })

  it('a block a peer adds above while the picker is open leaves the caret in its own block when it closes', async () => {
    const { pageId, ids } = seedPage(['pay rent', 'buy milk'])
    dispatch('set_due_date', { blockId: ids[0], date: '2026-10-20' })
    const { container, store } = renderPageMode(pageId)
    const editor = await editorIn(container)
    act(() => {
      editor.commands.setTextSelection(at(editor, 1, 3))
      editor.view.focus()
    })
    fireEvent.click(await inBlock(container, ids[0] as string, '.due-date-chip'))
    const field = await screen.findByRole('textbox', { name: t('journal.typeDateLabel') })

    dispatch('create_block', {
      blockType: 'content',
      content: 'from a peer',
      parentId: pageId,
      index: 0,
      scope: SCOPE,
    })
    await act(async () => {
      await store.getState().load()
    })
    await waitFor(() => {
      expect(docTexts(editor)).toEqual(['from a peer', 'pay rent', 'buy milk'])
    })
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Escape' })
    })
    await waitFor(() => {
      expect(editor.view.hasFocus()).toBe(true)
    })

    const { $from } = editor.state.selection
    expect(blockIdOf($from.node(1))).toBe(ids[1])
    expect($from.parentOffset).toBe(3)
  })

  it('Ctrl+Shift+D opens the picker, and the date chosen is linked at the caret, as its page', async () => {
    const { pageId, ids } = seedPage(['meet on '])
    const { container, handle } = renderPageMode(pageId)
    const editor = await editorIn(container)
    act(() => {
      editor.commands.setTextSelection(at(editor, 0, 8))
      editor.view.focus()
    })

    expect(press(editor, 'D', { ctrlKey: true, shiftKey: true })).toBe(true)
    await pickDate('2026-12-24')

    const pages = () =>
      dispatch('list_all_pages_in_space', { scope: SCOPE, aliases: null }) as Array<{
        id: string
        content: string | null
      }>
    await waitFor(() => {
      expect(pages().some((p) => p.content === '2026-12-24')).toBe(true)
    })
    const datePage = pages().find((p) => p.content === '2026-12-24')?.id
    await waitFor(() => {
      expect(docTexts(editor)).toEqual([`meet on [[${datePage}]]`])
    })
    await act(async () => {
      await handle.current?.flush()
    })
    expect(backendText(ids[0] as string)).toBe(`meet on [[${datePage}]]`)
  })

  it('a peer’s change to the block’s other fields redraws the checkbox alone; a date change, the row', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    dispatch('set_todo_state', { blockId: ids[0], state: 'TODO' })
    dispatch('set_priority', { blockId: ids[0], level: '1' })
    dispatch('set_due_date', { blockId: ids[0], date: '2026-10-20' })
    const { container, store } = renderPageMode(pageId)
    await editorIn(container)
    await inBlock(container, ids[0] as string, '.due-date-chip')
    const redrawn = vi.spyOn(ReactRenderer.prototype, 'updateProps')
    const rowsRedrawn = () =>
      redrawn.mock.calls.filter(([props]) => props !== undefined && 'dueDate' in props).length

    dispatch('set_todo_state', { blockId: ids[0], state: 'DOING' })
    dispatch('edit_block', { blockId: ids[0], toText: 'first, from a peer' })
    dispatch('set_priority', { blockId: ids[1], level: '3' })
    await act(async () => {
      await store.getState().load()
    })
    await waitFor(() => {
      expect(container.querySelector(`[data-page-block-id="${ids[0]}"]`)).toHaveAttribute(
        'data-todo-state',
        'DOING',
      )
    })
    await inBlock(container, ids[1] as string, BADGE)
    expect(redrawn).toHaveBeenCalledTimes(1)
    expect(rowsRedrawn()).toBe(0)

    dispatch('set_due_date', { blockId: ids[0], date: '2026-10-21' })
    await act(async () => {
      await store.getState().load()
    })
    await waitFor(() => {
      expect(rowsRedrawn()).toBe(1)
    })
    expect(
      (await inBlock(container, ids[0] as string, '.due-date-chip')).getAttribute('aria-label'),
    ).toBe(t('block.dueDate', { date: formatCompactDate('2026-10-21') }))
  })

  it('a peer’s priority and dates, set or cleared, show on reload, outside the document and its undo', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    dispatch('set_due_date', { blockId: ids[0], date: '2026-10-20' })
    const { container, store, onBlocked } = renderPageMode(pageId)
    const editor = await editorIn(container)
    await inBlock(container, ids[0] as string, '.due-date-chip')

    dispatch('set_priority', { blockId: ids[1], level: '2' })
    dispatch('set_scheduled_date', { blockId: ids[1], date: '2026-11-01' })
    dispatch('set_due_date', { blockId: ids[0], date: null })
    await act(async () => {
      await store.getState().load()
    })

    expect((await inBlock(container, ids[1] as string, BADGE)).getAttribute('aria-label')).toBe(
      badgeLabel('2'),
    )
    await inBlock(container, ids[1] as string, '.scheduled-chip')
    await waitFor(() => {
      expect(
        container.querySelector(`[data-page-block-id="${ids[0]}"] .block-metadata-row`),
      ).toBeNull()
    })
    expect(liveControls(editor)).toBe(1)
    expect(docTexts(editor)).toEqual(['first', 'second'])
    expect(editor.can().undo()).toBe(false)
    expect(onBlocked).not.toHaveBeenCalled()
  })
})

describe('PageModeEditor mounts a block’s controls as it nears the viewport (#5743)', () => {
  beforeEach(() => {
    MockIntersectionObserver.instances = []
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
  })

  const MARKER = '[data-testid="task-marker"]'
  const BADGE = '[data-testid="priority-badge"]'
  const blockEl = (container: HTMLElement, id: string) =>
    container.querySelector(`[data-page-block-id="${id}"]`) as HTMLElement
  const inBlock = (container: HTMLElement, id: string, selector: string) =>
    container.querySelector(`[data-page-block-id="${id}"] ${selector}`)

  /** The editor's one observer, once it watches the blocks. */
  async function observer(): Promise<MockIntersectionObserver> {
    return waitFor(() => {
      expect(MockIntersectionObserver.instances).toHaveLength(1)
      const found = MockIntersectionObserver.instances[0] as MockIntersectionObserver
      expect(found.observed.size).toBeGreaterThan(0)
      return found
    })
  }

  function report(io: MockIntersectionObserver, el: Element, isIntersecting: boolean): void {
    act(() => {
      io.trigger([{ target: el, isIntersecting }])
    })
  }

  /**
   * A page whose first block, the caret's, is plain, then three tasks out of
   * view, the last with a priority and a due date. Resolves the tasks' ids.
   */
  async function openOffscreen() {
    const { pageId, ids: all } = seedPage(['first', 'one', 'two', 'three'])
    const ids = all.slice(1) as [string, string, string]
    for (const id of ids) dispatch('set_todo_state', { blockId: id, state: 'TODO' })
    dispatch('set_priority', { blockId: ids[2], level: '1' })
    dispatch('set_due_date', { blockId: ids[2], date: '2026-10-20' })
    const view = renderPageMode(pageId)
    const editor = await editorIn(view.container)
    const io = await observer()
    return { ...view, pageId, ids, editor, io }
  }

  it('an off-screen task shows its state in an empty box, and its controls once near', async () => {
    const { container, editor, io, ids } = await openOffscreen()
    expect(io.rootMargin).toBe('100% 0px')
    // Every block but the caret's.
    expect(io.observed.size).toBe(3)

    expect(container.querySelector(MARKER)).toBeNull()
    expect(liveControls(editor)).toBe(0)
    const box = blockEl(container, ids[2]).querySelector('.page-block-controls') as HTMLElement
    expect(box.getAttribute('role')).toBe('img')
    expect(box.getAttribute('aria-label')).toBe(t('block.todoCycleTip', { state: 'TODO' }))
    expect(
      blockEl(container, ids[2]).querySelector('.page-block-metadata')?.childElementCount,
    ).toBe(0)
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })

    report(io, blockEl(container, ids[2]), true)
    await waitFor(() => {
      expect(inBlock(container, ids[2], MARKER)?.getAttribute('aria-label')).toBe(
        t('block.taskCycle', { state: 'TODO' }),
      )
    })
    expect(inBlock(container, ids[2], BADGE)).not.toBeNull()
    expect(box.hasAttribute('role')).toBe(false)
    expect(inBlock(container, ids[0], MARKER)).toBeNull()

    // Scrolled away again, they stay.
    report(io, blockEl(container, ids[2]), false)
    await act(async () => {})
    expect(inBlock(container, ids[2], MARKER)).not.toBeNull()
    expect(liveControls(editor)).toBe(2)
  })

  it('the caret entering a block mounts its controls', async () => {
    const { container, editor, io, ids } = await openOffscreen()

    caretTo(editor, 2)

    await waitFor(() => {
      expect(inBlock(container, ids[1], MARKER)).not.toBeNull()
    })
    expect(inBlock(container, ids[0], MARKER)).toBeNull()
    expect(liveControls(editor)).toBe(1)
    expect(io.observed.size).toBe(2)
  })

  it('Ctrl+Enter makes an off-screen block a task, and its checkbox shows', async () => {
    const { pageId, ids } = seedPage(['one', 'two'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    await observer()

    caretTo(editor, 1)
    expect(press(editor, 'Enter', { ctrlKey: true })).toBe(true)

    await waitFor(() => {
      expect((dispatch('get_block', { blockId: ids[1] }) as BlockRow).todo_state).toBe('TODO')
    })
    await waitFor(() => {
      expect(inBlock(container, ids[1] as string, MARKER)?.getAttribute('aria-label')).toBe(
        t('block.taskCycle', { state: 'TODO' }),
      )
    })
  })

  it('a peer’s change to a block not mounted yet is what it shows once mounted', async () => {
    const { container, store, io, ids } = await openOffscreen()

    dispatch('set_todo_state', { blockId: ids[2], state: 'DONE' })
    dispatch('set_priority', { blockId: ids[2], level: '3' })
    await act(async () => {
      await store.getState().load()
    })
    await waitFor(() => {
      expect(
        blockEl(container, ids[2])
          .querySelector('.page-block-controls')
          ?.getAttribute('aria-label'),
      ).toBe(t('block.todoCycleTip', { state: 'DONE' }))
    })
    expect(blockEl(container, ids[2]).getAttribute('data-todo-state')).toBe('DONE')

    report(io, blockEl(container, ids[2]), true)

    await waitFor(() => {
      expect(inBlock(container, ids[2], '[data-testid="task-checkbox-done"]')).not.toBeNull()
    })
    expect(inBlock(container, ids[2], BADGE)?.textContent).toBe('P3')
  })

  it('a block that gains a task and a priority unmounted shows empty boxes, then its controls', async () => {
    const { pageId, ids } = seedPage(['first', 'plain', 'loses'])
    dispatch('set_todo_state', { blockId: ids[2], state: 'TODO' })
    dispatch('set_priority', { blockId: ids[2], level: '1' })
    const { container, store } = renderPageMode(pageId)
    await editorIn(container)
    const io = await observer()

    dispatch('set_todo_state', { blockId: ids[1], state: 'DONE' })
    dispatch('set_priority', { blockId: ids[1], level: '2' })
    dispatch('set_todo_state', { blockId: ids[2], state: null })
    dispatch('set_priority', { blockId: ids[2], level: null })
    await act(async () => {
      await store.getState().load()
    })

    const box = await waitFor(() => {
      const found = inBlock(container, ids[1] as string, '.page-block-controls')
      if (found === null) throw new Error('no checkbox box yet')
      return found
    })
    expect(box.getAttribute('aria-label')).toBe(t('block.todoCycleTip', { state: 'DONE' }))
    const row = inBlock(container, ids[1] as string, '.page-block-metadata') as HTMLElement
    expect(row.childElementCount).toBe(0)
    expect(row.hasAttribute('data-priority')).toBe(true)
    expect(container.querySelector(MARKER)).toBeNull()
    // The block that lost both has neither box.
    expect(inBlock(container, ids[2] as string, '.page-block-controls')).toBeNull()
    expect(inBlock(container, ids[2] as string, '.page-block-metadata')).toBeNull()

    report(io, blockEl(container, ids[1] as string), true)
    await waitFor(() => {
      expect(
        inBlock(container, ids[1] as string, '[data-testid="task-checkbox-done"]'),
      ).not.toBeNull()
    })
    expect(inBlock(container, ids[1] as string, BADGE)?.textContent).toBe('P2')
  })

  it('a block deleted before it nears the view is no longer observed', async () => {
    const { container, store, io, ids } = await openOffscreen()
    const gone = blockEl(container, ids[1])
    expect(io.observed.has(gone)).toBe(true)

    dispatch('delete_block', { blockId: ids[1] })
    await act(async () => {
      await store.getState().load()
    })

    await waitFor(() => {
      expect(container.querySelector(`[data-page-block-id="${ids[1]}"]`)).toBeNull()
    })
    expect(io.observed.has(gone)).toBe(false)
    expect(io.observed.size).toBe(2)
  })

  it('a mounted block drawn anew, at a new depth, keeps its controls mounted', async () => {
    const { container, editor, store, io, ids } = await openOffscreen()
    report(io, blockEl(container, ids[2]), true)
    await waitFor(() => {
      expect(inBlock(container, ids[2], MARKER)).not.toBeNull()
    })
    const drawn = blockEl(container, ids[2])

    dispatch('move_block', { blockId: ids[2], newParentId: ids[1], newIndex: 0 })
    await act(async () => {
      await store.getState().load()
    })

    await waitFor(() => {
      expect(blockEl(container, ids[2])).not.toBe(drawn)
    })
    expect(blockEl(container, ids[2]).getAttribute('data-depth')).toBe('1')
    expect(inBlock(container, ids[2], MARKER)).not.toBeNull()
    expect(inBlock(container, ids[2], BADGE)).not.toBeNull()
    expect(liveControls(editor)).toBe(2)
  })

  it('a runtime with no IntersectionObserver mounts every block’s controls at once', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const { pageId, ids } = seedPage(['one', 'two'])
    for (const id of ids) dispatch('set_todo_state', { blockId: id, state: 'TODO' })
    const { container } = renderPageMode(pageId)
    await editorIn(container)

    await waitFor(() => {
      expect(container.querySelectorAll(MARKER)).toHaveLength(2)
    })
  })

  it('leaving page mode leaves no control mounted and no block observed', async () => {
    const { container, editor, io, ids, unmount } = await openOffscreen()
    report(io, blockEl(container, ids[2]), true)
    await waitFor(() => {
      expect(liveControls(editor)).toBe(2)
    })
    const portals = (editor as unknown as { contentComponent: { getSnapshot: () => object } })
      .contentComponent

    unmount()

    expect(Object.keys(portals.getSnapshot())).toHaveLength(0)
    expect(io.observed.size).toBe(0)
  })
})
