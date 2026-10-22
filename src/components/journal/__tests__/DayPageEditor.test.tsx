/**
 * DayPageEditor (#5691): the daily view's day page opens in page mode where a
 * page view would (the setting or the switch, a desktop pointer, within the
 * cap), else in block mode with its Add block button; Ctrl+E switches it; and
 * a link into the day lands in either mode.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Ref } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/editor/BlockTree', () => ({
  BlockTree: (props: { parentId: string; autoCreateFirstBlock?: boolean }) => (
    <div
      data-testid="block-tree"
      data-parent-id={props.parentId}
      data-auto-create={String(!!props.autoCreateFirstBlock)}
    />
  ),
}))

// Page mode's slot: the editor itself is tested on its own.
const pageModeFlush = vi.fn(() => Promise.resolve(true))
const pageModeCursor = vi.fn((): { blockId: string; pos: number } | null => null)
vi.mock('@/editor/page-mode/PageModeSlot', async () => {
  const { useImperativeHandle } = await import('react')
  return {
    PageModeSlot: (props: {
      pageId: string
      editorRef: Ref<{
        flush: () => Promise<boolean>
        cursor: () => { blockId: string; pos: number } | null
      }>
      opening: { cursor: { blockId: string } | null } | null
    }) => {
      useImperativeHandle(
        props.editorRef,
        () => ({ flush: pageModeFlush, cursor: pageModeCursor }),
        [],
      )
      return (
        <div
          data-testid="page-mode"
          data-page-id={props.pageId}
          data-cursor={props.opening?.cursor?.blockId ?? ''}
        />
      )
    },
  }
})

import { makeBlock } from '@/__tests__/fixtures'
import { axe } from '@/__tests__/helpers/axe'
import type { TypedInvokeHandlers } from '@/__tests__/helpers/invoke'
import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { DayPageEditor } from '@/components/journal/DayPageEditor'
import { PAGE_MODE_BLOCK_CAP } from '@/editor/page-mode/page-mode-fit'
import { t } from '@/lib/i18n'
import { PREFERENCES, removePreference, writePreference } from '@/lib/preferences'
import { useBlockStore } from '@/stores/blocks'
import { useNavigationStore } from '@/stores/navigation'
import { getPageStore, PageBlockStoreProvider } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'

const DAY = 'PAGE_DAY'

function stubInvoke(handlers: Readonly<TypedInvokeHandlers> = {}): void {
  vi.mocked(invoke).mockImplementation(mockInvokeCommands({ ...handlers }))
}

function renderDay(onAddBlock = vi.fn()) {
  return render(
    <PageBlockStoreProvider pageId={DAY}>
      <DayPageEditor pageId={DAY} onAddBlock={onAddBlock} />
    </PageBlockStoreProvider>,
  )
}

/** The day's blocks as `load_page_subtree` answers, `count` of them. */
function dayOf(count: number) {
  return {
    blocks: Array.from({ length: count }, (_, i) =>
      makeBlock({ id: `B${i}`, content: `block ${i}`, parent_id: DAY, position: i }),
    ),
    truncated: false,
    total: count,
  }
}

/** Load the day's store, as the block tree mocked here would. */
async function loadDay(): Promise<void> {
  await act(async () => {
    await getPageStore(DAY)?.getState().load()
  })
}

const radio = (name: string) => screen.getByRole('radio', { name })
const pressCtrlE = (): void => {
  fireEvent.keyDown(document, { key: 'e', ctrlKey: true })
}

beforeEach(() => {
  vi.clearAllMocks()
  removePreference(PREFERENCES.editMode)
  pageModeCursor.mockReturnValue(null)
  pageModeFlush.mockResolvedValue(true)
  useBlockStore.setState({ focusedBlockId: null, selectedBlockIds: [] })
  useNavigationStore.setState({ selectedBlockId: null })
  useSpaceStore.setState({ currentSpaceId: 'SPACE_A' })
  stubInvoke({ load_page_subtree: () => dayOf(2) })
})

afterEach(() => removePreference(PREFERENCES.editMode))

describe('DayPageEditor', () => {
  it('with the setting on Blocks, shows the block tree, its Add block, and a switch on Blocks', () => {
    const onAddBlock = vi.fn()
    renderDay(onAddBlock)

    expect(screen.getByTestId('block-tree')).toHaveAttribute('data-auto-create', 'true')
    expect(screen.queryByTestId('page-mode')).not.toBeInTheDocument()
    expect(radio(t('pageMode.blocks'))).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('button', { name: t('action.addBlock') }))
    expect(onAddBlock).toHaveBeenCalledTimes(1)
  })

  it('with the setting on Page, opens the day in page mode, the switch on Page', () => {
    writePreference(PREFERENCES.editMode, 'page')
    renderDay()

    expect(screen.getByTestId('page-mode')).toHaveAttribute('data-page-id', DAY)
    expect(screen.queryByTestId('block-tree')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: t('action.addBlock') })).not.toBeInTheDocument()
    expect(radio(t('pageMode.page'))).toHaveAttribute('aria-checked', 'true')
  })

  it.each(['blocks', 'page'] as const)('in %s mode, its row and switch pass axe', async (mode) => {
    writePreference(PREFERENCES.editMode, mode)
    const { container } = render(
      <PageBlockStoreProvider pageId={DAY}>
        <DayPageEditor
          pageId={DAY}
          actions={<button type="button">Open</button>}
          onAddBlock={vi.fn()}
        />
      </PageBlockStoreProvider>,
    )

    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('with the setting on Page, a day over the cap stays in block mode, Page saying why', async () => {
    writePreference(PREFERENCES.editMode, 'page')
    stubInvoke({ load_page_subtree: () => dayOf(PAGE_MODE_BLOCK_CAP + 1) })
    renderDay()

    await loadDay()

    expect(screen.getByTestId('block-tree')).toBeInTheDocument()
    expect(screen.queryByTestId('page-mode')).not.toBeInTheDocument()
    expect(radio(t('pageMode.page'))).toHaveAttribute('aria-disabled', 'true')
    expect(radio(t('pageMode.page'))).toHaveAccessibleDescription(
      t('pageMode.blocked.overCap', { cap: PAGE_MODE_BLOCK_CAP, blocks: PAGE_MODE_BLOCK_CAP + 1 }),
    )
  })

  it('on touch, offers no switch and keeps the day in block mode', () => {
    writePreference(PREFERENCES.editMode, 'page')
    const matchMedia = vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query === '(pointer: coarse)',
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    )
    const touchPoints = vi.spyOn(navigator, 'maxTouchPoints', 'get').mockReturnValue(5)
    try {
      renderDay()

      expect(screen.getByTestId('block-tree')).toBeInTheDocument()
      expect(screen.queryByTestId('page-mode')).not.toBeInTheDocument()
      expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
    } finally {
      matchMedia.mockRestore()
      touchPoints.mockRestore()
    }
  })

  it('Ctrl+E opens page mode on the block being edited, and back saves first, then shows the blocks', async () => {
    const order: string[] = []
    stubInvoke({
      load_page_subtree: () => {
        order.push('load')
        return dayOf(2)
      },
    })
    pageModeFlush.mockImplementation(() => {
      order.push('flush')
      return Promise.resolve(true)
    })
    useBlockStore.setState({ focusedBlockId: 'B0' })
    renderDay()

    pressCtrlE()

    expect(screen.getByTestId('page-mode')).toHaveAttribute('data-cursor', 'B0')
    expect(useBlockStore.getState().focusedBlockId).toBeNull()
    pageModeCursor.mockReturnValue({ blockId: 'B1', pos: 2 })

    pressCtrlE()

    expect(await screen.findByTestId('block-tree')).toBeInTheDocument()
    expect(order).toEqual(['flush', 'load'])
    expect(useBlockStore.getState().focusedBlockId).toBe('B1')
  })

  describe('a link into the day', () => {
    let scrollSpy: ReturnType<typeof vi.spyOn>
    beforeEach(() => {
      scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    })
    afterEach(() => scrollSpy.mockRestore())

    it('in block mode scrolls to its block, focuses it and clears the link', async () => {
      useNavigationStore.setState({ selectedBlockId: 'B1' })
      const row = document.createElement('li')
      row.setAttribute('data-block-id', 'B1')
      document.body.append(row)
      try {
        renderDay()

        await waitFor(() => {
          expect(useNavigationStore.getState().selectedBlockId).toBeNull()
        })
        expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' })
        expect(useBlockStore.getState().focusedBlockId).toBe('B1')
      } finally {
        row.remove()
      }
    })

    it('in block mode still focuses a block not drawn yet, for the tree to take, and clears the link', async () => {
      useNavigationStore.setState({ selectedBlockId: 'B1' })
      renderDay()

      await waitFor(() => {
        expect(useNavigationStore.getState().selectedBlockId).toBeNull()
      })
      expect(scrollSpy).not.toHaveBeenCalled()
      expect(useBlockStore.getState().focusedBlockId).toBe('B1')
    })

    it('in page mode is left to page mode’s editor, which puts its cursor there', async () => {
      writePreference(PREFERENCES.editMode, 'page')
      useNavigationStore.setState({ selectedBlockId: 'B1' })
      renderDay()

      await act(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve())
          }),
      )

      expect(useNavigationStore.getState().selectedBlockId).toBe('B1')
      expect(useBlockStore.getState().focusedBlockId).toBeNull()
    })
  })
})
