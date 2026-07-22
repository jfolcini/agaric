/**
 * #2905 — scoped batch-properties invalidation.
 *
 * `BlockTree` used to fold the app-GLOBAL `useBlockPropertyEvents` counter
 * into its `BatchPropertiesProvider` key, so a `block:properties-changed`
 * event for ONE block re-issued the `get_batch_properties` IPC for EVERY
 * mounted tree — journal week/month views mount one BlockTree per day, so a
 * single edit fanned out into 7+ concurrent refetches touching none of the
 * other trees.
 *
 * This suite mounts TWO sibling BlockTree instances (mirroring the
 * journal-view scenario) backed by separate page stores, and pins:
 *   (a) an event for a block a tree OWNS still triggers that tree's refetch;
 *   (b) an event for a block a tree does NOT own does NOT re-issue that
 *       tree's IPC — the core fix — while confirming the SIBLING tree (which
 *       does own the block) still refetches, proving the event was heard and
 *       the skip is deliberate, not accidental silence;
 *   (c) a payload-less event (bulk/unattributable change) still invalidates
 *       every tree — the safe fallback.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlock } from '@/__tests__/fixtures'
import { EVENT_PROPERTY_CHANGED } from '@/lib/block-event-names'
import { _resetPropertyChangeDispatchForTest } from '@/lib/property-change-dispatch'
import { useBlockStore } from '@/stores/blocks'
import { createPageBlockStore, PageBlockContext, type PageBlockState } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'

vi.mock('@/components/editor/SortableBlock', () => ({
  SortableBlock: (props: { blockId: string }) => (
    <div data-testid={`sortable-block-${props.blockId}`}>SortableBlock</div>
  ),
  INDENT_WIDTH: 24,
}))

vi.mock('@/editor/use-roving-editor', () => ({
  useRovingEditor: () => ({
    editor: null,
    mount: vi.fn(),
    unmount: vi.fn(() => null),
    getMarkdown: vi.fn(() => null),
    activeBlockId: null,
  }),
}))

vi.mock('@/editor/use-block-keyboard', () => ({
  useBlockKeyboard: () => {},
}))

vi.mock('@/lib/announcer', () => ({
  announce: vi.fn(),
}))

vi.mock('@/hooks/useViewportObserver', () => ({
  useViewportObserver: () => ({
    isOffscreen: () => false,
    createObserveRef: () => vi.fn(),
    getHeight: () => 40,
    subscribe: () => () => {},
    subscribeWindow: () => () => {},
    getWindowVersion: () => 0,
  }),
}))

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DragOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  closestCenter: vi.fn(),
  KeyboardSensor: vi.fn(),
  PointerSensor: vi.fn(),
  useSensor: vi.fn(),
  useSensors: vi.fn(() => []),
  MeasuringStrategy: { Always: 'always', WhileDragging: 'while-dragging' },
  useDroppable: vi.fn(() => ({ setNodeRef: vi.fn() })),
}))
vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  sortableKeyboardCoordinates: vi.fn(),
  verticalListSortingStrategy: vi.fn(),
}))

const eventListeners = new Map<string, (event: unknown) => void>()

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    async (eventName: string, handler: (event: unknown) => void): Promise<() => void> => {
      eventListeners.set(eventName, handler)
      return () => {
        eventListeners.delete(eventName)
      }
    },
  ),
}))

import { BlockTree } from '@/components/editor/BlockTree'

const mockedInvoke = vi.mocked(invoke)

/** Fire the single process-lifetime `block:properties-changed` listener
 *  directly, mirroring `useBlockPropertyEvents.test.ts`. `payload` undefined
 *  simulates a malformed/payload-less event (the bulk-change fallback). */
function firePropertyEvent(
  payload: { block_id: string; changed_keys: string[] } | undefined,
): void {
  const handler = eventListeners.get(EVENT_PROPERTY_CHANGED)
  if (!handler) throw new Error(`${EVENT_PROPERTY_CHANGED} listener was never registered`)
  handler({ payload })
}

function mockBatchProperties(): void {
  mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === 'load_page_subtree') throw new Error('test: load suppressed')
    if (cmd === 'get_batch_properties') {
      const blockIds = (args as { blockIds?: string[] } | undefined)?.blockIds ?? []
      const result: Record<string, unknown[]> = {}
      for (const id of blockIds) result[id] = []
      return result
    }
    return []
  })
}

/** Count of `get_batch_properties` IPCs whose payload includes `blockId`. */
function batchPropertiesCallsFor(blockId: string): number {
  return mockedInvoke.mock.calls.filter(([cmd, args]) => {
    if (cmd !== 'get_batch_properties') return false
    const ids = (args as { blockIds?: string[] } | undefined)?.blockIds ?? []
    return ids.includes(blockId)
  }).length
}

/** Real-time wait past `DEBOUNCE_MS` (150ms) so the scoped hook's debounce
 *  timer fires and `BatchPropertiesProvider`'s effect re-runs. */
async function flushDebounce(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 220))
  })
}

let storeA: StoreApi<PageBlockState>
let storeB: StoreApi<PageBlockState>

function renderTwoTrees() {
  return render(
    <>
      <PageBlockContext.Provider value={storeA}>
        <BlockTree autoCreateFirstBlock={false} />
      </PageBlockContext.Provider>
      <PageBlockContext.Provider value={storeB}>
        <BlockTree autoCreateFirstBlock={false} />
      </PageBlockContext.Provider>
    </>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  eventListeners.clear()
  _resetPropertyChangeDispatchForTest()
  // The scoped hook's dispatch listener only registers inside Tauri.
  ;(window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {}

  mockBatchProperties()

  storeA = createPageBlockStore('PAGE_A')
  storeA.setState({ blocks: [makeBlock({ id: 'BLK_A1', content: 'a1' })], loading: false })
  storeB = createPageBlockStore('PAGE_B')
  storeB.setState({ blocks: [makeBlock({ id: 'BLK_B1', content: 'b1' })], loading: false })

  useBlockStore.setState({ focusedBlockId: null, selectedBlockIds: [] })
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [{ id: 'SPACE_TEST', name: 'Test', accent_color: null }],
    isReady: true,
  })
})

describe('BlockTree scoped batch-properties invalidation (#2905)', () => {
  it("a property-change event for a block the tree OWNS re-issues that tree's get_batch_properties IPC", async () => {
    renderTwoTrees()
    await screen.findByTestId('sortable-block-BLK_A1')
    await waitFor(() => expect(batchPropertiesCallsFor('BLK_A1')).toBeGreaterThan(0))
    const callsBefore = batchPropertiesCallsFor('BLK_A1')

    act(() => {
      firePropertyEvent({ block_id: 'BLK_A1', changed_keys: ['todo_state'] })
    })
    await flushDebounce()

    await waitFor(() => {
      expect(batchPropertiesCallsFor('BLK_A1')).toBeGreaterThan(callsBefore)
    })
  })

  // The core fix (#2905).
  it("a property-change event for a block the tree does NOT own does not re-issue that tree's IPC", async () => {
    renderTwoTrees()
    await screen.findByTestId('sortable-block-BLK_A1')
    await screen.findByTestId('sortable-block-BLK_B1')
    await waitFor(() => expect(batchPropertiesCallsFor('BLK_A1')).toBeGreaterThan(0))
    await waitFor(() => expect(batchPropertiesCallsFor('BLK_B1')).toBeGreaterThan(0))

    const aCallsBefore = batchPropertiesCallsFor('BLK_A1')
    const bCallsBefore = batchPropertiesCallsFor('BLK_B1')

    // BLK_B1 belongs to tree B only — tree A must ignore this event.
    act(() => {
      firePropertyEvent({ block_id: 'BLK_B1', changed_keys: ['todo_state'] })
    })
    await flushDebounce()

    // Tree B (the owner) DID refetch — proves the event was actually heard
    // and dispatched, so tree A's silence below is a deliberate skip, not an
    // artifact of the event never firing.
    await waitFor(() => {
      expect(batchPropertiesCallsFor('BLK_B1')).toBeGreaterThan(bCallsBefore)
    })
    // Tree A (the non-owner) must NOT have re-issued its IPC.
    expect(batchPropertiesCallsFor('BLK_A1')).toBe(aCallsBefore)
  })

  it('a payload-less (bulk/unattributable) event still invalidates every tree — fallback', async () => {
    renderTwoTrees()
    await screen.findByTestId('sortable-block-BLK_A1')
    await screen.findByTestId('sortable-block-BLK_B1')
    await waitFor(() => expect(batchPropertiesCallsFor('BLK_A1')).toBeGreaterThan(0))
    await waitFor(() => expect(batchPropertiesCallsFor('BLK_B1')).toBeGreaterThan(0))

    const aCallsBefore = batchPropertiesCallsFor('BLK_A1')
    const bCallsBefore = batchPropertiesCallsFor('BLK_B1')

    act(() => {
      firePropertyEvent(undefined)
    })
    await flushDebounce()

    await waitFor(() => {
      expect(batchPropertiesCallsFor('BLK_A1')).toBeGreaterThan(aCallsBefore)
    })
    await waitFor(() => {
      expect(batchPropertiesCallsFor('BLK_B1')).toBeGreaterThan(bCallsBefore)
    })
  })
})
