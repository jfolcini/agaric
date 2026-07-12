/**
 * #2246 — real-row accessibility audit for the block tree.
 *
 * The BlockTree wiring suites (BlockTree.dnd-autoscroll / BlockTree.zoom-dnd)
 * stub `SortableBlock` to empty <div>s, so an axe audit there is tautological —
 * it never sees the row's real chrome (drag handle, task checkbox, metadata
 * row) or the rendered block content. This suite fills that gap: it renders the
 * REAL SortableBlock + EditableBlock for a non-focused row (which resolves to
 * the real StaticBlock read view — no TipTap needed), inside a real
 * DndContext / SortableContext and a real per-page store, mocking only IPC.
 */

import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'
import { invoke } from '@tauri-apps/api/core'
import { render, screen } from '@testing-library/react'
import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { StoreApi } from 'zustand'

import { makeBlock } from '@/__tests__/fixtures'
import { SortableBlock } from '@/components/editor/SortableBlock'
import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import { useBlockStore } from '@/stores/blocks'
import { createPageBlockStore, PageBlockContext, type PageBlockState } from '@/stores/page-blocks'

const mockedInvoke = vi.mocked(invoke)

/** Minimal roving-editor handle with no mounted editor (StaticBlock path). */
function makeRovingEditor(): RovingEditorHandle {
  return {
    editor: null,
    mount: vi.fn(),
    unmount: vi.fn(() => null),
    activeBlockId: null,
    getMarkdown: vi.fn(() => null),
    splitAtCaret: vi.fn(() => null),
    originalMarkdown: '',
    setOnMarkdownChange: vi.fn(),
    markCommitted: vi.fn(),
  } as unknown as RovingEditorHandle
}

let pageStore: StoreApi<PageBlockState>

function RealRow({ blockId }: { blockId: string }): React.ReactElement {
  return (
    <PageBlockContext.Provider value={pageStore}>
      <DndContext>
        <SortableContext items={[blockId]}>
          <SortableBlock
            blockId={blockId}
            content="a plain content block"
            isFocused={false}
            rovingEditor={makeRovingEditor()}
          />
        </SortableContext>
      </DndContext>
    </PageBlockContext.Provider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  // Benign IPC default — no test drives a specific backend call.
  mockedInvoke.mockResolvedValue([])
  useBlockStore.setState({ focusedBlockId: null })
  pageStore = createPageBlockStore('PAGE_1')
  pageStore.setState({
    blocks: [makeBlock({ id: 'BLK_1', parent_id: 'PAGE_1', content: 'a plain content block' })],
    loading: false,
  })
})

describe('BlockTree row a11y (#2246, real SortableBlock + EditableBlock)', () => {
  it('renders the real row read view (StaticBlock, not a stub)', () => {
    render(<RealRow blockId="BLK_1" />)
    // Real row chrome is present (proves we are auditing real markup).
    expect(screen.getByTestId('sortable-block')).toBeInTheDocument()
    expect(screen.getByText('a plain content block')).toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    const { container } = render(<RealRow blockId="BLK_1" />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
