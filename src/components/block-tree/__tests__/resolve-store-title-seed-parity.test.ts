/**
 * #4228 acceptance criterion 2 — all three resolve-store BLOCK-title seed
 * call sites must write BYTE-IDENTICAL titles for the same underlying
 * block content:
 *
 *   1. `searchBlockRefs`          — src/components/block-tree/use-block-resolve.ts
 *   2. `fetchAndCacheLinks`       — src/components/block-tree/use-block-link-resolve.ts
 *   3. `useBlockNavigateToLink`'s `handleNavigate` — use-block-navigate-to-link.ts
 *
 * Before #4228: (1) stored the FULL raw content (via `blockContentOr`),
 * while (2) and (3) each independently computed `content.slice(0, 60)` —
 * and all three used a DIFFERENT placeholder for blank/empty content
 * ("Untitled" for (1), the `[[id…]]` broken-link shape for (2)/(3)).
 * `batchSet` / `set` diff on value (`@/stores/resolve.ts`), so whichever
 * seeder ran last for a given id silently won, churning `version` (and
 * every version-subscribed consumer) on every disagreement.
 *
 * These tests drive the actual production call sites (not the shared
 * helper in isolation — that's `@/lib/__tests__/block-title.test.ts`) and
 * assert their resulting cache writes are identical strings.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import type { TFunction } from 'i18next'
import { useRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockedSearchBlocks = vi.hoisted(() => vi.fn())
const mockedBatchResolve = vi.hoisted(() => vi.fn())
const mockedGetBlock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bindings')>()
  return {
    ...actual,
    commands: {
      ...actual.commands,
      searchBlocks: (...args: unknown[]) =>
        mockedSearchBlocks(...args).then((data: unknown) => ({ status: 'ok', data })),
      batchResolve: (...args: unknown[]) =>
        mockedBatchResolve(...args).then((data: unknown) => ({ status: 'ok', data })),
      getBlock: (...args: unknown[]) =>
        mockedGetBlock(...args).then((data: unknown) => ({ status: 'ok', data })),
    },
  }
})

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { fetchAndCacheLinks } from '@/components/block-tree/use-block-link-resolve'
import { useBlockNavigateToLink } from '@/components/block-tree/use-block-navigate-to-link'
import { useBlockResolve } from '@/components/block-tree/use-block-resolve'
import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import type { BlockRow } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { keyFor, useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

const TEST_SPACE_ID = 'SPACE_TEST'

function mkSearchBlock(id: string, content: string | null) {
  return {
    id,
    block_type: 'block' as const,
    content,
    parent_id: null,
    position: 0,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    page_id: null,
  }
}

function makeBlockRow(overrides: Record<string, unknown>): BlockRow {
  return {
    id: 'X',
    block_type: 'content',
    content: '',
    parent_id: null,
    position: 0,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    ...overrides,
  } as BlockRow
}

function useNavigateHarness() {
  const rovingEditorRef = useRef<RovingEditorHandle | null>(null)
  const handleFlushRef = useRef<() => string | null>(() => null)
  return useBlockNavigateToLink({
    rovingEditorRef,
    handleFlushRef,
    load: vi.fn().mockResolvedValue(undefined),
    setFocused: vi.fn(),
    rootParentId: null,
    onNavigateToPage: vi.fn(),
    t: ((k: string) => k) as unknown as TFunction,
  })
}

/** Seed via path 1 — `searchBlockRefs`. */
async function seedViaSearchBlockRefs(id: string, content: string | null): Promise<void> {
  mockedSearchBlocks.mockResolvedValueOnce({
    items: [mkSearchBlock(id, content)],
    next_cursor: null,
    has_more: false,
    total_count: null,
  })
  const { result } = renderHook(() => useBlockResolve())
  await act(async () => {
    await result.current.searchBlockRefs('query matching two chars')
  })
}

/** Seed via path 2 — `fetchAndCacheLinks`. */
async function seedViaFetchAndCacheLinks(
  id: string,
  content: string | null,
  blockType: 'content' | 'page' | 'tag' = 'content',
): Promise<void> {
  mockedBatchResolve.mockResolvedValueOnce([
    { id, title: content, block_type: blockType, deleted: false },
  ])
  await fetchAndCacheLinks(new Set([id]), TEST_SPACE_ID, () => false)
}

/** Seed via path 3 — `useBlockNavigateToLink`'s `handleNavigate`. */
async function seedViaHandleNavigate(
  id: string,
  content: string | null,
  blockType: 'content' | 'page' | 'tag' = 'content',
): Promise<void> {
  mockedGetBlock.mockResolvedValueOnce(
    makeBlockRow({ id, block_type: blockType, content, parent_id: null }),
  )
  // The space-scope check: report the target as belonging to the active space.
  mockedBatchResolve.mockResolvedValueOnce([
    { id, title: content, block_type: blockType, deleted: false },
  ])
  const { result } = renderHook(() => useNavigateHarness())
  await act(async () => {
    await result.current.handleNavigate(id)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  useResolveStore.setState({ cache: new Map(), version: 0, _preloaded: false })
  useSpaceStore.setState({
    currentSpaceId: TEST_SPACE_ID,
    availableSpaces: [{ id: TEST_SPACE_ID, name: 'Test', accent_color: null }],
    isReady: true,
  })
})

describe('resolve-store block-title seed parity (#4228)', () => {
  it('all three seed paths write the SAME title for the same long (>60 char), single-line content', async () => {
    const longContent = 'x'.repeat(120)

    await seedViaSearchBlockRefs('LONG_A', longContent)
    const titleFromSearchBlockRefs = useResolveStore
      .getState()
      .cache.get(keyFor(TEST_SPACE_ID, 'LONG_A'))?.title

    await seedViaFetchAndCacheLinks('LONG_B', longContent)
    const titleFromFetchAndCacheLinks = useResolveStore
      .getState()
      .cache.get(keyFor(TEST_SPACE_ID, 'LONG_B'))?.title

    await seedViaHandleNavigate('LONG_C', longContent)
    const titleFromHandleNavigate = await waitFor(() => {
      const title = useResolveStore.getState().cache.get(keyFor(TEST_SPACE_ID, 'LONG_C'))?.title
      expect(title).toBeDefined()
      return title
    })

    expect(titleFromSearchBlockRefs).toBeDefined()
    expect(titleFromFetchAndCacheLinks).toBeDefined()
    // The load-bearing assertion: byte-identical across all three paths.
    expect(titleFromSearchBlockRefs).toBe(titleFromFetchAndCacheLinks)
    expect(titleFromFetchAndCacheLinks).toBe(titleFromHandleNavigate)
    // And pinned to the exact expected shape (57 chars + ellipsis), so this
    // test fails RED — not vacuously — against the pre-#4228 code, where
    // path 1 stored the full untruncated 120-char string.
    expect(titleFromSearchBlockRefs).toBe(`${'x'.repeat(57)}...`)
  })

  it('all three seed paths write the SAME title for resolved-but-blank content', async () => {
    await seedViaSearchBlockRefs('BLANK_A', '')
    const titleFromSearchBlockRefs = useResolveStore
      .getState()
      .cache.get(keyFor(TEST_SPACE_ID, 'BLANK_A'))?.title

    await seedViaFetchAndCacheLinks('BLANK_B', '')
    const titleFromFetchAndCacheLinks = useResolveStore
      .getState()
      .cache.get(keyFor(TEST_SPACE_ID, 'BLANK_B'))?.title

    await seedViaHandleNavigate('BLANK_C', '')
    const titleFromHandleNavigate = await waitFor(() => {
      const title = useResolveStore.getState().cache.get(keyFor(TEST_SPACE_ID, 'BLANK_C'))?.title
      expect(title).toBeDefined()
      return title
    })

    // The load-bearing assertion: byte-identical across all three paths.
    // Pre-#4228, path 1 wrote "Untitled" while paths 2/3 wrote the
    // `[[id…]]` broken-link placeholder — a real 3-way divergence for the
    // exact same (blank) content.
    expect(titleFromSearchBlockRefs).toBe(titleFromFetchAndCacheLinks)
    expect(titleFromFetchAndCacheLinks).toBe(titleFromHandleNavigate)
    // Pin the SHAPE too, not just mutual equality. Without this the three
    // assertions above would still hold if every path converged on `''`
    // (a blank chip — the very defect #4228 fixes) or on some other shared
    // wrong value; the ids differ per path, so an id-derived placeholder
    // like `[[BLANK_B…]]` cannot satisfy the equality either way.
    expect(titleFromSearchBlockRefs).toBe(t('block.untitled'))
  })

  it('seeding the SAME id twice via two different paths with the same content is a true no-op (no extra version bump)', async () => {
    const content = 'shared content under 60 chars'

    await seedViaSearchBlockRefs('SAME_ID', content)
    const versionAfterFirstSeed = useResolveStore.getState().version
    const titleAfterFirstSeed = useResolveStore
      .getState()
      .cache.get(keyFor(TEST_SPACE_ID, 'SAME_ID'))?.title

    // Re-seed the SAME id via a DIFFERENT path with the SAME underlying
    // content. If the two paths compute different bytes, `batchSet`'s
    // diff-on-value guard (@/stores/resolve.ts) detects a change and bumps
    // `version` again — the exact churn #4228 describes. Byte-identical
    // seeders make this a true no-op.
    await seedViaFetchAndCacheLinks('SAME_ID', content)

    expect(useResolveStore.getState().version).toBe(versionAfterFirstSeed)
    expect(useResolveStore.getState().cache.get(keyFor(TEST_SPACE_ID, 'SAME_ID'))?.title).toBe(
      titleAfterFirstSeed,
    )
  })
})

describe('resolve-store title parity — PAGE and TAG targets (#4228 review)', () => {
  // The original parity suite only ever passed `block_type: 'content'`, which
  // is exactly why a page-capping regression in `handleNavigate` shipped green
  // past it. `batch_resolve` and `get_block` both return `content` for EVERY
  // type, so all three seeders see page and tag rows too — and capping one
  // breaks `getPageDisplayName(title, 'leaf')` in `renderBlockLink` while
  // disagreeing with `preload`, which writes `p.content` verbatim.
  const LONG_PATH = `Engineering/Platform/Observability/${'z'.repeat(40)}`

  it('both id-fetching seeders write a long PAGE path verbatim, byte-identically', async () => {
    expect(LONG_PATH.length).toBeGreaterThan(60)

    await seedViaFetchAndCacheLinks('PAGE_B', LONG_PATH, 'page')
    const viaFetch = useResolveStore.getState().cache.get(keyFor(TEST_SPACE_ID, 'PAGE_B'))?.title

    await seedViaHandleNavigate('PAGE_C', LONG_PATH, 'page')
    const viaNavigate = await waitFor(() => {
      const title = useResolveStore.getState().cache.get(keyFor(TEST_SPACE_ID, 'PAGE_C'))?.title
      expect(title).toBeDefined()
      return title
    })

    expect(viaFetch).toBe(LONG_PATH)
    expect(viaNavigate).toBe(LONG_PATH)
    expect(viaNavigate).toBe(viaFetch)
  })

  it('and a long TAG name verbatim too', async () => {
    const longTag = `area/${'t'.repeat(80)}`

    await seedViaFetchAndCacheLinks('TAG_B', longTag, 'tag')
    const viaFetch = useResolveStore.getState().cache.get(keyFor(TEST_SPACE_ID, 'TAG_B'))?.title

    await seedViaHandleNavigate('TAG_C', longTag, 'tag')
    const viaNavigate = await waitFor(() => {
      const title = useResolveStore.getState().cache.get(keyFor(TEST_SPACE_ID, 'TAG_C'))?.title
      expect(title).toBeDefined()
      return title
    })

    expect(viaFetch).toBe(longTag)
    expect(viaNavigate).toBe(viaFetch)
  })
})
