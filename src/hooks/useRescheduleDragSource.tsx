/**
 * useRescheduleDragSource — context flag marking block rows as native
 * HTML5 drag sources for cross-day rescheduling (F-32, #2770).
 *
 * WeeklyView renders each day's blocks through the SAME shared row
 * component the daily journal view and the main page editor use
 * (`BlockTree` → `SortableBlockWrapper` → `SortableBlock`), which already
 * carries dnd-kit POINTER-based drag-and-drop for same-page reordering
 * (the grip handle in `BlockGutterControls`). Native HTML5 drag
 * (`draggable` + `dragstart`/`dragover`/`drop`) is a SEPARATE, browser-level
 * drag system from dnd-kit's synthetic pointer one — `RescheduleDropZone`
 * (#2708) already relies on native drag/drop to accept an
 * `application/x-block-reschedule` payload dropped onto a day, but nothing
 * in the shipped app ever SET that payload from a row a user could actually
 * reach (agenda's `BlockListItem` sets it, but agenda panels never co-render
 * with `RescheduleDropZone`).
 *
 * This context lets `WeeklyView` opt its subtree into being a reschedule
 * drag source WITHOUT threading a prop through every intermediate layer
 * (`BlockTree` → `BlockListRenderer` → `SortableBlockWrapper`) the way the
 * `BlockActions`/`BlockResolvers` contexts already avoid doing for their own
 * callback bags (see `useBlockActions.tsx`). `SortableBlock` is the only
 * consumer: outside a `RescheduleDragSourceProvider` (DailyView, the page
 * editor, StreamView, MonthlyView, ...) this defaults to `false`, so those
 * rows are completely unaffected — only WeeklyView's rows become native drag
 * sources.
 */

import type { ReactElement, ReactNode } from 'react'
import { createContext, useContext } from 'react'

const RescheduleDragSourceContext = createContext(false)

/**
 * Publish the "reschedule drag source" flag to descendants. Always `true`
 * while mounted — callers (currently only `WeeklyView`) simply choose
 * whether to wrap their subtree, rather than passing a boolean prop.
 */
export function RescheduleDragSourceProvider({ children }: { children: ReactNode }): ReactElement {
  return (
    <RescheduleDragSourceContext.Provider value>{children}</RescheduleDragSourceContext.Provider>
  )
}

/**
 * Read the reschedule-drag-source flag. `false` outside any provider, so
 * `SortableBlock` only becomes a native HTML5 drag source inside
 * `WeeklyView`.
 */
export function useRescheduleDragSourceEnabled(): boolean {
  return useContext(RescheduleDragSourceContext)
}
