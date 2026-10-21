/**
 * PageModeEditor (#5691) over the mock backend: every IPC goes to
 * `src/lib/tauri-mock`, so what a save wrote is read back from it.
 */

import type { InvokeArgs } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import { ReactRenderer } from '@tiptap/react'
import { createRef } from 'react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import {
  EnteringIntersectionObserver,
  MockIntersectionObserver,
} from '@/__tests__/helpers/viewport-observer-mocks'
import { getActiveEditor } from '@/editor/active-editor'
import { markdownOf, type as typeText } from '@/editor/page-mode/__tests__/page-mode-fixtures'
import {
  editorIn,
  renderPageMode,
  SCOPE,
  seedPage,
} from '@/editor/page-mode/__tests__/page-node-view-fixtures'
import { PAGE_MODE_BLOCK_CAP } from '@/editor/page-mode/page-mode-fit'
import { PageModeEditor, type PageModeEditorHandle } from '@/editor/page-mode/PageModeEditor'
import { blockIdOf } from '@/editor/token-ids'
import { CONTENT_COMMIT_DEBOUNCE_MS } from '@/hooks/useDebouncedContentCommit'
import { DRAFT_MAX_LATENCY_MS } from '@/hooks/useDraftAutosave'
import { flushActiveDraft } from '@/lib/active-draft-flush'
import { recordAttachmentInvalidation } from '@/lib/attachment-invalidation'
import type { BlockRow, PropertyRow } from '@/lib/bindings'
import { formatCompactDate } from '@/lib/date-utils'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { SYSTEM_MANAGED_PROPERTY_KEYS } from '@/lib/property-save-utils'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'
import { useNavigationStore } from '@/stores/navigation'
import { PageBlockStoreProvider } from '@/stores/page-blocks'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'
import { useUndoStore } from '@/stores/undo'

// Block mode's query builder, stood in as `QueryResult`'s own tests stand it in: Save hands back an expression.
vi.mock('@/components/dialogs/QueryBuilderModal', () => ({
  QueryBuilderModal: ({
    open,
    onSave,
  }: {
    open: boolean
    onSave: (expression: string) => Promise<void>
  }) =>
    open ? (
      <button type="button" onClick={() => void onSave('tag:personal')}>
        save query
      </button>
    ) : null,
}))

const mockedInvoke = vi.mocked(invoke)

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

/** How many times the app asked the backend for `cmd`. */
function callsTo(cmd: string): number {
  return mockedInvoke.mock.calls.filter(([name]) => name === cmd).length
}

/** The results block `id` draws of its query. */
function resultsIn(container: HTMLElement, id: string): NodeListOf<Element> {
  return container.querySelectorAll(
    `[data-page-block-id="${id}"] .page-block-rendered [data-testid="query-result-item"]`,
  )
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
    let saved: boolean | undefined
    await act(async () => {
      saved = await handle.current?.flush()
    })

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('pageMode.saveFailed'), {
      id: `page-mode-save-${pageId}`,
    })
    expect(backendText(ids[0] as string)).toBe('first')
    // What a mode switch reads to stay in page mode.
    expect(saved).toBe(false)

    mockedInvoke.mockImplementation(passThrough)
    await act(async () => {
      saved = await handle.current?.flush()
    })

    expect(backendText(ids[0] as string)).toBe('first!')
    expect(saved).toBe(true)
  })

  it('typing that never pauses is saved as often as block mode’s draft, not only once it stops', async () => {
    const { pageId, ids } = seedPage(['first'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    // A key each 500 ms, under the idle wait, until the cap is reached.
    const gap = 500
    for (let elapsed = 0; elapsed < DRAFT_MAX_LATENCY_MS; elapsed += gap) {
      typeAt(editor, 0, editor.state.doc.child(0).textContent.length, 'x')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(gap)
      })
    }
    // Real timers from here: the idle wait armed by the last key never fires, so only the cap saves.
    vi.useRealTimers()

    await waitFor(() => {
      expect(backendText(ids[0] as string)).toBe(`first${'x'.repeat(DRAFT_MAX_LATENCY_MS / gap)}`)
    })
  })

  it('typing after a save waits for a pause again, not for the deadline the typing before it set', async () => {
    const { pageId, ids } = seedPage(['first'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    typeAt(editor, 0, 5, 'a')
    await waitFor(() => {
      expect(backendText(ids[0] as string)).toBe('firsta')
    })

    // Past that deadline, then one key: its save is a pause away, not due at once.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(Date.now() + DRAFT_MAX_LATENCY_MS + 1000)
    typeAt(editor, 0, 6, 'b')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTENT_COMMIT_DEBOUNCE_MS - 100)
    })
    // Real timers, and one task for a save's IPC answers to settle, were one started.
    vi.useRealTimers()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(backendText(ids[0] as string)).toBe('firsta')
  })

  it('a new block the backend refuses holds back only itself: the rest of the page is saved, and the user told', async () => {
    const { pageId, ids } = seedPage(['alpha', 'beta', 'gamma'])
    const { container, handle } = renderPageMode(pageId)
    const editor = await editorIn(container)
    // Refused whatever its id, as `validate_content_refs_in_space` refuses a pasted link to
    // another space's page.
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'create_block' && (args as { content: string }).content.includes('REFUSED')) {
        throw new Error('cross-space reference')
      }
      return dispatch(cmd, args)
    })

    caretTo(editor, 1)
    press(editor, 'Enter')
    typeAt(editor, 1, 0, 'REFUSED')
    typeAt(editor, 2, 4, ' one')
    act(() => {
      editor.view.dispatch(
        editor.state.tr.delete(at(editor, 3, 0) - 2, editor.state.doc.content.size),
      )
    })
    await act(async () => {
      await handle.current?.flush()
    })

    expect(docTexts(editor)).toEqual(['alpha', 'REFUSED', 'beta one'])
    expect(backendPage(pageId)).toEqual([
      [ids[0], 'alpha'],
      [ids[1], 'beta one'],
    ])
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('pageMode.saveFailed'), {
      id: `page-mode-save-${pageId}`,
    })
  })

  it('a refused write whose reread fails still says the save failed, and what landed is undoable', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    const { container, handle } = renderPageMode(pageId)
    const editor = await editorIn(container)
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'edit_block' && (args as { blockId: string }).blockId === ids[1]) {
        throw new Error('database is locked')
      }
      if (cmd === 'get_batch_properties') throw new Error('database is locked')
      return dispatch(cmd, args)
    })

    typeAt(editor, 0, 5, 'A')
    typeAt(editor, 1, 6, 'B')
    await act(async () => {
      await handle.current?.flush()
    })

    expect(backendText(ids[0] as string)).toBe('firstA')
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('pageMode.saveFailed'), {
      id: `page-mode-save-${pageId}`,
    })
    expect(useUndoStore.getState().pages.get(pageId)?.undoStack).toHaveLength(1)
  })

  it('a reread a newer load overtakes brings nothing in until that load lands, so no saved text goes back', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    const { container, handle, store } = renderPageMode(pageId)
    const editor = await editorIn(container)
    typeAt(editor, 0, 5, ' saved')
    await act(async () => {
      await handle.current?.flush()
    })
    expect(store.getState().blocks.map((block) => block.content)).toEqual(['first', 'second'])
    // A refused edit makes the save read the page again; a sync's reload starts during that read
    // and lands only once released.
    let refuse = true
    let loads = 0
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'edit_block' && refuse) {
        refuse = false
        throw new Error('database is locked')
      }
      if (cmd === 'load_page_subtree') {
        loads += 1
        const load = loads
        if (load === 1) void store.getState().load()
        if (load === 2) await held
      }
      return dispatch(cmd, args)
    })

    typeAt(editor, 1, 6, '!')
    await act(async () => {
      await handle.current?.flush()
    })

    expect(loads).toBe(2)
    expect(docTexts(editor)).toEqual(['first saved', 'second!'])

    await act(async () => {
      release()
      await vi.waitFor(() => {
        expect(store.getState().loading).toBe(false)
      })
      await handle.current?.flush()
    })

    expect(docTexts(editor)).toEqual(['first saved', 'second!'])
    expect(backendPage(pageId)).toEqual([
      [ids[0], 'first saved'],
      [ids[1], 'second!'],
    ])
  })

  it('a reread whose load fails brings nothing in, so a key typed next writes no old text back', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    const { container, handle } = renderPageMode(pageId)
    const editor = await editorIn(container)
    typeAt(editor, 0, 5, ' saved')
    await act(async () => {
      await handle.current?.flush()
    })
    let refuse = true
    let fail = true
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'edit_block' && refuse) {
        refuse = false
        throw new Error('database is locked')
      }
      if (cmd === 'load_page_subtree' && fail) {
        fail = false
        throw new Error('database is locked')
      }
      return dispatch(cmd, args)
    })

    typeAt(editor, 1, 6, '!')
    await act(async () => {
      await handle.current?.flush()
    })
    expect(fail).toBe(false)
    expect(docTexts(editor)).toEqual(['first saved', 'second!'])

    typeAt(editor, 0, 11, 'X')
    await act(async () => {
      await handle.current?.flush()
    })

    expect(backendText(ids[0] as string)).toBe('first savedX')
  })

  it('a reread of a page that did not change is no failure: a load that lands replaces the rows', async () => {
    const { pageId } = seedPage(['first', 'second'])
    const { container, handle } = renderPageMode(pageId)
    const editor = await editorIn(container)
    const loads = callsTo('load_page_subtree')
    const error = vi.spyOn(logger, 'error')

    // An attachment changed elsewhere makes the editor read the page again.
    act(() => {
      recordAttachmentInvalidation()
    })
    await act(async () => {
      await handle.current?.flush()
    })

    expect(callsTo('load_page_subtree')).toBe(loads + 1)
    expect(error).not.toHaveBeenCalled()
    expect(docTexts(editor)).toEqual(['first', 'second'])
  })

  it('the save made as page mode closes reads the page again like any other, so a restore in it is not reported as failed', async () => {
    const { pageId, ids } = seedPage(['first', 'second', 'third'])
    const closing = renderPageMode(pageId)
    const editor = await editorIn(closing.container)
    act(() => {
      editor.view.dispatch(editor.state.tr.delete(at(editor, 1, 0) - 2, at(editor, 2, 0) - 2))
    })
    await act(async () => {
      await closing.handle.current?.flush()
    })
    expect(backendPage(pageId)).toEqual([
      [ids[0], 'first'],
      [ids[2], 'third'],
    ])
    // Takes the delete back; the restore waits for the save as the page closes, which reads the page.
    act(() => {
      editor.commands.undo()
    })
    vi.mocked(toast.error).mockClear()
    closing.unmount()

    // The next session waits for that save before it reads the page.
    const reopened = await editorIn(renderPageMode(pageId).container)

    expect(docTexts(reopened)).toEqual(['first', 'second', 'third'])
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
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

  // #5736 — a ref property's chip opens its target, as a page link's chip does.
  it('opens a ref property’s chip as block mode does', async () => {
    const other = seedPage(['elsewhere'], 'Other page')
    const { pageId, ids } = seedPage(['task'])
    dispatch('set_property', {
      blockId: ids[0],
      key: 'owner',
      value: {
        value_text: null,
        value_num: null,
        value_date: null,
        value_ref: other.pageId,
        value_bool: null,
      },
    })
    const onNavigateToPage = vi.fn()
    const { container } = renderPageMode(pageId, { onNavigateToPage })
    await editorIn(container)

    const value = await waitFor(() => {
      const found = container.querySelector(
        `[data-page-block-id="${ids[0]}"] button.property-chip-value`,
      )
      if (found === null) throw new Error('no ref chip')
      return found
    })
    await act(async () => {
      fireEvent.click(value)
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

  it('a new or empty page takes typing at once; a page with text leaves the focus alone', async () => {
    for (const [texts, focused] of [
      [[], true],
      [[''], true],
      [['first'], false],
    ] as const) {
      const pageId =
        texts.length === 0
          ? (dispatch('create_page_in_space', {
              parentId: null,
              content: 'New page',
              spaceId: SCOPE.space_id,
            }) as string)
          : seedPage(texts).pageId
      const { container, unmount } = renderPageMode(pageId)
      const editor = await editorIn(container)

      // TipTap focuses a frame later.
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve))
      })
      expect(document.activeElement === editor.view.dom).toBe(focused)
      unmount()
    }
  })

  it('does not open a page over the block cap, and says how many blocks it holds', async () => {
    const { pageId } = seedPage(Array.from({ length: PAGE_MODE_BLOCK_CAP + 1 }, (_, i) => `b${i}`))
    const { container, onBlocked } = renderPageMode(pageId)

    await waitFor(() => {
      expect(onBlocked).toHaveBeenCalledWith({ kind: 'overCap', count: PAGE_MODE_BLOCK_CAP + 1 })
    })
    expect(container.querySelector('[data-testid="page-mode-editor"]')).toBeNull()
  })

  it('leaves page mode when a reload brings the page over the cap', async () => {
    const { pageId } = seedPage(['first'])
    const { container, store, onBlocked } = renderPageMode(pageId)
    await editorIn(container)

    dispatch('create_blocks_batch', {
      specs: Array.from({ length: PAGE_MODE_BLOCK_CAP }, (_, i) => ({
        blockType: 'content',
        content: `peer ${i}`,
        parentId: pageId,
        position: null,
      })),
    })
    await act(async () => {
      await store.getState().load()
    })

    await waitFor(() => {
      expect(onBlocked).toHaveBeenCalledWith({ kind: 'overCap', count: PAGE_MODE_BLOCK_CAP + 1 })
    })
  })

  it.each(['get_batch_properties', 'list_attachments_batch'])(
    'a page whose %s read fails says so, and opens no editor that could save',
    async (refused) => {
      const { pageId } = seedPage(['first'])
      mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
        if (cmd === refused) throw new Error('database locked')
        return dispatch(cmd, args)
      })
      const { container, handle, onBlocked } = renderPageMode(pageId)

      await waitFor(() => {
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('error.loadBlocksFailed'))
      })
      expect(container.querySelector('[data-testid="page-mode-editor"]')).toBeNull()
      expect(handle.current).toBeNull()
      expect(onBlocked).not.toHaveBeenCalled()
    },
  )

  it('a reload whose read fails leaves the document as it was, writes no peer’s change back over, and the next reload brings it in', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    const { container, store, handle } = renderPageMode(pageId)
    const editor = await editorIn(container)
    const error = vi.spyOn(logger, 'error')
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'get_batch_properties') throw new Error('database locked')
      return dispatch(cmd, args)
    })

    dispatch('edit_block', { blockId: ids[0], toText: 'first, from a peer' })
    await act(async () => {
      await store.getState().load()
    })
    await waitFor(() => {
      expect(error).toHaveBeenCalledWith(
        'PageModeEditor',
        'Page mode save threw',
        { pageId },
        expect.any(Error),
      )
    })
    expect(docTexts(editor)).toEqual(['first', 'second'])

    mockedInvoke.mockImplementation(passThrough)
    typeAt(editor, 1, 6, '!')
    await act(async () => {
      await handle.current?.flush()
    })
    expect(backendPage(pageId)).toEqual([
      [ids[0], 'first, from a peer'],
      [ids[1], 'second!'],
    ])

    await act(async () => {
      await store.getState().load()
    })
    await waitFor(() => {
      expect(docTexts(editor)).toEqual(['first, from a peer', 'second!'])
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

  it('a #name typed and left for another block becomes the tag, its chip with no a11y violations, and undoes', async () => {
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
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })

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

  it('a tag lookup that fails leaves the name as text, creates no tag, and logs why', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    const { container, handle } = renderPageMode(pageId)
    const editor = await editorIn(container)
    const warn = vi.spyOn(logger, 'warn')
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'list_all_tags_in_space') throw new Error('database locked')
      return dispatch(cmd, args)
    })

    typeAt(editor, 0, 5, ' #newtag')
    caretTo(editor, 1)

    await waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        'unmount-flush',
        'tag lookup failed, the tags stay text',
        { spaceId: SCOPE.space_id },
        expect.any(Error),
      )
    })
    // Queued behind the commit: once it has run, so has everything the commit does.
    await act(async () => {
      await handle.current?.flush()
    })
    expect(backendText(ids[0] as string)).toBe('first #newtag')
    expect(docTexts(editor)).toEqual(['first #newtag', 'second'])
    expect(tagIds().has('newtag')).toBe(false)
  })

  it('a tag whose write into the text is refused leaves the name as text, and logs why', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    const { container, handle } = renderPageMode(pageId)
    const editor = await editorIn(container)
    const warn = vi.spyOn(logger, 'warn')
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'edit_block' && TAG_REF.test((args as { toText: string }).toText)) {
        throw new Error('database locked')
      }
      return dispatch(cmd, args)
    })

    typeAt(editor, 0, 5, ' #Work')
    caretTo(editor, 1)

    await waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        'unmount-flush',
        'content edit rejected',
        { blockId: ids[0] },
        expect.any(Error),
      )
    })
    // Queued behind the commit: once it has run, so has everything the commit does.
    await act(async () => {
      await handle.current?.flush()
    })
    expect(backendText(ids[0] as string)).toBe('first #Work')
    expect(docTexts(editor)).toEqual(['first #Work', 'second'])
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

  it('typing, its save and a reload draw no checkbox, badge, chip or attachment again', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    dispatch('add_attachment_with_bytes', {
      blockId: ids[1],
      filename: 'notes.txt',
      mimeType: 'text/plain',
      bytes: [104, 105],
    })
    dispatch('set_todo_state', { blockId: ids[0], state: 'TODO' })
    dispatch('set_todo_state', { blockId: ids[1], state: 'DONE' })
    dispatch('set_priority', { blockId: ids[0], level: '1' })
    dispatch('set_due_date', { blockId: ids[0], date: '2026-10-20' })
    dispatch('set_scheduled_date', { blockId: ids[1], date: '2026-10-21' })
    dispatch('set_property', {
      blockId: ids[1],
      key: 'assignee',
      value: {
        value_text: 'Ana',
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
    })
    const { container, handle, store } = renderPageMode(pageId)
    const editor = await editorIn(container)
    await checkbox(container, ids[1] as string)
    await waitFor(() => {
      expect(container.querySelectorAll('.block-metadata-row')).toHaveLength(2)
    })
    expect(container.querySelectorAll('[data-testid="property-chip"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-testid="attachment-badge"]')).toHaveLength(1)
    const draw = vi.spyOn(ReactRenderer.prototype, 'render')

    typeAt(editor, 1, 6, ' typed')
    typeAt(editor, 0, 5, '!')
    await act(async () => {
      await handle.current?.flush()
      await store.getState().load()
      // Once the reload's read of the properties has run, the next reload draws what it took.
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

  it('a scheduled date the command refuses says so, and the chip keeps the date the backend holds', async () => {
    const { pageId, ids } = seedPage(['plan trip'])
    dispatch('set_scheduled_date', { blockId: ids[0], date: '2026-11-01' })
    const { container } = renderPageMode(pageId)
    await editorIn(container)
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'set_scheduled_date') throw new Error('database locked')
      return dispatch(cmd, args)
    })

    fireEvent.click(await inBlock(container, ids[0] as string, '.scheduled-chip'))
    await pickDate('2026-12-31')

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('blockTree.setScheduledDateFailed'))
    })
    expect(backendRow(ids[0] as string).scheduled_date).toBe('2026-11-01')
    expect(
      (await inBlock(container, ids[0] as string, '.scheduled-chip')).getAttribute('aria-label'),
    ).toBe(t('block.scheduledDate', { date: formatCompactDate('2026-11-01') }))
  })

  it('a clear in the drawer the command refuses says so, and the chip keeps the date', async () => {
    const { pageId, ids } = seedPage(['pay rent'])
    dispatch('set_due_date', { blockId: ids[0], date: '2026-10-20' })
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    await inBlock(container, ids[0] as string, '.due-date-chip')
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'set_due_date') throw new Error('database locked')
      return dispatch(cmd, args)
    })

    act(() => {
      editor.view.focus()
    })
    caretTo(editor, 0)
    expect(press(editor, 'P', { ctrlKey: true, shiftKey: true })).toBe(true)
    const drawer = await screen.findByRole('dialog', { name: t('property.drawerTitle') })
    await act(async () => {
      fireEvent.click(
        await within(drawer).findByRole('button', { name: t('property.clearDueDate') }),
      )
    })
    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('property.saveFailed'))
    })
    await act(async () => {
      fireEvent.keyDown(drawer, { key: 'Escape' })
    })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: t('property.drawerTitle') })).toBeNull()
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

  it('a date page that cannot be created says so, and links nothing', async () => {
    const { pageId, ids } = seedPage(['meet on '])
    const { container, handle } = renderPageMode(pageId)
    const editor = await editorIn(container)
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'create_page_in_space') throw new Error('database locked')
      return dispatch(cmd, args)
    })
    act(() => {
      editor.commands.setTextSelection(at(editor, 0, 8))
      editor.view.focus()
    })

    expect(press(editor, 'D', { ctrlKey: true, shiftKey: true })).toBe(true)
    await pickDate('2026-12-24')

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('blockTree.insertDateLinkFailed'))
    })
    await act(async () => {
      await handle.current?.flush()
    })
    const pages = dispatch('list_all_pages_in_space', { scope: SCOPE, aliases: null }) as Array<{
      content: string | null
    }>
    expect(pages.filter((p) => p.content === '2026-12-24')).toEqual([])
    expect(docTexts(editor)).toEqual(['meet on '])
    expect(backendText(ids[0] as string)).toBe('meet on ')
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

describe('PageModeEditor properties (#5743)', () => {
  function setProp(id: string, key: string, text: string): void {
    dispatch('set_property', {
      blockId: id,
      key,
      value: {
        value_text: text,
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
    })
  }

  /** Block `id`'s properties in the backend, the user's: the text of each, by key. */
  function backendProps(id: string): Record<string, string | null> {
    const rows = dispatch('get_properties', { blockId: id }) as PropertyRow[]
    return Object.fromEntries(
      rows
        .filter((row) => !SYSTEM_MANAGED_PROPERTY_KEYS.has(row.key))
        .map((row) => [row.key, row.value_text ?? row.value_date]),
    )
  }

  /** What block `id`'s property chips say, in order. */
  function chips(container: HTMLElement, id: string): Array<string | null> {
    return [
      ...container.querySelectorAll(`[data-page-block-id="${id}"] [data-testid="property-chip"]`),
    ].map((chip) => chip.getAttribute('aria-label'))
  }

  const chip = (key: string, value: string) => t('property.selectValue', { key, value })

  it('shows block mode’s property chips and repeat rule under the text, with no a11y violations', async () => {
    const { pageId, ids } = seedPage(['water plants', 'call mom', 'plain'])
    dispatch('set_todo_state', { blockId: ids[0], state: 'TODO' })
    dispatch('set_due_date', { blockId: ids[0], date: '2026-10-20' })
    setProp(ids[0] as string, 'repeat', '+1w')
    setProp(ids[1] as string, 'assignee', 'Ana')
    setProp(ids[1] as string, 'location', 'home')
    const { container, onBlocked } = renderPageMode(pageId)
    const editor = await editorIn(container)

    await waitFor(() => {
      expect(chips(container, ids[1] as string)).toEqual([
        chip('Assignee', 'Ana'),
        chip('Location', 'home'),
      ])
    })
    expect(
      container
        .querySelector(`[data-page-block-id="${ids[0]}"] .repeat-indicator`)
        ?.getAttribute('aria-label'),
    ).toBe(t('block.repeats', { value: '+1w' }))
    // The rule has its chip; the stamps the task's state wrote are the app's.
    expect(chips(container, ids[0] as string)).toEqual([])
    expect(
      container.querySelector(`[data-page-block-id="${ids[2]}"] .block-metadata-row`),
    ).toBeNull()
    expect(container.querySelector('.page-block-content [data-testid="property-chip"]')).toBeNull()
    expect(docTexts(editor)).toEqual(['water plants', 'call mom', 'plain'])
    expect(onBlocked).not.toHaveBeenCalled()
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })

  it('a chip opens block mode’s property editor; the value given is the block’s, and the caret comes back', async () => {
    const { pageId, ids } = seedPage(['first', 'call mom'])
    setProp(ids[1] as string, 'assignee', 'Ana')
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    act(() => {
      editor.view.focus()
    })
    caretTo(editor, 0)

    fireEvent.click(await screen.findByRole('button', { name: chip('Assignee', 'Ana') }))
    const field = await screen.findByRole('textbox', { name: t('block.editProperty') })
    expect(field.closest('[data-editor-portal]')).not.toBeNull()
    fireEvent.change(field, { target: { value: 'Bo' } })
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' })
    })

    await waitFor(() => {
      expect(backendProps(ids[1] as string)).toEqual({ assignee: 'Bo' })
    })
    await waitFor(() => {
      expect(chips(container, ids[1] as string)).toEqual([chip('Assignee', 'Bo')])
    })
    await waitFor(() => {
      expect(document.activeElement).toBe(editor.view.dom)
    })
    expect(editor.state.selection.from).toBe(at(editor, 0, 0))
    expect(docTexts(editor)).toEqual(['first', 'call mom'])
  })

  it('an editor closed with the focus already moved elsewhere does not take it back', async () => {
    const { pageId, ids } = seedPage(['first', 'call mom'])
    setProp(ids[1] as string, 'assignee', 'Ana')
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    const elsewhere = document.createElement('button')
    document.body.append(elsewhere)
    fireEvent.click(await screen.findByRole('button', { name: chip('Assignee', 'Ana') }))
    const field = await screen.findByRole('textbox', { name: t('block.editProperty') })

    await act(async () => {
      fireEvent.keyDown(field, { key: 'Escape' })
      elsewhere.focus()
    })
    // The timer the refocus waits on is set; it fires before this one.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve))
    })

    expect(screen.queryByRole('textbox', { name: t('block.editProperty') })).toBeNull()
    expect(document.activeElement).toBe(elsewhere)
    expect(editor.isFocused).toBe(false)
    elsewhere.remove()
  })

  it('a chip’s key opens block mode’s rename; the new key holds the value', async () => {
    const { pageId, ids } = seedPage(['call mom'])
    setProp(ids[0] as string, 'assignee', 'Ana')
    const { container } = renderPageMode(pageId)
    await editorIn(container)

    fireEvent.click(
      await screen.findByRole('button', { name: t('property.editKeyLabel', { key: 'Assignee' }) }),
    )
    const field = await screen.findByRole('textbox', { name: t('block.editProperty') })
    fireEvent.change(field, { target: { value: 'location' } })
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' })
    })

    await waitFor(() => {
      expect(backendProps(ids[0] as string)).toEqual({ location: 'Ana' })
    })
    await waitFor(() => {
      expect(chips(container, ids[0] as string)).toEqual([chip('Location', 'Ana')])
    })
  })

  it('a chip emptied deletes the property, and its row goes', async () => {
    const { pageId, ids } = seedPage(['call mom'])
    setProp(ids[0] as string, 'assignee', 'Ana')
    const { container } = renderPageMode(pageId)
    await editorIn(container)

    fireEvent.click(await screen.findByRole('button', { name: chip('Assignee', 'Ana') }))
    const field = await screen.findByRole('textbox', { name: t('block.editProperty') })
    fireEvent.change(field, { target: { value: '' } })
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' })
    })

    await waitFor(() => {
      expect(backendProps(ids[0] as string)).toEqual({})
    })
    await waitFor(() => {
      expect(
        container.querySelector(`[data-page-block-id="${ids[0]}"] .page-block-metadata`),
      ).toBeNull()
    })
  })

  it('a refused property write says so, and the chip keeps what the backend holds', async () => {
    const { pageId, ids } = seedPage(['call mom'])
    setProp(ids[0] as string, 'assignee', 'Ana')
    const { container } = renderPageMode(pageId)
    await editorIn(container)
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'set_property') throw new Error('database locked')
      return dispatch(cmd, args)
    })

    fireEvent.click(await screen.findByRole('button', { name: chip('Assignee', 'Ana') }))
    const field = await screen.findByRole('textbox', { name: t('block.editProperty') })
    fireEvent.change(field, { target: { value: 'Bo' } })
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' })
    })

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('property.saveFailed'))
    })
    await waitFor(() => {
      expect(screen.queryByRole('textbox', { name: t('block.editProperty') })).toBeNull()
    })
    expect(chips(container, ids[0] as string)).toEqual([chip('Assignee', 'Ana')])
    expect(backendProps(ids[0] as string)).toEqual({ assignee: 'Ana' })
  })

  it('a chip emptied whose delete is refused says so, and the chip stays', async () => {
    const { pageId, ids } = seedPage(['call mom'])
    setProp(ids[0] as string, 'assignee', 'Ana')
    const { container } = renderPageMode(pageId)
    await editorIn(container)
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'delete_property') throw new Error('database locked')
      return dispatch(cmd, args)
    })

    fireEvent.click(await screen.findByRole('button', { name: chip('Assignee', 'Ana') }))
    const field = await screen.findByRole('textbox', { name: t('block.editProperty') })
    fireEvent.change(field, { target: { value: '' } })
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' })
    })

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('property.saveFailed'))
    })
    await waitFor(() => {
      expect(screen.queryByRole('textbox', { name: t('block.editProperty') })).toBeNull()
    })
    expect(chips(container, ids[0] as string)).toEqual([chip('Assignee', 'Ana')])
    expect(backendProps(ids[0] as string)).toEqual({ assignee: 'Ana' })
  })

  it('a delete in the drawer the command refuses says so, and the chip stays once it closes', async () => {
    const { pageId, ids } = seedPage(['call mom'])
    setProp(ids[0] as string, 'assignee', 'Ana')
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    await waitFor(() => {
      expect(chips(container, ids[0] as string)).toEqual([chip('Assignee', 'Ana')])
    })
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'delete_property') throw new Error('database locked')
      return dispatch(cmd, args)
    })

    act(() => {
      editor.view.focus()
    })
    caretTo(editor, 0)
    expect(press(editor, 'P', { ctrlKey: true, shiftKey: true })).toBe(true)
    const drawer = await screen.findByRole('dialog', { name: t('property.drawerTitle') })
    await within(drawer).findByTestId('property-value-input-assignee')
    await act(async () => {
      fireEvent.click(within(drawer).getByRole('button', { name: t('property.delete') }))
    })
    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('property.deleteFailed'))
    })
    expect(within(drawer).getByTestId('property-value-input-assignee')).toBeInTheDocument()
    await act(async () => {
      fireEvent.keyDown(drawer, { key: 'Escape' })
    })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: t('property.drawerTitle') })).toBeNull()
    })

    expect(backendProps(ids[0] as string)).toEqual({ assignee: 'Ana' })
    expect(chips(container, ids[0] as string)).toEqual([chip('Assignee', 'Ana')])
  })

  it('the +N pill and Ctrl+Shift+P open block mode’s drawer; what it deletes goes once it closes', async () => {
    const { pageId, ids } = seedPage(['call mom', 'plain'])
    for (const [key, value] of [
      ['assignee', 'Ana'],
      ['location', 'home'],
      ['context', '@phone'],
      ['url', 'example'],
    ] as const) {
      setProp(ids[0] as string, key, value)
    }
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)

    fireEvent.click(
      await screen.findByRole('button', { name: t('block.showAllProperties', { count: 4 }) }),
    )
    const drawer = await screen.findByRole('dialog', { name: t('property.drawerTitle') })
    // Its rows in the block's order: the second is `location`'s.
    await within(drawer).findByTestId('property-value-input-location')
    fireEvent.click(
      within(drawer).getAllByRole('button', { name: t('property.delete') })[1] as HTMLElement,
    )
    await waitFor(() => {
      expect(backendProps(ids[0] as string)).not.toHaveProperty('location')
    })
    await act(async () => {
      fireEvent.keyDown(drawer, { key: 'Escape' })
    })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: t('property.drawerTitle') })).toBeNull()
    })
    await waitFor(() => {
      expect(chips(container, ids[0] as string)).toEqual([
        chip('Assignee', 'Ana'),
        chip('Context', '@phone'),
        chip('Url', 'example'),
      ])
    })

    // The key, on a block holding none yet: the drawer adds to it.
    act(() => {
      editor.view.focus()
    })
    caretTo(editor, 1)
    expect(press(editor, 'P', { ctrlKey: true, shiftKey: true })).toBe(true)
    await screen.findByRole('dialog', { name: t('property.drawerTitle') })
  })

  it('a typed `key:: value` line becomes the property once the caret leaves the block, not before', async () => {
    const { pageId, ids } = seedPage(['first', 'call mom'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    act(() => {
      editor.view.focus()
    })

    act(() => {
      editor
        .chain()
        .setTextSelection(at(editor, 1, 8))
        .setHardBreak()
        .insertContent('assignee:: Ana')
        .run()
    })
    await act(async () => {
      await flushActiveDraft()
    })
    expect(backendText(ids[1] as string)).toBe('call mom\nassignee:: Ana')
    expect(backendProps(ids[1] as string)).toEqual({})
    expect(chips(container, ids[1] as string)).toEqual([])

    caretTo(editor, 0)
    await waitFor(() => {
      expect(backendProps(ids[1] as string)).toEqual({ assignee: 'Ana' })
    })
    await waitFor(() => {
      expect(backendText(ids[1] as string)).toBe('call mom')
    })
    await waitFor(() => {
      expect(chips(container, ids[1] as string)).toEqual([chip('Assignee', 'Ana')])
    })
    expect(docTexts(editor)).toEqual(['first', 'call mom'])
  })

  it('a `key:: value` line the block already held stays text when the block is edited and left', async () => {
    const { pageId, ids } = seedPage(['first', 'note'])
    dispatch('edit_block', { blockId: ids[1], toText: 'note\nassignee:: Ana' })
    const { container, handle } = renderPageMode(pageId)
    const editor = await editorIn(container)

    typeAt(editor, 1, 4, '!')
    caretTo(editor, 0)
    await act(async () => {
      await handle.current?.flush()
    })

    expect(backendText(ids[1] as string)).toBe('note!\nassignee:: Ana')
    expect(backendProps(ids[1] as string)).toEqual({})
    expect(chips(container, ids[1] as string)).toEqual([])
  })

  it('a typed line whose property write is refused stays text, and says so', async () => {
    const { pageId, ids } = seedPage(['first', 'call mom'])
    const { container, handle } = renderPageMode(pageId)
    const editor = await editorIn(container)
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'set_property') throw new Error('database locked')
      return dispatch(cmd, args)
    })

    act(() => {
      editor
        .chain()
        .setTextSelection(at(editor, 1, 8))
        .setHardBreak()
        .insertContent('assignee:: Ana')
        .run()
    })
    caretTo(editor, 0)
    await act(async () => {
      await handle.current?.flush()
    })

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      t('blockTree.propertyKeptAsText', { lines: 'assignee:: Ana' }),
    )
    expect(backendText(ids[1] as string)).toBe('call mom\nassignee:: Ana')
    expect(backendProps(ids[1] as string)).toEqual({})
    expect(chips(container, ids[1] as string)).toEqual([])
  })

  it('a marker, a property line and a tag typed in one block each read the text the one before wrote', async () => {
    const { pageId, ids } = seedPage(['first', 'call mom'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    act(() => {
      editor.view.focus()
    })

    typeAt(editor, 1, 8, ' #later')
    act(() => {
      editor
        .chain()
        .setTextSelection(at(editor, 1, 15))
        .setHardBreak()
        .insertContent('assignee:: Ana')
        .run()
    })
    typeAt(editor, 1, 0, '[ ] ')
    caretTo(editor, 0)

    await waitFor(() => {
      expect(backendText(ids[1] as string)).toMatch(/^call mom #\[[0-9A-Z]{26}\]$/)
    })
    expect((dispatch('get_block', { blockId: ids[1] }) as BlockRow).todo_state).toBe('TODO')
    expect(backendProps(ids[1] as string)).toEqual({ assignee: 'Ana' })
    await waitFor(() => {
      expect(chips(container, ids[1] as string)).toEqual([chip('Assignee', 'Ana')])
    })
    expect(docTexts(editor)).toEqual(['first', backendText(ids[1] as string)])
  })

  it('a property line that is a task’s whole text leaves the task, empty', async () => {
    const { pageId, ids } = seedPage(['first', 'x'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    act(() => {
      editor.view.focus()
    })

    act(() => {
      editor
        .chain()
        .setTextSelection({ from: at(editor, 1, 0), to: at(editor, 1, 1) })
        .insertContent('[ ] assignee:: Ana')
        .run()
    })
    caretTo(editor, 0)

    await waitFor(() => {
      expect(backendProps(ids[1] as string)).toEqual({ assignee: 'Ana' })
    })
    expect((dispatch('get_block', { blockId: ids[1] }) as BlockRow).todo_state).toBe('TODO')
    await waitFor(() => {
      expect(backendText(ids[1] as string)).toBe('')
    })
  })

  it('a peer’s properties, set or deleted, show on reload, outside the document and its undo', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    setProp(ids[0] as string, 'assignee', 'Ana')
    const { container, store, onBlocked } = renderPageMode(pageId)
    const editor = await editorIn(container)
    await waitFor(() => {
      expect(chips(container, ids[0] as string)).toEqual([chip('Assignee', 'Ana')])
    })

    dispatch('delete_property', { blockId: ids[0], key: 'assignee' })
    setProp(ids[1] as string, 'location', 'home')
    await act(async () => {
      await store.getState().load()
    })

    await waitFor(() => {
      expect(chips(container, ids[1] as string)).toEqual([chip('Location', 'home')])
    })
    await waitFor(() => {
      expect(
        container.querySelector(`[data-page-block-id="${ids[0]}"] .page-block-metadata`),
      ).toBeNull()
    })
    expect(liveControls(editor)).toBe(1)
    expect(docTexts(editor)).toEqual(['first', 'second'])
    expect(editor.can().undo()).toBe(false)
    expect(onBlocked).not.toHaveBeenCalled()
  })

  it('a peer’s new value of the same length shows on reload', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    setProp(ids[0] as string, 'assignee', 'Ana')
    const { container, store } = renderPageMode(pageId)
    await editorIn(container)
    await waitFor(() => {
      expect(chips(container, ids[0] as string)).toEqual([chip('Assignee', 'Ana')])
    })

    setProp(ids[0] as string, 'assignee', 'Bob')
    await act(async () => {
      await store.getState().load()
    })

    await waitFor(() => {
      expect(chips(container, ids[0] as string)).toEqual([chip('Assignee', 'Bob')])
    })
  })

  it('completing a repeating task brings in its next occurrence, with its rule', async () => {
    const { pageId, ids } = seedPage(['water plants', 'plain'])
    const task = ids[0] as string
    dispatch('set_todo_state', { blockId: task, state: 'DOING' })
    dispatch('set_due_date', { blockId: task, date: '2026-10-20' })
    setProp(task, 'repeat', '+1w')
    // The mock has no recurrence: this is the backend's, the next occurrence
    // made with the completion (`build_recurrence_sibling_in_tx`).
    let next = ''
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      const answer = dispatch(cmd, args)
      const { blockId, state } = (args ?? {}) as { blockId?: string; state?: string }
      if (cmd === 'set_todo_state' && blockId === task && state === 'DONE') {
        next = (
          dispatch('create_block', {
            blockType: 'content',
            content: 'water plants',
            parentId: pageId,
            index: 1,
            scope: SCOPE,
            blockId: null,
          }) as BlockRow
        ).id
        dispatch('set_todo_state', { blockId: next, state: 'TODO' })
        dispatch('set_due_date', { blockId: next, date: '2026-10-27' })
        setProp(next, 'repeat', '+1w')
      }
      return answer
    })
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    await waitFor(() => {
      expect(
        container.querySelector(`[data-page-block-id="${task}"] .repeat-indicator`),
      ).not.toBeNull()
    })

    await act(async () => {
      fireEvent.click(
        container.querySelector(
          `[data-page-block-id="${task}"] [data-testid="task-marker"]`,
        ) as HTMLElement,
      )
    })

    await waitFor(() => {
      expect(editor.state.doc.childCount).toBe(3)
    })
    expect(blockIdOf(editor.state.doc.child(1))).toBe(next)
    expect(docTexts(editor)).toEqual(['water plants', 'water plants', 'plain'])
    await waitFor(() => {
      expect(
        container
          .querySelector(`[data-page-block-id="${next}"] [data-testid="task-marker"]`)
          ?.getAttribute('aria-label'),
      ).toBe(t('block.taskCycle', { state: 'TODO' }))
    })
    expect(
      container
        .querySelector(`[data-page-block-id="${next}"] .due-date-chip`)
        ?.getAttribute('aria-label'),
    ).toBe(t('block.dueDate', { date: formatCompactDate('2026-10-27') }))
    expect(
      container.querySelector(`[data-page-block-id="${next}"] .repeat-indicator`),
    ).not.toBeNull()
    expect(
      container.querySelector(`[data-page-block-id="${task}"]`)?.getAttribute('data-todo-state'),
    ).toBe('DONE')
    expect(editor.can().undo()).toBe(false)
  })
})

describe('PageModeEditor attachments (#5743)', () => {
  // As the IPC does: the mock's rows are its own, so a rename there is not the row page mode holds.
  beforeEach(() => {
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) =>
      structuredClone(dispatch(cmd, args)),
    )
  })

  /** Attach a text file to block `id` in the backend, as a peer or block mode would. */
  function attachText(id: string, filename = 'notes.txt', text = 'hi'): string {
    const row = dispatch('add_attachment_with_bytes', {
      blockId: id,
      filename,
      mimeType: 'text/plain',
      bytes: [...new TextEncoder().encode(text)],
    }) as { id: string }
    return row.id
  }

  /** Block `id`'s attachments in the backend, by filename. */
  function backendFiles(id: string): string[] {
    const rows = dispatch('list_attachments', { blockId: id }) as Array<{ filename: string }>
    return rows.map((row) => row.filename)
  }

  const inBlock = (container: HTMLElement, id: string, selector: string) =>
    container.querySelector(`[data-page-block-id="${id}"] ${selector}`)

  /** What block `id`'s previews show: each text preview's body. */
  function previews(container: HTMLElement, id: string): string[] {
    return [
      ...container.querySelectorAll(
        `[data-page-block-id="${id}"] [data-testid="markdown-attachment-body"]`,
      ),
    ].map((body) => body.textContent ?? '')
  }

  /** Open block `id`'s attachment list from its badge. */
  async function openList(container: HTMLElement, id: string): Promise<HTMLElement> {
    const badge = await waitFor(() => {
      const found = inBlock(container, id, '[data-testid="attachment-badge"]')
      if (found === null) throw new Error('no attachment badge')
      return found as HTMLElement
    })
    fireEvent.click(badge)
    return screen.findByRole('list', { name: t('attachments.list') })
  }

  /** Paste `files` where the caret is, as the clipboard hands them to the editor. */
  function pasteFiles(editor: Editor, files: File[]): boolean {
    let taken = false
    act(() => {
      const clipboardData = { files, types: [], getData: () => '' }
      const event = { clipboardData, preventDefault: () => {} } as unknown as ClipboardEvent
      taken =
        editor.view.someProp('handlePaste', (f) =>
          f(editor.view, event, editor.state.doc.slice(0, 0)),
        ) ?? false
    })
    return taken
  }

  it('shows block mode’s previews and badge under the text, outside it, with no a11y violations', async () => {
    const { pageId, ids } = seedPage(['notes', 'plain'])
    attachText(ids[0] as string, 'notes.txt', 'hello there')
    const { container, onBlocked } = renderPageMode(pageId)
    const editor = await editorIn(container)

    await waitFor(() => {
      expect(previews(container, ids[0] as string)).toEqual(['hello there'])
    })
    expect(
      inBlock(container, ids[0] as string, '[data-testid="attachment-badge"]')?.getAttribute(
        'aria-label',
      ),
    ).toBe(t('block.attachments', { count: 1 }))
    expect(inBlock(container, ids[1] as string, '.page-block-metadata')).toBeNull()
    expect(
      container.querySelector('.page-block-content [data-testid="attachment-badge"]'),
    ).toBeNull()
    expect(docTexts(editor)).toEqual(['notes', 'plain'])
    expect(onBlocked).not.toHaveBeenCalled()
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })

  it('the badge opens block mode’s list, whose rename is read back, and the badge keeps the count', async () => {
    const { pageId, ids } = seedPage(['notes'])
    attachText(ids[0] as string)
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)

    const list = await openList(container, ids[0] as string)
    expect(within(list).getByText('notes.txt')).toBeInTheDocument()
    fireEvent.click(
      within(list).getByRole('button', { name: t('attachments.rename', { name: 'notes.txt' }) }),
    )
    const field = within(list).getByRole('textbox', {
      name: t('attachments.rename', { name: 'notes.txt' }),
    })
    fireEvent.change(field, { target: { value: 'renamed.txt' } })
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' })
    })

    await waitFor(() => {
      expect(backendFiles(ids[0] as string)).toEqual(['renamed.txt'])
    })
    await waitFor(() => {
      expect(within(list).getByText('renamed.txt')).toBeInTheDocument()
    })
    // The preview has the new name too: page mode read the page again.
    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: t('attachment.downloadFile', { filename: 'renamed.txt' }),
        }),
      ).toBeInTheDocument()
    })
    expect(docTexts(editor)).toEqual(['notes'])
    expect(editor.can().undo()).toBe(false)
  })

  it('what the list deletes goes from the backend, the badge and the previews', async () => {
    const { pageId, ids } = seedPage(['notes'])
    attachText(ids[0] as string, 'one.txt', 'first file')
    attachText(ids[0] as string, 'two.txt', 'second file')
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    const list = await openList(container, ids[0] as string)

    const remove = within(list).getByRole('button', {
      name: t('attachments.delete', { name: 'one.txt' }),
    })
    fireEvent.click(remove)
    await act(async () => {
      fireEvent.click(remove)
    })

    await waitFor(() => {
      expect(backendFiles(ids[0] as string)).toEqual(['two.txt'])
    })
    await waitFor(() => {
      expect(previews(container, ids[0] as string)).toEqual(['second file'])
    })
    expect(
      inBlock(container, ids[0] as string, '[data-testid="attachment-badge"]')?.getAttribute(
        'aria-label',
      ),
    ).toBe(t('block.attachments', { count: 1 }))
    expect(docTexts(editor)).toEqual(['notes'])
  })

  it('a refused delete says so, and the attachment stays', async () => {
    const { pageId, ids } = seedPage(['notes'])
    attachText(ids[0] as string)
    const { container } = renderPageMode(pageId)
    await editorIn(container)
    const list = await openList(container, ids[0] as string)
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'delete_attachment') throw new Error('database locked')
      return dispatch(cmd, args)
    })

    const remove = within(list).getByRole('button', {
      name: t('attachments.delete', { name: 'notes.txt' }),
    })
    fireEvent.click(remove)
    await act(async () => {
      fireEvent.click(remove)
    })

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('attachments.deleteFailed'))
    })
    expect(backendFiles(ids[0] as string)).toEqual(['notes.txt'])
    expect(within(list).getByText('notes.txt')).toBeInTheDocument()
    expect(previews(container, ids[0] as string)).toEqual(['hi'])
  })

  it('a refused rename says so, and the name stays', async () => {
    const { pageId, ids } = seedPage(['notes'])
    attachText(ids[0] as string)
    const { container } = renderPageMode(pageId)
    await editorIn(container)
    const list = await openList(container, ids[0] as string)
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'rename_attachment') throw new Error('database locked')
      return dispatch(cmd, args)
    })

    fireEvent.click(
      within(list).getByRole('button', { name: t('attachments.rename', { name: 'notes.txt' }) }),
    )
    const field = within(list).getByRole('textbox', {
      name: t('attachments.rename', { name: 'notes.txt' }),
    })
    fireEvent.change(field, { target: { value: 'renamed.txt' } })
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' })
    })

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('attachments.renameFailed'))
    })
    expect(backendFiles(ids[0] as string)).toEqual(['notes.txt'])
    expect(within(list).getByText('notes.txt')).toBeInTheDocument()
  })

  it('a file pasted is attached to the caret’s block, a new one too, and shows', async () => {
    const { pageId, ids } = seedPage(['notes'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    act(() => {
      editor.commands.setTextSelection(at(editor, 0, 5))
    })
    press(editor, 'Enter')
    const fresh = blockIdOf(editor.state.doc.child(1)) as string

    expect(
      pasteFiles(editor, [new File(['pasted text'], 'clip.txt', { type: 'text/plain' })]),
    ).toBe(true)

    await waitFor(() => {
      expect(backendFiles(fresh)).toEqual(['clip.txt'])
    })
    await waitFor(() => {
      expect(previews(container, fresh)).toEqual(['pasted text'])
    })
    expect(backendFiles(ids[0] as string)).toEqual([])
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      t('blockTree.attachedFileMessage', { filename: 'clip.txt' }),
    )
  })

  it('an image pasted goes in at the caret as well, as block mode puts it there', async () => {
    const { pageId, ids } = seedPage(['notes'])
    const { container, handle } = renderPageMode(pageId)
    const editor = await editorIn(container)
    act(() => {
      editor.commands.setTextSelection(at(editor, 0, 5))
    })

    pasteFiles(editor, [new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' })])

    await waitFor(() => {
      expect(backendFiles(ids[0] as string)).toEqual(['shot.png'])
    })
    const [attachment] = dispatch('list_attachments', { blockId: ids[0] }) as Array<{ id: string }>
    await act(async () => {
      await handle.current?.flush()
    })
    expect(backendText(ids[0] as string)).toBe(`notes![shot.png](attachment:${attachment?.id})`)
  })

  it('an image pasted goes in nowhere once the caret has left its block during the upload', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let uploading = false
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'add_attachment_with_bytes') {
        uploading = true
        await held
      }
      return structuredClone(dispatch(cmd, args))
    })
    const { container, handle } = renderPageMode(pageId)
    const editor = await editorIn(container)
    act(() => {
      editor.commands.setTextSelection(at(editor, 0, 5))
    })

    pasteFiles(editor, [new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' })])
    await waitFor(() => {
      expect(uploading).toBe(true)
    })
    act(() => {
      editor.commands.setTextSelection(at(editor, 1, 6))
    })
    release()

    await waitFor(() => {
      expect(backendFiles(ids[0] as string)).toEqual(['shot.png'])
    })
    await act(async () => {
      await handle.current?.flush()
    })
    expect(docTexts(editor)).toEqual(['first', 'second'])
    expect(backendText(ids[1] as string)).toBe('second')
  })

  it('a file pasted over the whole page (Ctrl+A) is attached to its first block', async () => {
    const { pageId, ids } = seedPage(['notes', 'more'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    act(() => {
      editor.commands.selectAll()
    })

    expect(pasteFiles(editor, [new File(['x'], 'clip.txt', { type: 'text/plain' })])).toBe(true)

    await waitFor(() => {
      expect(backendFiles(ids[0] as string)).toEqual(['clip.txt'])
    })
    expect(backendFiles(ids[1] as string)).toEqual([])
  })

  it('an export during a pasted file’s upload saves the typing before it reads', async () => {
    const { pageId, ids } = seedPage(['notes', 'other'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    // The focus registers page mode's flush, which an export asks for (`flushActiveDraft`).
    act(() => {
      editor.view.dom.dispatchEvent(new FocusEvent('focus'))
    })
    let answer = (): void => {}
    const held = new Promise<void>((resolve) => {
      answer = resolve
    })
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'add_attachment_with_bytes') await held
      return dispatch(cmd, args)
    })
    caretTo(editor, 0)
    pasteFiles(editor, [new File(['pasted text'], 'clip.txt', { type: 'text/plain' })])
    await waitFor(() => {
      expect(callsTo('add_attachment_with_bytes')).toBe(1)
    })

    typeAt(editor, 1, 5, ' typed')
    const exported = flushActiveDraft()
    answer()
    await act(async () => {
      await exported
    })
    expect(backendText(ids[1] as string)).toBe('other typed')
    expect(backendFiles(ids[0] as string)).toEqual(['clip.txt'])
  })

  it('a paste the backend refuses says so, and attaches nothing', async () => {
    const { pageId, ids } = seedPage(['notes'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    caretTo(editor, 0)
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'add_attachment_with_bytes') throw new Error('disk full')
      return dispatch(cmd, args)
    })

    pasteFiles(editor, [new File(['x'], 'clip.txt', { type: 'text/plain' })])

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('blockTree.attachFileFailed'))
    })
    expect(backendFiles(ids[0] as string)).toEqual([])
    expect(inBlock(container, ids[0] as string, '.page-block-metadata')).toBeNull()
  })

  it('a file pasted into a new block removed before it is saved says so, and attaches nothing', async () => {
    const { pageId, ids } = seedPage(['notes'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    act(() => {
      editor.commands.setTextSelection(at(editor, 0, 5))
    })
    press(editor, 'Enter')
    const fresh = blockIdOf(editor.state.doc.child(1)) as string

    act(() => {
      const clipboardData = {
        files: [new File(['x'], 'clip.txt', { type: 'text/plain' })],
        types: [],
        getData: () => '',
      }
      const event = { clipboardData, preventDefault: () => {} } as unknown as ClipboardEvent
      editor.view.someProp('handlePaste', (f) =>
        f(editor.view, event, editor.state.doc.slice(0, 0)),
      )
      // Before the save runs: the empty block joins the one before.
      editor.view.someProp('handleKeyDown', (f) =>
        f(editor.view, new KeyboardEvent('keydown', { key: 'Backspace' })),
      )
    })

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('blockTree.attachFileFailed'))
    })
    expect(docTexts(editor)).toEqual(['notes'])
    expect(backendFiles(ids[0] as string)).toEqual([])
    expect(backendFiles(fresh)).toEqual([])
  })

  it('a paste with no file is text, as before', async () => {
    const { pageId } = seedPage(['notes'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    caretTo(editor, 0)

    expect(pasteFiles(editor, [])).toBe(false)
  })

  it('a peer’s attachment added or deleted shows on reload, outside the document and its undo', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    const gone = attachText(ids[0] as string, 'gone.txt', 'old')
    const { container, store, onBlocked } = renderPageMode(pageId)
    const editor = await editorIn(container)
    await waitFor(() => {
      expect(previews(container, ids[0] as string)).toEqual(['old'])
    })

    dispatch('delete_attachment', { attachmentId: gone })
    attachText(ids[1] as string, 'new.txt', 'new')
    await act(async () => {
      await store.getState().load()
    })

    await waitFor(() => {
      expect(previews(container, ids[1] as string)).toEqual(['new'])
    })
    await waitFor(() => {
      expect(inBlock(container, ids[0] as string, '.page-block-metadata')).toBeNull()
    })
    expect(docTexts(editor)).toEqual(['first', 'second'])
    expect(editor.can().undo()).toBe(false)
    expect(onBlocked).not.toHaveBeenCalled()
  })

  it('an image’s size, alignment and caption set here are read back: a block drawn anew shows them', async () => {
    const { pageId, ids } = seedPage(['first', 'photo'])
    const photo = ids[1] as string
    dispatch('add_attachment_with_bytes', {
      blockId: photo,
      filename: 'photo.png',
      mimeType: 'image/png',
      bytes: [137, 80, 78, 71],
    })
    const blob = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:photo')
    onTestFinished(() => blob.mockRestore())
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    const image = (selector: string): HTMLElement => {
      const found = inBlock(container, photo, selector)
      if (!(found instanceof HTMLElement)) throw new Error(`no ${selector} in the photo block`)
      return found
    }
    const written = (key: string): string | null | undefined => {
      const rows = dispatch('get_properties', { blockId: photo }) as PropertyRow[]
      return rows.find((row) => row.key === key)?.value_text
    }
    /** Tab or Shift+Tab: the block's view is drawn anew at its new depth, from what page mode holds. */
    const redraw = (shiftKey: boolean): void => {
      caretTo(editor, 1)
      expect(press(editor, 'Tab', { shiftKey })).toBe(true)
    }
    const showToolbar = async (): Promise<void> => {
      fireEvent.focus(await waitFor(() => image('[data-testid="image-resize-wrapper"]')))
    }

    await showToolbar()
    await act(async () => {
      fireEvent.click(image('[data-testid="image-resize-50"]'))
    })
    await waitFor(() => {
      expect(written('image_width')).toBe('50')
    })
    redraw(false)
    await waitFor(() => {
      expect(image('[data-testid="image-resize-wrapper"]').style.maxWidth).toBe('50%')
    })

    await showToolbar()
    await act(async () => {
      fireEvent.click(image('[data-testid="image-align-right"]'))
    })
    await waitFor(() => {
      expect(written('image_alignment')).toBe('right')
    })
    redraw(true)
    await waitFor(() => {
      expect(image('[data-testid="attachment-section"]')).toHaveAttribute('data-alignment', 'right')
    })

    const caption = image('[data-testid="image-caption-input"]')
    fireEvent.focus(caption)
    fireEvent.change(caption, { target: { value: 'A photo' } })
    await act(async () => {
      fireEvent.blur(caption)
    })
    await waitFor(() => {
      expect(written('image_caption')).toBe('A photo')
    })
    redraw(false)
    await waitFor(() => {
      expect(image('[data-testid="image-caption-input"]')).toHaveValue('A photo')
    })
    expect(image('[data-testid="image-resize-wrapper"]').style.maxWidth).toBe('50%')
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

  it('a block with properties keeps its row’s box, empty, until it nears the view', async () => {
    const { pageId, ids } = seedPage(['first', 'call mom'])
    dispatch('set_property', {
      blockId: ids[1],
      key: 'assignee',
      value: {
        value_text: 'Ana',
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
    })
    const { container } = renderPageMode(pageId)
    await editorIn(container)
    const io = await observer()

    const box = inBlock(container, ids[1] as string, '.page-block-metadata') as HTMLElement
    expect(box.childElementCount).toBe(0)
    expect(box.hasAttribute('data-properties')).toBe(true)
    expect(box.hasAttribute('data-priority')).toBe(false)

    report(io, blockEl(container, ids[1] as string), true)
    await waitFor(() => {
      expect(inBlock(container, ids[1] as string, '[data-testid="property-chip"]')).not.toBeNull()
    })
  })

  it('a block with attachments shows its previews once near, or once the caret is in it', async () => {
    const { pageId, ids } = seedPage(['first', 'notes', 'more notes'])
    for (const id of ids.slice(1)) {
      dispatch('add_attachment_with_bytes', {
        blockId: id,
        filename: 'notes.txt',
        mimeType: 'text/plain',
        bytes: [104, 105],
      })
    }
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    const box = (id: string) => inBlock(container, id, '.page-block-metadata') as HTMLElement
    expect(box(ids[1] as string).childElementCount).toBe(0)
    expect(box(ids[2] as string).childElementCount).toBe(0)
    const io = await observer()

    report(io, blockEl(container, ids[1] as string), true)
    caretTo(editor, 2)

    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="markdown-attachment"]')).toHaveLength(2)
    })
    expect(inBlock(container, ids[1] as string, '[data-testid="attachment-badge"]')).not.toBeNull()
  })

  it('a query or an embed asks for nothing until it nears the view, or the caret is in it', async () => {
    const { pageId, ids } = seedPage([
      'first',
      '{{query tag:work}}',
      `{{embed ((${SEED_IDS.BLOCK_GS_1}))}}`,
    ])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    const box = (id: string) => inBlock(container, id, '.page-block-rendered') as HTMLElement
    const io = await observer()
    expect(box(ids[1] as string).childElementCount).toBe(0)
    expect(box(ids[2] as string).childElementCount).toBe(0)
    expect(callsTo('run_advanced_query')).toBe(0)

    report(io, blockEl(container, ids[1] as string), true)
    caretTo(editor, 2)

    await waitFor(() => {
      expect(resultsIn(container, ids[1] as string)).toHaveLength(4)
    })
    expect(inBlock(container, ids[2] as string, '[data-testid="embed-container"]')).not.toBeNull()
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

describe('PageModeEditor lists (#5743)', () => {
  function setStyle(id: string, style: 'bullet' | 'ordered'): void {
    dispatch('set_property', {
      blockId: id,
      key: 'listStyle',
      value: {
        value_text: style,
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
    })
  }

  /** Block `id`'s list style in the backend, or null. */
  function backendStyle(id: string): string | null {
    const rows = dispatch('get_properties', { blockId: id }) as PropertyRow[]
    return rows.find((row) => row.key === 'listStyle')?.value_text ?? null
  }

  /** Each block's marker, in order: '' for none. */
  function markers(container: HTMLElement): string[] {
    return [...container.querySelectorAll('[data-page-block]')].map(
      (block) => block.querySelector(':scope > [data-testid="list-marker"]')?.textContent ?? '',
    )
  }

  /** Type `text` at the caret as the keyboard does, input rules included. */
  function typeKeys(editor: Editor, text: string): void {
    act(() => {
      typeText(editor, text)
    })
  }

  /** A page of `texts`, each given the style beside it. */
  function seedList(rows: ReadonlyArray<[string, 'bullet' | 'ordered' | null]>) {
    const seeded = seedPage(rows.map(([text]) => text))
    rows.forEach(([, style], i) => {
      if (style !== null) setStyle(seeded.ids[i] as string, style)
    })
    return seeded
  }

  it('draws block mode’s markers, numbered by runs of siblings, outside the text, with no a11y violations', async () => {
    const { pageId, ids } = seedList([
      ['one', 'ordered'],
      ['two', 'ordered'],
      ['three', 'ordered'],
      ['plain', null],
      ['four', 'ordered'],
      ['dot', 'bullet'],
    ])
    const children = dispatch('create_blocks_batch', {
      specs: ['nested a', 'nested b'].map((content) => ({
        blockType: 'content',
        content,
        parentId: ids[1],
        position: null,
      })),
    }) as { blocks: BlockRow[] }
    for (const child of children.blocks) setStyle(child.id, 'ordered')
    const { container, onBlocked } = renderPageMode(pageId)
    const editor = await editorIn(container)

    expect(docTexts(editor)).toEqual([
      'one',
      'two',
      'nested a',
      'nested b',
      'three',
      'plain',
      'four',
      'dot',
    ])
    expect(markers(container)).toEqual(['1.', '2.', '1.', '2.', '3.', '', '1.', '•'])
    const marker = container.querySelector('[data-testid="list-marker"]') as HTMLElement
    expect(marker).toHaveAttribute('aria-hidden', 'true')
    expect(marker.contentEditable).toBe('false')
    expect(marker.closest('.page-block-content')).toBeNull()
    expect(onBlocked).not.toHaveBeenCalled()
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })

  it('`- ` and `1. ` then a character make the block a list, without the prefix', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    const { container, handle } = renderPageMode(pageId)
    const editor = await editorIn(container)

    caretTo(editor, 0)
    typeKeys(editor, '- a')
    caretTo(editor, 1)
    typeKeys(editor, '1. b')

    expect(docTexts(editor)).toEqual(['afirst', 'bsecond'])
    expect(markers(container)).toEqual(['•', '1.'])
    await act(async () => {
      await handle.current?.flush()
    })
    await waitFor(() => {
      expect([backendStyle(ids[0] as string), backendStyle(ids[1] as string)]).toEqual([
        'bullet',
        'ordered',
      ])
    })
    expect(backendPage(pageId)).toEqual([
      [ids[0], 'afirst'],
      [ids[1], 'bsecond'],
    ])
  })

  it('`- [` waits: a typed task marker stays one, as block mode’s rule leaves it', async () => {
    const { pageId, ids } = seedPage(['first'])
    const { container, handle } = renderPageMode(pageId)
    const editor = await editorIn(container)

    caretTo(editor, 0)
    typeKeys(editor, '- [ ] ')

    expect(docTexts(editor)).toEqual(['\\- \\[ \\] first'])
    expect(markers(container)).toEqual([''])
    await act(async () => {
      await handle.current?.flush()
    })
    await waitFor(() => {
      expect((dispatch('get_block', { blockId: ids[0] }) as BlockRow).todo_state).toBe('TODO')
    })
    expect(backendStyle(ids[0] as string)).toBeNull()
  })

  it('Tab and Shift+Tab number a block again at its new depth', async () => {
    const { pageId } = seedList([
      ['one', 'ordered'],
      ['two', 'ordered'],
    ])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    act(() => {
      editor.commands.setTextSelection(at(editor, 1, 0))
    })

    press(editor, 'Tab')
    expect(markers(container)).toEqual(['1.', '1.'])

    press(editor, 'Tab', { shiftKey: true })
    expect(markers(container)).toEqual(['1.', '2.'])
  })

  it('`- ` then Enter splits the block: the Enter is no character for the bullet rule', async () => {
    const { pageId, ids } = seedPage(['first'])
    const { container, handle } = renderPageMode(pageId)
    const editor = await editorIn(container)

    act(() => {
      editor.commands.setTextSelection(at(editor, 0, 5))
    })
    press(editor, 'Enter')
    typeKeys(editor, '- ')
    expect(press(editor, 'Enter')).toBe(true)

    expect(docTexts(editor)).toEqual(['first', '\\- ', ''])
    expect(markers(container)).toEqual(['', '', ''])
    await act(async () => {
      await handle.current?.flush()
    })
    const made = blockIdOf(editor.state.doc.child(1)) as string
    expect(backendPage(pageId)).toEqual([
      [ids[0], 'first'],
      [made, '\\- '],
    ])
    expect(backendStyle(made)).toBeNull()
  })

  it('Enter continues the list into a new block, and Enter on that empty block leaves it', async () => {
    const { pageId, ids } = seedList([
      ['one', 'ordered'],
      ['two', 'ordered'],
    ])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)

    act(() => {
      editor.commands.setTextSelection(at(editor, 1, 3))
    })
    expect(press(editor, 'Enter')).toBe(true)
    const added = blockIdOf(editor.state.doc.child(2)) as string
    expect(markers(container)).toEqual(['1.', '2.', '3.'])
    await waitFor(() => {
      expect(backendStyle(added)).toBe('ordered')
    })
    expect(backendPage(pageId)).toEqual([
      [ids[0], 'one'],
      [ids[1], 'two'],
      [added, ''],
    ])

    expect(press(editor, 'Enter')).toBe(true)

    expect(editor.state.doc.childCount).toBe(3)
    expect(markers(container)).toEqual(['1.', '2.', ''])
    await waitFor(() => {
      expect(backendStyle(added)).toBeNull()
    })
    expect(backendPage(pageId).map(([id]) => id)).toEqual([ids[0], ids[1], added])
  })

  it('Enter splitting a list block’s text gives the half with the new id the style', async () => {
    const { pageId, ids } = seedList([['onetwo', 'bullet']])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)

    act(() => {
      editor.commands.setTextSelection(at(editor, 0, 3))
    })
    press(editor, 'Enter')

    expect(docTexts(editor)).toEqual(['one', 'two'])
    expect(markers(container)).toEqual(['•', '•'])
    const added = blockIdOf(editor.state.doc.child(1)) as string
    await waitFor(() => {
      expect(backendStyle(added)).toBe('bullet')
    })
    expect(backendStyle(ids[0] as string)).toBe('bullet')
  })

  it('Backspace at a list block’s start takes its style off, and the next one joins', async () => {
    const { pageId, ids } = seedList([
      ['one', 'bullet'],
      ['two', 'ordered'],
    ])
    const { container, handle } = renderPageMode(pageId)
    const editor = await editorIn(container)

    caretTo(editor, 1)
    expect(press(editor, 'Backspace')).toBe(true)
    expect(markers(container)).toEqual(['•', ''])
    expect(docTexts(editor)).toEqual(['one', 'two'])
    await waitFor(() => {
      expect(backendStyle(ids[1] as string)).toBeNull()
    })

    expect(press(editor, 'Backspace')).toBe(true)
    expect(docTexts(editor)).toEqual(['onetwo'])
    await act(async () => {
      await handle.current?.flush()
    })
    expect(backendPage(pageId)).toEqual([[ids[0], 'onetwo']])
    expect(backendStyle(ids[0] as string)).toBe('bullet')

    // The first block of the page leaves its list too.
    caretTo(editor, 0)
    expect(press(editor, 'Backspace')).toBe(true)
    expect(markers(container)).toEqual([''])
    await waitFor(() => {
      expect(backendStyle(ids[0] as string)).toBeNull()
    })
  })

  it('a refused style write says so, and the block shows the style the backend kept', async () => {
    const { pageId, ids } = seedList([['one', 'ordered']])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'delete_property') throw new Error('database locked')
      return dispatch(cmd, args)
    })

    caretTo(editor, 0)
    press(editor, 'Backspace')
    expect(markers(container)).toEqual([''])

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('blockTree.clearListStyleFailed'))
    })
    expect(markers(container)).toEqual(['1.'])
    expect(backendStyle(ids[0] as string)).toBe('ordered')
  })

  it('Ctrl+Z gives the prefix back, then the typing, and leaves the style, as block mode’s undo does', async () => {
    const { pageId, ids } = seedPage(['first'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)

    caretTo(editor, 0)
    typeKeys(editor, '- a')
    await waitFor(() => {
      expect(backendStyle(ids[0] as string)).toBe('bullet')
    })
    act(() => {
      editor.commands.undo()
    })
    expect(docTexts(editor)).toEqual(['\\- afirst'])
    act(() => {
      editor.commands.undo()
    })

    expect(docTexts(editor)).toEqual(['first'])
    expect(markers(container)).toEqual(['•'])
    expect(backendStyle(ids[0] as string)).toBe('bullet')
  })

  it('a peer’s list style, set or cleared, shows on reload, outside the document and its undo', async () => {
    const { pageId, ids } = seedList([
      ['one', 'ordered'],
      ['two', null],
    ])
    const { container, store } = renderPageMode(pageId)
    const editor = await editorIn(container)
    expect(markers(container)).toEqual(['1.', ''])

    dispatch('delete_property', { blockId: ids[0], key: 'listStyle' })
    setStyle(ids[1] as string, 'bullet')
    await act(async () => {
      await store.getState().load()
    })

    await waitFor(() => {
      expect(markers(container)).toEqual(['', '•'])
    })
    expect(docTexts(editor)).toEqual(['one', 'two'])
    expect(editor.can().undo()).toBe(false)
  })

  it('typing, its save and a reload redraw no marker', async () => {
    const { pageId } = seedList([
      ['one', 'ordered'],
      ['two', 'ordered'],
      ['dot', 'bullet'],
    ])
    const { container, handle, store } = renderPageMode(pageId)
    const editor = await editorIn(container)
    const drawn = [...container.querySelectorAll('[data-testid="list-marker"]')]
    expect(drawn).toHaveLength(3)
    const changes: MutationRecord[] = []
    const observer = new MutationObserver((records) => {
      changes.push(
        ...records.filter((record) =>
          [record.target, ...record.addedNodes, ...record.removedNodes].some(
            (node) => node instanceof Element && node.matches('[data-testid="list-marker"]'),
          ),
        ),
        ...records.filter((record) => record.target.parentElement?.matches('.list-marker')),
      )
    })
    observer.observe(container, { subtree: true, childList: true, characterData: true })

    typeAt(editor, 1, 3, ' typed')
    typeAt(editor, 0, 3, '!')
    await act(async () => {
      await handle.current?.flush()
      await store.getState().load()
      await handle.current?.flush()
      await store.getState().load()
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    observer.disconnect()

    expect(docTexts(editor)).toEqual(['one!', 'two typed', 'dot'])
    expect(changes).toEqual([])
    expect([...container.querySelectorAll('[data-testid="list-marker"]')]).toEqual(drawn)
  })
})

describe('PageModeEditor queries and embeds (#5743)', () => {
  const WELCOME = 'Welcome to Agaric! This is your personal knowledge base.'
  const embedOf = (id: string) => `{{embed ((${id}))}}`
  const blockEl = (container: HTMLElement, id: string) =>
    container.querySelector(`[data-page-block-id="${id}"]`) as HTMLElement
  const inBlock = (container: HTMLElement, id: string) => within(blockEl(container, id))

  /** Open the builder from block `id`'s query and press its Save. */
  async function saveFromBuilder(container: HTMLElement, id: string): Promise<void> {
    fireEvent.click(
      inBlock(container, id).getByRole('button', { name: t('queryBuilder.editButton') }),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'save query' }))
  }

  it('draws a query’s results and an embedded block as block mode does, outside the text, with no a11y violations', async () => {
    const { pageId, ids } = seedPage(['first', '{{query tag:work}}', embedOf(SEED_IDS.BLOCK_GS_1)])
    const { container, onBlocked } = renderPageMode(pageId)
    const editor = await editorIn(container)

    await waitFor(() => {
      expect(resultsIn(container, ids[1] as string)).toHaveLength(4)
    })
    const embed = await inBlock(container, ids[2] as string).findByTestId('embed-container')
    await waitFor(() => {
      expect(embed).toHaveTextContent(WELCOME)
    })
    for (const id of [ids[1], ids[2]] as string[]) {
      const block = blockEl(container, id)
      const drawn = block.querySelector('.page-block-rendered') as HTMLElement
      expect(block).toHaveAttribute('data-rendered')
      expect(drawn.contentEditable).toBe('false')
      expect(block.querySelector('.page-block-content')?.contains(drawn)).toBe(false)
    }
    expect(blockEl(container, ids[0] as string)).not.toHaveAttribute('data-rendered')
    expect(docTexts(editor)).toEqual(['first', '{{query tag:work}}', embedOf(SEED_IDS.BLOCK_GS_1)])
    expect(onBlocked).not.toHaveBeenCalled()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('an embedded block’s link names its page, as block mode’s tree resolves it', async () => {
    const other = seedPage(['elsewhere'], 'Other page')
    const source = seedPage([`see [[${other.pageId}]]`], 'Source page')
    const { pageId, ids } = seedPage(['first', embedOf(source.ids[0] as string)])
    // The app's boot preload of the space's page titles.
    useResolveStore.getState().set(other.pageId, 'Other page', false)
    const { container } = renderPageMode(pageId)
    await editorIn(container)

    const embed = await inBlock(container, ids[1] as string).findByTestId('embed-container')

    await waitFor(() => {
      expect(within(embed).getByTestId('block-link-chip')).toHaveTextContent('Other page')
    })
  })

  it('the caret in a query shows its text to edit; the results follow the edit once the caret leaves', async () => {
    const { pageId, ids } = seedPage(['first', '{{query tag:work}}'])
    const { container, handle } = renderPageMode(pageId)
    const editor = await editorIn(container)
    await waitFor(() => {
      expect(resultsIn(container, ids[1] as string)).toHaveLength(4)
    })
    act(() => {
      editor.view.focus()
    })
    caretTo(editor, 1)
    expect(blockEl(container, ids[1] as string)).toHaveClass('page-block-current')

    act(() => {
      editor
        .chain()
        .setTextSelection({ from: at(editor, 1, 12), to: at(editor, 1, 16) })
        .insertContent('personal')
        .run()
    })
    await act(async () => {
      await handle.current?.flush()
    })

    // Saved, and the caret still in it: the results are the ones it came with.
    expect(backendText(ids[1] as string)).toBe('{{query tag:personal}}')
    expect(blockEl(container, ids[1] as string)).toHaveTextContent('tag: work')
    expect(resultsIn(container, ids[1] as string)).toHaveLength(4)

    caretTo(editor, 0)

    await waitFor(() => {
      expect(resultsIn(container, ids[1] as string)).toHaveLength(2)
    })
    expect(blockEl(container, ids[1] as string)).toHaveTextContent('tag: personal')
    expect(blockEl(container, ids[1] as string)).toHaveTextContent('Buy groceries')
  })

  it('a click on a query’s results puts the caret in its text; an embed’s Open source goes to its page', async () => {
    const onNavigateToPage = vi.fn()
    const { pageId, ids } = seedPage(['first', '{{query tag:work}}', embedOf(SEED_IDS.BLOCK_GS_1)])
    const { container } = renderPageMode(pageId, { onNavigateToPage })
    const editor = await editorIn(container)
    await waitFor(() => {
      expect(resultsIn(container, ids[1] as string)).toHaveLength(4)
    })

    fireEvent.click(resultsIn(container, ids[1] as string)[0] as Element)

    expect(editor.state.selection.$head.index(0)).toBe(1)
    expect(onNavigateToPage).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(
        await inBlock(container, ids[2] as string).findByRole('button', {
          name: t('embed.openSource'),
        }),
      )
    })

    await waitFor(() => {
      expect(onNavigateToPage.mock.calls[0]?.[0]).toBe(SEED_IDS.PAGE_GETTING_STARTED)
    })
  })

  it('a query whose results cannot be read shows block mode’s error, and Retry reads them', async () => {
    let refuse = true
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'run_advanced_query' && refuse) throw new Error('database locked')
      return dispatch(cmd, args)
    })
    const { pageId, ids } = seedPage(['first', '{{query tag:work}}'])
    const { container } = renderPageMode(pageId)
    await editorIn(container)

    const alert = await inBlock(container, ids[1] as string).findByRole('alert')
    refuse = false
    fireEvent.click(within(alert).getByRole('button', { name: t('action.retry') }))

    await waitFor(() => {
      expect(resultsIn(container, ids[1] as string)).toHaveLength(4)
    })
  })

  it('an embed of a missing block or of one that cannot be read, and a query that finds nothing, show block mode’s states', async () => {
    const warn = vi.spyOn(logger, 'warn')
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'get_block' && (args as { blockId: string }).blockId === SEED_IDS.BLOCK_GS_1) {
        throw new Error('database locked')
      }
      return dispatch(cmd, args)
    })
    const { pageId, ids } = seedPage([
      embedOf('01JZZZZZZZZZZZZZZZZZZZZZZZ'),
      embedOf(SEED_IDS.BLOCK_GS_1),
      '{{query tag:nothing-has-it}}',
    ])
    const { container } = renderPageMode(pageId)
    await editorIn(container)

    for (const id of [ids[0], ids[1]] as string[]) {
      expect(await inBlock(container, id).findByTestId('embed-unresolved')).toHaveTextContent(
        t('embed.unresolved'),
      )
    }
    expect(warn).toHaveBeenCalledWith(
      'EmbedContainer',
      'embed target fetch failed',
      { targetId: SEED_IDS.BLOCK_GS_1 },
      expect.any(Error),
    )
    expect(
      await inBlock(container, ids[2] as string).findByText(t('query.noResults')),
    ).toBeVisible()
  })

  it('the query builder’s Save writes after the text is saved, and the page reads it back', async () => {
    const { pageId, ids } = seedPage(['first', '{{query tag:work}}'])
    const { container, handle } = renderPageMode(pageId)
    const editor = await editorIn(container)
    await waitFor(() => {
      expect(resultsIn(container, ids[1] as string)).toHaveLength(4)
    })
    typeAt(editor, 0, 5, '!')
    await act(async () => {
      await handle.current?.flush()
    })
    // As the real backend can: a read of the page answered before an edit sent first commits.
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'edit_block') await new Promise((resolve) => setTimeout(resolve, 20))
      return dispatch(cmd, args)
    })

    await saveFromBuilder(container, ids[1] as string)

    await waitFor(() => {
      expect(docTexts(editor)).toEqual(['first!', '{{query tag:personal}}'])
    })
    expect(backendText(ids[1] as string)).toBe('{{query tag:personal}}')
    await waitFor(() => {
      expect(resultsIn(container, ids[1] as string)).toHaveLength(2)
    })
    expect(screen.queryByRole('button', { name: 'save query' })).toBeNull()
  })

  it('a builder Save the backend refuses says so, and the builder and the text stay', async () => {
    const { pageId, ids } = seedPage(['first', '{{query tag:work}}'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    await waitFor(() => {
      expect(resultsIn(container, ids[1] as string)).toHaveLength(4)
    })
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'edit_block') throw new Error('database locked')
      return dispatch(cmd, args)
    })

    await saveFromBuilder(container, ids[1] as string)

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('error.saveFailed'))
    })
    expect(screen.getByRole('button', { name: 'save query' })).toBeInTheDocument()
    expect(backendText(ids[1] as string)).toBe('{{query tag:work}}')
    expect(docTexts(editor)).toEqual(['first', '{{query tag:work}}'])
  })

  it('typing elsewhere, the caret passing through, its save and a reload redraw no result or embed', async () => {
    const { pageId, ids } = seedPage(['first', '{{query tag:work}}', embedOf(SEED_IDS.BLOCK_GS_1)])
    const { container, handle, store } = renderPageMode(pageId)
    const editor = await editorIn(container)
    await waitFor(() => {
      expect(resultsIn(container, ids[1] as string)).toHaveLength(4)
    })
    const embed = await inBlock(container, ids[2] as string).findByTestId('embed-container')
    await waitFor(() => {
      expect(embed).toHaveTextContent(WELCOME)
    })
    const query = inBlock(container, ids[1] as string).getByTestId('query-result')
    const asked = callsTo('run_advanced_query')
    const draw = vi.spyOn(ReactRenderer.prototype, 'render')
    // An earlier test's spy on the prototype is this one, and counted this page's first draws.
    draw.mockClear()
    act(() => {
      editor.view.focus()
    })

    typeAt(editor, 0, 5, ' typed')
    caretTo(editor, 1)
    caretTo(editor, 2)
    caretTo(editor, 0)
    typeAt(editor, 0, 0, '!')
    // Keys ask nothing; a save does, as block mode's does (`recordGraphStructureChange`).
    expect(callsTo('run_advanced_query')).toBe(asked)
    await act(async () => {
      await handle.current?.flush()
      await store.getState().load()
      await handle.current?.flush()
      await store.getState().load()
    })

    expect(backendText(ids[0] as string)).toBe('!first typed')
    expect(draw).not.toHaveBeenCalled()
    expect(inBlock(container, ids[1] as string).getByTestId('query-result')).toBe(query)
    expect(inBlock(container, ids[2] as string).getByTestId('embed-container')).toBe(embed)
  })

  it('an embed of a block of this page shows its text as saved, read once a save, not in a loop', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    dispatch('edit_block', { blockId: ids[1], toText: embedOf(ids[0] as string) })
    // Each answer in a task of its own, as the real IPC's: a loop of reads then shows as a count.
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      await new Promise((resolve) => setTimeout(resolve))
      return dispatch(cmd, args)
    })
    const handle = createRef<PageModeEditorHandle>()
    // Registered, as `PageEditor`'s is: the embed's own store of this page mirrors it.
    const { container } = render(
      <PageBlockStoreProvider pageId={pageId}>
        <PageModeEditor pageId={pageId} onBlocked={vi.fn()} ref={handle} />
      </PageBlockStoreProvider>,
    )
    const editor = await editorIn(container)
    const embed = () => inBlock(container, ids[1] as string).getByTestId('embed-container')
    await waitFor(() => {
      expect(embed()).toHaveTextContent('first')
    })

    typeAt(editor, 0, 5, ' edited')
    await act(async () => {
      await handle.current?.flush()
    })

    await waitFor(() => {
      expect(embed()).toHaveTextContent('first edited')
    })
    const reads = callsTo('load_page_subtree')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
    })
    expect(callsTo('load_page_subtree')).toBe(reads)
  })

  it('a query of this page lists a block tagged here once the tag is saved, as block mode’s does', async () => {
    const { pageId, ids } = seedPage(['first', 'second', '{{query tag:work}}'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    await waitFor(() => {
      expect(resultsIn(container, ids[2] as string)).toHaveLength(4)
    })

    typeAt(editor, 0, 5, ' #work')
    caretTo(editor, 1)

    await waitFor(() => {
      expect(resultsIn(container, ids[2] as string)).toHaveLength(5)
    })
    expect(
      [...resultsIn(container, ids[2] as string)].some((row) =>
        row.textContent?.startsWith('first'),
      ),
    ).toBe(true)
  })
})

describe('PageModeEditor slash menu and pickers (#5743)', () => {
  beforeEach(() => {
    // The menu's "Recent" band reads what earlier picks recorded.
    localStorage.clear()
  })

  function backendRow(id: string): BlockRow {
    return dispatch('get_block', { blockId: id }) as BlockRow
  }

  function backendProps(id: string): Record<string, string | null> {
    const rows = dispatch('get_properties', { blockId: id }) as PropertyRow[]
    return Object.fromEntries(
      rows
        .filter((row) => !SYSTEM_MANAGED_PROPERTY_KEYS.has(row.key))
        .map((row) => [row.key, row.value_text ?? row.value_date]),
    )
  }

  /** Type `text` after `offset` characters of block `index`, as the keyboard does. */
  function typeIn(editor: Editor, index: number, offset: number, text: string): void {
    act(() => {
      editor.view.focus()
      editor.commands.setTextSelection(at(editor, index, offset))
      typeText(editor, text)
    })
  }

  /** Click the open menu's option named `name`. */
  async function pick(name: RegExp): Promise<void> {
    const option = await screen.findByRole('option', { name })
    await act(async () => {
      fireEvent.click(option)
    })
  }

  /** What `selector` finds in block `id`, once it shows. */
  async function inBlock(container: HTMLElement, id: string, selector: string) {
    return waitFor(() => {
      const found = container.querySelector<HTMLElement>(`[data-page-block-id="${id}"] ${selector}`)
      if (found === null) throw new Error(`no ${selector} in ${id}`)
      return found
    })
  }

  const checkboxIn = (container: HTMLElement, id: string) =>
    inBlock(container, id, '[data-testid="task-marker"]')

  it('`/` opens block mode’s menu less the commands that write blocks, with no a11y violations', async () => {
    const { pageId } = seedPage(['first'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)

    typeIn(editor, 0, 5, ' /')
    const listbox = await screen.findByRole('listbox')
    const offered = within(listbox)
      .getAllByRole('option')
      .map((option) => option.getAttribute('data-item-id') ?? option.textContent)
    expect(offered.some((name) => name?.startsWith('TODO — Mark as to-do'))).toBe(true)
    expect(offered.some((name) => name?.startsWith('DUE — Set due date on block'))).toBe(true)
    expect(offered.some((name) => name?.startsWith('QUERY — Insert embedded query block'))).toBe(
      true,
    )
    expect(offered.some((name) => name?.startsWith('DUPLICATE'))).toBe(false)
    expect(offered.some((name) => name?.startsWith('TEMPLATE'))).toBe(false)
    expect(editor.view.dom).toHaveAttribute('role', 'combobox')
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
    await waitFor(async () => {
      expect(await axe(screen.getByTestId('suggestion-popup'))).toHaveNoViolations()
    })
  })

  it('Enter picks from the open menu, not a split; Escape closes it and writes nothing', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)

    typeIn(editor, 1, 6, ' /tod')
    await screen.findByRole('option', { name: /TODO — Mark as to-do/ })
    expect(press(editor, 'Escape')).toBe(true)
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).toBeNull()
    })
    expect(editor.isFocused).toBe(true)
    expect(docTexts(editor)).toEqual(['first', 'second /tod'])

    typeIn(editor, 0, 5, ' /todo')
    await screen.findByRole('option', { name: /TODO — Mark as to-do/ })
    expect(press(editor, 'Enter')).toBe(true)
    await waitFor(() => {
      expect(backendRow(ids[0] as string).todo_state).toBe('TODO')
    })
    expect(docTexts(editor)).toEqual(['first ', 'second /tod'])
    await waitFor(() => {
      expect(backendText(ids[1] as string)).toBe('second /tod')
    })
    expect(backendRow(ids[1] as string).todo_state).toBeNull()
    expect(callsTo('set_todo_state')).toBe(1)
  })

  it('a task command writes the caret’s block, a new empty one too, and its checkbox shows', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    const { container, handle } = renderPageMode(pageId)
    const editor = await editorIn(container)

    typeIn(editor, 1, 6, ' /doing')
    await pick(/DOING — Mark as in progress/)
    await waitFor(() => {
      expect(backendRow(ids[1] as string).todo_state).toBe('DOING')
    })
    expect((await checkboxIn(container, ids[1] as string)).getAttribute('aria-label')).toBe(
      t('block.taskCycle', { state: 'DOING' }),
    )
    expect(backendRow(ids[0] as string).todo_state).toBeNull()

    // A new block holding only the command: the save creates it, empty, for the state.
    act(() => {
      editor.commands.setTextSelection(at(editor, 1, 7))
    })
    press(editor, 'Enter')
    const added = blockIdOf(editor.state.doc.child(2)) as string
    // The save the caret's move started, done before the command is typed: it creates nothing.
    await act(async () => {
      await handle.current?.flush()
    })
    expect(backendPage(pageId)).toHaveLength(2)
    typeIn(editor, 2, 0, '/todo')
    await pick(/TODO — Mark as to-do/)
    await waitFor(() => {
      expect(backendRow(added).todo_state).toBe('TODO')
    })
    expect(backendPage(pageId)).toEqual([
      [ids[0], 'first'],
      [ids[1], 'second '],
      [added, ''],
    ])
    await checkboxIn(container, added)
  })

  it('a refused command says so, as block mode’s does, and nothing shows', async () => {
    const { pageId, ids } = seedPage(['first'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'set_todo_state' || cmd === 'set_property') throw new Error('database locked')
      return dispatch(cmd, args)
    })

    typeIn(editor, 0, 5, ' /todo')
    await pick(/TODO — Mark as to-do/)
    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('blockTree.setTaskStateFailed'))
    })
    expect(backendRow(ids[0] as string).todo_state).toBeNull()
    expect(
      container.querySelector(`[data-page-block-id="${ids[0]}"] [data-testid="task-marker"]`),
    ).toBeNull()

    typeIn(editor, 0, 6, '/effort')
    await pick(/EFFORT 1h/)
    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('slash.effortFailed'))
    })
    expect(backendProps(ids[0] as string)).toEqual({})
  })

  it('a property command writes the block, and its chip shows once the page is read again', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)

    typeIn(editor, 1, 6, ' /effort')
    await pick(/EFFORT 1h/)
    await waitFor(() => {
      expect(backendProps(ids[1] as string)).toEqual({ effort: '1h' })
    })
    await waitFor(() => {
      expect(
        container
          .querySelector(`[data-page-block-id="${ids[1]}"] [data-testid="property-chip"]`)
          ?.getAttribute('aria-label'),
      ).toBe(t('property.selectValue', { key: 'Effort', value: '1h' }))
    })
    expect(backendProps(ids[0] as string)).toEqual({})
  })

  it('a list command styles the caret’s block, and its marker shows', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)

    typeIn(editor, 1, 6, ' /numbered')
    await pick(/NUMBERED LIST/)
    await waitFor(() => {
      expect(
        container.querySelector(`[data-page-block-id="${ids[1]}"] > [data-testid="list-marker"]`)
          ?.textContent,
      ).toBe('1.')
    })
    const styles = dispatch('get_properties', { blockId: ids[1] }) as PropertyRow[]
    expect(styles.find((row) => row.key === 'listStyle')?.value_text).toBe('ordered')
  })

  it('/due gives an undated block its date through block mode’s picker; the drawer clears it', async () => {
    const { pageId, ids } = seedPage(['pay rent', 'plan trip'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)

    typeIn(editor, 0, 8, ' /due')
    await pick(/DUE — Set due date on block/)
    const field = await screen.findByRole('textbox', { name: t('journal.typeDateLabel') })
    fireEvent.change(field, { target: { value: '2026-12-24' } })
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' })
    })
    await waitFor(() => {
      expect(backendRow(ids[0] as string).due_date).toBe('2026-12-24')
    })
    expect(
      (await inBlock(container, ids[0] as string, '.due-date-chip')).getAttribute('aria-label'),
    ).toBe(t('block.dueDate', { date: formatCompactDate('2026-12-24') }))
    expect(backendRow(ids[1] as string).due_date).toBeNull()

    caretTo(editor, 0)
    expect(press(editor, 'P', { ctrlKey: true, shiftKey: true })).toBe(true)
    const drawer = await screen.findByRole('dialog', { name: t('property.drawerTitle') })
    await act(async () => {
      fireEvent.click(
        await within(drawer).findByRole('button', { name: t('property.clearDueDate') }),
      )
    })
    await waitFor(() => {
      expect(backendRow(ids[0] as string).due_date).toBeNull()
    })
    await waitFor(() => {
      expect(container.querySelector(`[data-page-block-id="${ids[0]}"] .due-date-chip`)).toBeNull()
    })
  })

  it('/repeat-until’s date the command refuses says so, and the block keeps its rule alone', async () => {
    const { pageId, ids } = seedPage(['water plants'])
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
    const { container, handle } = renderPageMode(pageId)
    const editor = await editorIn(container)
    const row = await inBlock(container, ids[0] as string, '.block-metadata-row')
    const shown = row.textContent
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'set_property' && (args as { key: string }).key === 'repeat-until') {
        throw new Error('database locked')
      }
      return dispatch(cmd, args)
    })

    typeIn(editor, 0, 12, ' /until')
    await pick(/REPEAT UNTIL — Stop repeating after a date/)
    const field = await screen.findByRole('textbox', { name: t('journal.typeDateLabel') })
    fireEvent.change(field, { target: { value: '2026-12-24' } })
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' })
    })

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('blockTree.setRepeatEndDateFailed'))
    })
    expect(backendProps(ids[0] as string)).toEqual({ repeat: '+1w' })
    // Queued behind the read the pick asks for: once it has run, the row shows that read.
    await act(async () => {
      await handle.current?.flush()
    })
    expect((await inBlock(container, ids[0] as string, '.block-metadata-row')).textContent).toBe(
      shown,
    )
  })

  it('a text command edits the document alone, which the save writes; a mark carries to the next text', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    await waitFor(() => {
      expect(callsTo('list_attachments_batch')).toBe(1)
    })
    const reads = callsTo('load_page_subtree')

    typeIn(editor, 1, 6, ' /h2')
    await pick(/Heading 2/)
    expect(docTexts(editor)).toEqual(['first', '## second '])
    await waitFor(() => {
      expect(backendText(ids[1] as string)).toBe('## second ')
    })
    expect(callsTo('edit_block')).toBe(1)

    typeIn(editor, 0, 5, ' /bold')
    await pick(/BOLD — Bold text/)
    act(() => {
      typeText(editor, 'loud')
    })
    expect(docTexts(editor)).toEqual(['first **loud**', '## second '])
    await waitFor(() => {
      expect(backendText(ids[0] as string)).toBe('first **loud**')
    })
    // Neither waited for a save, nor read the page again after it.
    expect(callsTo('load_page_subtree')).toBe(reads)
  })

  it('`::` lists the property keys, and the pick is a `key:: ` line that becomes the property once left', async () => {
    const { pageId, ids } = seedPage(['first', 'call mom'])
    dispatch('set_property', {
      blockId: ids[0],
      key: 'assignee',
      value: {
        value_text: 'Bo',
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
    })
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)

    act(() => {
      editor.view.focus()
      editor.commands.setTextSelection(at(editor, 1, 8))
      editor.commands.setHardBreak()
      typeText(editor, '::assi')
    })
    await pick(/^assignee$/)
    act(() => {
      typeText(editor, 'Ana')
    })
    expect(docTexts(editor)[1]).toBe('call mom\nassignee:: Ana')
    caretTo(editor, 0)
    await waitFor(() => {
      expect(backendProps(ids[1] as string)).toEqual({ assignee: 'Ana' })
    })
    await waitFor(() => {
      expect(backendText(ids[1] as string)).toBe('call mom')
    })
  })

  it('`{{` opens block mode’s builder, whose Save writes the query to the caret’s block', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)

    typeIn(editor, 1, 6, ' {{')
    await pick(/Insert query/)
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'save query' }))
    })
    await waitFor(() => {
      expect(backendText(ids[1] as string)).toBe('{{query tag:personal}}')
    })
    await waitFor(() => {
      expect(docTexts(editor)).toEqual(['first', '{{query tag:personal}}'])
    })
    expect(screen.queryByRole('button', { name: 'save query' })).toBeNull()
    caretTo(editor, 0)
    await waitFor(() => {
      expect(resultsIn(container, ids[1] as string)).toHaveLength(2)
    })
  })

  it('/attach opens the file dialog inside the pick, and the file chosen is attached once the block is saved', async () => {
    const { pageId } = seedPage(['first'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    act(() => {
      editor.commands.setTextSelection(at(editor, 0, 5))
    })
    press(editor, 'Enter')
    const added = blockIdOf(editor.state.doc.child(1)) as string
    // WebKit opens a file dialog only inside the key or click that asked for it,
    // so the dialog cannot wait for the save that creates the block: hold that save.
    let answer = (): void => {}
    const held = new Promise<void>((resolve) => {
      answer = resolve
    })
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'create_block') await held
      return dispatch(cmd, args)
    })
    const opened: HTMLInputElement[] = []
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement,
    ) {
      opened.push(this)
    })

    typeIn(editor, 1, 0, '/attach')
    const option = await screen.findByRole('option', { name: /ATTACH — Attach file to block/ })
    act(() => {
      fireEvent.click(option)
    })
    expect(opened.map((input) => input.type)).toEqual(['file'])
    click.mockRestore()

    const file = new File(['picked text'], 'picked.txt', { type: 'text/plain' })
    Object.defineProperty(opened[0], 'files', { value: [file] })
    act(() => {
      opened[0]?.dispatchEvent(new Event('change'))
    })
    answer()
    await waitFor(() => {
      const rows = dispatch('list_attachments', { blockId: added }) as Array<{ filename: string }>
      expect(rows.map((row) => row.filename)).toEqual(['picked.txt'])
    })
    expect(backendPage(pageId)).toEqual([
      [backendPage(pageId)[0]?.[0], 'first'],
      [added, ''],
    ])
  })

  it('a builder Save on a block gone before its save says so, as a refused one does, and the builder stays', async () => {
    const { pageId, ids } = seedPage(['first', 'second'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    typeIn(editor, 1, 6, ' {{')
    await pick(/Insert query/)
    const save = await screen.findByRole('button', { name: 'save query' })
    act(() => {
      const from = editor.state.doc.child(0).nodeSize
      editor.view.dispatch(editor.state.tr.delete(from, from + editor.state.doc.child(1).nodeSize))
    })

    await act(async () => {
      fireEvent.click(save)
    })

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('error.saveFailed'))
    })
    expect(screen.getByRole('button', { name: 'save query' })).toBeInTheDocument()
    expect(backendPage(pageId)).toEqual([[ids[0], 'first']])
  })

  it('/attach of an image attaches it and leaves the text alone, as block mode’s /attach does', async () => {
    const { pageId, ids } = seedPage(['first'])
    const { container, handle } = renderPageMode(pageId)
    const editor = await editorIn(container)
    const opened: HTMLInputElement[] = []
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement,
    ) {
      opened.push(this)
    })

    typeIn(editor, 0, 5, ' /attach')
    await pick(/ATTACH — Attach file to block/)
    click.mockRestore()
    const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' })
    Object.defineProperty(opened[0], 'files', { value: [file] })
    act(() => {
      opened[0]?.dispatchEvent(new Event('change'))
    })

    await waitFor(() => {
      expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
        t('blockTree.attachedFileMessage', { filename: 'shot.png' }),
      )
    })
    const rows = dispatch('list_attachments', { blockId: ids[0] }) as Array<{ filename: string }>
    expect(rows.map((row) => row.filename)).toEqual(['shot.png'])
    await act(async () => {
      await handle.current?.flush()
    })
    expect(docTexts(editor)).toEqual(['first '])
    expect(backendText(ids[0] as string)).toBe('first ')
  })

  it('a command after typing saves the typing first, with the editor’s own flush registered', async () => {
    const { pageId, ids } = seedPage(['first'])
    const { container } = renderPageMode(pageId)
    const editor = await editorIn(container)
    // The focus registers page mode's flush, which block mode's handlers call first.
    act(() => {
      editor.view.dom.dispatchEvent(new FocusEvent('focus'))
    })

    typeIn(editor, 0, 5, ' typed /priority')
    await pick(/PRIORITY 1/)
    await waitFor(() => {
      expect(backendRow(ids[0] as string).priority).toBe('1')
    })
    expect(backendText(ids[0] as string)).toBe('first typed ')
    await flushActiveDraft()
  })
})
