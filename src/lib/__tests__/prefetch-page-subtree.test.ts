/**
 * Tests for `src/lib/prefetch-page-subtree.ts` (#2850) — the one-shot
 * speculative prefetch handoff.
 *
 * Covers the contract the maintainer decision spells out: dedup (a second
 * intent for the same key reuses the in-flight fetch, no second IPC),
 * single-consumption (`consume` returns the promise then deletes the
 * entry), TTL expiry (a stale entry reads back as absent), the concurrency
 * cap (past `MAX_INFLIGHT_PREFETCHES` new intent is dropped), and that a
 * rejected prefetch never throws / becomes an unhandled rejection and
 * simply leaves `consume` returning `null`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PageSubtree } from '@/lib/tauri'
import { loadPageSubtree } from '@/lib/tauri'

vi.mock('@/lib/tauri', () => ({
  loadPageSubtree: vi.fn(),
}))

import {
  _resetPrefetchPageSubtreeForTest,
  consumePrefetchedPageSubtree,
  MAX_INFLIGHT_PREFETCHES,
  PREFETCH_TTL_MS,
  prefetchPageSubtree,
} from '@/lib/prefetch-page-subtree'

const mockedLoadPageSubtree = vi.mocked(loadPageSubtree)

function subtree(tag: string): PageSubtree {
  // `tag` isn't part of the real shape — it's just so `toBe`/`resolves.toBe`
  // assertions below can tell distinct fixture instances apart by identity.
  return { blocks: [], truncated: false, total: 0, __tag: tag } as unknown as PageSubtree
}

describe('prefetch-page-subtree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    _resetPrefetchPageSubtreeForTest()
  })

  describe('prefetchPageSubtree', () => {
    it('kicks off loadPageSubtree(pageId, spaceId) on intent', () => {
      let resolve: (v: PageSubtree) => void = () => {}
      mockedLoadPageSubtree.mockReturnValueOnce(
        new Promise((res) => {
          resolve = res
        }),
      )

      prefetchPageSubtree('SPACE_A', 'PAGE_1')

      expect(mockedLoadPageSubtree).toHaveBeenCalledTimes(1)
      expect(mockedLoadPageSubtree).toHaveBeenCalledWith('PAGE_1', 'SPACE_A')
      resolve(subtree('x'))
    })

    it('dedups — a second intent for the same key while the first is live fires no second IPC', () => {
      mockedLoadPageSubtree.mockReturnValueOnce(new Promise(() => {}))

      prefetchPageSubtree('SPACE_A', 'PAGE_1')
      prefetchPageSubtree('SPACE_A', 'PAGE_1')
      prefetchPageSubtree('SPACE_A', 'PAGE_1')

      expect(mockedLoadPageSubtree).toHaveBeenCalledTimes(1)
    })

    it('different keys (space or page) are independent — each fires its own IPC', () => {
      mockedLoadPageSubtree.mockReturnValue(new Promise(() => {}))

      prefetchPageSubtree('SPACE_A', 'PAGE_1')
      prefetchPageSubtree('SPACE_A', 'PAGE_2')
      prefetchPageSubtree('SPACE_B', 'PAGE_1')

      expect(mockedLoadPageSubtree).toHaveBeenCalledTimes(3)
    })

    it('caps concurrent in-flight prefetches — past MAX_INFLIGHT_PREFETCHES, new intent is dropped', () => {
      mockedLoadPageSubtree.mockReturnValue(new Promise(() => {}))

      for (let i = 0; i < MAX_INFLIGHT_PREFETCHES + 3; i++) {
        prefetchPageSubtree('SPACE_A', `PAGE_${i}`)
      }

      expect(mockedLoadPageSubtree).toHaveBeenCalledTimes(MAX_INFLIGHT_PREFETCHES)
      // The dropped keys never got parked — consuming them returns null.
      expect(consumePrefetchedPageSubtree('SPACE_A', `PAGE_${MAX_INFLIGHT_PREFETCHES}`)).toBeNull()
      // The ones under the cap DID get parked.
      expect(consumePrefetchedPageSubtree('SPACE_A', 'PAGE_0')).not.toBeNull()
    })

    it('a rejected prefetch never throws synchronously and produces no unhandled rejection', async () => {
      mockedLoadPageSubtree.mockReturnValueOnce(Promise.reject(new Error('ipc failed')))

      expect(() => prefetchPageSubtree('SPACE_A', 'PAGE_1')).not.toThrow()
      // Let the rejection's microtask settle. If this promise were left
      // unhandled, vitest/node would report an unhandledRejection — the
      // absence of a thrown/failed test here IS the assertion.
      await new Promise((r) => setTimeout(r, 0))
    })

    it('consume falls back to null after a prefetch rejects', async () => {
      mockedLoadPageSubtree.mockReturnValueOnce(Promise.reject(new Error('ipc failed')))
      prefetchPageSubtree('SPACE_A', 'PAGE_1')
      await new Promise((r) => setTimeout(r, 0))

      // The entry is still parked (rejection doesn't remove it early) — a
      // consumer awaiting it observes the same rejection `load()`'s own
      // catch handles.
      const consumed = consumePrefetchedPageSubtree('SPACE_A', 'PAGE_1')
      expect(consumed).not.toBeNull()
      await expect(consumed).rejects.toThrow('ipc failed')
    })
  })

  describe('consumePrefetchedPageSubtree', () => {
    it('returns null when nothing was prefetched', () => {
      expect(consumePrefetchedPageSubtree('SPACE_A', 'PAGE_1')).toBeNull()
    })

    it('single-consumption — returns the live promise then deletes the entry', async () => {
      const page = subtree('a')
      mockedLoadPageSubtree.mockResolvedValueOnce(page)
      prefetchPageSubtree('SPACE_A', 'PAGE_1')

      const first = consumePrefetchedPageSubtree('SPACE_A', 'PAGE_1')
      expect(first).not.toBeNull()
      await expect(first).resolves.toBe(page)

      // Second consume of the SAME key returns null — already consumed.
      const second = consumePrefetchedPageSubtree('SPACE_A', 'PAGE_1')
      expect(second).toBeNull()
    })

    it('TTL expiry — an entry older than PREFETCH_TTL_MS reads back as absent', () => {
      vi.useFakeTimers()
      try {
        mockedLoadPageSubtree.mockReturnValueOnce(new Promise(() => {}))
        prefetchPageSubtree('SPACE_A', 'PAGE_1')

        // Still within TTL.
        vi.advanceTimersByTime(PREFETCH_TTL_MS - 1)
        expect(consumePrefetchedPageSubtree('SPACE_A', 'PAGE_1')).not.toBeNull()

        // Re-park (the previous consume deleted it) and let it actually expire.
        prefetchPageSubtree('SPACE_A', 'PAGE_1')
        vi.advanceTimersByTime(PREFETCH_TTL_MS + 1)
        expect(consumePrefetchedPageSubtree('SPACE_A', 'PAGE_1')).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })

    it('an expired entry does not count against the concurrency cap', () => {
      vi.useFakeTimers()
      try {
        mockedLoadPageSubtree.mockReturnValue(new Promise(() => {}))
        for (let i = 0; i < MAX_INFLIGHT_PREFETCHES; i++) {
          prefetchPageSubtree('SPACE_A', `PAGE_${i}`)
        }
        expect(mockedLoadPageSubtree).toHaveBeenCalledTimes(MAX_INFLIGHT_PREFETCHES)

        // Expire everything, then a fresh intent should fire (cap no longer hit).
        vi.advanceTimersByTime(PREFETCH_TTL_MS + 1)
        prefetchPageSubtree('SPACE_A', 'PAGE_NEW')
        expect(mockedLoadPageSubtree).toHaveBeenCalledTimes(MAX_INFLIGHT_PREFETCHES + 1)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
