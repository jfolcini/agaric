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
  notifyPageAdded,
  notifyPageRemoved,
  notifyPageRenamed,
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
