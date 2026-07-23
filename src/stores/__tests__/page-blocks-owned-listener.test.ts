/**
 * Tests for `addOwnedBlockListener` — the STRUCTURAL #713 ownership gate.
 *
 * #2903 — the #713 gate used to be hand-applied (`if (!storeOwnsBlock(...))
 * return`) inside every per-tree document listener, surviving only by
 * convention. `addOwnedBlockListener` centralizes it: a listener registered
 * through it can NEVER run for a tree that doesn't own the gate block, so the
 * invariant is enforced by construction rather than by remembering to write the
 * guard.
 *
 * Kept in its own file (dash, not dot, so it stays clear of the
 * `page-blocks.<concern>.test.ts` split) — it needs none of the tauri-invoke /
 * space-store setup the `page-blocks` load tests rely on: these tests only seed
 * a store's `blocksById` via `setState` and dispatch real document keydowns.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlock } from '@/__tests__/fixtures'
import {
  addOwnedBlockListener,
  createPageBlockStore,
  type PageBlockState,
} from '@/stores/page-blocks'

let store: StoreApi<PageBlockState>

beforeEach(() => {
  store = createPageBlockStore('PAGE_1')
})

describe('addOwnedBlockListener (#713)', () => {
  it('runs the handler — with the owned id typed as a non-null string — when the store owns the block', () => {
    store.setState({ blocks: [makeBlock({ id: 'OWNED' })] })
    const handler = vi.fn()
    const cleanup = addOwnedBlockListener(store, 'OWNED', 'keydown', handler)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', cancelable: true }))

    expect(handler).toHaveBeenCalledTimes(1)
    // The gate is a `blockId is string` type guard, so the owned id is handed
    // to the handler already narrowed — no re-check for null at the call site.
    expect(handler.mock.calls[0]?.[1]).toBe('OWNED')
    cleanup()
  })

  it('does NOT run the handler and does NOT preventDefault when the store does not own the block', () => {
    store.setState({ blocks: [makeBlock({ id: 'OWNED' })] })
    const handler = vi.fn((e: KeyboardEvent) => e.preventDefault())
    const cleanup = addOwnedBlockListener(store, 'FOREIGN', 'keydown', handler)

    const e = new KeyboardEvent('keydown', { key: 'x', cancelable: true })
    document.dispatchEvent(e)

    // Non-tautology: were the gate dropped from `addOwnedBlockListener`, the
    // handler would run and call `preventDefault()`, flipping BOTH assertions
    // — exactly the #713 contract (no side effects, no preventDefault).
    expect(handler).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
    cleanup()
  })

  it('does NOT run the handler when the gate id is null (empty focus/selection)', () => {
    store.setState({ blocks: [makeBlock({ id: 'OWNED' })] })
    const handler = vi.fn()
    const cleanup = addOwnedBlockListener(store, null, 'keydown', handler)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }))

    expect(handler).not.toHaveBeenCalled()
    cleanup()
  })

  it('cleanup removes the exact listener (no leak across mount/unmount)', () => {
    store.setState({ blocks: [makeBlock({ id: 'OWNED' })] })
    const handler = vi.fn()
    const cleanup = addOwnedBlockListener(store, 'OWNED', 'keydown', handler)

    cleanup()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }))

    // If cleanup failed to remove the listener, a journal week/month cycling
    // BlockTrees would accumulate leaked handlers; this guards that path.
    expect(handler).not.toHaveBeenCalled()
  })

  it('#713 multi-tree — for a shared document event, only the OWNING store’s listener fires', () => {
    // Two stores sharing the SAME document (as journal week/month do), both
    // gating on the SAME global id 'BLOCK_A' which lives only in store A.
    const storeA = createPageBlockStore('PAGE_A')
    const storeB = createPageBlockStore('PAGE_B')
    storeA.setState({ blocks: [makeBlock({ id: 'BLOCK_A' })] })
    storeB.setState({ blocks: [makeBlock({ id: 'BLOCK_B' })] })

    const handlerA = vi.fn((e: KeyboardEvent) => e.preventDefault())
    const handlerB = vi.fn((e: KeyboardEvent) => e.preventDefault())
    const cleanupA = addOwnedBlockListener(storeA, 'BLOCK_A', 'keydown', handlerA)
    const cleanupB = addOwnedBlockListener(storeB, 'BLOCK_A', 'keydown', handlerB)

    const e = new KeyboardEvent('keydown', { key: 'x', cancelable: true })
    document.dispatchEvent(e)

    // Non-tautology: dropping the gate would let BOTH handlers fire (the #713
    // double-handling bug) and B would also `preventDefault()`. The gate keeps
    // the non-owning tree provably inert.
    expect(handlerA).toHaveBeenCalledTimes(1)
    expect(handlerB).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(true)

    cleanupA()
    cleanupB()
  })
})
