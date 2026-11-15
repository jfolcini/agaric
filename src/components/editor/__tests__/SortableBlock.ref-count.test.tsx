/**
 * #6746 — a real block row shows how many blocks reference it, and its
 * count zooms the block, where its linked references list.
 */

import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'
import { invoke } from '@tauri-apps/api/core'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlock } from '@/__tests__/fixtures'
import { axe } from '@/__tests__/helpers/axe'
import { stubInvoke } from '@/__tests__/helpers/invoke'
import { BlockActionsProvider } from '@/components/block-tree/use-block-actions'
import { SortableBlock } from '@/components/editor/SortableBlock'
import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import { BlockRefCountsContext } from '@/hooks/useBlockRefCounts'
import { t } from '@/lib/i18n'
import { useBlockStore } from '@/stores/blocks'
import { createPageBlockStore, PageBlockContext, type PageBlockState } from '@/stores/page-blocks'

const mockedInvoke = vi.mocked(invoke)

function makeRovingEditor(): RovingEditorHandle {
  return {
    editor: null,
    mount: vi.fn(),
    unmount: vi.fn(() => null),
    activeBlockId: null,
    getMarkdown: vi.fn(() => null),
    splitAtCaret: vi.fn(() => null),
    originalMarkdown: '',
    setOnUpdate: vi.fn(),
    markCommitted: vi.fn(),
  } as unknown as RovingEditorHandle
}

let pageStore: StoreApi<PageBlockState>

const COUNTS = { QUOTED: 2 }

function Rows({ onZoomIn }: { onZoomIn: (id: string) => void }): React.ReactElement {
  return (
    <PageBlockContext.Provider value={pageStore}>
      <BlockActionsProvider value={{ onZoomIn }}>
        <BlockRefCountsContext.Provider value={COUNTS}>
          <DndContext>
            <SortableContext items={['QUOTED', 'PLAIN']}>
              {['QUOTED', 'PLAIN'].map((id) => (
                <SortableBlock
                  key={id}
                  blockId={id}
                  content={`${id} text`}
                  isFocused={false}
                  rovingEditor={makeRovingEditor()}
                />
              ))}
            </SortableContext>
          </DndContext>
        </BlockRefCountsContext.Provider>
      </BlockActionsProvider>
    </PageBlockContext.Provider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  stubInvoke(mockedInvoke, {})
  useBlockStore.setState({ focusedBlockId: null })
  pageStore = createPageBlockStore('PAGE_1')
  pageStore.setState({
    blocks: [
      makeBlock({ id: 'QUOTED', parent_id: 'PAGE_1', content: 'QUOTED text' }),
      makeBlock({ id: 'PLAIN', parent_id: 'PAGE_1', content: 'PLAIN text' }),
    ],
    loading: false,
  })
})

describe('SortableBlock reference count (#6746)', () => {
  it('a block two blocks reference shows 2; one nothing references shows nothing', () => {
    render(<Rows onZoomIn={vi.fn()} />)
    const chips = screen.getAllByTestId('ref-count-chip')
    expect(chips).toHaveLength(1)
    expect(chips[0]).toHaveTextContent('2')
    expect(chips[0]).toHaveAccessibleName(t('refCount.label', { count: 2 }))
  })

  it('activating the count zooms its own block', async () => {
    const user = userEvent.setup()
    const onZoomIn = vi.fn()
    render(<Rows onZoomIn={onZoomIn} />)
    await user.click(screen.getByTestId('ref-count-chip'))
    expect(onZoomIn).toHaveBeenCalledExactlyOnceWith('QUOTED')
  })

  it('has no a11y violations', async () => {
    const { container } = render(<Rows onZoomIn={vi.fn()} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
