/**
 * JournalPage / BlockTree integration tests — PEND-16.
 *
 * These tests intentionally exercise the REAL `BlockTree` component
 * (specifically its `autoCreateFirstBlock` effect), which is mocked
 * out in `JournalPage.test.tsx`. The race fixed by PEND-16 only
 * surfaces when both `useJournalBlockCreation.handleAddBlock` and
 * `BlockTree.autoCreateFirstBlock` are alive at the same time —
 * mocking either side hides it.
 *
 * Heavy editor / DnD dependencies (TipTap via `useRovingEditor`,
 * `@dnd-kit`, viewport observers, the SortableBlock renderer) are
 * stubbed because they have nothing to do with the auto-create race
 * and would otherwise pull in a TipTap instance per render in jsdom.
 * The `autoCreateFirstBlock` useEffect itself is untouched and runs
 * end-to-end against the mocked Tauri IPC — that is the surface under
 * test.
 *
 * This file deliberately lives next to `JournalPage.test.tsx` rather
 * than reusing it: a separate file signals "integration-level
 * regression" and avoids the `vi.unmock('@/components/editor/BlockTree')` +
 * `vi.resetModules()` mock-juggling fragility.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, waitFor } from '@testing-library/react'
import { format } from 'date-fns'
import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { emptyPage, makeBlock } from '../../__tests__/fixtures'

// ── BlockTree-internal mocks ────────────────────────────────────────
// These mirror `BlockTree.test.tsx` and stub the editor + DnD layers
// without touching BlockTree itself, so the `autoCreateFirstBlock`
// effect still runs end-to-end. We do NOT mock `../BlockTree`.

vi.mock('../../editor/use-roving-editor', () => ({
  useRovingEditor: () => ({
    editor: null,
    mount: vi.fn(),
    unmount: vi.fn(() => null),
    activeBlockId: null,
  }),
}))

vi.mock('../../editor/use-block-keyboard', () => ({
  useBlockKeyboard: () => {},
}))

vi.mock('../../hooks/useViewportObserver', () => ({
  useViewportObserver: () => ({
    isOffscreen: () => false,
    createObserveRef: () => vi.fn(),
    getHeight: () => 40,
  }),
}))

vi.mock('@/components/editor/SortableBlock', () => ({
  SortableBlock: (props: { blockId: string }) => (
    <div data-testid={`sortable-block-${props.blockId}`}>SortableBlock</div>
  ),
  INDENT_WIDTH: 24,
}))

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DragOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  closestCenter: vi.fn(),
  KeyboardSensor: vi.fn(),
  PointerSensor: vi.fn(),
  useSensor: vi.fn(),
  useSensors: vi.fn(() => []),
  MeasuringStrategy: { Always: 'always' },
  useDroppable: vi.fn(() => ({ setNodeRef: vi.fn() })),
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  sortableKeyboardCoordinates: vi.fn(),
  verticalListSortingStrategy: vi.fn(),
}))

// ── JournalPage sibling-component mocks ─────────────────────────────
// These mirror the (non-BlockTree) mocks in `JournalPage.test.tsx`. We
// deliberately do NOT import that file's setup — the mock layer is
// vitest-module-scoped and we want this file's intent ("the real
// BlockTree, please") to be self-contained.

vi.mock('@/components/agenda/DuePanel', () => ({
  DuePanel: () => <div data-testid="due-panel" />,
}))

vi.mock('@/components/agenda/DonePanel', () => ({
  DonePanel: () => <div data-testid="done-panel" />,
}))

vi.mock('@/components/backlinks/LinkedReferences', () => ({
  LinkedReferences: () => <div data-testid="linked-references" />,
}))

import { __resetCalendarPageDatesForTests } from '../../hooks/useCalendarPageDates'
import { useBlockStore } from '../../stores/blocks'
import { useJournalStore } from '../../stores/journal'
import { useSpaceStore } from '../../stores/space'
import { JournalControls, JournalPage } from '../JournalPage'

const mockedInvoke = vi.mocked(invoke)

/** Format a Date as YYYY-MM-DD (mirrors the component's formatDate). */
function formatDate(d: Date): string {
  return format(d, 'yyyy-MM-dd')
}

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = vi.fn()
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetCalendarPageDatesForTests()
  useBlockStore.setState({ focusedBlockId: null, selectedBlockIds: [] })
  useJournalStore.setState({
    mode: 'daily',
    currentDate: new Date(),
    currentDateBySpace: {},
    modeBySpace: {},
    scrollToDate: null,
    scrollToPanel: null,
  })
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [{ id: 'SPACE_TEST', name: 'Test', accent_color: null }],
    isReady: true,
  })
})

function renderJournal() {
  return render(
    <>
      <JournalControls />
      <JournalPage />
    </>,
  )
}

describe('JournalPage / BlockTree integration — auto-create race (PEND-16)', () => {
  it('creates exactly one content block when auto-creating a fresh daily page', async () => {
    const todayStr = formatDate(new Date())

    // Track every `create_block` call so we can both (a) count them and
    // (b) capture the id returned to BlockTree.autoCreateFirstBlock for
    // the focus assertion below.
    const createdBlockIds: string[] = []
    let counter = 0

    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      // BUG-48: the auto-create probe and calendar fetch route through
      // these new commands now. Default both to "no page exists" so the
      // hook progresses to creating the daily page.
      if (cmd === 'get_journal_page_by_date') return null
      if (cmd === 'list_journal_pages_in_range') return []
      if (cmd === 'create_page_in_space') return 'DP_NEW'
      if (cmd === 'create_block') {
        const params = args as { blockType?: string; content?: string; parentId?: string }
        // Use distinct ids so a duplicate fire is observable in the
        // failing assertion message rather than masquerading as a
        // single call returning the same row twice.
        const id = `BLK_NEW_${counter++}`
        createdBlockIds.push(id)
        return makeBlock({
          id,
          block_type: params.blockType ?? 'content',
          content: params.content ?? '',
          parent_id: params.parentId ?? 'DP_NEW',
        })
      }
      // `get_properties` returns a flat array (not a paginated page);
      // returning emptyPage here would break callers that
      // `.find(...)` / `.filter(...)` on the result.
      if (cmd === 'get_properties') return []
      // `get_batch_properties` returns a `Record<blockId, PropertyRow[]>`
      // — give it an empty record so BlockTree's `useBlockPropertiesBatch`
      // doesn't log "Cannot read properties of null (reading 'filter')".
      if (cmd === 'get_batch_properties') return {}
      // Catch-all empty pagination response covers `list_blocks`,
      // `query_by_property`, and the various agenda/source counters
      // JournalPage fires on mount.
      return emptyPage
    })

    renderJournal()

    // Wait for `useJournalAutoCreate` to have routed through
    // `handleAddBlock` and produced the new daily page.
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('create_page_in_space', {
        parentId: null,
        content: todayStr,
        spaceId: 'SPACE_TEST',
      })
    })

    // Flush all pending microtasks so both auto-creators
    // (useJournalBlockCreation + BlockTree.autoCreateFirstBlock) have
    // had a chance to settle. Two ticks: one for the page-create
    // promise chain, one for the BlockTree mount + create_block
    // promise chain that runs after the React re-render triggered by
    // `setCreatedPages`.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    // The whole point of PEND-16: exactly ONE create_block call.
    // Before the fix this received 2 (one from the no-template
    // fallback in `useJournalBlockCreation.handleAddBlock`, one from
    // `BlockTree.autoCreateFirstBlock` racing it).
    const createBlockCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'create_block')
    expect(createBlockCalls).toHaveLength(1)

    // The single `create_block` must have been parented to the new
    // daily page — this guards against a future regression where the
    // surviving auto-creator targets the wrong parent.
    expect(createBlockCalls[0]?.[1]).toMatchObject({ parentId: 'DP_NEW' })

    // Focus lands on the block created by the surviving auto-creator
    // (BlockTree.autoCreateFirstBlock under Option 1a).
    expect(createdBlockIds).toHaveLength(1)
    expect(useBlockStore.getState().focusedBlockId).toBe(createdBlockIds[0])
  })

  // Required by `src/__tests__/AGENTS.md` — every component test file
  // under `src/components/__tests__/` ships at least one axe audit.
  // The auto-create flow above is the same render path; we simply
  // re-render and snapshot accessibility once both auto-creators have
  // settled to the post-fix state.
  it('has no a11y violations after the auto-create race settles', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      // BUG-48: see sibling test for rationale.
      if (cmd === 'get_journal_page_by_date') return null
      if (cmd === 'list_journal_pages_in_range') return []
      if (cmd === 'create_page_in_space') return 'DP_NEW'
      if (cmd === 'create_block') {
        return makeBlock({ id: 'BLK_A11Y', block_type: 'content', parent_id: 'DP_NEW' })
      }
      if (cmd === 'get_properties') return []
      if (cmd === 'get_batch_properties') return {}
      return emptyPage
    })

    const { container } = renderJournal()

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('create_page_in_space', expect.any(Object))
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
