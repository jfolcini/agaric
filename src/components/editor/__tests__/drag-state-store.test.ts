/**
 * #2244 — direct unit tests for the invariant-critical drag-state store
 * (#1267). This module underpins the per-row `useSyncExternalStore`
 * subscription that lets bystander rows stay memoized during a drag; the
 * referential-stability contract below is what keeps React from looping.
 *
 * Previously these invariants were only exercised indirectly (through
 * BlockTree render tests), so a regression in the snapshot-caching or the
 * `changed` accounting could slip through. These tests pin them directly.
 */

import { describe, expect, it } from 'vitest'

import type { DragState } from '@/components/editor/drag-state-store'
import {
  deriveRowDragState,
  DragStateStore,
  IDLE_ROW_DRAG_STATE,
} from '@/components/editor/drag-state-store'
import type { Projection } from '@/lib/tree-utils'

/** A valid projection at a given depth (only `depth` is read by the store). */
function projectionAtDepth(depth: number): Projection {
  return { depth, parentId: null, maxDepth: depth, minDepth: 0 }
}

const NO_DRAG: DragState = { projected: null, activeId: null, overId: null, dropAfter: false }

describe('deriveRowDragState (truth table)', () => {
  it('returns the shared IDLE singleton for every row when no drag is active', () => {
    // Fast path: activeId === null → the exact shared reference (not a copy).
    // This is the useSyncExternalStore infinite-loop guard: getSnapshot must
    // return a stable reference for an idle row or React re-renders forever.
    expect(deriveRowDragState('A', NO_DRAG)).toBe(IDLE_ROW_DRAG_STATE)
    expect(deriveRowDragState('B', NO_DRAG)).toBe(IDLE_ROW_DRAG_STATE)
  })

  it('flags the active drag row and previews the projected depth, never the indicator', () => {
    const state: DragState = {
      projected: projectionAtDepth(2),
      activeId: 'A',
      overId: 'B',
      dropAfter: true,
    }
    expect(deriveRowDragState('A', state)).toEqual({
      isActiveDragRow: true,
      // B3 (#217): the active row previews the projected depth.
      projectedDepthOverride: 2,
      // #923/#991: the indicator + tint never render on the active row.
      showDropIndicator: false,
      dropAfter: false,
      dropIndicatorDepth: 0,
    })
  })

  it('shows the drop indicator on the over-row and carries dropAfter + depth', () => {
    const state: DragState = {
      projected: projectionAtDepth(3),
      activeId: 'A',
      overId: 'B',
      dropAfter: true,
    }
    expect(deriveRowDragState('B', state)).toEqual({
      isActiveDragRow: false,
      projectedDepthOverride: 3,
      showDropIndicator: true,
      dropAfter: true,
      dropIndicatorDepth: 3,
    })
  })

  it('gates dropAfter/dropIndicatorDepth off when the indicator is hidden', () => {
    // dropAfter is true in the state, but a bystander row must not carry it —
    // otherwise its snapshot would churn on every move, defeating its memo.
    const state: DragState = {
      projected: projectionAtDepth(3),
      activeId: 'A',
      overId: 'B',
      dropAfter: true,
    }
    const bystander = deriveRowDragState('C', state)
    expect(bystander).toEqual({
      isActiveDragRow: false,
      projectedDepthOverride: null,
      showDropIndicator: false,
      dropAfter: false,
      dropIndicatorDepth: 0,
    })
    // Value-equal to IDLE, but NOT the singleton (that reuse only happens on
    // the activeId===null fast path / inside the store's cache).
    expect(bystander).toEqual(IDLE_ROW_DRAG_STATE)
    expect(bystander).not.toBe(IDLE_ROW_DRAG_STATE)
  })

  it('leaves projectedDepthOverride null when there is no projection', () => {
    const state: DragState = { projected: null, activeId: 'A', overId: 'B', dropAfter: false }
    expect(deriveRowDragState('A', state).projectedDepthOverride).toBeNull()
    expect(deriveRowDragState('B', state).showDropIndicator).toBe(false)
  })
})

describe('DragStateStore.getRowSnapshot referential stability', () => {
  it('returns the shared IDLE singleton for an idle row (loop guard)', () => {
    const store = new DragStateStore()
    // getSnapshot for an idle row must be the shared reference, not a fresh
    // idle-shaped object — the useSyncExternalStore infinite-loop guard.
    expect(store.getRowSnapshot('A')).toBe(IDLE_ROW_DRAG_STATE)
  })

  it('returns the same reference for the same state across repeated reads', () => {
    const store = new DragStateStore()
    store.applyState({ projected: null, activeId: 'A', overId: null, dropAfter: false })
    const first = store.getRowSnapshot('A')
    const second = store.getRowSnapshot('A')
    // Cached snapshot: identical reference between notifications.
    expect(second).toBe(first)
    // Active row → a real (non-idle) snapshot.
    expect(first.isActiveDragRow).toBe(true)
  })
})

describe('DragStateStore.applyState change accounting', () => {
  it('returns false when no rows are cached (nothing mounted to update)', () => {
    const store = new DragStateStore()
    // No row has been read yet → no cached snapshot to recompute.
    expect(
      store.applyState({ projected: null, activeId: 'A', overId: null, dropAfter: false }),
    ).toBe(false)
  })

  it('returns true only when a cached snapshot actually changes', () => {
    const store = new DragStateStore()
    // Cache row A as idle.
    expect(store.getRowSnapshot('A')).toBe(IDLE_ROW_DRAG_STATE)

    // A becomes the active drag row → its cached snapshot changes.
    expect(
      store.applyState({ projected: null, activeId: 'A', overId: null, dropAfter: false }),
    ).toBe(true)

    // Re-applying the identical state → no snapshot changes → false.
    expect(
      store.applyState({ projected: null, activeId: 'A', overId: null, dropAfter: false }),
    ).toBe(false)
  })

  it('recomputes only cached (mounted) rows, notifying just those subscribers', () => {
    const store = new DragStateStore()
    let aNotified = 0
    let bNotified = 0
    store.subscribe('A', () => {
      aNotified += 1
    })
    store.subscribe('B', () => {
      bNotified += 1
    })
    // Only A is "mounted" (its snapshot has been read/cached). B subscribed
    // but never read a snapshot, so it is not in the cache.
    store.getRowSnapshot('A')

    // A drag that would affect both rows if both were cached.
    store.applyState({
      projected: projectionAtDepth(1),
      activeId: 'A',
      overId: 'B',
      dropAfter: false,
    })
    store.notifyPending()

    expect(aNotified).toBe(1)
    // B was never cached, so applyState did not recompute or flag it.
    expect(bNotified).toBe(0)
  })
})

describe('DragStateStore.subscribe/unsubscribe', () => {
  it('evicts the last snapshot when the final subscriber unsubscribes', () => {
    const store = new DragStateStore()
    // Put the store into an active drag so A resolves to a NON-idle snapshot
    // (a fresh object each recompute, so eviction is observable by reference).
    store.applyState({ projected: null, activeId: 'A', overId: null, dropAfter: false })

    const unsubscribe = store.subscribe('A', () => {})
    const cached = store.getRowSnapshot('A')
    expect(cached.isActiveDragRow).toBe(true)
    // While cached, the same reference is handed back.
    expect(store.getRowSnapshot('A')).toBe(cached)

    // Last subscriber leaves → the cached snapshot is evicted.
    unsubscribe()

    // Observable via getRowSnapshot: a post-eviction read recomputes a FRESH
    // object (value-equal but a different reference). Had the snapshot not been
    // evicted, this would return the very same `cached` reference.
    const afterEviction = store.getRowSnapshot('A')
    expect(afterEviction).toEqual(cached)
    expect(afterEviction).not.toBe(cached)
  })
})
