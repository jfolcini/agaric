// Split from the page-blocks.test.ts monolith (#2929). Concern: pasteBlocks
// and page-subtree prefetch integration.
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlock } from '@/__tests__/fixtures'
import { t as translate } from '@/lib/i18n'
import {
  _resetPrefetchPageSubtreeForTest,
  consumePrefetchedPageSubtree,
  prefetchPageSubtree,
} from '@/lib/prefetch-page-subtree'
import { createPageBlockStore, type FlatBlock, type PageBlockState } from '@/stores/page-blocks'
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
        if (cmd === 'load_page_subtree') return subtreeResp(reloadRows)
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

    // #1442 regression — template-variable substitution must NOT leak into the
    // generic clipboard-paste path. A pasted literal `{{date}}` stays literal.
    it('leaves {{date}}/{{title}} tokens literal (no template substitution)', async () => {
      const anchor = makeBlock({ id: 'A', parent_id: 'PAGE_1', position: 0 })
      store.setState({ blocks: [anchor] })
      const { batches } = wireBatchAndReload([anchor])

      await store.getState().pasteBlocks('A', 'Due: {{date}}\nFor {{title}}')

      const specs = batches[0] as Array<{ content: string }>
      expect(specs.map((s) => s.content)).toEqual(['Due: {{date}}', 'For {{title}}'])
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
      mockedInvoke.mockResolvedValueOnce(subtreeResp([]))

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
        if (cmd === 'load_page_subtree') return subtreeResp([anchor])
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

    // #1484 — human-readable wiki-link resolution on paste/import. The
    // resolvers fetch the active-space page/tag lists and create missing
    // targets through the existing IPC (`create_page_in_space` / `create_block`
    // with `block_type: 'tag'`).
    describe('wiki-link resolution on import (#1484)', () => {
      const EXISTING_PAGE = '01HZ0PAGE0000000000000000A'
      const EXISTING_TAG = '01HZ0TAG00000000000000000B'

      /**
       * Wire the paste batch/reload plus the wiki-link resolution IPC:
       * `list_all_pages_in_space` / `list_all_tags_in_space` return the seeded
       * existing rows; `create_page_in_space` returns a fresh ULID and records
       * the title; `create_block` (tag) returns a fresh BlockRow and records the
       * name. Captures every batch's specs plus the created page titles/tag names.
       */
      function wireWikiLinkIpc(opts: {
        pages?: Array<{ id: string; content: string }>
        tags?: Array<{ tag_id: string; name: string }>
      }): { batches: unknown[][]; createdPages: string[]; createdTags: string[] } {
        const batches: unknown[][] = []
        const createdPages: string[] = []
        const createdTags: string[] = []
        let createdBlocks = 0
        let createdPageN = 0
        let createdTagN = 0
        mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
          if (cmd === 'list_all_pages_in_space') return opts.pages ?? []
          if (cmd === 'list_all_tags_in_space') {
            return (opts.tags ?? []).map((t) => ({
              tag_id: t.tag_id,
              name: t.name,
              usage_count: 0,
              updated_at: '',
            }))
          }
          if (cmd === 'create_page_in_space') {
            const content = (args as { content: string }).content
            createdPages.push(content)
            return `01HZ0CREATEDPAGE0000000${String(createdPageN++).padStart(3, '0')}`
          }
          if (cmd === 'create_block') {
            const a = args as { blockType: string; content: string }
            const id =
              a.blockType === 'tag'
                ? `01HZ0CREATEDTAG00000000${String(createdTagN++).padStart(3, '0')}`
                : `NEWBLOCK${createdBlocks}`
            if (a.blockType === 'tag') createdTags.push(a.content)
            return {
              id,
              block_type: a.blockType,
              content: a.content,
              parent_id: null,
              position: null,
              deleted_at: null,
            }
          }
          if (cmd === 'create_blocks_batch') {
            const specs = ((args as { specs?: unknown })?.specs ?? []) as Array<{
              content: string
              parentId: string | null
            }>
            batches.push(specs)
            return specs.map((s) => ({
              id: `NEW${createdBlocks++}`,
              block_type: 'content',
              content: s.content,
              parent_id: s.parentId,
              position: null,
              deleted_at: null,
            }))
          }
          if (cmd === 'load_page_subtree') {
            return subtreeResp([makeBlock({ id: 'A', parent_id: 'PAGE_1', position: 0 })])
          }
          return []
        })
        return { batches, createdPages, createdTags }
      }

      function firstSpecContent(batches: unknown[][]): string {
        const specs = batches[0] as Array<{ content: string }>
        return specs[0]?.content ?? ''
      }

      it('resolves an existing [[Page Name]] to its internal [[ULID]]', async () => {
        store.setState({ blocks: [makeBlock({ id: 'A', parent_id: 'PAGE_1', position: 0 })] })
        const { batches, createdPages } = wireWikiLinkIpc({
          pages: [{ id: EXISTING_PAGE, content: 'My Page' }],
        })

        await store.getState().pasteBlocks('A', 'see [[My Page]] here')

        expect(firstSpecContent(batches)).toBe(`see [[${EXISTING_PAGE}]] here`)
        expect(createdPages).toEqual([])
      })

      it('creates a missing [[New Page]] and links to the created ULID', async () => {
        store.setState({ blocks: [makeBlock({ id: 'A', parent_id: 'PAGE_1', position: 0 })] })
        const { batches, createdPages } = wireWikiLinkIpc({ pages: [] })

        await store.getState().pasteBlocks('A', 'link [[Fresh Page]]')

        expect(createdPages).toEqual(['Fresh Page'])
        expect(firstSpecContent(batches)).toBe('link [[01HZ0CREATEDPAGE0000000000]]')
      })

      it('resolves an existing #tag and creates a missing one', async () => {
        store.setState({ blocks: [makeBlock({ id: 'A', parent_id: 'PAGE_1', position: 0 })] })
        const { batches, createdTags } = wireWikiLinkIpc({
          tags: [{ tag_id: EXISTING_TAG, name: 'todo' }],
        })

        await store.getState().pasteBlocks('A', 'a #todo and a #newtag')

        expect(createdTags).toEqual(['newtag'])
        expect(firstSpecContent(batches)).toBe(
          `a #[${EXISTING_TAG}] and a #[01HZ0CREATEDTAG00000000000]`,
        )
      })

      it('leaves a canonical [[ULID]] untouched (internal duplicate→paste round-trip)', async () => {
        store.setState({ blocks: [makeBlock({ id: 'A', parent_id: 'PAGE_1', position: 0 })] })
        const { batches, createdPages } = wireWikiLinkIpc({ pages: [] })

        await store.getState().pasteBlocks('A', `dup [[${EXISTING_PAGE}]]`)

        // The ULID body is never looked up or created — it stays canonical.
        expect(firstSpecContent(batches)).toBe(`dup [[${EXISTING_PAGE}]]`)
        expect(createdPages).toEqual([])
        expect(mockedInvoke).not.toHaveBeenCalledWith('create_page_in_space', expect.anything())
      })

      it('leaves an ambiguous duplicate title as plain text (no create)', async () => {
        store.setState({ blocks: [makeBlock({ id: 'A', parent_id: 'PAGE_1', position: 0 })] })
        const { batches, createdPages } = wireWikiLinkIpc({
          pages: [
            { id: '01HZ0DUP000000000000000001', content: 'Dup' },
            { id: '01HZ0DUP000000000000000002', content: 'Dup' },
          ],
        })

        await store.getState().pasteBlocks('A', 'see [[Dup]]')

        expect(firstSpecContent(batches)).toBe('see [[Dup]]')
        expect(createdPages).toEqual([])
      })
    })
  })
  describe('#2850 prefetch integration', () => {
    it('consumes a live prefetched promise instead of firing a fresh loadPageSubtree IPC', async () => {
      const blocks = [makeBlock({ id: 'A', parent_id: 'PAGE_1' })]
      // The ONE invoke resolution here backs the PREFETCH's IPC. If load()
      // fired a second, fresh IPC it would find no queued response and hang
      // / reject — proving `mockedInvoke` was called exactly once is the
      // load-bearing assertion below.
      mockedInvoke.mockResolvedValueOnce(subtreeResp(blocks))

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
      mockedInvoke
        .mockResolvedValueOnce(subtreeResp([makeBlock({ id: 'A', parent_id: 'PAGE_1' })])) // load 1 (fresh)
        .mockResolvedValueOnce(subtreeResp([makeBlock({ id: 'STALE', parent_id: 'PAGE_1' })])) // parked prefetch
        .mockResolvedValueOnce(subtreeResp([makeBlock({ id: 'FRESH', parent_id: 'PAGE_1' })])) // reload (fresh)

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
      mockedInvoke.mockResolvedValueOnce(subtreeResp(blocks))

      // No prefetchPageSubtree call — load() has nothing to consume.
      await store.getState().load()

      expect(mockedInvoke).toHaveBeenCalledTimes(1)
      expect(store.getState().blocks).toHaveLength(1)
    })

    it("a prefetch parked for a DIFFERENT page is not consumed by this page's load()", async () => {
      const otherPagePromiseNeverResolves = new Promise(() => {})
      mockedInvoke.mockReturnValueOnce(otherPagePromiseNeverResolves)
      prefetchPageSubtree(TEST_SPACE_ID, 'SOME_OTHER_PAGE')

      const blocks = [makeBlock({ id: 'A', parent_id: 'PAGE_1' })]
      mockedInvoke.mockResolvedValueOnce(subtreeResp(blocks))

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

      let resolveStale: (v: unknown) => void = () => {}
      mockedInvoke.mockReturnValueOnce(
        new Promise((res) => {
          resolveStale = res
        }),
      )
      prefetchPageSubtree(TEST_SPACE_ID, 'PAGE_1')

      // Start a load() that will consume the (still-pending) prefetch.
      const stalePromise = store.getState().load()

      // A second, newer load() fires a fresh IPC and resolves FIRST.
      mockedInvoke.mockResolvedValueOnce(subtreeResp(freshBlocks))
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
      mockedInvoke.mockRejectedValueOnce(membershipRejection)

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
