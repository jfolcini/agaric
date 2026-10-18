/**
 * A broken `[[link]]` chip in an unfocused block (#5736): clicking it writes
 * the block's content without the link through the page store's `edit`, the
 * same `edit_block` any edit writes, so page-level undo restores it, from
 * Ctrl+Z or the toast's Undo. Real `EditableBlock`, `StaticBlock` and page
 * store; the first cases stub IPC, the Undo cases run the tauri mock backend
 * and the real undo store, and read every effect back from the backend.
 */

import type { InvokeArgs } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type React from 'react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import { axe } from '@/__tests__/helpers/axe'
import { echoEditBlock, mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { EditableBlock } from '@/components/editor/EditableBlock'
import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import { t } from '@/lib/i18n'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'
import {
  createPageBlockStore,
  getPageStore,
  PageBlockContext,
  PageBlockStoreProvider,
  usePageBlockStore,
} from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'
import { useUndoStore } from '@/stores/undo'

const PAGE_ID = '01PAGE00000000000000000000'
const BLOCK_ID = '01BLOCK0000000000000000000'
const DEAD_ID = '01DEAD00000000000000000000'
const LIVE_ID = '01L1VE00000000000000000000'
const CONTENT = `see [[${DEAD_ID}]] and [[${LIVE_ID}]]`

const mockedInvoke = vi.mocked(invoke)

const rovingEditor = {
  editor: null,
  activeBlockId: null,
  mount: vi.fn(),
  unmount: vi.fn(() => null),
} as unknown as RovingEditorHandle

function renderBlock() {
  const store = createPageBlockStore(PAGE_ID)
  const block = makeBlock({ id: BLOCK_ID, parent_id: PAGE_ID, content: CONTENT })
  store.setState({ blocks: [block], blocksById: new Map([[BLOCK_ID, block]]) })
  const onNavigate = vi.fn()
  const view = render(
    <PageBlockContext.Provider value={store}>
      {/* The row around the block, with its gutter's focus target. */}
      <div data-block-id={BLOCK_ID}>
        <button type="button" data-context-trigger="true">
          grip
        </button>
        <EditableBlock
          blockId={BLOCK_ID}
          content={CONTENT}
          isFocused={false}
          rovingEditor={rovingEditor}
          onNavigate={onNavigate}
          resolveBlockTitle={(id) => (id === DEAD_ID ? '[[01DEAD00...]]' : 'Live Page')}
          resolveBlockStatus={(id) => (id === DEAD_ID ? 'deleted' : 'active')}
        />
      </div>
    </PageBlockContext.Provider>,
  )
  const content = () => store.getState().blocksById.get(BLOCK_ID)?.content
  return { ...view, content, onNavigate }
}

const brokenChip = () =>
  screen.getByRole('button', {
    name: `[[01DEAD00...]] ${t('editor.brokenLinkRemoveAction')}`,
  })

describe('EditableBlock — removing a broken link from a static block', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('writes the content without the link, says so, and keeps focus on the row', async () => {
    mockedInvoke.mockImplementation(mockInvokeCommands({ edit_block: echoEditBlock }))
    const user = userEvent.setup()
    const { content, onNavigate } = renderBlock()
    await user.click(brokenChip())
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledTimes(1)
    })
    expect(vi.mocked(toast.success).mock.calls[0]?.[0]).toBe(t('editor.brokenLinkRemoved'))
    expect(content()).toBe(`see  and [[${LIVE_ID}]]`)
    expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
      blockId: BLOCK_ID,
      toText: `see  and [[${LIVE_ID}]]`,
    })
    expect(onNavigate).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'grip' })).toHaveFocus()
  })

  it('puts the link back and claims nothing when the edit fails', async () => {
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        edit_block: () => Promise.reject(new Error('disk full')),
      }),
    )
    const user = userEvent.setup()
    const { content } = renderBlock()
    await user.click(brokenChip())
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledTimes(1)
    })
    expect(content()).toBe(CONTENT)
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('has no a11y violations', async () => {
    mockedInvoke.mockImplementation(mockInvokeCommands({}))
    const { container } = renderBlock()
    expect(screen.getAllByTestId('block-link-chip')[0]?.tagName).toBe('BUTTON')
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('EditableBlock — the removal toast’s Undo', () => {
  const { PAGE_QUICK_NOTES: PAGE, PAGE_GETTING_STARTED: TARGET } = SEED_IDS
  const { BLOCK_QN_1: QN_1, BLOCK_QN_2: QN_2 } = SEED_IDS
  const LINKED = `These notes complement the [[${TARGET}]] guide.`

  function Row(): React.ReactElement {
    const content = usePageBlockStore((s) => s.blocksById.get(QN_1)?.content ?? '')
    return (
      <EditableBlock
        blockId={QN_1}
        content={content}
        isFocused={false}
        rovingEditor={rovingEditor}
        onNavigate={vi.fn()}
        resolveBlockTitle={() => 'Moved'}
        resolveBlockStatus={(id) => (id === TARGET ? 'deleted' : 'active')}
      />
    )
  }

  /** Remove QN_1's link, after typing `typed` into the block first when given. */
  async function removeLink(typed?: string): Promise<{ label: string; onClick: () => void }> {
    render(
      <PageBlockStoreProvider pageId={PAGE}>
        <Row />
      </PageBlockStoreProvider>,
    )
    await act(() => pageStore().getState().load())
    if (typed !== undefined) await act(() => pageStore().getState().edit(QN_1, typed))
    const user = userEvent.setup()
    await user.click(
      await screen.findByRole('button', {
        name: `Moved ${t('editor.brokenLinkRemoveAction')}`,
      }),
    )
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledTimes(1)
    })
    const opts = vi.mocked(toast.success).mock.calls[0]?.[1] as {
      action: { label: string; onClick: () => void }
    }
    expect(opts.action.label).toBe(t('action.undo'))
    return opts.action
  }

  const pageStore = () => getPageStore(PAGE) as NonNullable<ReturnType<typeof getPageStore>>

  const backendContent = (id: string) =>
    (dispatch('get_block', { blockId: id }) as { content: string | null }).content

  beforeEach(async () => {
    seedBlocks()
    vi.clearAllMocks()
    useUndoStore.setState({ pages: new Map() })
    useSpaceStore.setState({ currentSpaceId: 'SPACE_PERSONAL' })
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
  })

  it('puts the link back', async () => {
    const undo = await removeLink()
    expect(backendContent(QN_1)).toBe('These notes complement the  guide.')

    undo.onClick()

    await waitFor(() => {
      expect(backendContent(QN_1)).toBe(LINKED)
    })
    expect(await screen.findByRole('button', { name: /^Moved / })).toBeInTheDocument()
  })

  it('puts back only the link, leaving what was typed into the block just before', async () => {
    const typed = `These notes typed complement the [[${TARGET}]] guide.`
    const undo = await removeLink(typed)
    expect(backendContent(QN_1)).toBe('These notes typed complement the  guide.')

    undo.onClick()

    await waitFor(() => {
      expect(backendContent(QN_1)).toBe(typed)
    })
  })

  it('reverts nothing once the page has changed after the removal', async () => {
    const undo = await removeLink()
    await act(() => pageStore().getState().edit(QN_2, 'changed later'))

    undo.onClick()

    await waitFor(() => {
      expect(vi.mocked(toast)).toHaveBeenLastCalledWith(t('editor.brokenLinkUndoStale'))
    })
    expect(backendContent(QN_1)).toBe('These notes complement the  guide.')
    expect(backendContent(QN_2)).toBe('changed later')
  })
})
