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
  notifyPageRemoved,
  notifyPageRenamed,
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
      notifyPageRenamed('P1', 'New Title')
      notifyPageRemoved('P2')
      notifyTagRenamed('T1', 'newtag')
      notifyTagRemoved('T2')
      invalidateNameCaches()
    } finally {
      unsubA()
      unsubB()
    }

    const expected: NameChange[] = [
      { kind: 'renamed', entity: 'page', id: 'P1', name: 'New Title' },
      { kind: 'removed', entity: 'page', id: 'P2' },
      { kind: 'renamed', entity: 'tag', id: 'T1', name: 'newtag' },
      { kind: 'removed', entity: 'tag', id: 'T2' },
      { kind: 'invalidated' },
    ]
    expect(a).toEqual(expected)
    expect(b).toEqual(expected)
  })

  it('stops delivering after unsubscribe', () => {
    const seen: NameChange[] = []
    const unsubscribe = subscribeToNameChanges((c) => seen.push(c))
    notifyPageRemoved('P1')
    unsubscribe()
    notifyPageRemoved('P2')

    expect(seen).toEqual([{ kind: 'removed', entity: 'page', id: 'P1' }])
  })

  it('a throwing subscriber does not starve the others', () => {
    const seen: NameChange[] = []
    const unsubA = subscribeToNameChanges(() => {
      throw new Error('subscriber blew up')
    })
    const unsubB = subscribeToNameChanges((c) => seen.push(c))
    try {
      expect(() => notifyTagRemoved('T9')).not.toThrow()
    } finally {
      unsubA()
      unsubB()
    }

    expect(seen).toEqual([{ kind: 'removed', entity: 'tag', id: 'T9' }])
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
      notifyPageRemoved('P1')
    } finally {
      unsubA()
      b.unsubscribe?.()
      unsubC()
    }

    expect(seen).toEqual(['a', 'c'])
  })
})
