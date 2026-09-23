// Split from the page-blocks.test.ts monolith (#2929). Concern: page-subtree
// prefetch integration. (`pasteBlocks` moved to `page-blocks.paste.test.ts`.)
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlock } from '@/__tests__/fixtures'
import { type CommandReturns, strictInvokeFallback, stubInvoke } from '@/__tests__/helpers/invoke'
import type { BlockRow } from '@/lib/bindings'
import { t as translate } from '@/lib/i18n'
import {
  _resetPrefetchPageSubtreeForTest,
  consumePrefetchedPageSubtree,
  prefetchPageSubtree,
} from '@/lib/prefetch-page-subtree'
import { createPageBlockStore, type PageBlockState } from '@/stores/page-blocks'
import { useRecentPagesStore } from '@/stores/recent-pages'
import { useSpaceStore } from '@/stores/space'
import { selectPageStack, useTabsStore } from '@/stores/tabs'

const mockedInvoke = vi.mocked(invoke)

const TEST_SPACE_ID = 'SPACE_TEST'

// #1258 — `load_page_subtree` now returns `{ blocks, truncated, total }`
// (the `PageSubtree` wrapper) instead of a bare `BlockRow[]`. `load()` reads
// `.blocks` and surfaces `.truncated`/`.total`. This helper wraps a row array
// in the un-truncated shape so the many `load()` mocks below keep their
// intent (a full, non-truncated page load) without each spelling out the
// wrapper. See the dedicated truncation test for the `truncated: true` path.
function subtreeResp(blocks: BlockRow[]): CommandReturns['load_page_subtree'] {
  return { blocks, truncated: false, total: blocks.length }
}

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
    // Every test installs its own persistent implementation, so restore the
    // strict base first — otherwise one test's handlers would serve the next.
    mockedInvoke.mockImplementation(strictInvokeFallback)
    // #2850 — the prefetch map is a module-level singleton; reset it so a
    // prefetch parked by one test can never leak into the next.
    _resetPrefetchPageSubtreeForTest()
  })

  describe('#2850 prefetch integration', () => {
    it('consumes a live prefetched promise instead of firing a fresh loadPageSubtree IPC', async () => {
      const blocks = [makeBlock({ id: 'A', parent_id: 'PAGE_1' })]
      // The ONE invoke resolution here backs the PREFETCH's IPC. If load()
      // fired a second, fresh IPC it would find no queued response and hang
      // / reject — proving `mockedInvoke` was called exactly once is the
      // load-bearing assertion below.
      stubInvoke(mockedInvoke, { load_page_subtree: () => subtreeResp(blocks) })

      prefetchPageSubtree(TEST_SPACE_ID, 'PAGE_1')
      expect(mockedInvoke).toHaveBeenCalledTimes(1)

      await store.getState().load()

      expect(mockedInvoke).toHaveBeenCalledTimes(1)
      expect(store.getState().blocks).toHaveLength(1)
      expect(store.getState().blocks[0]?.id).toBe('A')
      expect(store.getState().loading).toBe(false)
      // Single-consumption — the entry `load()` just consumed is gone; a
      // second load() call must fetch fresh (falls through to `invoke` again).
      expect(consumePrefetchedPageSubtree(TEST_SPACE_ID, 'PAGE_1')).toBeNull()
    })

    it('a RELOAD (sync/undo) never consumes a prefetch parked for the already-open page — fetches fresh', async () => {
      // Regression guard (PR #2864 review): `load()` is ALSO the reload path
      // (useSyncEvents/useUndoShortcuts). A prefetch parked for the CURRENTLY
      // OPEN page (palette-highlight its recents row then Escape, viewport
      // auto-prefetch of the open row, a self-link) must NOT be served to a
      // reload fired precisely to show post-mutation state — otherwise Ctrl+Z
      // or a just-synced remote edit would render the pre-mutation snapshot
      // for one cycle. Consumption is gated on the first navigation load only.
      // The ORDER is the subject: call 1 is the navigation load, call 2 the
      // prefetch parked for the same page, call 3 the reload that must NOT be
      // served that parked snapshot.
      const snapshots = ['A', 'STALE', 'FRESH']
      let call = 0
      stubInvoke(mockedInvoke, {
        load_page_subtree: () =>
          subtreeResp([makeBlock({ id: snapshots[call++] ?? 'UNEXPECTED', parent_id: 'PAGE_1' })]),
      })

      // Initial navigation load — populates the store (generation 1).
      await store.getState().load()
      expect(store.getState().blocks[0]?.id).toBe('A')

      // A prefetch for the SAME (open) page gets parked before the reload.
      prefetchPageSubtree(TEST_SPACE_ID, 'PAGE_1')
      expect(mockedInvoke).toHaveBeenCalledTimes(2)

      // Reload (generation 2 — e.g. sync:complete / Ctrl+Z) must fetch fresh,
      // NOT serve the stale parked snapshot.
      await store.getState().load()
      expect(mockedInvoke).toHaveBeenCalledTimes(3) // reload fired its own IPC
      expect(store.getState().blocks[0]?.id).toBe('FRESH') // fresh, not STALE
      // The reload left the parked prefetch untouched (it never consumed it);
      // it simply lingers until TTL/sweep.
      expect(consumePrefetchedPageSubtree(TEST_SPACE_ID, 'PAGE_1')).not.toBeNull()
    })

    it('falls through to a fresh IPC when no prefetch is live for this page', async () => {
      const blocks = [makeBlock({ id: 'A', parent_id: 'PAGE_1' })]
      stubInvoke(mockedInvoke, { load_page_subtree: () => subtreeResp(blocks) })

      // No prefetchPageSubtree call — load() has nothing to consume.
      await store.getState().load()

      expect(mockedInvoke).toHaveBeenCalledTimes(1)
      expect(store.getState().blocks).toHaveLength(1)
    })

    it("a prefetch parked for a DIFFERENT page is not consumed by this page's load()", async () => {
      const blocks = [makeBlock({ id: 'A', parent_id: 'PAGE_1' })]
      // The ORDER is the subject: the first call backs the unrelated page's
      // prefetch and never settles; the second is this page's own fetch.
      let call = 0
      stubInvoke(mockedInvoke, {
        load_page_subtree: () =>
          call++ === 0
            ? new Promise<CommandReturns['load_page_subtree']>(() => {})
            : subtreeResp(blocks),
      })
      prefetchPageSubtree(TEST_SPACE_ID, 'SOME_OTHER_PAGE')

      await store.getState().load()

      // Two distinct IPCs: one for the (unrelated, still-pending) prefetch,
      // one for this page's own fresh fetch.
      expect(mockedInvoke).toHaveBeenCalledTimes(2)
      expect(store.getState().blocks).toHaveLength(1)
      // The unrelated prefetch is untouched — still there for its own page.
      expect(consumePrefetchedPageSubtree(TEST_SPACE_ID, 'SOME_OTHER_PAGE')).not.toBeNull()
    })

    it('a prefetched snapshot still runs the #753 load-generation guard (a newer load wins)', async () => {
      const staleBlocks = [makeBlock({ id: 'STALE', parent_id: 'PAGE_1' })]
      const freshBlocks = [makeBlock({ id: 'FRESH', parent_id: 'PAGE_1' })]

      let resolveStale: (v: CommandReturns['load_page_subtree']) => void = () => {}
      // The ORDER is the subject: call 1 backs the prefetch this test parks
      // and holds open; call 2 is the newer load's own fetch, which wins.
      let call = 0
      stubInvoke(mockedInvoke, {
        load_page_subtree: () =>
          call++ === 0
            ? new Promise<CommandReturns['load_page_subtree']>((res) => {
                resolveStale = res
              })
            : subtreeResp(freshBlocks),
      })
      prefetchPageSubtree(TEST_SPACE_ID, 'PAGE_1')

      // Start a load() that will consume the (still-pending) prefetch.
      const stalePromise = store.getState().load()

      // A second, newer load() fires a fresh IPC and resolves FIRST.
      await store.getState().load()
      expect(store.getState().blocks[0]?.id).toBe('FRESH')

      // Now let the stale prefetched promise resolve — #753 must discard it
      // (it started before the newer load claimed the generation).
      resolveStale(subtreeResp(staleBlocks))
      await stalePromise

      expect(store.getState().blocks[0]?.id).toBe('FRESH')
    })

    it('#2802/#2810 — a prefetched snapshot for a page since moved out of the active space still hits the rejection/heal path', async () => {
      useTabsStore.setState({
        tabs: [
          {
            id: '0',
            pageStack: [{ pageId: 'PAGE_1', title: 'Moved page' }],
            label: 'Moved page',
          },
        ],
        activeTabIndex: 0,
        tabsBySpace: {},
        activeTabIndexBySpace: {},
      })
      useRecentPagesStore.setState({
        recentPages: [{ pageId: 'PAGE_1', title: 'Moved page' }],
        recentPagesBySpace: {
          [TEST_SPACE_ID]: [{ pageId: 'PAGE_1', title: 'Moved page' }],
        },
      })
      const membershipRejection = Object.assign(
        new Error(`block 'PAGE_1' not in current space '${TEST_SPACE_ID}'`),
        { kind: 'validation', code: 'PageNotInSpace' },
      )
      // Backs the PREFETCH's IPC — the prefetch itself is what rejects, not
      // a fresh fetch inside load().
      stubInvoke(mockedInvoke, { load_page_subtree: () => Promise.reject(membershipRejection) })

      prefetchPageSubtree(TEST_SPACE_ID, 'PAGE_1')
      await store.getState().load()

      // Exactly one IPC fired (the prefetch's) — load() consumed it rather
      // than dispatching its own, and STILL ran the full heal path on the
      // rejection it observed from that consumed promise.
      expect(mockedInvoke).toHaveBeenCalledTimes(1)
      expect(toast.error).not.toHaveBeenCalled()
      expect(toast.info).toHaveBeenCalledWith(
        translate('error.pageNotInCurrentSpace'),
        expect.objectContaining({ id: 'page-not-in-space' }),
      )
      expect(selectPageStack(useTabsStore.getState())).toEqual([])
      expect(useRecentPagesStore.getState().recentPagesBySpace[TEST_SPACE_ID]).toEqual([])
    })
  })
})
