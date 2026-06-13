import { invoke } from '@tauri-apps/api/core'
import { act, render } from '@testing-library/react'
import { createElement, type ReactElement, type ReactNode, useRef } from 'react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlock } from '../../__tests__/fixtures'
import {
  createPageBlockStore,
  type FlatBlock,
  PageBlockContext,
  type PageBlockState,
  PageBlockStoreProvider,
  pageBlockRegistry,
  usePageBlockStore,
} from '../page-blocks'
import { useSpaceStore } from '../space'

const mockedInvoke = vi.mocked(invoke)

const TEST_SPACE_ID = 'SPACE_TEST'

// --- Mock for undo store (used by notifyUndoNewAction in page-blocks.ts) ---
const mockOnNewAction = vi.fn()
const mockClearPage = vi.fn()
vi.mock('@/stores/undo', () => ({
  useUndoStore: {
    getState: () => ({
      onNewAction: mockOnNewAction,
      clearPage: mockClearPage,
    }),
  },
}))

// Mock the global block store (focus/selection) — page-blocks.ts imports it for cross-store updates
let mockGlobalBlockState = {
  focusedBlockId: null as string | null,
  selectedBlockIds: [] as string[],
}
const mockGlobalSetState = vi.fn()
// #773 — load() clears phantom focus via the store ACTION (setFocused), not
// raw setState. Mirror the real action's semantics (clearing focus also
// clears the coupled selection) so state assertions hold after the call.
const mockSetFocused = vi.fn((blockId: string | null) => {
  mockGlobalBlockState = { focusedBlockId: blockId, selectedBlockIds: [] }
})
// #798 — load() prunes remotely-deleted ids from the global selection via the
// store ACTION (setSelected). Mirror the real action so post-load assertions
// can read the pruned selection back off the mock.
const mockSetSelected = vi.fn((ids: string[]) => {
  mockGlobalBlockState = { ...mockGlobalBlockState, selectedBlockIds: ids }
})
vi.mock('@/stores/blocks', () => ({
  useBlockStore: {
    getState: () => ({
      ...mockGlobalBlockState,
      setFocused: mockSetFocused,
      setSelected: mockSetSelected,
    }),
    setState: (...args: unknown[]) => mockGlobalSetState(...args),
  },
}))

let store: StoreApi<PageBlockState>

describe('PageBlockStore', () => {
  beforeEach(() => {
    store = createPageBlockStore('PAGE_1')
    mockGlobalBlockState = { focusedBlockId: null, selectedBlockIds: [] }
    // FE-H-22 — `load()` now early-returns when `currentSpaceId` is
    // null/undefined (pre-bootstrap). Seed the space store so the
    // existing post-bootstrap load tests still drive the IPC path.
    // The pre-bootstrap no-op contract is exercised in its own test.
    useSpaceStore.setState({ currentSpaceId: TEST_SPACE_ID })
    vi.clearAllMocks()
  })

  // ---------------------------------------------------------------------------
  // load
  // ---------------------------------------------------------------------------
  describe('load', () => {
    it('fetches blocks from the backend and stores them with depth', async () => {
      const blocks = [
        makeBlock({ id: 'A', parent_id: 'PAGE_1' }),
        makeBlock({ id: 'B', parent_id: 'PAGE_1' }),
      ]
      mockedInvoke.mockResolvedValueOnce(blocks)

      await store.getState().load()

      const result = store.getState().blocks
      expect(result).toHaveLength(2)
      expect(result[0]?.id).toBe('A')
      expect(result[0]?.depth).toBe(0)
      expect(result[1]?.id).toBe('B')
      expect(store.getState().loading).toBe(false)
    })

    it('sets loading=true while the request is in flight', async () => {
      let resolvePromise!: (v: unknown) => void
      const pending = new Promise((resolve) => {
        resolvePromise = resolve
      })
      mockedInvoke.mockReturnValueOnce(pending)

      const loadPromise = store.getState().load()
      expect(store.getState().loading).toBe(true)

      resolvePromise([])
      await loadPromise

      expect(store.getState().loading).toBe(false)
    })

    it('resets loading on error without changing blocks', async () => {
      mockedInvoke.mockRejectedValueOnce(new Error('network'))

      await store.getState().load()

      expect(store.getState().loading).toBe(false)
      expect(store.getState().blocks).toEqual([])
    })

    it('passes rootBlockId through to load_page_subtree', async () => {
      const s = createPageBlockStore('PARENT_42')
      mockedInvoke.mockResolvedValue([])

      await s.getState().load()

      expect(mockedInvoke).toHaveBeenCalledWith(
        'load_page_subtree',
        expect.objectContaining({ rootBlockId: 'PARENT_42' }),
      )
    })

    it('#753 — overlapping loads of the same page: the latest-started load wins', async () => {
      const resolvers: Array<(v: unknown) => void> = []
      mockedInvoke.mockImplementation(async () => new Promise((resolve) => resolvers.push(resolve)))

      // Two loads for the SAME page overlap (e.g. a sync:complete reload
      // racing a mount load). `rootParentId` is identical for both, so
      // the old guard could never discard either.
      const load1 = store.getState().load()
      await vi.waitFor(() => expect(resolvers).toHaveLength(1))
      const load2 = store.getState().load()
      await vi.waitFor(() => expect(resolvers).toHaveLength(2))

      // The NEWER load's snapshot arrives first and commits.
      resolvers[1]?.([makeBlock({ id: 'FRESH', parent_id: 'PAGE_1' })])
      await load2
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['FRESH'])
      expect(store.getState().loading).toBe(false)

      // The STALE snapshot resolves last — last-resolve-wins would
      // clobber FRESH with STALE here. The generation guard discards it.
      resolvers[0]?.([makeBlock({ id: 'STALE', parent_id: 'PAGE_1' })])
      await load1
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['FRESH'])
      expect(store.getState().blocksById.has('STALE')).toBe(false)
      expect(store.getState().loading).toBe(false)
    })

    it('#753 — a stale FAILED load neither resets the newer load’s loading flag nor toasts', async () => {
      let rejectStale!: (e: unknown) => void
      const resolvers: Array<(v: unknown) => void> = []
      mockedInvoke
        .mockImplementationOnce(
          async () =>
            new Promise((_resolve, reject) => {
              rejectStale = reject
            }),
        )
        .mockImplementationOnce(async () => new Promise((resolve) => resolvers.push(resolve)))

      const load1 = store.getState().load()
      await vi.waitFor(() => expect(mockedInvoke).toHaveBeenCalledTimes(1))
      const load2 = store.getState().load()
      await vi.waitFor(() => expect(mockedInvoke).toHaveBeenCalledTimes(2))

      // The stale load fails while the newer one is still in flight —
      // it must not flip `loading` back to false (the newer load owns
      // the flag) and must not surface an error toast for a snapshot
      // nobody wants.
      rejectStale(new Error('stale failure'))
      await load1
      expect(store.getState().loading).toBe(true)
      expect(toast.error).not.toHaveBeenCalled()

      resolvers[0]?.([])
      await load2
      expect(store.getState().loading).toBe(false)
    })

    it('preserves focused block content during sync reload', async () => {
      // Pre-populate store with blocks (simulating user editing block A)
      const blockA = makeBlock({ id: 'A', parent_id: 'PAGE_1', content: 'user is typing here' })
      const blockB = makeBlock({ id: 'B', parent_id: 'PAGE_1', content: 'original B' })
      store.setState({ blocks: [blockA, blockB] })

      // Simulate block A being focused (user is editing it)
      mockGlobalBlockState = { focusedBlockId: 'A', selectedBlockIds: [] }

      // Backend returns different (stale) content for block A
      const backendBlocks = [
        makeBlock({ id: 'A', parent_id: 'PAGE_1', content: 'old backend content' }),
        makeBlock({ id: 'B', parent_id: 'PAGE_1', content: 'updated B from backend' }),
      ]
      mockedInvoke.mockResolvedValueOnce(backendBlocks)

      await store.getState().load()

      const result = store.getState().blocks
      // Focused block A should preserve its pre-load content
      expect(result.find((b) => b.id === 'A')?.content).toBe('user is typing here')
      // Non-focused block B should be updated from backend
      expect(result.find((b) => b.id === 'B')?.content).toBe('updated B from backend')
    })

    it('updates non-focused blocks from backend during sync reload', async () => {
      const blockA = makeBlock({ id: 'A', parent_id: 'PAGE_1', content: 'old A' })
      const blockB = makeBlock({ id: 'B', parent_id: 'PAGE_1', content: 'old B' })
      const blockC = makeBlock({ id: 'C', parent_id: 'PAGE_1', content: 'old C' })
      store.setState({ blocks: [blockA, blockB, blockC] })

      // Only block B is focused
      mockGlobalBlockState = { focusedBlockId: 'B', selectedBlockIds: [] }

      const backendBlocks = [
        makeBlock({ id: 'A', parent_id: 'PAGE_1', content: 'new A from backend' }),
        makeBlock({ id: 'B', parent_id: 'PAGE_1', content: 'new B from backend' }),
        makeBlock({ id: 'C', parent_id: 'PAGE_1', content: 'new C from backend' }),
      ]
      mockedInvoke.mockResolvedValueOnce(backendBlocks)

      await store.getState().load()

      const result = store.getState().blocks
      // Non-focused blocks A and C should be updated
      expect(result.find((b) => b.id === 'A')?.content).toBe('new A from backend')
      expect(result.find((b) => b.id === 'C')?.content).toBe('new C from backend')
      // Focused block B should preserve its pre-load content
      expect(result.find((b) => b.id === 'B')?.content).toBe('old B')
    })

    it('updates all blocks when no block is focused (normal reload)', async () => {
      const blockA = makeBlock({ id: 'A', parent_id: 'PAGE_1', content: 'old A' })
      const blockB = makeBlock({ id: 'B', parent_id: 'PAGE_1', content: 'old B' })
      store.setState({ blocks: [blockA, blockB] })

      // No block is focused
      mockGlobalBlockState = { focusedBlockId: null, selectedBlockIds: [] }

      const backendBlocks = [
        makeBlock({ id: 'A', parent_id: 'PAGE_1', content: 'new A from backend' }),
        makeBlock({ id: 'B', parent_id: 'PAGE_1', content: 'new B from backend' }),
      ]
      mockedInvoke.mockResolvedValueOnce(backendBlocks)

      await store.getState().load()

      const result = store.getState().blocks
      // All blocks should be updated from backend
      expect(result.find((b) => b.id === 'A')?.content).toBe('new A from backend')
      expect(result.find((b) => b.id === 'B')?.content).toBe('new B from backend')
    })

    it('FE-H-22 — skips IPC entirely when currentSpaceId is null (pre-bootstrap)', async () => {
      // Pre-bootstrap state: the space store has not hydrated yet.
      // Earlier code would forward `?? ''` to the page-load IPC and
      // rely on the backend treating `''` as a no-match SQL filter.
      // We now fail closed: no IPC, no state change.  The page stays
      // in its initial `loading: true` slot until the space hydrates
      // and load() is re-invoked.
      useSpaceStore.setState({ currentSpaceId: null })
      const blocksBefore = store.getState().blocks
      const loadingBefore = store.getState().loading

      await store.getState().load()

      expect(mockedInvoke).not.toHaveBeenCalled()
      expect(store.getState().blocks).toBe(blocksBefore)
      expect(store.getState().loading).toBe(loadingBefore)
    })

    // ── #773 — sync-delete focus reconciliation ─────────────────────────
    it('#773 — clears global focus when a sync-delete + registry reload drops the focused block', async () => {
      // The store owns the focused block before the reload.
      store.setState({
        blocks: [
          makeBlock({ id: 'A', parent_id: 'PAGE_1', content: 'focused' }),
          makeBlock({ id: 'B', parent_id: 'PAGE_1', content: 'other' }),
        ],
      })
      mockGlobalBlockState = { focusedBlockId: 'A', selectedBlockIds: [] }

      // Registry-wide reload — exactly what useSyncEvents' sync:complete
      // handler does. The fresh backend snapshot no longer contains A
      // (a remote peer deleted it).
      pageBlockRegistry.set('PAGE_1', store)
      try {
        mockedInvoke.mockResolvedValueOnce([makeBlock({ id: 'B', parent_id: 'PAGE_1' })])
        for (const s of pageBlockRegistry.values()) {
          await s.getState().load()
        }
      } finally {
        pageBlockRegistry.delete('PAGE_1')
      }

      expect(mockSetFocused).toHaveBeenCalledWith(null)
      expect(mockGlobalBlockState.focusedBlockId).toBeNull()
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['B'])
    })

    it('#773 — retains focus when the focused block survives the reload', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', parent_id: 'PAGE_1', content: 'focused' }),
          makeBlock({ id: 'B', parent_id: 'PAGE_1', content: 'other' }),
        ],
      })
      mockGlobalBlockState = { focusedBlockId: 'A', selectedBlockIds: [] }

      mockedInvoke.mockResolvedValueOnce([
        makeBlock({ id: 'A', parent_id: 'PAGE_1', content: 'from backend' }),
        makeBlock({ id: 'B', parent_id: 'PAGE_1', content: 'from backend' }),
      ])
      await store.getState().load()

      expect(mockSetFocused).not.toHaveBeenCalled()
      expect(mockGlobalBlockState.focusedBlockId).toBe('A')
    })

    it('#773 — does not clear focus owned by another page when THIS store reloads (no spurious clears)', async () => {
      // Focus belongs to a block on page A; this store is page B and has
      // never contained that block (e.g. ordinary navigation load, or one
      // of N journal-day trees reloading after sync). Ownership pre-check
      // fails → focus must stay untouched even though the snapshot lacks
      // the focused id.
      const pageB = createPageBlockStore('PAGE_B')
      pageB.setState({ blocks: [makeBlock({ id: 'X', parent_id: 'PAGE_B' })] })
      mockGlobalBlockState = { focusedBlockId: 'BLOCK_ON_PAGE_A', selectedBlockIds: [] }

      mockedInvoke.mockResolvedValueOnce([makeBlock({ id: 'X', parent_id: 'PAGE_B' })])
      await pageB.getState().load()

      expect(mockSetFocused).not.toHaveBeenCalled()
      expect(mockGlobalBlockState.focusedBlockId).toBe('BLOCK_ON_PAGE_A')
    })

    it('#773 — does not clear focus on a block created and focused while the load was in flight', async () => {
      // Race: a sync-triggered load() is in flight (its backend snapshot was
      // taken at query time) when the user presses Enter — createBelow's
      // optimistic splice adds block N to blocksById and focus moves to N
      // BEFORE the stale load response is processed. N is absent from the
      // snapshot because the snapshot predates it, NOT because a remote peer
      // deleted it. The clear guard must compare against the load-START
      // index, so N's mid-flight arrival cannot be mistaken for a deletion.
      store.setState({ blocks: [makeBlock({ id: 'A', parent_id: 'PAGE_1' })] })
      mockGlobalBlockState = { focusedBlockId: 'A', selectedBlockIds: [] }

      let resolveLoad!: (v: unknown) => void
      mockedInvoke.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveLoad = resolve
        }),
      )
      const loadPromise = store.getState().load()

      // Mid-flight: optimistic create lands N in the store and focus moves.
      store.setState({
        blocks: [
          makeBlock({ id: 'A', parent_id: 'PAGE_1' }),
          makeBlock({ id: 'N', parent_id: 'PAGE_1', content: 'just created' }),
        ],
      })
      mockGlobalBlockState = { focusedBlockId: 'N', selectedBlockIds: [] }

      // Stale snapshot: predates N's insert.
      resolveLoad([makeBlock({ id: 'A', parent_id: 'PAGE_1' })])
      await loadPromise

      expect(mockSetFocused).not.toHaveBeenCalled()
      expect(mockGlobalBlockState.focusedBlockId).toBe('N')
    })

    it('#773 — fresh-mount load (empty store) never clears a focus id absent from the snapshot', async () => {
      // Page-navigation case: a brand-new store loads while some focus id
      // is still set globally. The store never owned the block (blocksById
      // is empty pre-load), so it must not clear focus — that lifecycle is
      // managed elsewhere.
      const fresh = createPageBlockStore('PAGE_NAV')
      mockGlobalBlockState = { focusedBlockId: 'STALE_FOCUS', selectedBlockIds: [] }

      mockedInvoke.mockResolvedValueOnce([makeBlock({ id: 'Y', parent_id: 'PAGE_NAV' })])
      await fresh.getState().load()

      expect(mockSetFocused).not.toHaveBeenCalled()
      expect(mockGlobalBlockState.focusedBlockId).toBe('STALE_FOCUS')
    })

    // ── #798 — prune remotely-deleted ids from the selection ────────────
    it('#798 — drops a remotely-deleted block id from selectedBlockIds on reload', async () => {
      // The store owns blocks A + B before the reload; both are selected.
      store.setState({
        blocks: [
          makeBlock({ id: 'A', parent_id: 'PAGE_1' }),
          makeBlock({ id: 'B', parent_id: 'PAGE_1' }),
        ],
      })
      mockGlobalBlockState = { focusedBlockId: null, selectedBlockIds: ['A', 'B'] }

      // Fresh backend snapshot lost B (a remote peer deleted it).
      mockedInvoke.mockResolvedValueOnce([makeBlock({ id: 'A', parent_id: 'PAGE_1' })])
      await store.getState().load()

      // B is pruned; the surviving id A stays selected.
      expect(mockSetSelected).toHaveBeenCalledWith(['A'])
      expect(mockGlobalBlockState.selectedBlockIds).toEqual(['A'])
    })

    it('#798 — does not touch the selection when every selected id survives', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', parent_id: 'PAGE_1' }),
          makeBlock({ id: 'B', parent_id: 'PAGE_1' }),
        ],
      })
      mockGlobalBlockState = { focusedBlockId: null, selectedBlockIds: ['A', 'B'] }

      mockedInvoke.mockResolvedValueOnce([
        makeBlock({ id: 'A', parent_id: 'PAGE_1' }),
        makeBlock({ id: 'B', parent_id: 'PAGE_1' }),
      ])
      await store.getState().load()

      // No change → no setSelected call (avoids a needless selection churn).
      expect(mockSetSelected).not.toHaveBeenCalled()
      expect(mockGlobalBlockState.selectedBlockIds).toEqual(['A', 'B'])
    })

    it('#798 — preserves a selected id this store never owned (managed elsewhere)', async () => {
      // A selected id belonging to another page (this store never held it):
      // absent from the snapshot, but the load-START ownership guard means
      // its absence proves nothing here — it must survive.
      store.setState({ blocks: [makeBlock({ id: 'A', parent_id: 'PAGE_1' })] })
      mockGlobalBlockState = { focusedBlockId: null, selectedBlockIds: ['A', 'OTHER_PAGE_BLK'] }

      mockedInvoke.mockResolvedValueOnce([makeBlock({ id: 'A', parent_id: 'PAGE_1' })])
      await store.getState().load()

      // A survives (still present); OTHER_PAGE_BLK survives (never owned).
      expect(mockSetSelected).not.toHaveBeenCalled()
      expect(mockGlobalBlockState.selectedBlockIds).toEqual(['A', 'OTHER_PAGE_BLK'])
    })

    it('#798 — does not prune a block created+selected while the load was in flight', async () => {
      // Mirror of the #773 mid-flight guard for selection: a block spliced
      // in (and selected) AFTER the load started is absent from the snapshot
      // because the snapshot predates it, NOT because of a remote delete.
      store.setState({ blocks: [makeBlock({ id: 'A', parent_id: 'PAGE_1' })] })
      mockGlobalBlockState = { focusedBlockId: null, selectedBlockIds: ['A'] }

      let resolveLoad!: (v: unknown) => void
      mockedInvoke.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveLoad = resolve
        }),
      )
      const loadPromise = store.getState().load()

      // Mid-flight: optimistic create lands N and selects it.
      store.setState({
        blocks: [
          makeBlock({ id: 'A', parent_id: 'PAGE_1' }),
          makeBlock({ id: 'N', parent_id: 'PAGE_1' }),
        ],
      })
      mockGlobalBlockState = { focusedBlockId: null, selectedBlockIds: ['A', 'N'] }

      // Snapshot predates N.
      resolveLoad([makeBlock({ id: 'A', parent_id: 'PAGE_1' })])
      await loadPromise

      // N must NOT be pruned (load-START guard); A survives → no change.
      expect(mockSetSelected).not.toHaveBeenCalled()
      expect(mockGlobalBlockState.selectedBlockIds).toEqual(['A', 'N'])
    })
  })

  // ---------------------------------------------------------------------------
  // createBelow
  // ---------------------------------------------------------------------------
  describe('createBelow', () => {
    it('inserts a new block after the specified block', async () => {
      const blockA = makeBlock({ id: 'A', position: 0 })
      const blockB = makeBlock({ id: 'B', position: 1 })
      store.setState({ blocks: [blockA, blockB] })

      mockedInvoke.mockResolvedValueOnce({
        id: 'NEW',
        block_type: 'text',
        content: 'new content',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })

      const newId = await store.getState().createBelow('A', 'new content')

      expect(newId).toBe('NEW')
      const blocks = store.getState().blocks
      expect(blocks).toHaveLength(3)
      expect(blocks[0]?.id).toBe('A')
      expect(blocks[1]?.id).toBe('NEW')
      expect(blocks[1]?.content).toBe('new content')
      expect(blocks[2]?.id).toBe('B')
    })

    it('returns null when afterBlockId is not found', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A' })] })

      const result = await store.getState().createBelow('NONEXISTENT')

      expect(result).toBeNull()
      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('returns null on backend error (state unchanged)', async () => {
      const block = makeBlock({ id: 'A' })
      store.setState({ blocks: [block] })
      mockedInvoke.mockRejectedValueOnce(new Error('create failed'))

      const result = await store.getState().createBelow('A')

      expect(result).toBeNull()
      expect(store.getState().blocks).toHaveLength(1)
    })

    it('inherits parent_id from the afterBlock', async () => {
      const block = makeBlock({ id: 'A', parent_id: 'PARENT', position: 3 })
      store.setState({ blocks: [block] })

      mockedInvoke.mockResolvedValueOnce({
        id: 'NEW',
        block_type: 'text',
        content: '',
        parent_id: 'PARENT',
        position: 4,
        deleted_at: null,
      })

      await store.getState().createBelow('A')

      expect(mockedInvoke).toHaveBeenCalledWith(
        'create_block',
        expect.objectContaining({
          parentId: 'PARENT',
          // #400: index = afterBlock's 0-based sibling slot (0) + 1.
          index: 1,
        }),
      )
    })

    it('defaults content to empty string', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A', position: 0 })] })

      mockedInvoke.mockResolvedValueOnce({
        id: 'NEW',
        block_type: 'text',
        content: '',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })

      await store.getState().createBelow('A')

      expect(mockedInvoke).toHaveBeenCalledWith(
        'create_block',
        expect.objectContaining({ content: '' }),
      )
    })
  })

  // ---------------------------------------------------------------------------
  // edit
  // ---------------------------------------------------------------------------
  describe('edit', () => {
    it('updates block content locally after successful backend call', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A', content: 'old' })],
      })
      mockedInvoke.mockResolvedValueOnce({
        id: 'A',
        block_type: 'text',
        content: 'new',
        parent_id: null,
        position: 0,
        deleted_at: null,
      })

      const ok = await store.getState().edit('A', 'new')

      expect(ok).toBe(true)
      expect(store.getState().blocks[0]?.content).toBe('new')
      expect(mockedInvoke).toHaveBeenCalledWith('edit_block', { blockId: 'A', toText: 'new' })
    })

    it('#753 — adopts the backend-normalized content echo on success', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A', content: 'old' })],
      })
      // The backend echoes a NORMALIZED version of the text we sent.
      mockedInvoke.mockResolvedValueOnce({
        id: 'A',
        block_type: 'text',
        content: 'raw text (normalized)',
        parent_id: null,
        position: 0,
        deleted_at: null,
      })

      const ok = await store.getState().edit('A', 'raw text')

      expect(ok).toBe(true)
      // Store mirrors the canonical backend row, not the raw optimistic text.
      expect(store.getState().blocks[0]?.content).toBe('raw text (normalized)')
      expect(store.getState().blocksById.get('A')?.content).toBe('raw text (normalized)')
    })

    it('#753 — a newer in-flight local edit wins over a stale echo', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A', content: 'old' })],
      })
      mockedInvoke.mockImplementationOnce(async () => {
        // A newer optimistic edit lands while the first IPC is in flight.
        store.setState({ blocks: [makeBlock({ id: 'A', content: 'newer typed text' })] })
        return {
          id: 'A',
          block_type: 'text',
          content: 'first (normalized)',
          parent_id: null,
          position: 0,
          deleted_at: null,
        }
      })

      const ok = await store.getState().edit('A', 'first')

      expect(ok).toBe(true)
      // The echo belongs to the SUPERSEDED edit — adopting it would
      // clobber what the user typed afterwards.
      expect(store.getState().blocks[0]?.content).toBe('newer typed text')
      expect(store.getState().blocksById.get('A')?.content).toBe('newer typed text')
    })

    it('#824 — a rejected edit does NOT roll back over newer typed text', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A', content: 'old' })],
      })
      mockedInvoke.mockImplementationOnce(async () => {
        // The user keeps typing while edit('A', 'new') is in flight — a newer
        // optimistic edit lands before this IPC rejects.
        store.setState({ blocks: [makeBlock({ id: 'A', content: 'newer typed text' })] })
        throw new Error('edit failed')
      })

      const ok = await store.getState().edit('A', 'new')

      expect(ok).toBe(false)
      // Rolling back to 'old' would clobber the newer text the user typed
      // after this edit was dispatched — the guard must leave it intact.
      expect(store.getState().blocks[0]?.content).toBe('newer typed text')
      expect(store.getState().blocksById.get('A')?.content).toBe('newer typed text')
      // Failure is still surfaced.
      expect(toast.error).toHaveBeenCalledWith('Failed to save')
    })

    it('rolls back optimistic content and resolves false on backend error', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A', content: 'old' })],
      })
      mockedInvoke.mockRejectedValueOnce(new Error('edit failed'))

      const ok = await store.getState().edit('A', 'new')

      expect(ok).toBe(false)
      expect(store.getState().blocks[0]?.content).toBe('old')
    })

    it('shows toast.error on backend failure', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A', content: 'old' })],
      })
      mockedInvoke.mockRejectedValueOnce(new Error('edit failed'))

      await store.getState().edit('A', 'new')

      expect(toast.error).toHaveBeenCalledWith('Failed to save')
    })

    it('does not crash when editing a block that does not exist in the store', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A', content: 'aaa' })] })
      mockedInvoke.mockRejectedValueOnce(new Error('not found'))

      await store.getState().edit('NONEXISTENT', 'whatever')

      // Store is unchanged — no crash
      expect(store.getState().blocks).toHaveLength(1)
      expect(store.getState().blocks[0]?.content).toBe('aaa')
    })

    it('only updates the target block, leaving others unchanged', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A', content: 'aaa' }), makeBlock({ id: 'B', content: 'bbb' })],
      })
      mockedInvoke.mockResolvedValueOnce({})

      await store.getState().edit('A', 'aaa-updated')

      expect(store.getState().blocks[0]?.content).toBe('aaa-updated')
      expect(store.getState().blocks[1]?.content).toBe('bbb')
    })

    it('notifies undo with the original rootParentId even if it changes during await', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A', content: 'old' })],
      })
      mockedInvoke.mockImplementation(async () => {
        // Simulate rootParentId change during IPC
        store.setState({ rootParentId: 'PAGE_2' })
        return {}
      })

      await store.getState().edit('A', 'new')

      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1')
    })
  })

  // ---------------------------------------------------------------------------
  // remove
  // ---------------------------------------------------------------------------
  describe('remove', () => {
    it('removes the block from local state on success', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A' }), makeBlock({ id: 'B' })],
      })
      mockedInvoke.mockResolvedValueOnce({
        block_id: 'A',
        deleted_at: '2025-01-01T00:00:00Z',
        descendants_affected: 0,
      })

      await store.getState().remove('A')

      const blocks = store.getState().blocks
      expect(blocks).toHaveLength(1)
      expect(blocks[0]?.id).toBe('B')
    })

    it('does not mutate global block store focus — callers manage focus', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A' })],
      })
      mockGlobalBlockState = { focusedBlockId: 'A', selectedBlockIds: [] }
      mockedInvoke.mockResolvedValueOnce({
        block_id: 'A',
        deleted_at: '2025-01-01T00:00:00Z',
        descendants_affected: 0,
      })

      await store.getState().remove('A')

      expect(mockGlobalSetState).not.toHaveBeenCalled()
    })

    it('does not modify state on backend error', async () => {
      const originalBlock = makeBlock({ id: 'A' })
      store.setState({
        blocks: [originalBlock],
      })
      mockedInvoke.mockRejectedValueOnce(new Error('delete failed'))

      await store.getState().remove('A')

      expect(store.getState().blocks).toHaveLength(1)
      expect(store.getState().blocks[0]).toEqual(originalBlock)
    })

    it('does not mutate global block store selection — callers manage selection', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', content: 'alpha', position: 0 }),
          makeBlock({ id: 'B', content: 'beta', position: 1 }),
        ],
      })
      mockGlobalBlockState = { focusedBlockId: null, selectedBlockIds: ['A', 'B'] }
      mockedInvoke.mockResolvedValueOnce({
        block_id: 'A',
        deleted_at: '2025-01-01T00:00:00Z',
        descendants_affected: 0,
      })

      await store.getState().remove('A')

      expect(mockGlobalSetState).not.toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------
  // splitBlock
  // ---------------------------------------------------------------------------
  describe('splitBlock', () => {
    it('does nothing for single-line content', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A' })] })

      await store.getState().splitBlock('A', 'no newlines')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('edits first line and creates new blocks for remaining lines', async () => {
      const block = makeBlock({ id: 'A', position: 0, content: '' })
      store.setState({ blocks: [block] })

      // edit('A', 'line1') → invoke('edit_block', ...)
      mockedInvoke.mockResolvedValueOnce({
        id: 'A',
        block_type: 'text',
        content: 'line1',
        parent_id: null,
        position: 0,
        deleted_at: null,
      })
      // createBelow('A', 'line2') → invoke('create_block', ...)
      mockedInvoke.mockResolvedValueOnce({
        id: 'B',
        block_type: 'text',
        content: 'line2',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })
      // createBelow('B', 'line3') → invoke('create_block', ...)
      mockedInvoke.mockResolvedValueOnce({
        id: 'C',
        block_type: 'text',
        content: 'line3',
        parent_id: null,
        position: 2,
        deleted_at: null,
      })

      await store.getState().splitBlock('A', 'line1\nline2\nline3')

      const blocks = store.getState().blocks
      expect(blocks).toHaveLength(3)
      expect(blocks[0]?.content).toBe('line1')
      expect(blocks[1]?.content).toBe('line2')
      expect(blocks[2]?.content).toBe('line3')
    })

    it('handles empty first line in split — filters empty paragraphs', async () => {
      const block = makeBlock({ id: 'A', position: 0, content: '' })
      store.setState({ blocks: [block] })

      // Empty paragraph filtered → only 'text' remains → single block, just edit
      mockedInvoke.mockResolvedValueOnce({
        id: 'A',
        block_type: 'text',
        content: 'text',
        parent_id: null,
        position: 0,
        deleted_at: null,
      })

      await store.getState().splitBlock('A', '\ntext')

      const blocks = store.getState().blocks
      expect(blocks).toHaveLength(1)
      expect(blocks[0]?.content).toBe('text')
    })

    it('chains createBelow sequentially using previous new id', async () => {
      const block = makeBlock({ id: 'A', position: 0 })
      store.setState({ blocks: [block] })

      // edit
      mockedInvoke.mockResolvedValueOnce({
        id: 'A',
        block_type: 'text',
        content: 'a',
        parent_id: null,
        position: 0,
        deleted_at: null,
      })
      // createBelow('A', 'b') → returns 'B'
      mockedInvoke.mockResolvedValueOnce({
        id: 'B',
        block_type: 'text',
        content: 'b',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })
      // createBelow('B', 'c') — note: must use B as the afterBlockId
      mockedInvoke.mockResolvedValueOnce({
        id: 'C',
        block_type: 'text',
        content: 'c',
        parent_id: null,
        position: 2,
        deleted_at: null,
      })

      await store.getState().splitBlock('A', 'a\nb\nc')

      // Verify the third invoke used position based on B's position
      expect(mockedInvoke).toHaveBeenCalledTimes(3)
      const blocks = store.getState().blocks
      expect(blocks.map((b) => b.id)).toEqual(['A', 'B', 'C'])
    })

    it('splits heading + paragraph into two blocks', async () => {
      const block = makeBlock({ id: 'A', position: 0 })
      store.setState({ blocks: [block] })

      // edit('A', '# Title') — first block is heading
      mockedInvoke.mockResolvedValueOnce({
        id: 'A',
        block_type: 'text',
        content: '# Title',
        parent_id: null,
        position: 0,
        deleted_at: null,
      })
      // createBelow('A', 'Paragraph') — second block is paragraph
      mockedInvoke.mockResolvedValueOnce({
        id: 'B',
        block_type: 'text',
        content: 'Paragraph',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })

      await store.getState().splitBlock('A', '# Title\nParagraph')

      const blocks = store.getState().blocks
      expect(blocks).toHaveLength(2)
      expect(blocks[0]?.content).toBe('# Title')
      expect(blocks[1]?.content).toBe('Paragraph')
    })

    it('does NOT split single code block (multi-line content is one block)', async () => {
      const codeContent = '```\ncode line 1\ncode line 2\n```'
      const block = makeBlock({ id: 'A', position: 0, content: codeContent })
      store.setState({ blocks: [block] })

      // Single code block → blockCount = 1, serialized matches input → no edit, no split
      await store.getState().splitBlock('A', codeContent)

      const blocks = store.getState().blocks
      expect(blocks).toHaveLength(1)
      expect(blocks[0]?.content).toBe(codeContent)
    })

    it('does NOT split single heading (single block)', async () => {
      const block = makeBlock({ id: 'A', position: 0, content: '' })
      store.setState({ blocks: [block] })

      await store.getState().splitBlock('A', '## Just a heading')

      // Single heading → blockCount = 1 → no split, no edit needed since content unchanged
      const blocks = store.getState().blocks
      expect(blocks).toHaveLength(1)
    })

    it('filters empty paragraphs between content blocks', async () => {
      const block = makeBlock({ id: 'A', position: 0 })
      store.setState({ blocks: [block] })

      // 'hello\n\nworld' → 3 parsed blocks: paragraph("hello"), empty paragraph, paragraph("world")
      // After filtering empty: 2 blocks
      mockedInvoke.mockResolvedValueOnce({
        id: 'A',
        block_type: 'text',
        content: 'hello',
        parent_id: null,
        position: 0,
        deleted_at: null,
      })
      mockedInvoke.mockResolvedValueOnce({
        id: 'B',
        block_type: 'text',
        content: 'world',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })

      await store.getState().splitBlock('A', 'hello\n\nworld')

      const blocks = store.getState().blocks
      expect(blocks).toHaveLength(2)
      expect(blocks[0]?.content).toBe('hello')
      expect(blocks[1]?.content).toBe('world')
    })

    it('rolls back on createBelow failure during splitBlock', async () => {
      const block = makeBlock({ id: 'A', position: 0, content: 'original' })
      store.setState({ blocks: [block] })

      const previousContent = store.getState().blocks[0]?.content

      // edit('A', 'line1') → invoke('edit_block', ...) — succeeds
      mockedInvoke.mockResolvedValueOnce({
        id: 'A',
        block_type: 'text',
        content: 'line1',
        parent_id: null,
        position: 0,
        deleted_at: null,
      })
      // createBelow('A', 'line2') → invoke('create_block', ...) — rejects
      mockedInvoke.mockRejectedValueOnce(new Error('create failed'))

      await store.getState().splitBlock('A', 'line1\nline2')

      // Original block should revert to its original content after the failed createBelow
      expect(store.getState().blocks[0]?.content).toBe(previousContent)
    })

    it('rejects a second concurrent splitBlock on the same block (re-entrancy guard)', async () => {
      const block = makeBlock({ id: 'A', position: 0, content: '' })
      store.setState({ blocks: [block] })

      // Mocks for the first (and only) splitBlock that executes:
      // edit_block for 'line1'
      mockedInvoke.mockResolvedValueOnce({
        id: 'A',
        block_type: 'text',
        content: 'line1',
        parent_id: null,
        position: 0,
        deleted_at: null,
      })
      // create_block for 'line2'
      mockedInvoke.mockResolvedValueOnce({
        id: 'B',
        block_type: 'text',
        content: 'line2',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })

      // Fire two splitBlocks simultaneously on the same block
      await Promise.all([
        store.getState().splitBlock('A', 'line1\nline2'),
        store.getState().splitBlock('A', 'line1\nline2'),
      ])

      // Only the first splitBlock should have made backend calls (edit + create = 2)
      expect(mockedInvoke).toHaveBeenCalledTimes(2)

      const blocks = store.getState().blocks
      expect(blocks).toHaveLength(2)
      expect(blocks[0]?.content).toBe('line1')
      expect(blocks[1]?.content).toBe('line2')
    })

    it('clears re-entrancy guard after completion — next splitBlock works', async () => {
      const block = makeBlock({ id: 'A', position: 0, content: '' })
      store.setState({ blocks: [block] })

      // First splitBlock on block A
      mockedInvoke.mockResolvedValueOnce({
        id: 'A',
        block_type: 'text',
        content: 'line1',
        parent_id: null,
        position: 0,
        deleted_at: null,
      })
      mockedInvoke.mockResolvedValueOnce({
        id: 'B',
        block_type: 'text',
        content: 'line2',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })

      await store.getState().splitBlock('A', 'line1\nline2')
      expect(mockedInvoke).toHaveBeenCalledTimes(2)

      // Second splitBlock on same block A — should work (guard cleared)
      mockedInvoke.mockResolvedValueOnce({
        id: 'A',
        block_type: 'text',
        content: 'x',
        parent_id: null,
        position: 0,
        deleted_at: null,
      })
      mockedInvoke.mockResolvedValueOnce({
        id: 'C',
        block_type: 'text',
        content: 'y',
        parent_id: null,
        position: 2,
        deleted_at: null,
      })

      await store.getState().splitBlock('A', 'x\ny')
      expect(mockedInvoke).toHaveBeenCalledTimes(4)
    })

    it('#730 — aborts (no duplicate creates) when the FIRST edit fails', async () => {
      // Pasting multi-line content: if the first-line edit() fails, the old
      // code STILL created every plan.rest line below the reverted original —
      // duplicating the pasted content. The fix branches on edit()'s boolean.
      const block = makeBlock({ id: 'A', position: 0, content: 'original' })
      store.setState({ blocks: [block] })

      // edit('A', 'line1') → editBlock IPC rejects (edit() resolves false and
      // rolls its optimistic update back internally).
      mockedInvoke.mockRejectedValueOnce(new Error('edit failed'))

      await store.getState().splitBlock('A', 'line1\nline2\nline3')

      // Only the failed edit_block IPC fired — NO create_block for line2/line3.
      expect(mockedInvoke).toHaveBeenCalledTimes(1)
      const blocks = store.getState().blocks
      // No new blocks; original is restored by edit()'s rollback (not split).
      expect(blocks).toHaveLength(1)
      expect(blocks[0]?.content).toBe('original')
    })
  })

  // ---------------------------------------------------------------------------
  // #730 — pool_busy retry wiring on block mutations
  // ---------------------------------------------------------------------------
  describe('pool_busy retry (#730)', () => {
    it('edit retries a transient pool_busy blip and commits without reverting', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A', content: 'old' })] })

      // First editBlock attempt rejects with pool_busy; the shared
      // retryOnPoolBusy helper retries and the second attempt succeeds.
      mockedInvoke
        .mockRejectedValueOnce({ kind: 'pool_busy', message: 'pool exhausted' })
        .mockResolvedValueOnce({
          id: 'A',
          block_type: 'text',
          content: 'new',
          parent_id: null,
          position: 0,
          deleted_at: null,
        })

      const ok = await store.getState().edit('A', 'new')

      expect(ok).toBe(true)
      // Two edit_block IPC attempts (the blip + the retry success).
      expect(mockedInvoke).toHaveBeenCalledTimes(2)
      // The optimistic edit survives — not reverted to 'old'.
      expect(store.getState().blocks[0]?.content).toBe('new')
      // No save-failed toast for a recovered blip.
      expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
    })

    it('moveUp retries a transient pool_busy blip before reporting failure', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      mockedInvoke
        .mockRejectedValueOnce({ kind: 'pool_busy', message: 'pool exhausted' })
        .mockResolvedValueOnce({ block_id: 'B', new_parent_id: null, new_position: 0 })

      const ok = await store.getState().moveUp('B')

      expect(ok).toBe(true)
      expect(mockedInvoke).toHaveBeenCalledTimes(2)
      expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
    })

    it('a non-pool_busy error is NOT retried (re-thrown immediately)', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A', content: 'old' })] })

      // A generic database error must bubble on the first attempt — the
      // retry helper only retries pool_busy.
      mockedInvoke.mockRejectedValueOnce({ kind: 'database', message: 'boom' })

      const ok = await store.getState().edit('A', 'new')

      expect(ok).toBe(false)
      // Exactly one attempt — no retry for a non-pool_busy error.
      expect(mockedInvoke).toHaveBeenCalledTimes(1)
      // Rolled back to the previous content.
      expect(store.getState().blocks[0]?.content).toBe('old')
    })
  })

  // ---------------------------------------------------------------------------
  // indent
  // ---------------------------------------------------------------------------
  describe('indent', () => {
    it('makes a block a child of its previous sibling', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'B',
        new_parent_id: 'A',
        new_position: 0,
      })

      await store.getState().indent('B')

      const moved = store.getState().blocks.find((b) => b.id === 'B')
      expect(moved?.parent_id).toBe('A')
      expect(moved?.position).toBe(1)
      expect(moved?.depth).toBe(1)
      // #400: indent appends as last child → slot = prev sibling's child count
      // (0 here, A has no children).
      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'B',
        newParentId: 'A',
        newIndex: 0,
      })
    })

    it('does nothing for the first block (idx === 0)', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A' })] })

      await store.getState().indent('A')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('#928 — does NOT indent when it would push the subtree past MAX_BLOCK_DEPTH', async () => {
      // Parent chain P0..P17 (depths 0..17), two siblings S1 & B at depth 18
      // under P17, and B has a child BC at depth 19. Indenting B under S1 would
      // put B at depth 19 and BC at depth 20 (> MAX_BLOCK_DEPTH-1=19) — reject
      // up front (no move_block IPC) instead of letting the backend bounce it.
      const chain = Array.from({ length: 18 }, (_, d) =>
        makeBlock({ id: `P${d}`, parent_id: d === 0 ? null : `P${d - 1}`, position: 0, depth: d }),
      )
      const s1 = makeBlock({ id: 'S1', parent_id: 'P17', position: 0, depth: 18 })
      const b = makeBlock({ id: 'B', parent_id: 'P17', position: 1, depth: 18 })
      const bc = makeBlock({ id: 'BC', parent_id: 'B', position: 0, depth: 19 })
      store.setState({ blocks: [...chain, s1, b, bc] })

      const ok = await store.getState().indent('B')

      expect(ok).toBe(false)
      expect(mockedInvoke).not.toHaveBeenCalledWith('move_block', expect.anything())
    })

    it('#976 f21 — surfaces a visual toast when an indent is rejected at max depth', async () => {
      // Same shape as the #928 case: indenting B under S1 would exceed the
      // depth ceiling. Sighted users previously got a silent no-op; the store
      // now emits a toast so visual + AT feedback reach parity.
      const chain = Array.from({ length: 18 }, (_, d) =>
        makeBlock({ id: `P${d}`, parent_id: d === 0 ? null : `P${d - 1}`, position: 0, depth: d }),
      )
      const s1 = makeBlock({ id: 'S1', parent_id: 'P17', position: 0, depth: 18 })
      const b = makeBlock({ id: 'B', parent_id: 'P17', position: 1, depth: 18 })
      const bc = makeBlock({ id: 'BC', parent_id: 'B', position: 0, depth: 19 })
      store.setState({ blocks: [...chain, s1, b, bc] })

      const ok = await store.getState().indent('B')

      expect(ok).toBe(false)
      expect(toast.error).toHaveBeenCalledWith('Max nesting level reached', {
        id: 'max-nesting-reached',
      })
    })

    it('#976 f21 — does NOT toast for the harmless "already outermost" no-op', async () => {
      // No previous sibling → indent is a benign no-op; it must stay silent
      // (the max-depth toast is only for the depth-ceiling rejection).
      const blockA = makeBlock({ id: 'A', parent_id: 'P', position: 0, depth: 1 })
      store.setState({ blocks: [makeBlock({ id: 'P', depth: 0 }), blockA] })

      await store.getState().indent('A')

      expect(toast.error).not.toHaveBeenCalled()
    })

    it('does nothing when block not found', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A' })] })

      await store.getState().indent('NONEXISTENT')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('does nothing when previous block has a different parent', async () => {
      const blockA = makeBlock({ id: 'A', parent_id: 'P1', depth: 0 })
      const blockB = makeBlock({ id: 'B', parent_id: 'P2', depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      await store.getState().indent('B')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('does not update state on backend error', async () => {
      const blockA = makeBlock({ id: 'A', parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      mockedInvoke.mockRejectedValueOnce(new Error('move failed'))

      await store.getState().indent('B')

      expect(store.getState().blocks.find((b) => b.id === 'B')?.parent_id).toBeNull()
    })

    it('places indented block after prevSibling existing children (while-loop)', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const childA1 = makeBlock({ id: 'A1', position: 0, parent_id: 'A', depth: 1 })
      const childA2 = makeBlock({ id: 'A2', position: 1, parent_id: 'A', depth: 1 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, childA1, childA2, blockB] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'B',
        new_parent_id: 'A',
        new_position: 0,
      })

      await store.getState().indent('B')

      const blocks = store.getState().blocks
      const bIdx = blocks.findIndex((b) => b.id === 'B')
      expect(bIdx).toBeGreaterThan(blocks.findIndex((b) => b.id === 'A2'))
      expect(blocks[bIdx]?.parent_id).toBe('A')
      expect(blocks[bIdx]?.depth).toBe(1)
    })

    it('#774 — reloads when the backend echoes a parent other than the requested prevSibling', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      // indent('B') requests parent 'A', but the backend echoes a DIFFERENT
      // parent ('UNEXPECTED'). Old indent ignored the echo entirely and
      // trusted the requested parent → silent FE/BE divergence. The fix
      // mirrors reorder/moveUp: fall back to a structural reload.
      mockedInvoke.mockResolvedValueOnce({
        block_id: 'B',
        new_parent_id: 'UNEXPECTED',
        new_position: 0,
      })
      // The reload load_page_subtree returns the authoritative tree.
      mockedInvoke.mockResolvedValueOnce([
        makeBlock({ id: 'A', parent_id: 'PAGE_1', depth: 0 }),
        makeBlock({ id: 'B', parent_id: 'UNEXPECTED', depth: 0 }),
      ])

      const ok = await store.getState().indent('B')

      expect(ok).toBe(true)
      // A second IPC (the reload) fired — the local "indent under A" splice
      // was NOT trusted.
      expect(mockedInvoke).toHaveBeenCalledTimes(2)
      expect(mockedInvoke).toHaveBeenLastCalledWith(
        'load_page_subtree',
        expect.objectContaining({ rootBlockId: 'PAGE_1' }),
      )
    })

    it('#774 — serialized double moveDown lands two slots down (queued moves do not collapse)', async () => {
      // A → B → C → D at root. Two rapid moveDown('A') presses fired before
      // the first resolves must move A two slots (past B, then past C), not
      // collapse into a single move. Serialization makes the 2nd press read
      // the post-first-move state and request the correct next slot.
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 }),
          makeBlock({ id: 'C', position: 2, parent_id: null, depth: 0 }),
          makeBlock({ id: 'D', position: 3, parent_id: null, depth: 0 }),
        ],
      })

      // First moveDown: A swaps past B → slot 1.
      mockedInvoke.mockResolvedValueOnce({ block_id: 'A', new_parent_id: null, new_position: 1 })
      // Second moveDown (computed AFTER the first commits): A swaps past C → slot 2.
      mockedInvoke.mockResolvedValueOnce({ block_id: 'A', new_parent_id: null, new_position: 2 })

      // Fire both without awaiting the first — the queue serializes them.
      const p1 = store.getState().moveDown('A')
      const p2 = store.getState().moveDown('A')
      const [r1, r2] = await Promise.all([p1, p2])

      expect(r1).toBe(true)
      expect(r2).toBe(true)
      // Two distinct backend moves — the second did NOT re-state the first's slot.
      expect(mockedInvoke).toHaveBeenCalledTimes(2)
      expect(mockedInvoke).toHaveBeenNthCalledWith(1, 'move_block', {
        blockId: 'A',
        newParentId: null,
        newIndex: 1,
      })
      expect(mockedInvoke).toHaveBeenNthCalledWith(2, 'move_block', {
        blockId: 'A',
        newParentId: null,
        newIndex: 2,
      })
      // Final order: B, C, A, D.
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['B', 'C', 'A', 'D'])
    })
  })

  // ---------------------------------------------------------------------------
  // moveToParent
  // ---------------------------------------------------------------------------
  describe('moveToParent', () => {
    it('calls moveBlock, reloads tree, and notifies undo', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      // move_block
      mockedInvoke.mockResolvedValueOnce({
        block_id: 'B',
        new_parent_id: 'A',
        new_position: 0,
      })
      // load_page_subtree (reload from load())
      mockedInvoke.mockResolvedValueOnce({
        items: [],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      await store.getState().moveToParent('B', 'A', 0)

      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'B',
        newParentId: 'A',
        newIndex: 0,
      })
      expect(mockedInvoke).toHaveBeenCalledWith(
        'load_page_subtree',
        expect.objectContaining({ rootBlockId: 'PAGE_1' }),
      )
      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1')
    })

    it('does not update blocks or notify undo on backend error', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      mockedInvoke.mockRejectedValueOnce(new Error('move failed'))

      await store.getState().moveToParent('B', 'A', 0)

      expect(store.getState().blocks).toHaveLength(2)
      expect(store.getState().blocks[0]?.id).toBe('A')
      expect(store.getState().blocks[1]?.id).toBe('B')
      expect(mockOnNewAction).not.toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------
  // moveToParent race conditions
  // ---------------------------------------------------------------------------
  describe('moveToParent race conditions', () => {
    it('notifies undo with the original rootParentId even if it changes during await', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      // Deferred promise for move_block so we can mutate state mid-flight.
      let resolveMove!: (v: unknown) => void
      const movePending = new Promise((resolve) => {
        resolveMove = resolve
      })
      mockedInvoke.mockReturnValueOnce(movePending)
      // load_page_subtree call for the load() that follows moveBlock resolve.
      mockedInvoke.mockResolvedValue({
        items: [],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      const promise = store.getState().moveToParent('B', 'A', 0)

      // Simulate the user navigating to a different page while the IPC is in flight.
      store.setState({ rootParentId: 'DIFFERENT_PAGE' })

      // Resolve the move_block IPC; load() and notifyUndoNewAction run after.
      resolveMove({ block_id: 'B', new_parent_id: 'A', new_position: 0 })
      await promise

      // The undo notification must target the ORIGINAL page, not the one the user navigated to.
      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1')
      expect(mockOnNewAction).not.toHaveBeenCalledWith('DIFFERENT_PAGE')
    })
  })

  // ---------------------------------------------------------------------------
  // stale-capture races (#714) — mutators must commit splices against the
  // state CURRENT at commit time, not a pre-IPC-await capture, so concurrent
  // writes (edit flush, sync load, queued move) survive and the
  // blocks-array / blocksById-Map invariant cannot diverge.
  // ---------------------------------------------------------------------------
  describe('stale-capture races (#714)', () => {
    /** Array/Map consistency: same length, every array entry present AND identical in the Map. */
    function expectMapMatchesArray(s: PageBlockState): void {
      expect(s.blocksById.size).toBe(s.blocks.length)
      for (const b of s.blocks) {
        expect(s.blocksById.get(b.id)).toBe(b)
      }
    }

    /** Deferred IPC: queue a promise we can resolve mid-test. */
    function deferInvoke(): (v: unknown) => void {
      let resolve!: (v: unknown) => void
      mockedInvoke.mockReturnValueOnce(
        new Promise((r) => {
          resolve = r
        }),
      )
      return resolve
    }

    it('createBelow: an edit() interleaved during the IPC survives in blocks AND blocksById', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', content: 'orig A', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'B', content: 'orig B', position: 1, parent_id: null, depth: 0 }),
        ],
      })

      const resolveCreate = deferInvoke()
      const createPromise = store.getState().createBelow('A', 'new content')

      // Interleave an edit flush while create_block is in flight.
      mockedInvoke.mockResolvedValueOnce({})
      await store.getState().edit('A', 'edited mid-flight')

      resolveCreate({
        id: 'NEW',
        block_type: 'text',
        content: 'new content',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })
      await expect(createPromise).resolves.toBe('NEW')

      const s = store.getState()
      // Structural change applied: NEW inserted right after A.
      expect(s.blocks.map((b) => b.id)).toEqual(['A', 'NEW', 'B'])
      // The interleaved write survived in BOTH the array and the Map.
      expect(s.blocks.find((b) => b.id === 'A')?.content).toBe('edited mid-flight')
      expect(s.blocksById.get('A')?.content).toBe('edited mid-flight')
      expectMapMatchesArray(s)
    })

    it('createBelow: falls back to load() when the anchor disappeared mid-flight (sync reload race)', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 }),
        ],
      })

      const resolveCreate = deferInvoke()
      const createPromise = store.getState().createBelow('A', 'x')

      // Simulate a sync:complete registry-wide load() that dropped the anchor
      // while create_block was in flight.
      store.setState({ blocks: [makeBlock({ id: 'B', position: 0, parent_id: null, depth: 0 })] })

      // The fallback load() will hit load_page_subtree — give it the backend truth.
      mockedInvoke.mockResolvedValueOnce([
        makeBlock({ id: 'B', parent_id: 'PAGE_1', position: 0 }),
        makeBlock({ id: 'NEW', parent_id: 'PAGE_1', position: 1, content: 'x' }),
      ])

      resolveCreate({
        id: 'NEW',
        block_type: 'text',
        content: 'x',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })
      await expect(createPromise).resolves.toBe('NEW')

      // No blind splice against stale state — full reload instead.
      expect(mockedInvoke).toHaveBeenCalledWith(
        'load_page_subtree',
        expect.objectContaining({ rootBlockId: 'PAGE_1' }),
      )
      const s = store.getState()
      expect(s.blocks.map((b) => b.id)).toEqual(['B', 'NEW'])
      expectMapMatchesArray(s)
    })

    it('reorder: an edit() interleaved during the IPC survives in blocks AND blocksById', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', content: 'orig A', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'B', content: 'orig B', position: 1, parent_id: null, depth: 0 }),
          makeBlock({ id: 'C', content: 'orig C', position: 2, parent_id: null, depth: 0 }),
        ],
      })

      const resolveMove = deferInvoke()
      const reorderPromise = store.getState().reorder('C', 0)

      mockedInvoke.mockResolvedValueOnce({})
      await store.getState().edit('B', 'edited mid-flight')

      resolveMove({ block_id: 'C', new_parent_id: null, new_position: 0 })
      await reorderPromise

      const s = store.getState()
      expect(s.blocks.map((b) => b.id)).toEqual(['C', 'A', 'B'])
      expect(s.blocks.find((b) => b.id === 'B')?.content).toBe('edited mid-flight')
      expect(s.blocksById.get('B')?.content).toBe('edited mid-flight')
      expectMapMatchesArray(s)
    })

    it('moveUp: an edit() interleaved during the IPC survives in blocks AND blocksById', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', content: 'orig A', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'B', content: 'orig B', position: 1, parent_id: null, depth: 0 }),
        ],
      })

      const resolveMove = deferInvoke()
      const movePromise = store.getState().moveUp('B')

      mockedInvoke.mockResolvedValueOnce({})
      await store.getState().edit('A', 'edited mid-flight')

      resolveMove({ block_id: 'B', new_parent_id: null, new_position: 0 })
      await expect(movePromise).resolves.toBe(true)

      const s = store.getState()
      expect(s.blocks.map((b) => b.id)).toEqual(['B', 'A'])
      expect(s.blocks.find((b) => b.id === 'A')?.content).toBe('edited mid-flight')
      expect(s.blocksById.get('A')?.content).toBe('edited mid-flight')
      expectMapMatchesArray(s)
    })

    it('all six mutators keep the blocks array and blocksById Map consistent', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 }),
          makeBlock({ id: 'C', position: 2, parent_id: null, depth: 0 }),
        ],
      })

      // createBelow: A,NEW,B,C
      mockedInvoke.mockResolvedValueOnce({
        id: 'NEW',
        block_type: 'text',
        content: 'x',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })
      await store.getState().createBelow('A', 'x')
      expectMapMatchesArray(store.getState())

      // reorder: C,A,NEW,B
      mockedInvoke.mockResolvedValueOnce({ block_id: 'C', new_parent_id: null, new_position: 0 })
      await store.getState().reorder('C', 0)
      expectMapMatchesArray(store.getState())
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['C', 'A', 'NEW', 'B'])

      // moveUp: C,A,B,NEW
      mockedInvoke.mockResolvedValueOnce({ block_id: 'B', new_parent_id: null, new_position: 2 })
      await store.getState().moveUp('B')
      expectMapMatchesArray(store.getState())
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['C', 'A', 'B', 'NEW'])

      // moveDown: C,B,A,NEW
      mockedInvoke.mockResolvedValueOnce({ block_id: 'A', new_parent_id: null, new_position: 2 })
      await store.getState().moveDown('A')
      expectMapMatchesArray(store.getState())
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['C', 'B', 'A', 'NEW'])

      // indent: A becomes child of B. #774 — indent now checks the backend
      // parent echo, so the mock must echo the requested parent ('B') to
      // exercise the local-splice path (an unexpected/absent parent reloads).
      mockedInvoke.mockResolvedValueOnce({ block_id: 'A', new_parent_id: 'B', new_position: 0 })
      await store.getState().indent('A')
      expectMapMatchesArray(store.getState())
      expect(store.getState().blocksById.get('A')?.parent_id).toBe('B')
      expect(store.getState().blocksById.get('A')?.depth).toBe(1)

      // dedent: A back to root, after B
      mockedInvoke.mockResolvedValueOnce({ block_id: 'A', new_parent_id: null, new_position: 2 })
      await store.getState().dedent('A')
      expectMapMatchesArray(store.getState())
      expect(store.getState().blocksById.get('A')?.parent_id).toBe(null)
      expect(store.getState().blocksById.get('A')?.depth).toBe(0)
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['C', 'B', 'A', 'NEW'])
    })

    it('createBelow: skips the splice when an interleaved load() already delivered the new block', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 }),
        ],
      })

      const resolveCreate = deferInvoke()
      const createPromise = store.getState().createBelow('A', 'x')

      // A sync:complete load() landed mid-flight whose snapshot already
      // contains the freshly created block.
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'NEW', content: 'x', position: 1, parent_id: null, depth: 0 }),
          makeBlock({ id: 'B', position: 2, parent_id: null, depth: 0 }),
        ],
      })

      resolveCreate({
        id: 'NEW',
        block_type: 'text',
        content: 'x',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })
      await expect(createPromise).resolves.toBe('NEW')

      const s = store.getState()
      // No duplicate entry, no fallback reload — state was already reconciled.
      expect(s.blocks.map((b) => b.id)).toEqual(['A', 'NEW', 'B'])
      expect(mockedInvoke).not.toHaveBeenCalledWith('load_page_subtree', expect.anything())
      expectMapMatchesArray(s)
    })

    it('createBelow: falls back to load() when the anchor was re-parented mid-flight', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 }),
        ],
      })

      const resolveCreate = deferInvoke()
      const createPromise = store.getState().createBelow('A', 'x')

      // A was re-parented under B while create_block was in flight — the new
      // block belongs under A's ORIGINAL parent, so a local splice after A's
      // new location would lie about the structure.
      store.setState({
        blocks: [
          makeBlock({ id: 'B', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'A', position: 0, parent_id: 'B', depth: 1 }),
        ],
      })
      mockedInvoke.mockResolvedValueOnce([
        makeBlock({ id: 'B', parent_id: 'PAGE_1', position: 0 }),
        makeBlock({ id: 'A', parent_id: 'B', position: 0 }),
        makeBlock({ id: 'NEW', parent_id: 'PAGE_1', position: 1, content: 'x' }),
      ])

      resolveCreate({
        id: 'NEW',
        block_type: 'text',
        content: 'x',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })
      await expect(createPromise).resolves.toBe('NEW')

      expect(mockedInvoke).toHaveBeenCalledWith(
        'load_page_subtree',
        expect.objectContaining({ rootBlockId: 'PAGE_1' }),
      )
      expectMapMatchesArray(store.getState())
    })

    it('moveUp: falls back to load() when a sibling was inserted above mid-flight (slot drift)', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 }),
          makeBlock({ id: 'C', position: 2, parent_id: null, depth: 0 }),
        ],
      })

      const resolveMove = deferInvoke()
      // moveUp(C) → backend slot 1 among the other siblings, anchored on B.
      const movePromise = store.getState().moveUp('C')

      // A sibling X appeared between A and B mid-flight: slot 1 among the
      // current others is now X, not B — backend and local interpretations
      // diverge, so the store must reload instead of splicing before B.
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'X', position: 1, parent_id: null, depth: 0 }),
          makeBlock({ id: 'B', position: 2, parent_id: null, depth: 0 }),
          makeBlock({ id: 'C', position: 3, parent_id: null, depth: 0 }),
        ],
      })
      mockedInvoke.mockResolvedValueOnce([
        makeBlock({ id: 'A', parent_id: 'PAGE_1', position: 0 }),
        makeBlock({ id: 'C', parent_id: 'PAGE_1', position: 1 }),
        makeBlock({ id: 'X', parent_id: 'PAGE_1', position: 2 }),
        makeBlock({ id: 'B', parent_id: 'PAGE_1', position: 3 }),
      ])

      resolveMove({ block_id: 'C', new_parent_id: null, new_position: 1 })
      await expect(movePromise).resolves.toBe(true)

      expect(mockedInvoke).toHaveBeenCalledWith(
        'load_page_subtree',
        expect.objectContaining({ rootBlockId: 'PAGE_1' }),
      )
      const s = store.getState()
      expect(s.blocks.map((b) => b.id)).toEqual(['A', 'C', 'X', 'B'])
      expectMapMatchesArray(s)
    })

    it('moveDown: an edit() interleaved during the IPC survives in blocks AND blocksById', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', content: 'orig A', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'B', content: 'orig B', position: 1, parent_id: null, depth: 0 }),
        ],
      })

      const resolveMove = deferInvoke()
      const movePromise = store.getState().moveDown('A')

      mockedInvoke.mockResolvedValueOnce({})
      await store.getState().edit('B', 'edited mid-flight')

      resolveMove({ block_id: 'A', new_parent_id: null, new_position: 1 })
      await expect(movePromise).resolves.toBe(true)

      const s = store.getState()
      expect(s.blocks.map((b) => b.id)).toEqual(['B', 'A'])
      expect(s.blocks.find((b) => b.id === 'B')?.content).toBe('edited mid-flight')
      expect(s.blocksById.get('B')?.content).toBe('edited mid-flight')
      expectMapMatchesArray(s)
    })

    it('indent: falls back to load() when the new parent gained a child mid-flight (slot drift)', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 }),
        ],
      })

      const resolveMove = deferInvoke()
      // indent(B) → backend appends at slot 0 under A (A had no children).
      const indentPromise = store.getState().indent('B')

      // A gained a child K mid-flight: the backend's captured append slot no
      // longer means "last child", so the local append must yield to load().
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'K', position: 0, parent_id: 'A', depth: 1 }),
          makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 }),
        ],
      })
      mockedInvoke.mockResolvedValueOnce([
        makeBlock({ id: 'A', parent_id: 'PAGE_1', position: 0 }),
        makeBlock({ id: 'B', parent_id: 'A', position: 0 }),
        makeBlock({ id: 'K', parent_id: 'A', position: 1 }),
      ])

      resolveMove(undefined)
      await expect(indentPromise).resolves.toBe(true)

      expect(mockedInvoke).toHaveBeenCalledWith(
        'load_page_subtree',
        expect.objectContaining({ rootBlockId: 'PAGE_1' }),
      )
      const s = store.getState()
      expect(s.blocksById.get('B')?.parent_id).toBe('A')
      expectMapMatchesArray(s)
    })

    it('dedent: an edit() interleaved during the IPC survives in blocks AND blocksById', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'P', content: 'orig P', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'C', content: 'orig C', position: 0, parent_id: 'P', depth: 1 }),
        ],
      })

      const resolveMove = deferInvoke()
      const dedentPromise = store.getState().dedent('C')

      mockedInvoke.mockResolvedValueOnce({})
      await store.getState().edit('P', 'edited mid-flight')

      resolveMove({ block_id: 'C', new_parent_id: null, new_position: 1 })
      await expect(dedentPromise).resolves.toBe(true)

      const s = store.getState()
      expect(s.blocks.map((b) => b.id)).toEqual(['P', 'C'])
      expect(s.blocksById.get('C')?.parent_id).toBeNull()
      expect(s.blocksById.get('C')?.depth).toBe(0)
      expect(s.blocks.find((b) => b.id === 'P')?.content).toBe('edited mid-flight')
      expect(s.blocksById.get('P')?.content).toBe('edited mid-flight')
      expectMapMatchesArray(s)
    })

    it("dedent: falls back to load() when the parent's sibling slot changed mid-flight (slot drift)", async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'P', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'C', position: 0, parent_id: 'P', depth: 1 }),
        ],
      })

      const resolveMove = deferInvoke()
      // dedent(C) → backend slot 1 under the root (right after P at slot 0).
      const dedentPromise = store.getState().dedent('C')

      // A sibling X appeared ABOVE P mid-flight: P's slot is now 1, so the
      // backend's captured slot 1 no longer means "right after P".
      store.setState({
        blocks: [
          makeBlock({ id: 'X', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'P', position: 1, parent_id: null, depth: 0 }),
          makeBlock({ id: 'C', position: 0, parent_id: 'P', depth: 1 }),
        ],
      })
      mockedInvoke.mockResolvedValueOnce([
        makeBlock({ id: 'X', parent_id: 'PAGE_1', position: 0 }),
        makeBlock({ id: 'C', parent_id: 'PAGE_1', position: 1 }),
        makeBlock({ id: 'P', parent_id: 'PAGE_1', position: 2 }),
      ])

      resolveMove({ block_id: 'C', new_parent_id: null, new_position: 1 })
      await expect(dedentPromise).resolves.toBe(true)

      expect(mockedInvoke).toHaveBeenCalledWith(
        'load_page_subtree',
        expect.objectContaining({ rootBlockId: 'PAGE_1' }),
      )
      const s = store.getState()
      expect(s.blocks.map((b) => b.id)).toEqual(['X', 'C', 'P'])
      expectMapMatchesArray(s)
    })
  })

  // ---------------------------------------------------------------------------
  // dedent
  // ---------------------------------------------------------------------------
  describe('dedent', () => {
    it('moves a block up to its grandparent', async () => {
      const parent = makeBlock({ id: 'P', parent_id: null, position: 0, depth: 0 })
      const child = makeBlock({ id: 'C', parent_id: 'P', position: 0, depth: 1 })
      store.setState({ blocks: [parent, child] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'C',
        new_parent_id: null,
        new_position: 1,
      })

      await store.getState().dedent('C')

      const moved = store.getState().blocks.find((b) => b.id === 'C')
      expect(moved?.parent_id).toBeNull()
      expect(moved?.position).toBe(1)
      expect(moved?.depth).toBe(0)
      // #400: dedent slot = parent's sibling slot (0) + 1.
      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'C',
        newParentId: null,
        newIndex: 1,
      })
    })

    it('does nothing if block is at root level', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A', parent_id: null })],
      })

      await store.getState().dedent('A')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('does nothing when block not found', async () => {
      store.setState({ blocks: [] })

      await store.getState().dedent('NONEXISTENT')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('does nothing when parent is not in the blocks array', async () => {
      const orphan = makeBlock({ id: 'A', parent_id: 'MISSING_PARENT' })
      store.setState({ blocks: [orphan] })

      await store.getState().dedent('A')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('does not update state on backend error', async () => {
      const parent = makeBlock({ id: 'P', parent_id: null, depth: 0 })
      const child = makeBlock({ id: 'C', parent_id: 'P', depth: 1 })
      store.setState({ blocks: [parent, child] })

      mockedInvoke.mockRejectedValueOnce(new Error('move failed'))

      await store.getState().dedent('C')

      expect(store.getState().blocks.find((b) => b.id === 'C')?.parent_id).toBe('P')
    })

    it('positions after parent when moving to grandparent', async () => {
      const parent = makeBlock({ id: 'P', parent_id: 'GP', position: 5, depth: 1 })
      const child = makeBlock({ id: 'C', parent_id: 'P', position: 0, depth: 2 })
      store.setState({ blocks: [parent, child] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'C',
        new_parent_id: 'GP',
        new_position: 2,
      })

      await store.getState().dedent('C')

      // #400: P is the only known child of GP → slot 0 → dedent slot 0 + 1 = 1.
      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'C',
        newParentId: 'GP',
        newIndex: 1,
      })
    })

    it('places dedented block after parent subtree with other descendants (while-loop)', async () => {
      const grandparent = makeBlock({ id: 'GP', parent_id: null, position: 0, depth: 0 })
      const parent = makeBlock({ id: 'P', parent_id: 'GP', position: 0, depth: 1 })
      const sibling = makeBlock({ id: 'S', parent_id: 'P', position: 0, depth: 2 })
      const child = makeBlock({ id: 'C', parent_id: 'P', position: 1, depth: 2 })
      const otherRoot = makeBlock({ id: 'R', parent_id: null, position: 1, depth: 0 })
      store.setState({ blocks: [grandparent, parent, sibling, child, otherRoot] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'C',
        new_parent_id: 'GP',
        new_position: 1,
      })

      await store.getState().dedent('C')

      const blocks = store.getState().blocks
      const cIdx = blocks.findIndex((b) => b.id === 'C')
      const sIdx = blocks.findIndex((b) => b.id === 'S')
      const pIdx = blocks.findIndex((b) => b.id === 'P')
      expect(cIdx).toBeGreaterThan(sIdx)
      expect(cIdx).toBeGreaterThan(pIdx)
      expect(blocks[cIdx]?.depth).toBe(1)
      expect(blocks[cIdx]?.parent_id).toBe('GP')
    })

    it('#774 — reloads when the backend echoes a parent other than the requested grandparent', async () => {
      // C under P under GP. dedent('C') requests grandparent GP, but the
      // backend echoes a DIFFERENT parent. Old dedent checked the slot but
      // never the parent echo against the REQUESTED parent — trusting the
      // local "place after parent" splice. The fix reloads on disagreement.
      const grandparent = makeBlock({ id: 'GP', parent_id: null, position: 0, depth: 0 })
      const parent = makeBlock({ id: 'P', parent_id: 'GP', position: 0, depth: 1 })
      const child = makeBlock({ id: 'C', parent_id: 'P', position: 0, depth: 2 })
      store.setState({ blocks: [grandparent, parent, child] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'C',
        new_parent_id: 'UNEXPECTED',
        new_position: 0,
      })
      mockedInvoke.mockResolvedValueOnce([
        makeBlock({ id: 'GP', parent_id: 'PAGE_1', depth: 0 }),
        makeBlock({ id: 'P', parent_id: 'GP', depth: 1 }),
        makeBlock({ id: 'C', parent_id: 'UNEXPECTED', depth: 1 }),
      ])

      const ok = await store.getState().dedent('C')

      expect(ok).toBe(true)
      expect(mockedInvoke).toHaveBeenCalledTimes(2)
      expect(mockedInvoke).toHaveBeenLastCalledWith(
        'load_page_subtree',
        expect.objectContaining({ rootBlockId: 'PAGE_1' }),
      )
    })
  })

  // ---------------------------------------------------------------------------
  // reorder
  // ---------------------------------------------------------------------------
  describe('reorder', () => {
    it('calls moveBlock and reorders the local array', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null })
      const blockC = makeBlock({ id: 'C', position: 2, parent_id: null })
      store.setState({ blocks: [blockA, blockB, blockC] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'C',
        new_parent_id: null,
        new_position: 0,
      })

      await store.getState().reorder('C', 0)

      expect(mockedInvoke).toHaveBeenCalledWith(
        'move_block',
        expect.objectContaining({ blockId: 'C', newParentId: null }),
      )
      const blocks = store.getState().blocks
      expect(blocks[0]?.id).toBe('C')
      expect(blocks[1]?.id).toBe('A')
      expect(blocks[2]?.id).toBe('B')
    })

    it('is no-op when same index', async () => {
      const blockA = makeBlock({ id: 'A', position: 0 })
      const blockB = makeBlock({ id: 'B', position: 1 })
      store.setState({ blocks: [blockA, blockB] })

      await store.getState().reorder('A', 0)

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('is no-op at the adjacent-slot boundary — reorder to own current slot (#928 f6)', async () => {
      // siblingSlot returns the index INCLUDING self (B is at slot 1), while
      // newIndex is the backend slot-basis EXCLUDING self. The guard relies on
      // these coinciding at the block's own position: reorder('B', 1) must NOT
      // emit a move_block IPC and must leave the order untouched.
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null })
      const blockC = makeBlock({ id: 'C', position: 2, parent_id: null })
      store.setState({ blocks: [blockA, blockB, blockC] })

      await store.getState().reorder('B', 1)

      // No-op assertion: the move_block IPC was never invoked.
      expect(mockedInvoke).not.toHaveBeenCalledWith('move_block', expect.anything())
      // Store order is unchanged.
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['A', 'B', 'C'])
    })

    it('moves to the adjacent slot just past its own (#928 f6)', async () => {
      // reorder('B', 2): one slot past B's current slot — must actually move.
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null })
      const blockC = makeBlock({ id: 'C', position: 2, parent_id: null })
      store.setState({ blocks: [blockA, blockB, blockC] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'B',
        new_parent_id: null,
        new_position: 3,
      })

      await store.getState().reorder('B', 2)

      // The move IPC fires with the expected newIndex.
      expect(mockedInvoke).toHaveBeenCalledWith(
        'move_block',
        expect.objectContaining({ blockId: 'B', newParentId: null, newIndex: 2 }),
      )
      // B lands after C: [A, C, B].
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['A', 'C', 'B'])
    })

    it('is no-op when blockId not found', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A' })] })

      await store.getState().reorder('NONEXISTENT', 0)

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('does not update state on backend error', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null })
      store.setState({ blocks: [blockA, blockB] })

      mockedInvoke.mockRejectedValueOnce(new Error('move failed'))

      await store.getState().reorder('B', 0)

      const blocks = store.getState().blocks
      expect(blocks[0]?.id).toBe('A')
      expect(blocks[1]?.id).toBe('B')
    })

    it('moves block down in the list (arrayMove semantics)', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null })
      const blockC = makeBlock({ id: 'C', position: 2, parent_id: null })
      store.setState({ blocks: [blockA, blockB, blockC] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'A',
        new_parent_id: null,
        new_position: 3,
      })

      // Move A to index 2 (where C is) → [B, C, A] via arrayMove
      await store.getState().reorder('A', 2)

      expect(mockedInvoke).toHaveBeenCalledWith(
        'move_block',
        expect.objectContaining({ blockId: 'A', newParentId: null }),
      )
      const blocks = store.getState().blocks
      // arrayMove([A,B,C], 0, 2) → [B, C, A]
      expect(blocks[0]?.id).toBe('B')
      expect(blocks[1]?.id).toBe('C')
      expect(blocks[2]?.id).toBe('A')
    })

    it('preserves parent_id when reordering', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: 'PARENT' })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: 'PARENT' })
      store.setState({ blocks: [blockA, blockB] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'B',
        new_parent_id: 'PARENT',
        new_position: -1,
      })

      await store.getState().reorder('B', 0)

      expect(mockedInvoke).toHaveBeenCalledWith(
        'move_block',
        expect.objectContaining({ blockId: 'B', newParentId: 'PARENT' }),
      )
    })

    it('handles consecutive positions (collision avoidance) for backward move', async () => {
      // Positions 10, 11, 12 — consecutive, no room for Math.floor average
      const blockA = makeBlock({ id: 'A', position: 10, parent_id: null })
      const blockB = makeBlock({ id: 'B', position: 11, parent_id: null })
      const blockC = makeBlock({ id: 'C', position: 12, parent_id: null })
      store.setState({ blocks: [blockA, blockB, blockC] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'C',
        new_parent_id: null,
        new_position: 11,
      })

      // Move C (idx 2) to idx 1 → between A(10) and B(11)
      // floor((10+11)/2) = 10, which <= 10, so nudge up → 11
      // Position 11 collides with B but local array order is correct
      await store.getState().reorder('C', 1)

      const blocks = store.getState().blocks
      expect(blocks.map((b) => b.id)).toEqual(['A', 'C', 'B'])
      // Position is nudged to beforePos + 1
      expect(blocks[1]?.position).toBe(11)
    })

    it('handles consecutive positions for forward move', async () => {
      const blockA = makeBlock({ id: 'A', position: 10, parent_id: null })
      const blockB = makeBlock({ id: 'B', position: 11, parent_id: null })
      const blockC = makeBlock({ id: 'C', position: 12, parent_id: null })
      store.setState({ blocks: [blockA, blockB, blockC] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'A',
        new_parent_id: null,
        new_position: 12,
      })

      // Move A (idx 0) to idx 1 → between B(11) and C(12)
      // floor((11+12)/2) = 11, which <= 11, so nudge up → 12
      await store.getState().reorder('A', 1)

      const blocks = store.getState().blocks
      // arrayMove([A,B,C], 0, 1) → [B, A, C]
      expect(blocks.map((b) => b.id)).toEqual(['B', 'A', 'C'])
      expect(blocks[1]?.position).toBe(12)
    })

    it('assigns position after last block when moving forward to last index', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null })
      const blockB = makeBlock({ id: 'B', position: 5, parent_id: null })
      const blockC = makeBlock({ id: 'C', position: 10, parent_id: null })
      store.setState({ blocks: [blockA, blockB, blockC] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'A',
        new_parent_id: null,
        new_position: 11,
      })

      // Move A to last index (2) — hits newIndex >= blocks.length - 1 branch
      await store.getState().reorder('A', 2)

      const blocks = store.getState().blocks
      // arrayMove([A,B,C], 0, 2) → [B, C, A]
      expect(blocks.map((b) => b.id)).toEqual(['B', 'C', 'A'])
      // Position = last block's position + 1
      expect(blocks[2]?.position).toBe(11)
    })

    it('uses average position when there is room between positions', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null })
      const blockB = makeBlock({ id: 'B', position: 10, parent_id: null })
      const blockC = makeBlock({ id: 'C', position: 20, parent_id: null })
      store.setState({ blocks: [blockA, blockB, blockC] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'C',
        new_parent_id: null,
        new_position: 5,
      })

      // Move C (idx 2) to idx 1 → between A(0) and B(10)
      // floor((0+10)/2) = 5, which > 0, so no nudge needed
      await store.getState().reorder('C', 1)

      const blocks = store.getState().blocks
      expect(blocks.map((b) => b.id)).toEqual(['A', 'C', 'B'])
      expect(blocks[1]?.position).toBe(5)
    })
  })

  // ---------------------------------------------------------------------------
  // moveUp
  // ---------------------------------------------------------------------------
  describe('moveUp', () => {
    it('calls move_block with the prev sibling slot, then splices locally (PEND-35 Tier 4.1)', async () => {
      const blockA = makeBlock({ id: 'A', position: 1, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 2, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      // move_block — echoes the dense new position back so FE can splice.
      mockedInvoke.mockResolvedValueOnce({
        block_id: 'B',
        new_parent_id: null,
        new_position: 1,
      })

      await store.getState().moveUp('B')

      // #400: target slot is the previous sibling's slot (B is at slot 1 → 0).
      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'B',
        newParentId: null,
        newIndex: 0,
      })
      // PEND-35 Tier 4.1 — same-parent moveUp must NOT trigger a re-list IPC.
      expect(mockedInvoke).not.toHaveBeenCalledWith('load_page_subtree', expect.anything())
      // The blocks array is reordered locally with the echoed dense position.
      const blocks = store.getState().blocks
      expect(blocks[0]?.id).toBe('B')
      expect(blocks[0]?.position).toBe(1)
      expect(blocks[1]?.id).toBe('A')
      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1')
    })

    it('is no-op when block is the first sibling at ROOT (nowhere to pop out)', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      await store.getState().moveUp('A')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('#922 — first child pops OUT to become the parent previous sibling', async () => {
      // GRAND > P > {C1, C2}; P is GRAND's 2nd child (after S).
      const grand = makeBlock({ id: 'GRAND', position: 0, parent_id: null, depth: 0 })
      const sibBeforeP = makeBlock({ id: 'S', position: 0, parent_id: 'GRAND', depth: 1 })
      const parent = makeBlock({ id: 'P', position: 1, parent_id: 'GRAND', depth: 1 })
      const child1 = makeBlock({ id: 'C1', position: 0, parent_id: 'P', depth: 2 })
      const child2 = makeBlock({ id: 'C2', position: 1, parent_id: 'P', depth: 2 })
      store.setState({ blocks: [grand, sibBeforeP, parent, child1, child2] })

      // move_block — the cross-parent pop-out. C1 lands under GRAND at the
      // parent P's own sibling slot (1), i.e. right BEFORE P.
      mockedInvoke.mockResolvedValueOnce({
        block_id: 'C1',
        new_parent_id: 'GRAND',
        new_position: 1,
      })
      // load() reload after the structural move.
      mockedInvoke.mockResolvedValueOnce([
        makeBlock({ id: 'GRAND', parent_id: 'PAGE_1', depth: 0 }),
        makeBlock({ id: 'S', parent_id: 'GRAND', depth: 1 }),
        makeBlock({ id: 'C1', parent_id: 'GRAND', depth: 1 }),
        makeBlock({ id: 'P', parent_id: 'GRAND', depth: 1 }),
        makeBlock({ id: 'C2', parent_id: 'P', depth: 2 }),
      ])

      const ok = await store.getState().moveUp('C1')

      expect(ok).toBe(true)
      // The pop-out targets the grandparent at parent P's sibling slot (1).
      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'C1',
        newParentId: 'GRAND',
        newIndex: 1,
      })
      // Structural move → a follow-up reload (mirrors moveToParent).
      expect(mockedInvoke).toHaveBeenCalledWith(
        'load_page_subtree',
        expect.objectContaining({ rootBlockId: 'PAGE_1' }),
      )
      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1')
    })

    it('#922 — first child pop-out under a ROOT parent uses newParentId null', async () => {
      // P (root) > {C1, C2}. C1 pops out to root, right before P (slot 0).
      const parent = makeBlock({ id: 'P', position: 0, parent_id: null, depth: 0 })
      const child1 = makeBlock({ id: 'C1', position: 0, parent_id: 'P', depth: 1 })
      const child2 = makeBlock({ id: 'C2', position: 1, parent_id: 'P', depth: 1 })
      store.setState({ blocks: [parent, child1, child2] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'C1',
        new_parent_id: null,
        new_position: 0,
      })
      mockedInvoke.mockResolvedValueOnce([
        makeBlock({ id: 'C1', parent_id: 'PAGE_1', depth: 0 }),
        makeBlock({ id: 'P', parent_id: 'PAGE_1', depth: 0 }),
        makeBlock({ id: 'C2', parent_id: 'P', depth: 1 }),
      ])

      const ok = await store.getState().moveUp('C1')

      expect(ok).toBe(true)
      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'C1',
        newParentId: null,
        newIndex: 0,
      })
    })

    it('is no-op when block is not found', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A' })] })

      await store.getState().moveUp('NONEXISTENT')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('does not crash on backend error (silently fails)', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 5, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      mockedInvoke.mockRejectedValueOnce(new Error('move failed'))

      // R6 (#405): move actions now resolve `false` on a caught backend error.
      await expect(store.getState().moveUp('B')).resolves.toBe(false)
      expect(store.getState().blocks).toHaveLength(2)
    })

    it('uses correct parentId in move_block call', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: 'PARENT', depth: 1 })
      const blockB = makeBlock({ id: 'B', position: 3, parent_id: 'PARENT', depth: 1 })
      store.setState({ blocks: [blockA, blockB] })

      // move_block — echoes new position
      mockedInvoke.mockResolvedValueOnce({
        block_id: 'B',
        new_parent_id: 'PARENT',
        new_position: -1,
      })

      await store.getState().moveUp('B')

      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'B',
        newParentId: 'PARENT',
        newIndex: 0, // B is at sibling slot 1 → swap up to slot 0
      })
      // Tier 4.1 — same-parent path skips re-list.
      expect(mockedInvoke).not.toHaveBeenCalledWith('load_page_subtree', expect.anything())
    })

    it('falls back to full reload if backend echoes a different parent (Tier 4.1 cross-parent guard)', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 5, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      // move_block returns a parent_id different from what we asked for —
      // shouldn't happen in practice for moveUp, but the guard exists so
      // descendant chains stay consistent if it ever does.
      mockedInvoke.mockResolvedValueOnce({
        block_id: 'B',
        new_parent_id: 'OTHER',
        new_position: -1,
      })
      // load_page_subtree (fallback reload)
      mockedInvoke.mockResolvedValueOnce({
        items: [],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      await store.getState().moveUp('B')

      expect(mockedInvoke).toHaveBeenCalledWith(
        'load_page_subtree',
        expect.objectContaining({ rootBlockId: 'PAGE_1' }),
      )
    })
  })

  // ---------------------------------------------------------------------------
  // moveDown
  // ---------------------------------------------------------------------------
  describe('moveDown', () => {
    it('calls move_block with the next sibling slot, then splices locally (PEND-35 Tier 4.1)', async () => {
      const blockA = makeBlock({ id: 'A', position: 1, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 2, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      // move_block — echoes the dense new position.
      mockedInvoke.mockResolvedValueOnce({
        block_id: 'A',
        new_parent_id: null,
        new_position: 2,
      })

      await store.getState().moveDown('A')

      // #400: A is at slot 0; once it vacates, B slides to slot 0, so landing
      // AFTER B is slot 1.
      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'A',
        newParentId: null,
        newIndex: 1,
      })
      // PEND-35 Tier 4.1 — same-parent moveDown must NOT trigger a re-list IPC.
      expect(mockedInvoke).not.toHaveBeenCalledWith('load_page_subtree', expect.anything())
      const blocks = store.getState().blocks
      expect(blocks[0]?.id).toBe('B')
      expect(blocks[1]?.id).toBe('A')
      expect(blocks[1]?.position).toBe(2)
      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1')
    })

    it('is no-op when block is the last sibling at ROOT (nowhere to pop out)', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      await store.getState().moveDown('B')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('#922 — last child pops OUT to become the parent next sibling', async () => {
      // GRAND > {P, S}; P > {C1, C2}. moveDown(C2) pops C2 out to GRAND right
      // AFTER P (parent P's sibling slot 0 + 1 = 1).
      const grand = makeBlock({ id: 'GRAND', position: 0, parent_id: null, depth: 0 })
      const parent = makeBlock({ id: 'P', position: 0, parent_id: 'GRAND', depth: 1 })
      const sibAfterP = makeBlock({ id: 'S', position: 1, parent_id: 'GRAND', depth: 1 })
      const child1 = makeBlock({ id: 'C1', position: 0, parent_id: 'P', depth: 2 })
      const child2 = makeBlock({ id: 'C2', position: 1, parent_id: 'P', depth: 2 })
      store.setState({ blocks: [grand, parent, sibAfterP, child1, child2] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'C2',
        new_parent_id: 'GRAND',
        new_position: 1,
      })
      mockedInvoke.mockResolvedValueOnce([
        makeBlock({ id: 'GRAND', parent_id: 'PAGE_1', depth: 0 }),
        makeBlock({ id: 'P', parent_id: 'GRAND', depth: 1 }),
        makeBlock({ id: 'C1', parent_id: 'P', depth: 2 }),
        makeBlock({ id: 'C2', parent_id: 'GRAND', depth: 1 }),
        makeBlock({ id: 'S', parent_id: 'GRAND', depth: 1 }),
      ])

      const ok = await store.getState().moveDown('C2')

      expect(ok).toBe(true)
      // Pop-out under the grandparent, right after parent P (slot 0 + 1).
      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'C2',
        newParentId: 'GRAND',
        newIndex: 1,
      })
      expect(mockedInvoke).toHaveBeenCalledWith(
        'load_page_subtree',
        expect.objectContaining({ rootBlockId: 'PAGE_1' }),
      )
      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1')
    })

    it('#922 — single-child pop-out under a ROOT parent uses newParentId null', async () => {
      // P (root) > {C1}. C1 is both first AND last; moveDown pops it out to
      // root right after P (parent slot 0 + 1 = 1).
      const parent = makeBlock({ id: 'P', position: 0, parent_id: null, depth: 0 })
      const child1 = makeBlock({ id: 'C1', position: 0, parent_id: 'P', depth: 1 })
      store.setState({ blocks: [parent, child1] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'C1',
        new_parent_id: null,
        new_position: 1,
      })
      mockedInvoke.mockResolvedValueOnce([
        makeBlock({ id: 'P', parent_id: 'PAGE_1', depth: 0 }),
        makeBlock({ id: 'C1', parent_id: 'PAGE_1', depth: 0 }),
      ])

      const ok = await store.getState().moveDown('C1')

      expect(ok).toBe(true)
      expect(mockedInvoke).toHaveBeenCalledWith('move_block', {
        blockId: 'C1',
        newParentId: null,
        newIndex: 1,
      })
    })

    it('is no-op when block is not found', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A' })] })

      await store.getState().moveDown('NONEXISTENT')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('does not crash on backend error (silently fails)', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 5, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      mockedInvoke.mockRejectedValueOnce(new Error('move failed'))

      // R6 (#405): move actions now resolve `false` on a caught backend error.
      await expect(store.getState().moveDown('A')).resolves.toBe(false)
      expect(store.getState().blocks).toHaveLength(2)
    })

    it('falls back to full reload if backend echoes a different parent (Tier 4.1 cross-parent guard)', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 5, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })

      mockedInvoke.mockResolvedValueOnce({
        block_id: 'A',
        new_parent_id: 'OTHER',
        new_position: 6,
      })
      mockedInvoke.mockResolvedValueOnce({
        items: [],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      await store.getState().moveDown('A')

      expect(mockedInvoke).toHaveBeenCalledWith(
        'load_page_subtree',
        expect.objectContaining({ rootBlockId: 'PAGE_1' }),
      )
    })
  })

  // ---------------------------------------------------------------------------
  // DnD slot-safety invariants (#400).
  //
  // The store's move actions now persist a 0-based sibling SLOT (`newIndex`),
  // not a sparse integer position. The backend derives a collision-free dense
  // 1-based rank from the slot — "move to top" / "nest as first child" are
  // slot 0 (no `position <= 0` rejection), and same-parent swaps never collide.
  // These tests lock in the slot the store emits for the four cases that used
  // to produce non-positive / colliding positions.
  // ---------------------------------------------------------------------------
  describe('slot-safety invariants (DnD)', () => {
    /** Pull the `newIndex` from the most recent move_block IPC call. */
    function lastMoveIndex(): number | undefined {
      const calls = mockedInvoke.mock.calls.filter((c) => c[0] === 'move_block')
      const last = calls[calls.length - 1]?.[1] as { newIndex?: number } | undefined
      return last?.newIndex
    }

    it('moveUp emits a non-negative slot (0) when the prev sibling is at the floor', async () => {
      const blockA = makeBlock({ id: 'A', position: 1, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 2, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })
      mockedInvoke.mockResolvedValueOnce({ block_id: 'B', new_parent_id: null, new_position: 1 })

      await store.getState().moveUp('B')

      // B at slot 1 → swap up to slot 0 (the backend accepts "move to top").
      expect(lastMoveIndex()).toBe(0)
    })

    it('reorder to the top emits slot 0 (accepted by the backend)', async () => {
      const blockA = makeBlock({ id: 'A', position: 1, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 2, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })
      mockedInvoke.mockResolvedValueOnce({ block_id: 'B', new_parent_id: null, new_position: 1 })

      await store.getState().reorder('B', 0)

      expect(lastMoveIndex()).toBe(0)
    })

    it('moveDown emits a slot that does not collide with an existing sibling', async () => {
      // Consecutive positions 1,2,3 (no gaps) — the common real-world case.
      const blockA = makeBlock({ id: 'A', position: 1, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 2, parent_id: null, depth: 0 })
      const blockC = makeBlock({ id: 'C', position: 3, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB, blockC] })
      mockedInvoke.mockResolvedValueOnce({ block_id: 'A', new_parent_id: null, new_position: 2 })

      // Move A down past B → slot 1 (B slides up once A vacates). The backend
      // assigns a dense rank from the slot; no collision.
      await store.getState().moveDown('A')

      expect(lastMoveIndex()).toBe(1)
    })

    it('dedent emits a slot that does not collide with the parent’s following sibling', async () => {
      // GP > P(slot 0) { X }, and P has a following sibling S at slot 1.
      // Dedent X → slot = P's sibling slot (0) + 1 = 1, BEFORE S; the backend
      // re-ranks densely so S shifts down — no collision.
      const gp = makeBlock({ id: 'GP', position: 1, parent_id: null, depth: 0 })
      const p = makeBlock({ id: 'P', position: 1, parent_id: 'GP', depth: 1 })
      const x = makeBlock({ id: 'X', position: 1, parent_id: 'P', depth: 2 })
      const s = makeBlock({ id: 'S', position: 2, parent_id: 'GP', depth: 1 })
      store.setState({
        blocks: [gp, p, x, s],
        blocksById: new Map([
          ['GP', gp],
          ['P', p],
          ['X', x],
          ['S', s],
        ]),
      })
      mockedInvoke.mockResolvedValueOnce({ block_id: 'X', new_parent_id: 'GP', new_position: 2 })

      await store.getState().dedent('X')

      expect(lastMoveIndex()).toBe(1)
    })
  })

  // ---------------------------------------------------------------------------
  // appendBlock (PEND-35 Tier 4.2)
  // ---------------------------------------------------------------------------
  describe('appendBlock', () => {
    it('pushes the row to blocks and rebuilds blocksById (no IPC)', () => {
      store.setState({ blocks: [] })

      const row = makeBlock({ id: 'NEW', parent_id: 'PAGE_1', position: 0 })
      // Drop `depth` from the BlockRow input — appendBlock supplies depth = 0.
      const { depth: _depth, ...rowWithoutDepth } = row

      store.getState().appendBlock(rowWithoutDepth)

      expect(mockedInvoke).not.toHaveBeenCalled()
      const blocks = store.getState().blocks
      expect(blocks).toHaveLength(1)
      expect(blocks[0]?.id).toBe('NEW')
      expect(blocks[0]?.depth).toBe(0)
      expect(store.getState().blocksById.get('NEW')?.id).toBe('NEW')
    })

    it('appends to an existing block list without disturbing prior entries', () => {
      const existing = makeBlock({ id: 'A', parent_id: 'PAGE_1', position: 0, depth: 0 })
      store.setState({ blocks: [existing] })

      const row = makeBlock({ id: 'B', parent_id: 'PAGE_1', position: 1 })
      const { depth: _depth, ...rowWithoutDepth } = row

      store.getState().appendBlock(rowWithoutDepth)

      const blocks = store.getState().blocks
      expect(blocks.map((b) => b.id)).toEqual(['A', 'B'])
    })
  })

  // ---------------------------------------------------------------------------
  // undo store integration — notifyUndoNewAction
  // ---------------------------------------------------------------------------
  describe('undo store integration', () => {
    it('createBelow calls onNewAction after successful create', async () => {
      const block = makeBlock({ id: 'A', position: 0 })
      store.setState({ blocks: [block] })

      mockedInvoke.mockResolvedValueOnce({
        id: 'NEW',
        block_type: 'text',
        content: '',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })

      await store.getState().createBelow('A')

      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1')
    })

    it('edit calls onNewAction after successful edit', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A', content: 'old' })],
      })
      mockedInvoke.mockResolvedValueOnce({
        id: 'A',
        block_type: 'text',
        content: 'new',
        parent_id: null,
        position: 0,
        deleted_at: null,
      })

      await store.getState().edit('A', 'new')

      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1')
    })

    it('remove calls onNewAction after successful delete', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A' })],
      })
      mockedInvoke.mockResolvedValueOnce({
        block_id: 'A',
        deleted_at: '2025-01-01T00:00:00Z',
        descendants_affected: 0,
      })

      await store.getState().remove('A')

      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1')
    })

    it('does NOT call onNewAction when createBelow fails', async () => {
      const block = makeBlock({ id: 'A', position: 0 })
      store.setState({ blocks: [block] })

      mockedInvoke.mockRejectedValueOnce(new Error('create failed'))

      await store.getState().createBelow('A')

      expect(mockOnNewAction).not.toHaveBeenCalled()
    })

    it('does NOT call onNewAction when edit fails', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A', content: 'old' })],
      })
      mockedInvoke.mockRejectedValueOnce(new Error('edit failed'))

      await store.getState().edit('A', 'new')

      expect(mockOnNewAction).not.toHaveBeenCalled()
    })

    it('does NOT call onNewAction when remove fails', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A' })],
      })
      mockedInvoke.mockRejectedValueOnce(new Error('delete failed'))

      await store.getState().remove('A')

      expect(mockOnNewAction).not.toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------
  // pageBlockRegistry guard (FE-L-3)
  // ---------------------------------------------------------------------------
  describe('pageBlockRegistry cleanup guard', () => {
    it('does not delete a newer registration when an older provider unmounts', () => {
      const pageId = 'GUARD_PAGE'
      pageBlockRegistry.delete(pageId)

      // PageBlockStoreProvider declares `children` as a required prop, so the props
      // arg must include it. We cast to a permissive shape here to keep the props
      // object simple while satisfying both TS and Biome's noChildrenProp rule.
      const Provider = PageBlockStoreProvider as unknown as (props: {
        pageId: string
        children?: ReactNode
      }) => ReactElement

      // Mount provider A → registers store A.
      const a = render(createElement(Provider, { pageId }, 'a'))
      const storeA = pageBlockRegistry.get(pageId)
      expect(storeA).toBeDefined()

      // Mount provider B for the same pageId → overwrites the slot with store B.
      const b = render(createElement(Provider, { pageId }, 'b'))
      const storeB = pageBlockRegistry.get(pageId)
      expect(storeB).toBeDefined()
      expect(storeB).not.toBe(storeA)

      // Unmount provider A: its cleanup must NOT delete B's registration.
      a.unmount()
      expect(pageBlockRegistry.get(pageId)).toBe(storeB)

      b.unmount()
      expect(pageBlockRegistry.has(pageId)).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // #753 — undo state cleared on provider unmount
  // ---------------------------------------------------------------------------
  describe('undo clearPage on provider unmount (#753)', () => {
    // PageBlockStoreProvider declares `children` as required; cast keeps the
    // props object simple (same pattern as the registry-guard tests above).
    const Provider = PageBlockStoreProvider as unknown as (props: {
      pageId: string
      children?: ReactNode
    }) => ReactElement

    it('clears the page undo state when the provider unmounts', () => {
      const pageId = 'JOURNAL_DAY_PAGE'
      pageBlockRegistry.delete(pageId)

      // Journal day pages mount one provider per DaySection and have no
      // PageEditor-style clear path — the provider unmount is the only
      // place their session undo state can be released.
      const view = render(createElement(Provider, { pageId }, 'x'))
      expect(mockClearPage).not.toHaveBeenCalled()

      view.unmount()
      expect(mockClearPage).toHaveBeenCalledTimes(1)
      expect(mockClearPage).toHaveBeenCalledWith(pageId)
    })

    it('a stale unmount does not clear a newer mount’s undo state', () => {
      const pageId = 'GUARD_PAGE_UNDO'
      pageBlockRegistry.delete(pageId)

      const a = render(createElement(Provider, { pageId }, 'a'))
      const b = render(createElement(Provider, { pageId }, 'b'))
      mockClearPage.mockClear()

      // Provider A's cleanup sees B's registration in the slot — it must
      // neither delete the registry entry NOR wipe B's live undo state.
      a.unmount()
      expect(mockClearPage).not.toHaveBeenCalled()

      b.unmount()
      expect(mockClearPage).toHaveBeenCalledTimes(1)
      expect(mockClearPage).toHaveBeenCalledWith(pageId)
    })
  })

  // ---------------------------------------------------------------------------
  // PEND-20 G — blocksById Map invariant
  // ---------------------------------------------------------------------------
  describe('blocksById Map invariant', () => {
    it('seeds an empty Map on a freshly created store', () => {
      const fresh = createPageBlockStore('PAGE_FRESH')
      const { blocks, blocksById } = fresh.getState()
      expect(blocks).toEqual([])
      expect(blocksById).toBeInstanceOf(Map)
      expect(blocksById.size).toBe(0)
    })

    it('load() populates blocksById from the loaded blocks', async () => {
      const items = [
        makeBlock({ id: 'A', parent_id: 'PAGE_1' }),
        makeBlock({ id: 'B', parent_id: 'PAGE_1' }),
      ]
      mockedInvoke.mockResolvedValueOnce(items)

      await store.getState().load()

      const { blocks, blocksById } = store.getState()
      expect(blocksById.size).toBe(2)
      expect(blocksById.get('A')).toBe(blocks[0])
      expect(blocksById.get('B')).toBe(blocks[1])
    })

    it('createBelow keeps blocksById in sync', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A', position: 0 })] })

      mockedInvoke.mockResolvedValueOnce({
        id: 'NEW',
        block_type: 'text',
        content: 'new',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })

      await store.getState().createBelow('A', 'new')

      const { blocks, blocksById } = store.getState()
      expect(blocksById.size).toBe(blocks.length)
      expect(blocksById.get('NEW')?.content).toBe('new')
      expect(blocksById.get('A')?.id).toBe('A')
    })

    it('edit keeps blocksById in sync', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A', content: 'old' })] })
      mockedInvoke.mockResolvedValueOnce({})

      await store.getState().edit('A', 'new')

      const { blocks, blocksById } = store.getState()
      expect(blocksById.get('A')?.content).toBe('new')
      expect(blocksById.get('A')).toBe(blocks[0])
    })

    it('remove keeps blocksById in sync', async () => {
      store.setState({
        blocks: [makeBlock({ id: 'A' }), makeBlock({ id: 'B' })],
      })
      mockedInvoke.mockResolvedValueOnce({
        block_id: 'A',
        deleted_at: '2025-01-01T00:00:00Z',
        descendants_affected: 0,
      })

      await store.getState().remove('A')

      const { blocks, blocksById } = store.getState()
      expect(blocks).toHaveLength(1)
      expect(blocksById.size).toBe(1)
      expect(blocksById.has('A')).toBe(false)
      expect(blocksById.get('B')?.id).toBe('B')
    })

    it('reorder keeps blocksById in sync', async () => {
      const blockA = makeBlock({ id: 'A', position: 1, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 2, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })
      mockedInvoke.mockResolvedValueOnce({ block_id: 'A', new_parent_id: null, new_position: 2 })

      await store.getState().reorder('A', 1)

      const { blocks, blocksById } = store.getState()
      expect(blocks.map((b) => b.id)).toEqual(['B', 'A'])
      expect(blocksById.size).toBe(2)
      // Map points to the new array entries (after reorder).
      expect(blocksById.get('A')).toBe(blocks[1])
      expect(blocksById.get('B')).toBe(blocks[0])
    })

    it('indent keeps blocksById in sync', async () => {
      const blockA = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
      const blockB = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
      store.setState({ blocks: [blockA, blockB] })
      // #774 — indent checks the backend parent echo; echo the requested
      // parent ('A') so the local-splice path runs (was a bare `undefined`).
      mockedInvoke.mockResolvedValueOnce({ block_id: 'B', new_parent_id: 'A', new_position: 0 })

      await store.getState().indent('B')

      const { blocks, blocksById } = store.getState()
      expect(blocksById.size).toBe(blocks.length)
      // Indented block's depth/parent updated and the Map entry reflects that.
      const indented = blocksById.get('B')
      expect(indented?.parent_id).toBe('A')
      expect(indented?.depth).toBe(1)
    })

    it('dedent keeps blocksById in sync', async () => {
      const parent = makeBlock({ id: 'P', position: 1, parent_id: null, depth: 0 })
      const child = makeBlock({ id: 'C', position: 1, parent_id: 'P', depth: 1 })
      store.setState({ blocks: [parent, child] })
      mockedInvoke.mockResolvedValueOnce({ block_id: 'C', new_parent_id: null, new_position: 2 })

      await store.getState().dedent('C')

      const { blocks, blocksById } = store.getState()
      expect(blocksById.size).toBe(blocks.length)
      const dedented = blocksById.get('C')
      expect(dedented?.parent_id).toBe(null)
      expect(dedented?.depth).toBe(0)
    })

    it('edit rollback on backend error restores both blocks and blocksById', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A', content: 'old' })] })
      mockedInvoke.mockRejectedValueOnce(new Error('edit failed'))

      await store.getState().edit('A', 'new')

      const { blocks, blocksById } = store.getState()
      expect(blocks[0]?.content).toBe('old')
      expect(blocksById.get('A')?.content).toBe('old')
      expect(blocksById.get('A')).toBe(blocks[0])
    })

    it('produces a fresh Map reference on every blocks-touching mutation', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A', content: 'old' })] })
      const map1 = store.getState().blocksById

      mockedInvoke.mockResolvedValueOnce({})
      await store.getState().edit('A', 'new')
      const map2 = store.getState().blocksById
      expect(map2).not.toBe(map1)

      mockedInvoke.mockResolvedValueOnce({
        id: 'NEW',
        block_type: 'text',
        content: '',
        parent_id: null,
        position: 1,
        deleted_at: null,
      })
      await store.getState().createBelow('A')
      const map3 = store.getState().blocksById
      expect(map3).not.toBe(map2)
    })

    it('subscribe listeners fire when blocksById changes', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A', content: 'old' })] })
      const seen: Map<string, FlatBlock>[] = []
      const unsub = store.subscribe((state, prev) => {
        if (state.blocksById !== prev.blocksById) seen.push(state.blocksById)
      })

      mockedInvoke.mockResolvedValueOnce({})
      await store.getState().edit('A', 'new')

      expect(seen).toHaveLength(1)
      expect(seen[0]?.get('A')?.content).toBe('new')
      unsub()
    })

    it('getBlockById returns the matching block or undefined', () => {
      const a = makeBlock({ id: 'A' })
      const b = makeBlock({ id: 'B' })
      store.setState({ blocks: [a, b] })

      expect(store.getState().getBlockById('A')?.id).toBe('A')
      expect(store.getState().getBlockById('B')?.id).toBe('B')
      expect(store.getState().getBlockById('NOPE')).toBeUndefined()
    })

    it('external setState({ blocks }) auto-derives blocksById', () => {
      store.setState({ blocks: [makeBlock({ id: 'X' }), makeBlock({ id: 'Y' })] })

      const { blocksById } = store.getState()
      expect(blocksById.size).toBe(2)
      expect(blocksById.get('X')?.id).toBe('X')
      expect(blocksById.get('Y')?.id).toBe('Y')
    })

    it('external setState honours an explicitly provided blocksById', () => {
      const explicit = new Map<string, ReturnType<typeof makeBlock>>([
        // Intentionally drop one entry so we can prove the explicit Map wins
        // over the would-be auto-derived one.
        ['A', makeBlock({ id: 'A' })],
      ])
      store.setState({
        blocks: [makeBlock({ id: 'A' }), makeBlock({ id: 'B' })],
        blocksById: explicit,
      })

      expect(store.getState().blocksById).toBe(explicit)
      expect(store.getState().blocksById.size).toBe(1)
    })

    it('setState that does not touch blocks leaves blocksById identity intact', () => {
      store.setState({ blocks: [makeBlock({ id: 'A' })] })
      const before = store.getState().blocksById

      store.setState({ loading: false })

      expect(store.getState().blocksById).toBe(before)
    })

    // ── perf invariant (perf-review Tier 1 #2, 2026-05-09) ───────────────
    // Single-block-edit hot paths MUST NOT walk the entire `blocks` array to
    // rebuild `blocksById`. They derive the new Map from the previous one and
    // touch only the affected keys (`cloneBlocksByIdWith` / `cloneBlocksByIdWithout`).
    //
    // We assert this by counting reads of the per-block `.id` property across
    // a single `edit()` call. The old `buildBlocksById(newBlocks)` path walks
    // every block in the new array and reads `b.id` once per entry (to use as
    // the Map key) — yielding at least N reads. The new cloneBlocksByIdWith
    // path clones via `new Map(prev)`, which iterates the existing Map's
    // internal slots without touching any FlatBlock's `.id` property, then
    // sets the single touched key. Result: zero `.id` reads on the
    // unedited blocks during the Map rebuild.
    //
    // We still allow a few `.id` reads (logger context, etc.) so the
    // threshold is generous: any regression to a full-scan rebuild would
    // produce O(N) reads, far above the small constant we allow.
    it('edit() does not full-scan rebuild blocksById from the blocks array', async () => {
      // Seed a 50-block page — large enough that a regression to full-scan
      // would produce ~50 .id reads on top of any normal overhead.
      const N = 50
      const idReads = new Map<string, number>()
      const seeded = Array.from({ length: N }, (_, i) => {
        const raw = makeBlock({
          id: `B${i}`,
          content: `c${i}`,
          position: i,
          parent_id: 'PAGE_1',
        })
        idReads.set(raw.id, 0)
        // Replace `.id` with an accessor that bumps a counter on read while
        // preserving the same value semantics.
        const trueId = raw.id
        Object.defineProperty(raw, 'id', {
          get() {
            idReads.set(trueId, (idReads.get(trueId) ?? 0) + 1)
            return trueId
          },
          enumerable: true,
          configurable: true,
        })
        return raw
      })
      store.setState({ blocks: seeded })

      // Reset counters after seeding (setState calls augmentBlocksUpdate,
      // which legitimately walks the blocks array once on this entry path
      // — that's seeding, not the hot path we're measuring).
      for (const k of idReads.keys()) idReads.set(k, 0)

      mockedInvoke.mockResolvedValueOnce({})
      await store.getState().edit('B25', 'edited content')

      const total = [...idReads.values()].reduce((a, b) => a + b, 0)
      // The hot path may legitimately read `.id` on the edited block (to
      // identify it during `state.blocks.map`) — that's O(N) array walks
      // touching `.id` for every block. Wait: the `.map` callback reads
      // `b.id` on every entry. So we expect ~N reads from the `.map`
      // identity check. What we're guarding against is the SECOND O(N)
      // walk that `buildBlocksById` used to do. So budget: at most N + a
      // small constant. With the new cloneBlocksByIdWith path the second
      // walk is gone, leaving just the single `.map` traversal.
      expect(total).toBeLessThanOrEqual(N + 5)

      // Correctness check: the Map is right.
      const { blocksById } = store.getState()
      expect(blocksById.size).toBe(N)
      expect(blocksById.get('B25')?.content).toBe('edited content')
    })

    it('Probe component subscribed to blocksById re-renders on every mutation', async () => {
      let renderCount = 0

      function Probe(): ReactElement {
        const map = usePageBlockStore((s) => s.blocksById)
        const renderedRef = useRef(0)
        renderedRef.current++
        renderCount = renderedRef.current
        return createElement('span', { 'data-testid': 'probe' }, `size=${map.size}`)
      }

      const { getByTestId } = render(
        createElement(PageBlockContext.Provider, { value: store }, createElement(Probe)),
      )

      const initialRenders = renderCount
      expect(getByTestId('probe').textContent).toBe('size=0')

      // Mutation 1: setState with new blocks → derives new Map → re-render.
      act(() => {
        store.setState({ blocks: [makeBlock({ id: 'A' })] })
      })
      expect(renderCount).toBeGreaterThan(initialRenders)
      expect(getByTestId('probe').textContent).toBe('size=1')

      // Mutation 2: edit() → new Map → re-render.
      const beforeEdit = renderCount
      mockedInvoke.mockResolvedValueOnce({})
      await act(async () => {
        await store.getState().edit('A', 'new content')
      })
      expect(renderCount).toBeGreaterThan(beforeEdit)

      // Non-blocks mutation should NOT re-render.
      const beforeIdle = renderCount
      act(() => {
        store.setState({ loading: false })
      })
      expect(renderCount).toBe(beforeIdle)
    })
  })

  // ---------------------------------------------------------------------------
  // moveBlocks (#914 — multi-select drag)
  // ---------------------------------------------------------------------------
  describe('moveBlocks', () => {
    /** Extract the recorded `move_block` IPC payloads, in call order. */
    function moveCalls() {
      return mockedInvoke.mock.calls
        .filter(([cmd]) => cmd === 'move_block')
        .map(
          ([, args]) => args as { blockId: string; newParentId: string | null; newIndex: number },
        )
    }

    it('issues one move_block per id at consecutive slots, then reloads + notifies undo', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 }),
          makeBlock({ id: 'C', position: 2, parent_id: null, depth: 0 }),
          makeBlock({ id: 'D', position: 3, parent_id: null, depth: 0 }),
        ],
      })

      // Two moves echo their committed slot, then the reload returns the tree.
      mockedInvoke.mockResolvedValueOnce({ block_id: 'A', new_parent_id: null, new_position: 2 })
      mockedInvoke.mockResolvedValueOnce({ block_id: 'B', new_parent_id: null, new_position: 3 })
      mockedInvoke.mockResolvedValueOnce([
        makeBlock({ id: 'C', parent_id: 'PAGE_1', position: 0 }),
        makeBlock({ id: 'D', parent_id: 'PAGE_1', position: 1 }),
        makeBlock({ id: 'A', parent_id: 'PAGE_1', position: 2 }),
        makeBlock({ id: 'B', parent_id: 'PAGE_1', position: 3 }),
      ])

      await store.getState().moveBlocks(['A', 'B'], null, 2)

      const moves = moveCalls()
      expect(moves).toEqual([
        { blockId: 'A', newParentId: null, newIndex: 2 },
        { blockId: 'B', newParentId: null, newIndex: 3 },
      ])
      // Reload ran and the new flattened order is adopted.
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['C', 'D', 'A', 'B'])
      expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1')
    })

    it('preserves DOCUMENT order even when ids are passed out of order', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 }),
          makeBlock({ id: 'C', position: 2, parent_id: null, depth: 0 }),
        ],
      })

      mockedInvoke.mockResolvedValueOnce({ block_id: 'A', new_parent_id: null, new_position: 1 })
      mockedInvoke.mockResolvedValueOnce({ block_id: 'C', new_parent_id: null, new_position: 2 })
      mockedInvoke.mockResolvedValueOnce([])

      // Caller passes ['C', 'A'] — but A precedes C in the document, so A moves first.
      await store.getState().moveBlocks(['C', 'A'], null, 1)

      expect(moveCalls()).toEqual([
        { blockId: 'A', newParentId: null, newIndex: 1 },
        { blockId: 'C', newParentId: null, newIndex: 2 },
      ])
    })

    it('moves the selection into a NEW parent at consecutive slots', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'P', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'A', position: 1, parent_id: null, depth: 0 }),
          makeBlock({ id: 'B', position: 2, parent_id: null, depth: 0 }),
        ],
      })

      mockedInvoke.mockResolvedValueOnce({ block_id: 'A', new_parent_id: 'P', new_position: 0 })
      mockedInvoke.mockResolvedValueOnce({ block_id: 'B', new_parent_id: 'P', new_position: 1 })
      mockedInvoke.mockResolvedValueOnce([
        makeBlock({ id: 'P', parent_id: 'PAGE_1', position: 0 }),
        makeBlock({ id: 'A', parent_id: 'P', position: 0 }),
        makeBlock({ id: 'B', parent_id: 'P', position: 1 }),
      ])

      await store.getState().moveBlocks(['A', 'B'], 'P', 0)

      expect(moveCalls()).toEqual([
        { blockId: 'A', newParentId: 'P', newIndex: 0 },
        { blockId: 'B', newParentId: 'P', newIndex: 1 },
      ])
      // A and B now nested under P.
      const blocks = store.getState().blocks
      expect(blocks.find((b) => b.id === 'A')?.parent_id).toBe('P')
      expect(blocks.find((b) => b.id === 'B')?.parent_id).toBe('P')
    })

    it('honours a boundary slot of 0 (move to top)', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 }),
          makeBlock({ id: 'C', position: 2, parent_id: null, depth: 0 }),
        ],
      })

      mockedInvoke.mockResolvedValueOnce({ block_id: 'B', new_parent_id: null, new_position: 0 })
      mockedInvoke.mockResolvedValueOnce({ block_id: 'C', new_parent_id: null, new_position: 1 })
      mockedInvoke.mockResolvedValueOnce([])

      await store.getState().moveBlocks(['B', 'C'], null, 0)

      expect(moveCalls()).toEqual([
        { blockId: 'B', newParentId: null, newIndex: 0 },
        { blockId: 'C', newParentId: null, newIndex: 1 },
      ])
    })

    it('is a no-op for an empty id list (no IPC, no undo)', async () => {
      store.setState({ blocks: [makeBlock({ id: 'A', parent_id: null, depth: 0 })] })

      await store.getState().moveBlocks([], null, 0)

      expect(mockedInvoke).not.toHaveBeenCalled()
      expect(mockOnNewAction).not.toHaveBeenCalled()
    })

    it('drops ids that are absent from the current tree before issuing moves', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 }),
        ],
      })

      mockedInvoke.mockResolvedValueOnce({ block_id: 'A', new_parent_id: null, new_position: 1 })
      mockedInvoke.mockResolvedValueOnce([])

      // 'GHOST' is not in the tree — only 'A' should move.
      await store.getState().moveBlocks(['A', 'GHOST'], null, 1)

      expect(moveCalls()).toEqual([{ blockId: 'A', newParentId: null, newIndex: 1 }])
    })

    it('reloads to reconcile and does not notify undo when a move fails', async () => {
      store.setState({
        blocks: [
          makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 }),
          makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 }),
        ],
      })

      // First move succeeds, second rejects → catch reloads, no undo.
      mockedInvoke.mockResolvedValueOnce({ block_id: 'A', new_parent_id: null, new_position: 1 })
      mockedInvoke.mockRejectedValueOnce(new Error('move failed'))
      mockedInvoke.mockResolvedValueOnce([
        makeBlock({ id: 'A', parent_id: 'PAGE_1', position: 0 }),
        makeBlock({ id: 'B', parent_id: 'PAGE_1', position: 1 }),
      ])

      await store.getState().moveBlocks(['A', 'B'], null, 1)

      // A reconciling reload fired after the failure.
      expect(mockedInvoke).toHaveBeenCalledWith(
        'load_page_subtree',
        expect.objectContaining({ rootBlockId: 'PAGE_1' }),
      )
      expect(mockOnNewAction).not.toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------
  // pasteBlocks (#913)
  // ---------------------------------------------------------------------------
  describe('pasteBlocks', () => {
    /**
     * Dispatch the `invoke` mock by command name: `create_blocks_batch` echoes
     * created BlockRows (one per spec, ids `NEW0..`), `load_page_subtree`
     * returns `reloadRows`. Captures every batch's specs for assertions.
     */
    function wireBatchAndReload(reloadRows: FlatBlock[]): { batches: unknown[][] } {
      const batches: unknown[][] = []
      let created = 0
      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'create_blocks_batch') {
          const specs = ((args as { specs?: unknown })?.specs ?? []) as Array<{
            content: string
            parentId: string | null
          }>
          batches.push(specs)
          return specs.map((s) => ({
            id: `NEW${created++}`,
            block_type: 'content',
            content: s.content,
            parent_id: s.parentId,
            position: null,
            deleted_at: null,
          }))
        }
        if (cmd === 'load_page_subtree') return reloadRows
        return []
      })
      return { batches }
    }

    it('inserts a flat markdown outline as siblings after the anchor', async () => {
      const anchor = makeBlock({ id: 'A', parent_id: 'PAGE_1', position: 0 })
      store.setState({ blocks: [anchor] })
      const { batches } = wireBatchAndReload([anchor])

      const ids = await store.getState().pasteBlocks('A', 'one\ntwo')

      expect(ids).toEqual(['NEW0', 'NEW1'])
      // One batch (single depth level), both blocks under the anchor's parent.
      expect(batches).toHaveLength(1)
      const specs = batches[0] as Array<{
        content: string
        parentId: string | null
        position: number
      }>
      expect(specs.map((s) => s.content)).toEqual(['one', 'two'])
      expect(specs.every((s) => s.parentId === 'PAGE_1')).toBe(true)
      // Anchor is at sibling slot 0 → wire positions 2, 3 (slot+2, contiguous).
      expect(specs.map((s) => s.position)).toEqual([2, 3])
      // Structural insert reloads the tree.
      expect(mockedInvoke).toHaveBeenCalledWith(
        'load_page_subtree',
        expect.objectContaining({ rootBlockId: 'PAGE_1' }),
      )
    })

    it('materializes a nested outline level-by-level with resolved parents', async () => {
      const anchor = makeBlock({ id: 'A', parent_id: 'PAGE_1', position: 0 })
      store.setState({ blocks: [anchor] })
      const { batches } = wireBatchAndReload([anchor])

      const ids = await store.getState().pasteBlocks('A', 'parent\n  child\n    grandchild')

      // Three depth levels → three batches.
      expect(batches).toHaveLength(3)
      const top = batches[0] as Array<{ content: string; parentId: string | null }>
      const mid = batches[1] as Array<{ content: string; parentId: string | null }>
      const deep = batches[2] as Array<{ content: string; parentId: string | null }>
      expect(top[0]?.content).toBe('parent')
      expect(top[0]?.parentId).toBe('PAGE_1')
      // child resolves to the freshly-created parent id from the first batch.
      expect(mid[0]?.content).toBe('child')
      expect(mid[0]?.parentId).toBe('NEW0')
      // grandchild resolves to the child id from the second batch.
      expect(deep[0]?.content).toBe('grandchild')
      expect(deep[0]?.parentId).toBe('NEW1')
      expect(ids).toEqual(['NEW0', 'NEW1', 'NEW2'])
    })

    it('falls back to a single block for non-markdown / unrecognizable text', async () => {
      const anchor = makeBlock({ id: 'A', parent_id: 'PAGE_1', position: 0 })
      store.setState({ blocks: [anchor] })
      const { batches } = wireBatchAndReload([anchor])

      // A whitespace-only string parses to nothing → single raw-content block.
      const ids = await store.getState().pasteBlocks('A', '   ')

      expect(ids).toEqual(['NEW0'])
      expect(batches).toHaveLength(1)
      const specs = batches[0] as Array<{ content: string }>
      expect(specs).toHaveLength(1)
      expect(specs[0]?.content).toBe('   ')
    })

    it('reloads and returns [] when the anchor vanished before paste', async () => {
      store.setState({ blocks: [] })
      mockedInvoke.mockResolvedValueOnce([])

      const ids = await store.getState().pasteBlocks('GONE', 'x')

      expect(ids).toEqual([])
      // No create batch fired; a reconciling load did.
      expect(mockedInvoke).toHaveBeenCalledWith(
        'load_page_subtree',
        expect.objectContaining({ rootBlockId: 'PAGE_1' }),
      )
      expect(mockedInvoke).not.toHaveBeenCalledWith('create_blocks_batch', expect.anything())
    })

    it('reconciles with a reload when the create batch fails', async () => {
      const anchor = makeBlock({ id: 'A', parent_id: 'PAGE_1', position: 0 })
      store.setState({ blocks: [anchor] })
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'create_blocks_batch') throw new Error('batch failed')
        if (cmd === 'load_page_subtree') return [anchor]
        return []
      })

      const ids = await store.getState().pasteBlocks('A', 'one\ntwo')

      expect(ids).toEqual([])
      expect(toast.error).toHaveBeenCalled()
      expect(mockedInvoke).toHaveBeenCalledWith(
        'load_page_subtree',
        expect.objectContaining({ rootBlockId: 'PAGE_1' }),
      )
    })
  })
})
