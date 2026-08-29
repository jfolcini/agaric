/**
 * Tests for the #4007 name-change bus — the invalidation channel the picker's
 * `pagesListRef` / `tagsListRef` caches subscribe to.
 *
 * The end-to-end behaviour (a rename or delete elsewhere changing what the
 * next picker read offers) is pinned in
 * `src/components/block-tree/__tests__/use-block-resolve.test.ts`; this file
 * pins the transport itself: event shapes, unsubscribe, and the throw
 * isolation that keeps one broken subscriber from starving the others.
 */

import { describe, expect, it } from 'vitest'

import type { NameChange } from '@/lib/name-change-bus'
import {
  invalidateNameCaches,
  NAME_CACHE_FANOUT_MAX_IDS,
  notifyPageAdded,
  notifyPageRemoved,
  notifyPageRenamed,
  notifyPagesRemoved,
  notifyTagAdded,
  notifyTagRemoved,
  notifyTagRenamed,
  subscribeToNameChanges,
} from '@/lib/name-change-bus'

describe('name-change bus (#4007)', () => {
  it('delivers every notification shape to every subscriber', () => {
    const a: NameChange[] = []
    const b: NameChange[] = []
    const unsubA = subscribeToNameChanges((c) => a.push(c))
    const unsubB = subscribeToNameChanges((c) => b.push(c))
    try {
      notifyPageRenamed('P1', 'New Title', 'SPACE_1')
      notifyPageRemoved('P2', 'SPACE_1')
      notifyTagRenamed('T1', 'newtag', 'SPACE_1')
      notifyTagRemoved('T2', 'SPACE_1')
      invalidateNameCaches()
    } finally {
      unsubA()
      unsubB()
    }

    const expected: NameChange[] = [
      { kind: 'renamed', entity: 'page', id: 'P1', name: 'New Title', spaceId: 'SPACE_1' },
      { kind: 'removed', entity: 'page', id: 'P2', spaceId: 'SPACE_1' },
      { kind: 'renamed', entity: 'tag', id: 'T1', name: 'newtag', spaceId: 'SPACE_1' },
      { kind: 'removed', entity: 'tag', id: 'T2', spaceId: 'SPACE_1' },
      { kind: 'invalidated' },
    ]
    expect(a).toEqual(expected)
    expect(b).toEqual(expected)
  })

  // #4338 — the create half of the bus. Kept as its own case rather than
  // folded into the shape sweep above so a regression names itself: the
  // sweep would report "expected 5 events, got 7" for anything at all.
  it("delivers the 'added' shapes for both entities", () => {
    const seen: NameChange[] = []
    const unsubscribe = subscribeToNameChanges((c) => seen.push(c))
    try {
      notifyPageAdded('P_NEW', 'Quarterly Review', 'SPACE_1')
      notifyTagAdded('T_NEW', 'urgent', 'SPACE_1')
    } finally {
      unsubscribe()
    }

    expect(seen).toEqual([
      { kind: 'added', entity: 'page', id: 'P_NEW', name: 'Quarterly Review', spaceId: 'SPACE_1' },
      { kind: 'added', entity: 'tag', id: 'T_NEW', name: 'urgent', spaceId: 'SPACE_1' },
    ])
  })

  it('stops delivering after unsubscribe', () => {
    const seen: NameChange[] = []
    const unsubscribe = subscribeToNameChanges((c) => seen.push(c))
    notifyPageRemoved('P1', 'SPACE_1')
    unsubscribe()
    notifyPageRemoved('P2', 'SPACE_1')

    expect(seen).toEqual([{ kind: 'removed', entity: 'page', id: 'P1', spaceId: 'SPACE_1' }])
  })

  it('a throwing subscriber does not starve the others', () => {
    const seen: NameChange[] = []
    const unsubA = subscribeToNameChanges(() => {
      throw new Error('subscriber blew up')
    })
    const unsubB = subscribeToNameChanges((c) => seen.push(c))
    try {
      expect(() => notifyTagRemoved('T9', 'SPACE_1')).not.toThrow()
    } finally {
      unsubA()
      unsubB()
    }

    expect(seen).toEqual([{ kind: 'removed', entity: 'tag', id: 'T9', spaceId: 'SPACE_1' }])
  })

  it('an unsubscribe mid-dispatch drops only that listener, never its neighbour', () => {
    const seen: string[] = []
    // Held in an object so `b`'s unsubscribe can be captured by `a`'s
    // listener, which is registered before it exists.
    const b: { unsubscribe?: () => void } = {}
    const unsubA = subscribeToNameChanges(() => {
      seen.push('a')
      // An unmounting BlockTree can unsubscribe while a dispatch is in
      // flight. `b` must be dropped — and `c`, the entry after it, must
      // still be reached rather than skipped over.
      b.unsubscribe?.()
    })
    b.unsubscribe = subscribeToNameChanges(() => {
      seen.push('b')
    })
    const unsubC = subscribeToNameChanges(() => {
      seen.push('c')
    })
    try {
      notifyPageRemoved('P1', 'SPACE_1')
    } finally {
      unsubA()
      b.unsubscribe?.()
      unsubC()
    }

    expect(seen).toEqual(['a', 'c'])
  })
})

/**
 * #4524 — the shared bulk-removal publisher. Every rule here was previously
 * an inline recipe in `PageBrowserBatchToolbar`, copied between its two
 * handlers, and absent entirely from `useBlockMultiSelect` — the third
 * surface running the same `delete_blocks_by_ids` command. The end-to-end
 * behaviour lives with each caller; this pins the policy itself, once.
 */
describe('notifyPagesRemoved (#4524)', () => {
  function record(): { changes: NameChange[]; unsubscribe: () => void } {
    const changes: NameChange[] = []
    const unsubscribe = subscribeToNameChanges((c) => changes.push(c))
    return { changes, unsubscribe }
  }

  it('emits one scoped removal per id below the budget', () => {
    const { changes, unsubscribe } = record()
    try {
      notifyPagesRemoved(['P1', 'P2'], 'SPACE_1')
    } finally {
      unsubscribe()
    }
    expect(changes).toEqual([
      { kind: 'removed', entity: 'page', id: 'P1', spaceId: 'SPACE_1' },
      { kind: 'removed', entity: 'page', id: 'P2', spaceId: 'SPACE_1' },
    ] satisfies NameChange[])
  })

  // Callers union their own input list with a backend cohort that echoes it
  // back, so duplicates are the NORMAL input shape, not an edge case. Each
  // duplicate event costs O(listeners x pages) of synchronous work.
  it('de-duplicates before emitting', () => {
    const { changes, unsubscribe } = record()
    try {
      notifyPagesRemoved(['P1', 'P1', 'P2', 'P1'], 'SPACE_1')
    } finally {
      unsubscribe()
    }
    expect(changes.map((c) => (c.kind === 'removed' ? c.id : c.kind))).toEqual(['P1', 'P2'])
  })

  it(`collapses into one invalidation above ${NAME_CACHE_FANOUT_MAX_IDS} ids`, () => {
    const ids = Array.from({ length: NAME_CACHE_FANOUT_MAX_IDS + 1 }, (_, i) => `P${i}`)
    const { changes, unsubscribe } = record()
    try {
      notifyPagesRemoved(ids, 'SPACE_1')
    } finally {
      unsubscribe()
    }
    expect(changes).toEqual([{ kind: 'invalidated' } satisfies NameChange])
  })

  // The budget is checked AFTER de-duplication, because that is what is
  // actually emitted. A duplicate-laden list one over the cap must still take
  // the precise per-id branch.
  it('measures the budget on the de-duplicated set, not the raw input length', () => {
    const ids = Array.from({ length: NAME_CACHE_FANOUT_MAX_IDS }, (_, i) => `P${i}`)
    const { changes, unsubscribe } = record()
    try {
      notifyPagesRemoved([...ids, 'P0'], 'SPACE_1')
    } finally {
      unsubscribe()
    }
    expect(changes).toHaveLength(NAME_CACHE_FANOUT_MAX_IDS)
  })

  it('falls back to one invalidation with no active space', () => {
    const { changes, unsubscribe } = record()
    try {
      notifyPagesRemoved(['P1', 'P2'], null)
    } finally {
      unsubscribe()
    }
    expect(changes).toEqual([{ kind: 'invalidated' } satisfies NameChange])
  })

  // Load-bearing for the block tree, whose selections are usually pure
  // content blocks: no page was removed, so there is nothing for the picker
  // cache to be wrong about, and a null space must NOT turn that into a wipe.
  it('publishes nothing for an empty cohort, with or without an active space', () => {
    const { changes, unsubscribe } = record()
    try {
      notifyPagesRemoved([], 'SPACE_1')
      notifyPagesRemoved(new Set<string>(), null)
    } finally {
      unsubscribe()
    }
    expect(changes).toEqual([])
  })

  // #4524 review note 1 — a bare `string` is itself an `Iterable<string>` (it
  // iterates its own characters), so a slipped `notifyPagesRemoved(id,
  // spaceId)` — passing a single id where a cohort was meant — type-checked
  // under the old `Iterable<string>` signature and would have silently fanned
  // out one `notifyPageRemoved` per CHARACTER of `id`. `readonly string[] |
  // ReadonlySet<string>` closes that hole at no cost to any real caller (see
  // `notifyPagesRemoved`'s docblock).
  it('a bare string cohort is a compile error (type guard)', () => {
    // @ts-expect-error — `pageIds` must be `readonly string[] | ReadonlySet<string>`;
    // a bare string is also `Iterable<string>`, which is exactly the hole this
    // signature closes.
    notifyPagesRemoved('P1', 'SPACE_1')
  })
})
