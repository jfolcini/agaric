/**
 * DragStateStore — narrowly-subscribed per-row drag state (#1267).
 *
 * During a drag, `onDragMove` updates `projected` / `overId` / `dropAfter` at
 * pointer-move frequency (useBlockDnD). Those values used to flow as props to
 * EVERY `SortableBlockWrapper` in `BlockListRenderer`'s `visibleItems.map`, so
 * the per-row `React.memo` could never short-circuit: `projected` is a fresh
 * reference on every move, defeating the shallow comparator on all N visible
 * rows — even the (N − 2) that are neither the dragged row nor the over-row.
 *
 * The fix mirrors the #1067 viewport pattern: the per-move drag state lives in
 * a ref-backed external store with PER-ID subscription. Each row subscribes to
 * a tiny derived snapshot for ITS OWN id (`isActiveDragRow`,
 * `projectedDepthOverride`, `showDropIndicator`, `dropAfter`,
 * `dropIndicatorDepth`) via `useSyncExternalStore`. A move that changes the
 * over-row notifies only the two rows whose derived snapshot actually changes
 * (the previous over-row and the new one) plus the active row; every other row
 * keeps a referentially-equal snapshot and stays memoized.
 *
 * The store object identity is permanently stable (it's created once per
 * BlockTree mount and held in a ref), so it never perturbs the wrappers' memo.
 */

import { createContext } from 'react'

import type { Projection } from '@/lib/tree-utils'

/** Live, per-move drag state published by the BlockTree/useBlockDnD layer. */
export interface DragState {
  projected: Projection | null
  activeId: string | null
  overId: string | null
  dropAfter: boolean
}

/**
 * The minimal drag-derived render inputs for a SINGLE row. Everything a
 * `SortableBlockWrapper` needs from the drag state is captured here so a row
 * re-renders only when one of these values changes — never on a bare
 * pointer-move that doesn't touch this row.
 */
export interface RowDragState {
  /** True when this row is the lifted (active) drag source. */
  isActiveDragRow: boolean
  /**
   * Projected depth to render this row at, or null to use the row's own
   * `block.depth`. Non-null only for the active row and the over-row while a
   * projection exists (B3, #217).
   */
  projectedDepthOverride: number | null
  /** True when the drop indicator + over-row tint show on this row (#923/#991). */
  showDropIndicator: boolean
  /** #923 — render the indicator BELOW the row (dragging downward) when true. */
  dropAfter: boolean
  /** Indent depth for the drop indicator's marginLeft (only when shown). */
  dropIndicatorDepth: number
}

/** The neutral snapshot used when no drag is in progress for a row. */
export const IDLE_ROW_DRAG_STATE: RowDragState = {
  isActiveDragRow: false,
  projectedDepthOverride: null,
  showDropIndicator: false,
  dropAfter: false,
  dropIndicatorDepth: 0,
}

/** Derive a row's snapshot from the live drag state. Pure. */
export function deriveRowDragState(id: string, state: DragState): RowDragState {
  const { projected, activeId, overId, dropAfter } = state
  // Fast path: no active drag → every row is idle (shared singleton snapshot).
  if (activeId === null) return IDLE_ROW_DRAG_STATE

  const isActiveDragRow = activeId === id
  const isOverRow = overId === id
  // B3 (#217): the active row and the over-row preview the projected depth.
  const projectedDepthOverride =
    projected && (isActiveDragRow || isOverRow) ? projected.depth : null
  // #923/#991: indicator + tint on the over-row only, never the active row.
  const showDropIndicator = projected != null && isOverRow && !isActiveDragRow
  return {
    isActiveDragRow,
    projectedDepthOverride,
    showDropIndicator,
    dropAfter: showDropIndicator ? dropAfter : false,
    // Zero unless the indicator is actually shown — otherwise an unrelated row's
    // snapshot would churn on every depth change (the value is never read while
    // hidden), defeating the per-row memo for bystanders (#1267).
    dropIndicatorDepth: showDropIndicator ? (projected?.depth ?? 0) : 0,
  }
}

/** Shallow equality over a row snapshot — gates the per-id notify. */
function rowDragStateEqual(a: RowDragState, b: RowDragState): boolean {
  return (
    a.isActiveDragRow === b.isActiveDragRow &&
    a.projectedDepthOverride === b.projectedDepthOverride &&
    a.showDropIndicator === b.showDropIndicator &&
    a.dropAfter === b.dropAfter &&
    a.dropIndicatorDepth === b.dropIndicatorDepth
  )
}

/**
 * Ref-backed external store for per-row drag state (#1267).
 *
 * `getRowSnapshot(id)` returns a REFERENTIALLY-STABLE snapshot per id: it is
 * recomputed only when `publish` runs, and a row's cached snapshot is replaced
 * only when its derived value actually changes (gated by `rowDragStateEqual`).
 * This is the `useSyncExternalStore` getSnapshot contract — the same id must
 * return the same object reference between notifications, or React loops.
 */
export class DragStateStore {
  private state: DragState = {
    projected: null,
    activeId: null,
    overId: null,
    dropAfter: false,
  }

  /** id → per-id `useSyncExternalStore` subscribers. */
  private readonly subscribers = new Map<string, Set<() => void>>()

  /** id → last derived snapshot (stable reference until it changes). */
  private readonly snapshots = new Map<string, RowDragState>()

  /** ids whose snapshot changed since the last `notifyPending()` flush. */
  private readonly pending = new Set<string>()

  /** Subscribe a single row's listener; returns an unsubscribe. */
  subscribe = (id: string, callback: () => void): (() => void) => {
    let subs = this.subscribers.get(id)
    if (!subs) {
      subs = new Set()
      this.subscribers.set(id, subs)
    }
    subs.add(callback)
    return () => {
      const current = this.subscribers.get(id)
      if (!current) return
      current.delete(callback)
      if (current.size === 0) {
        this.subscribers.delete(id)
        this.snapshots.delete(id)
      }
    }
  }

  /** Stable per-id snapshot. Computed lazily and cached. */
  getRowSnapshot = (id: string): RowDragState => {
    const cached = this.snapshots.get(id)
    if (cached) return cached
    const fresh = deriveRowDragState(id, this.state)
    // Reuse the idle singleton so idle rows share one reference (cheaper memo).
    const snapshot = rowDragStateEqual(fresh, IDLE_ROW_DRAG_STATE) ? IDLE_ROW_DRAG_STATE : fresh
    this.snapshots.set(id, snapshot)
    return snapshot
  }

  /**
   * Apply a new live drag state. Call this DURING the publisher's render so any
   * row that renders in the same pass (newly mounted, or one already updating)
   * reads the fresh snapshot immediately — avoiding a mount-time idle→drag race
   * where the layout-effect notify fires before `useSyncExternalStore`'s
   * subscription is registered.
   *
   * Recomputes only the snapshots of currently CACHED (i.e. mounted) rows and
   * records which changed in `pending` — `notifyPending()` (run from a layout
   * effect) then re-renders the memoized rows that did NOT re-render in this
   * pass. Idempotent for an unchanged `next`. O(visible rows), not O(all
   * blocks). Returns true if any row's snapshot changed.
   */
  applyState = (next: DragState): boolean => {
    this.state = next
    let changed = false
    // Recompute every cached id (the mounted rows), even those without an
    // active subscriber yet, so a snapshot read during this render is fresh.
    for (const [id, prev] of this.snapshots) {
      const fresh = deriveRowDragState(id, next)
      if (rowDragStateEqual(prev, fresh)) continue
      // Keep idle rows on the shared singleton so their reference is stable.
      this.snapshots.set(
        id,
        rowDragStateEqual(fresh, IDLE_ROW_DRAG_STATE) ? IDLE_ROW_DRAG_STATE : fresh,
      )
      this.pending.add(id)
      changed = true
    }
    return changed
  }

  /**
   * Notify the subscribers of rows whose snapshot changed since the last flush.
   * Run from a layout effect AFTER `applyState`, when `useSyncExternalStore`
   * subscriptions are guaranteed to be registered.
   */
  notifyPending = (): void => {
    if (this.pending.size === 0) return
    const ids = [...this.pending]
    this.pending.clear()
    for (const id of ids) {
      const subs = this.subscribers.get(id)
      if (!subs) continue
      for (const cb of subs) cb()
    }
  }
}

/**
 * Context carrying the per-mount `DragStateStore`. `null` when no provider is
 * present (e.g. unit tests that render `SortableBlockWrapper` standalone) — the
 * wrapper then falls back to its DnD props, preserving the old contract.
 */
export const DragStateContext = createContext<DragStateStore | null>(null)
