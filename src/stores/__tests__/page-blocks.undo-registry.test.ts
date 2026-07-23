// Split from the page-blocks.test.ts monolith (#2929). Concern: undo store
// integration, the ref-counted page-store registry, and clearPage on
// provider unmount.
import { invoke } from '@tauri-apps/api/core'
import { render } from '@testing-library/react'
import { createElement, type ReactElement, type ReactNode, useContext } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlock } from '@/__tests__/fixtures'
import { _resetPrefetchPageSubtreeForTest } from '@/lib/prefetch-page-subtree'
import {
  createPageBlockStore,
  forEachPageStore,
  getPageStore,
  PageBlockContext,
  type PageBlockState,
  PageBlockStoreProvider,
} from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)

const TEST_SPACE_ID = 'SPACE_TEST'

// #1258 — `load_page_subtree` now returns `{ blocks, truncated, total }`
// (the `PageSubtree` wrapper) instead of a bare `BlockRow[]`. `load()` reads
// `.blocks` and surfaces `.truncated`/`.total`. This helper wraps a row array
// in the un-truncated shape so the many `load()` mocks below keep their
// intent (a full, non-truncated page load) without each spelling out the
// wrapper. See the dedicated truncation test for the `truncated: true` path.
function subtreeResp<T>(blocks: T[]): { blocks: T[]; truncated: boolean; total: number } {
  return { blocks, truncated: false, total: blocks.length }
}

// #2849 PR2 — `createBelow` now generates the new block's id CLIENT-SIDE (a
// ULID) BEFORE the create IPC, so the row can be spliced in optimistically. Mock
// the generator deterministically (`CID_1`, `CID_2`, …, reset per test) so tests
// can address the new block by a stable, predictable id instead of a random
// ULID. `resetClientIds` runs in `beforeEach`.
const { newBlockIdMock, resetClientIds } = vi.hoisted(() => {
  let counter = 0
  return {
    newBlockIdMock: () => `CID_${++counter}`,
    resetClientIds: () => {
      counter = 0
    },
  }
})
vi.mock('@/lib/block-id', () => ({
  newBlockId: newBlockIdMock,
}))

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
    // #2849 PR2 — reset the client-ULID counter so each test's first
    // `createBelow` mints `CID_1` deterministically.
    resetClientIds()
    // #2850 — the prefetch map is a module-level singleton; reset it so a
    // prefetch parked by one test can never leak into the next.
    _resetPrefetchPageSubtreeForTest()
  })

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

    // -------------------------------------------------------------------------
    // #2468 — ref-addressed undo: every migrated mutation threads the
    // response's `op_refs` (the exact op-log refs the command appended) into
    // the undo notification, so Ctrl+Z submits captured refs instead of a
    // positional depth. The two batch commands (`move_blocks_batch`,
    // `create_blocks_batch`) do not surface refs yet — their flows must keep
    // the ref-LESS call shape (positional `undoPageGroup` fallback).
    // -------------------------------------------------------------------------
    describe('#2468 op_refs threading', () => {
      const REFS = [{ device_id: 'dev1', seq: 42 }]

      it('createBelow forwards the create_block response op_refs', async () => {
        store.setState({ blocks: [makeBlock({ id: 'A', position: 0 })] })
        mockedInvoke.mockResolvedValueOnce({
          id: 'NEW',
          block_type: 'text',
          content: '',
          parent_id: null,
          position: 1,
          deleted_at: null,
          op_refs: REFS,
        })

        await store.getState().createBelow('A')

        expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1', REFS)
      })

      it('edit forwards the edit_block response op_refs', async () => {
        store.setState({ blocks: [makeBlock({ id: 'A', content: 'old' })] })
        mockedInvoke.mockResolvedValueOnce({
          id: 'A',
          block_type: 'text',
          content: 'new',
          parent_id: null,
          position: 0,
          deleted_at: null,
          op_refs: REFS,
        })

        await store.getState().edit('A', 'new')

        // #2600 — edit threads a per-block coalesce key (`edit:<blockId>`) so a
        // block's debounced mid-typing commits + its blur commit fold into one
        // undo entry.
        expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1', REFS, 'edit:A')
      })

      it('remove forwards the delete_block response op_refs', async () => {
        store.setState({ blocks: [makeBlock({ id: 'A' })] })
        mockedInvoke.mockResolvedValueOnce({
          block_id: 'A',
          deleted_at: '2025-01-01T00:00:00Z',
          descendants_affected: 0,
          op_refs: REFS,
        })

        await store.getState().remove('A')

        expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1', REFS)
      })

      it('reorder forwards the move_block response op_refs', async () => {
        store.setState({
          blocks: [
            makeBlock({ id: 'A', position: 0, parent_id: null }),
            makeBlock({ id: 'B', position: 1, parent_id: null }),
            makeBlock({ id: 'C', position: 2, parent_id: null }),
          ],
        })
        mockedInvoke.mockResolvedValueOnce({
          block_id: 'C',
          new_parent_id: null,
          new_position: 0,
          op_refs: REFS,
        })

        await store.getState().reorder('C', 0)

        expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1', REFS)
      })

      it('moveToParent forwards the move_block response op_refs', async () => {
        store.setState({
          blocks: [
            makeBlock({ id: 'A', position: 0, parent_id: null }),
            makeBlock({ id: 'B', position: 1, parent_id: null }),
          ],
        })
        mockedInvoke.mockImplementation(async (cmd: string) => {
          if (cmd === 'move_block') {
            return { block_id: 'A', new_parent_id: 'B', new_position: 1, op_refs: REFS }
          }
          if (cmd === 'load_page_subtree') return subtreeResp([])
          return undefined
        })

        await store.getState().moveToParent('A', 'B', 0)

        expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1', REFS)
      })

      it('moveBlocks (batch) keeps the ref-less positional fallback', async () => {
        store.setState({
          blocks: [
            makeBlock({ id: 'A', position: 0, parent_id: null }),
            makeBlock({ id: 'B', position: 1, parent_id: null }),
          ],
        })
        mockedInvoke.mockImplementation(async (cmd: string) => {
          if (cmd === 'move_blocks_batch') {
            return [{ block_id: 'A', new_parent_id: 'B', new_position: 1 }]
          }
          if (cmd === 'load_page_subtree') return subtreeResp([])
          return undefined
        })

        await store.getState().moveBlocks(['A'], 'B', 0)

        // Exactly ONE argument — no refs threaded: the undo store must record
        // a positional-fallback entry for the batch flow.
        expect(mockOnNewAction).toHaveBeenCalledTimes(1)
        expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1')
        expect(mockOnNewAction.mock.calls[0]).toHaveLength(1)
      })

      it('pasteBlocks (batch create) keeps the ref-less positional fallback', async () => {
        const anchor = makeBlock({ id: 'A', parent_id: 'PAGE_1', position: 0 })
        store.setState({ blocks: [anchor] })
        mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
          if (cmd === 'create_blocks_batch') {
            const specs = ((args as { specs?: unknown })?.specs ?? []) as Array<{
              content: string
              parentId: string | null
            }>
            return specs.map((s, i) => ({
              id: `NEW${i}`,
              block_type: 'content',
              content: s.content,
              parent_id: s.parentId,
              position: null,
              deleted_at: null,
            }))
          }
          if (cmd === 'load_page_subtree') return subtreeResp([anchor])
          return []
        })

        await store.getState().pasteBlocks('A', 'one\ntwo')

        expect(mockOnNewAction).toHaveBeenCalledTimes(1)
        expect(mockOnNewAction).toHaveBeenCalledWith('PAGE_1')
        expect(mockOnNewAction.mock.calls[0]).toHaveLength(1)
      })
    })
  })
  describe('#1075 page-store registry (ref-counted)', () => {
    // PageBlockStoreProvider declares `children` as a required prop, so the props
    // arg must include it. We cast to a permissive shape here to keep the props
    // object simple while satisfying both TS and the noChildrenProp lint rule.
    const Provider = PageBlockStoreProvider as unknown as (props: {
      pageId: string
      children?: ReactNode
    }) => ReactElement

    it('getPageStore returns the SAME store instance the provider gives its context', () => {
      const pageId = 'IDENTITY_PAGE'
      // A probe inside the provider tree captures the exact store the React
      // context hands to consumers (usePageBlockStoreApi reads PageBlockContext).
      let contextStore: StoreApi<PageBlockState> | undefined
      function Probe(): null {
        contextStore = useContext(PageBlockContext) ?? undefined
        return null
      }
      const view = render(createElement(Provider, { pageId }, createElement(Probe)))

      expect(contextStore).toBeDefined()
      // The single source of truth: the registry exposes the very instance the
      // editor renders from — so getPageStore(pageId).load() reloads in place.
      expect(getPageStore(pageId)).toBe(contextStore)

      view.unmount()
      expect(getPageStore(pageId)).toBeUndefined()
    })

    it('two providers for the same pageId → one slot; unmounting one keeps the store, last unmount cleans up', () => {
      const pageId = 'GUARD_PAGE'
      expect(getPageStore(pageId)).toBeUndefined()

      // Mount provider A → registers store A (refCount 1).
      const a = render(createElement(Provider, { pageId }, 'a'))
      const storeA = getPageStore(pageId)
      expect(storeA).toBeDefined()

      // Mount provider B for the same pageId → shares the slot (refCount 2);
      // the slot adopts the newest mounted provider's store so getPageStore
      // tracks the active provider.
      const b = render(createElement(Provider, { pageId }, 'b'))
      const storeB = getPageStore(pageId)
      expect(storeB).toBeDefined()

      // Unmount provider A: ref-count drops to 1 — the slot (and its store)
      // MUST survive because B is still mounted.
      a.unmount()
      expect(getPageStore(pageId)).toBe(storeB)

      // Only when the LAST provider unmounts does the slot disappear.
      b.unmount()
      expect(getPageStore(pageId)).toBeUndefined()
    })

    it('#1560 — out-of-order unmount (slot owner first) re-points to a live store, never strands an orphan', () => {
      const pageId = 'ORPHAN_GUARD_PAGE'
      expect(getPageStore(pageId)).toBeUndefined()

      // Mount provider A → registers store A (refCount 1, slot.store = A).
      const a = render(createElement(Provider, { pageId }, 'a'))
      const storeA = getPageStore(pageId)
      expect(storeA).toBeDefined()

      // Mount provider B for the same pageId → shares the slot (refCount 2);
      // the slot ADOPTS B's store so getPageStore now tracks B.
      const b = render(createElement(Provider, { pageId }, 'b'))
      const storeB = getPageStore(pageId)
      expect(storeB).toBeDefined()
      // Each provider creates its own store instance, so the two differ — that
      // is what makes a dangling pointer observable.
      expect(storeB).not.toBe(storeA)

      // Unmount the slot OWNER (B, the newer provider) FIRST — the out-of-order
      // case. Without the re-point fallback the slot would still point at B's
      // now-unmounted store; with it the slot adopts the surviving provider A.
      b.unmount()
      expect(getPageStore(pageId)).toBe(storeA)
      // And never the orphaned (unmounted) store.
      expect(getPageStore(pageId)).not.toBe(storeB)

      // Final unmount of A cleans the slot entirely.
      a.unmount()
      expect(getPageStore(pageId)).toBeUndefined()
    })

    it('forEachPageStore iterates only currently-mounted stores', () => {
      const p1 = 'EACH_PAGE_1'
      const p2 = 'EACH_PAGE_2'
      const v1 = render(createElement(Provider, { pageId: p1 }, 'a'))
      const v2 = render(createElement(Provider, { pageId: p2 }, 'b'))

      const seen = new Map<string, StoreApi<PageBlockState>>()
      forEachPageStore((pId, storeApi) => seen.set(pId, storeApi))
      expect(seen.get(p1)).toBe(getPageStore(p1))
      expect(seen.get(p2)).toBe(getPageStore(p2))

      v1.unmount()
      const after = new Set<string>()
      forEachPageStore((pageId) => after.add(pageId))
      expect(after.has(p1)).toBe(false)
      expect(after.has(p2)).toBe(true)

      v2.unmount()
    })
  })
  describe('undo clearPage on provider unmount (#753)', () => {
    // PageBlockStoreProvider declares `children` as required; cast keeps the
    // props object simple (same pattern as the registry-guard tests above).
    const Provider = PageBlockStoreProvider as unknown as (props: {
      pageId: string
      children?: ReactNode
    }) => ReactElement

    it('clears the page undo state when the provider unmounts', () => {
      const pageId = 'JOURNAL_DAY_PAGE'

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
})
