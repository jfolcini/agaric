/**
 * useFocusedRowEffect — shared focused-row behaviour for keyboard-navigable
 * list views.
 *
 * Centralises three otherwise-duplicated effects:
 *   1. Reset `focusedIndex` to 0 when the underlying data (`resetDeps`)
 *      changes — wraps the `biome-ignore lint/correctness/useExhaustiveDependencies:
 *      intentional reset` exemption in one place.
 *   2. Scroll the focused row into view (`block: 'nearest'`) when the
 *      focused row id changes.
 *   3. Add `focusClasses` to the focused row's element while it has
 *      focus, removing them on cleanup so a roving focus ring tracks
 *      keyboard navigation without React having to re-render the rows.
 *
 * The row is found by querying `[${rowAttr}="${focusedRowId}"]` inside
 * `containerRef.current`. When the id is null or the element isn't
 * mounted yet, the scroll/class effect is a no-op.
 *
 * Used by `LinkedReferences` and `UnlinkedReferences` (MAINT-129).
 */

import { type DependencyList, type RefObject, useEffect } from 'react'

export interface UseFocusedRowEffectOptions {
  /** The scrollable container that holds the rows. */
  containerRef: RefObject<HTMLElement | null>
  /** The id of the row that currently has keyboard focus, or `null`. */
  focusedRowId: string | null
  /**
   * Name of the data attribute used to tag rows in the DOM. The hook
   * looks up the focused row via `[${rowAttr}="${focusedRowId}"]`.
   */
  rowAttr: string
  /**
   * CSS classes to add to the focused row element. They're removed on
   * cleanup so navigating away (or unmounting) leaves the DOM clean.
   */
  focusClasses?: readonly string[]
  /** Reset target. Called with `0` whenever `resetDeps` changes. */
  setFocusedIndex: (idx: number) => void
  /**
   * Dependencies that trigger a focus-index reset. Pass the same array
   * length on every render — array length must stay stable per React's
   * rules of hooks.
   */
  resetDeps: DependencyList
}

export function useFocusedRowEffect({
  containerRef,
  focusedRowId,
  rowAttr,
  focusClasses,
  setFocusedIndex,
  resetDeps,
}: UseFocusedRowEffectOptions): void {
  // 1. Reset focused index when the list contents / grouping change.
  // The deps array is caller-supplied — biome's `useExhaustiveDependencies`
  // can't statically verify a non-literal deps argument. Centralising
  // the suppression here removes the per-view `biome-ignore` lines that
  // previously appeared in each migrated component.
  useEffect(() => {
    setFocusedIndex(0)
    // biome-ignore lint/correctness/useExhaustiveDependencies: caller-supplied non-literal deps; intentional reset
  }, resetDeps)

  // 2/3. Scroll into view and apply focus classes when the focused row id changes.
  useEffect(() => {
    const container = containerRef.current
    if (!container || !focusedRowId) return undefined

    const el = container.querySelector(`[${rowAttr}="${focusedRowId}"]`) as HTMLElement | null
    if (!el) return undefined

    el.scrollIntoView({ block: 'nearest' })

    if (focusClasses && focusClasses.length > 0) {
      for (const cls of focusClasses) el.classList.add(cls)
      return () => {
        for (const cls of focusClasses) el.classList.remove(cls)
      }
    }
    return undefined
  }, [focusedRowId, containerRef, rowAttr, focusClasses])
}
