/**
 * BatchActionToolbar — shared wrapper for batch-action toolbars.
 *
 * Provides the common container (flex, border, bg-muted/50, padding)
 * and a selection count badge. Context-specific action buttons are
 * passed as children.
 *
 * Used by HistorySelectionToolbar.
 *
 * Sub-fix 4: a desktop-only Shift+Click range-select hint is
 * appended to the right of the toolbar, mirroring the
 * HistorySelectionToolbar:63-65 pattern, so the gesture surfaces in
 * every batch context (history, trash). Hidden on touch
 * via `hidden sm:inline` so we don't show a desktop-only affordance.
 */

import type React from 'react'
import { type RefObject, useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface BatchActionToolbarProps {
  selectedCount: number
  /** The list whose selection this acts on; focus returns to it (see below). */
  listRef: RefObject<HTMLElement | null>
  children: React.ReactNode
  className?: string
  /**
   * Whether to suppress the Shift+Click range-select hint. Defaults to
   * `false` (hint shown). Callers that already render their own hint
   * (e.g., `TrashView` shipped one in session 483) pass `true` to avoid
   * duplication.
   */
  suppressRangeSelectHint?: boolean
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BatchActionToolbar({
  selectedCount,
  listRef,
  children,
  className,
  suppressRangeSelectHint,
}: BatchActionToolbarProps): React.ReactElement {
  const { t } = useTranslation()
  const toolbarRef = useRef<HTMLDivElement>(null)
  // The toolbar unmounts when the selection empties. When one of its own
  // buttons emptied it, focus would fall to <body> with the toolbar; it goes to
  // the list's Tab stop instead (the list, or its cursor row), so the next key
  // still reaches the list. A layout cleanup runs before the node is removed.
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current
    return () => {
      // Read at unmount, not at mount: the list renders after the toolbar, so
      // its ref is still empty when this effect runs.
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- the list's node, not one this component renders
      const list = listRef.current
      if (toolbar == null || list == null || !toolbar.contains(document.activeElement)) return
      const tabStop = list.tabIndex === 0 ? list : list.querySelector<HTMLElement>('[tabindex="0"]')
      tabStop?.focus({ preventScroll: true })
    }
  }, [listRef])
  return (
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label={t('batch.selectedCount', { count: selectedCount })}
      aria-describedby={!suppressRangeSelectHint ? 'batch-range-select-hint' : undefined}
      // Wraps: a phone cannot fit the actions on one line, and the clipped
      // ones (Pages' Bookmark and Delete) were unreachable.
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-lg border bg-muted/50 p-2',
        className,
      )}
    >
      <Badge tone="secondary">{t('batch.selectedCount', { count: selectedCount })}</Badge>
      {children}
      {!suppressRangeSelectHint && (
        <span
          id="batch-range-select-hint"
          className="ml-auto hidden text-xs text-muted-foreground sm:inline"
          data-testid="batch-range-select-hint"
        >
          {t('list.rangeSelectHint')}
        </span>
      )}
    </div>
  )
}
