/**
 * #3306 — integration test for the space-scoping of the `[[ULID]]` navigate
 * path (`useBlockNavigateToLink`).
 *
 * This suite deliberately does NOT stub `commands.getBlock` / `batchResolve`.
 * The whole defect lives in the ASYMMETRY between the two backend commands,
 * so a hand-rolled stub of either one would test the stub rather than the bug:
 *
 *   - `get_block` → `get_active_block_inner`:
 *     `SELECT … FROM blocks WHERE id = ? AND deleted_at IS NULL`
 *     — one soft-delete predicate, NO space predicate.
 *   - `batch_resolve` → `batch_resolve_inner`:
 *     `… WHERE b.id IN (…) AND (?2 IS NULL OR b.space_id = ?2)`
 *     — takes a mandatory `SpaceScope` and drops foreign-space rows.
 *
 * So every IPC here is routed through the real in-memory backend model
 * (`src/lib/tauri-mock`), whose `get_block` / `batch_resolve` handlers
 * reproduce exactly that asymmetry, and the fixture is built by actually
 * calling `create_page_in_space` with a second space id — the same way
 * PageHeader's "Move to space" produces cross-space links in the product.
 *
 * The invariant under test: a `[[ULID]]` pointing at a block in ANOTHER space
 * must not navigate and — the actual leak — must not write that block's title
 * into the ACTIVE space's resolve cache, which is keyed `${spaceId}::${ulid}`
 * and would otherwise render the foreign title on the chip for the rest of the
 * session.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, renderHook } from '@testing-library/react'
import type { TFunction } from 'i18next'
import { useRef } from 'react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useBlockNavigateToLink } from '@/components/block-tree/use-block-navigate-to-link'
import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import { t as translate } from '@/lib/i18n'
import { SEED_IDS } from '@/lib/tauri-mock'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { seedBlocks } from '@/lib/tauri-mock/seed'
import { keyFor, useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

const ACTIVE_SPACE = 'SPACE_PERSONAL'
const FOREIGN_SPACE = 'SPACE_WORK_CROSS'

interface HarnessParams {
  onNavigateToPage: (pageId: string, title?: string, blockId?: string) => void
  load: () => Promise<void>
  setFocused: (id: string | null) => void
}

function useHarness(params: HarnessParams) {
  const rovingEditorRef = useRef<RovingEditorHandle | null>(null)
  const handleFlushRef = useRef<() => string | null>(() => null)

  return useBlockNavigateToLink({
    rovingEditorRef,
    handleFlushRef,
    load: params.load,
    setFocused: params.setFocused,
    rootParentId: 'SOME_OTHER_ROOT',
    onNavigateToPage: params.onNavigateToPage,
    t: translate as unknown as TFunction,
  })
}

/** Create a page in `FOREIGN_SPACE` and return its id. */
function seedForeignPage(content: string): string {
  return dispatch('create_page_in_space', {
    parentId: null,
    content,
    spaceId: FOREIGN_SPACE,
  }) as string
}

beforeEach(() => {
  seedBlocks()
  vi.mocked(invoke).mockImplementation((cmd: string, args?: unknown) => {
    // Synchronous throws from the model must surface as a rejected IPC, the
    // way the real transport does.
    try {
      return Promise.resolve(dispatch(cmd, args)) as Promise<never>
    } catch (err) {
      return Promise.reject(err) as Promise<never>
    }
  })
  useResolveStore.setState({ cache: new Map(), version: 0, _preloaded: false })
  useSpaceStore.setState({
    currentSpaceId: ACTIVE_SPACE,
    availableSpaces: [
      { id: ACTIVE_SPACE, name: 'Personal', accent_color: null },
      { id: FOREIGN_SPACE, name: 'Work', accent_color: null },
    ],
    isReady: true,
  })
  vi.mocked(toast.info).mockClear()
})

describe('useBlockNavigateToLink — cross-space targets', () => {
  it('refuses to navigate to a page that lives in another space', async () => {
    const foreignPageId = seedForeignPage('Q3 Compensation Review')
    const onNavigateToPage = vi.fn()

    // Sanity-check the fixture models the real asymmetry: the unscoped
    // single-row read DOES return the foreign row (that is the whole problem),
    // while the space-scoped resolver drops it.
    expect(dispatch('get_block', { blockId: foreignPageId })).toBeTruthy()
    expect(
      dispatch('batch_resolve', {
        ids: [foreignPageId],
        scope: { kind: 'active', space_id: ACTIVE_SPACE },
      }),
    ).toEqual([])

    const { result } = renderHook(() =>
      useHarness({
        onNavigateToPage,
        load: vi.fn().mockResolvedValue(undefined),
        setFocused: vi.fn(),
      }),
    )

    await act(async () => {
      await result.current.handleNavigate(foreignPageId)
    })

    expect(onNavigateToPage).not.toHaveBeenCalled()
  })

  it('does not leak the foreign page title into the active space resolve cache', async () => {
    const foreignPageId = seedForeignPage('Q3 Compensation Review')

    const { result } = renderHook(() =>
      useHarness({
        onNavigateToPage: vi.fn(),
        load: vi.fn().mockResolvedValue(undefined),
        setFocused: vi.fn(),
      }),
    )

    await act(async () => {
      await result.current.handleNavigate(foreignPageId)
    })

    // The leak the finding is about: `useResolveStore.set` keys by the ACTIVE
    // space, so a foreign title written here renders on the chip in this space
    // until the next space switch flushes it.
    const cache = useResolveStore.getState().cache
    expect(cache.has(keyFor(ACTIVE_SPACE, foreignPageId))).toBe(false)
    expect([...cache.values()].map((e) => e.title)).not.toContain('Q3 Compensation Review')
  })

  it('tells the user the target lives in another space', async () => {
    const foreignPageId = seedForeignPage('Q3 Compensation Review')

    const { result } = renderHook(() =>
      useHarness({
        onNavigateToPage: vi.fn(),
        load: vi.fn().mockResolvedValue(undefined),
        setFocused: vi.fn(),
      }),
    )

    await act(async () => {
      await result.current.handleNavigate(foreignPageId)
    })

    expect(vi.mocked(toast.info)).toHaveBeenCalledWith(
      translate('error.pageNotInCurrentSpace'),
      expect.objectContaining({ id: 'page-not-in-space' }),
    )
  })

  it('still navigates normally to a target inside the active space', async () => {
    // Positive control — the guard must not break the mainstream path, and it
    // is what proves the two cross-space assertions above are about the SPACE,
    // not about the hook being broken outright.
    const onNavigateToPage = vi.fn()

    const { result } = renderHook(() =>
      useHarness({
        onNavigateToPage,
        load: vi.fn().mockResolvedValue(undefined),
        setFocused: vi.fn(),
      }),
    )

    await act(async () => {
      await result.current.handleNavigate(SEED_IDS.PAGE_GETTING_STARTED)
    })

    expect(onNavigateToPage).toHaveBeenCalledWith(SEED_IDS.PAGE_GETTING_STARTED, expect.any(String))
    expect(
      useResolveStore.getState().cache.has(keyFor(ACTIVE_SPACE, SEED_IDS.PAGE_GETTING_STARTED)),
    ).toBe(true)
  })

  it('fails closed when the space store has not hydrated', async () => {
    // An unverifiable target must not be trusted — same policy as the resolve
    // store's FE-H-22 preload guard.
    useSpaceStore.setState({ currentSpaceId: null, isReady: false })
    const onNavigateToPage = vi.fn()

    const { result } = renderHook(() =>
      useHarness({
        onNavigateToPage,
        load: vi.fn().mockResolvedValue(undefined),
        setFocused: vi.fn(),
      }),
    )

    await act(async () => {
      await result.current.handleNavigate(SEED_IDS.PAGE_GETTING_STARTED)
    })

    expect(onNavigateToPage).not.toHaveBeenCalled()
    expect(useResolveStore.getState().cache.size).toBe(0)
  })
})
