/**
 * BlockGutterControls — drag handle, history, and delete buttons
 * that appear in the narrow left gutter of each sortable block.
 *
 * Extracted from SortableBlock to reduce duplication (M-25).
 *
 * Each button is rendered via the `GutterButton` helper which wraps
 * a `<button>` inside `Tooltip` / `TooltipTrigger` / `TooltipContent`.
 *
 * On coarse-pointer devices (touch screens, tablets) hover tooltips are
 * unreachable and three 44×44 buttons no longer fit in the 68 px gutter
 * (UX-281). The touch render therefore collapses the secondary actions
 * (history + delete) into an overflow `Sheet` opened from a single
 * `MoreVertical` button next to the drag handle.
 */

import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core'
import type { LucideIcon } from 'lucide-react'
import { Clock, GripVertical, MoreVertical, Trash2 } from 'lucide-react'
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useIsTouch } from '../hooks/useIsTouch'
import { cn } from '../lib/utils'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from './ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

/** Shared visibility / interaction classes for every gutter button. */
const GUTTER_BUTTON_BASE =
  'flex-shrink-0 p-0.5 text-muted-foreground opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto [.block-active_&]:opacity-100 [.block-active_&]:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto transition-opacity focus-ring active:scale-95 touch-target'

/** Layout for the action rows inside the touch overflow Sheet. */
const SHEET_ROW_CLASS =
  'flex w-full items-center gap-3 rounded-md px-3 py-3 text-left text-sm font-medium text-foreground transition-colors hover:bg-accent focus-visible:bg-accent focus-ring touch-target'

/* ── GutterButton ───────────────────────────────────────────────── */

interface GutterButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon
  /** Text shown inside the tooltip. */
  label: string
  ariaLabel: string
  testId?: string
  ref?: React.Ref<HTMLButtonElement>
}

/**
 * A single gutter button wrapped in a Radix Tooltip.
 *
 * Extra props (dnd-kit `attributes`/`listeners`, `onPointerDown`, etc.)
 * are forwarded to the underlying `<button>`.
 */
export const GutterButton = ({
  ref,
  icon: Icon,
  label,
  ariaLabel,
  testId,
  className,
  ...buttonProps
}: GutterButtonProps) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <button
        ref={ref}
        type="button"
        className={cn(GUTTER_BUTTON_BASE, className)}
        aria-label={ariaLabel}
        data-testid={testId}
        {...buttonProps}
      >
        <Icon className="h-4 w-4" />
      </button>
    </TooltipTrigger>
    <TooltipContent side="bottom" sideOffset={4}>
      {label}
    </TooltipContent>
  </Tooltip>
)
GutterButton.displayName = 'GutterButton'

/* ── BlockGutterControls ────────────────────────────────────────── */

interface BlockGutterControlsProps {
  blockId: string
  onDelete?: ((blockId: string) => void) | undefined
  onShowHistory?: ((blockId: string) => void) | undefined
  /** dnd-kit sortable `attributes` — spread onto the drag handle button. */
  dragAttributes?: DraggableAttributes
  /** dnd-kit sortable `listeners` — spread onto the drag handle button. */
  dragListeners?: DraggableSyntheticListeners
  /** Whether this block is part of the active multi-selection (B1, #217). */
  isSelected?: boolean | undefined
  /** Toggle this block's membership in the multi-selection (B1, #217). */
  onSelect?: ((blockId: string, mode: 'toggle' | 'range') => void) | undefined
}

export const BlockGutterControls = React.memo(function BlockGutterControls({
  blockId,
  onDelete,
  onShowHistory,
  dragAttributes,
  dragListeners,
  isSelected,
  onSelect,
}: BlockGutterControlsProps): React.ReactElement {
  const { t } = useTranslation()
  const isTouch = useIsTouch()
  const [sheetOpen, setSheetOpen] = useState(false)

  // B1 (#217): hover-revealed multi-select checkbox — surfaces the
  // otherwise-invisible Ctrl/Shift+Click selection affordance. Mirrors the
  // `TrashRowItem` checkbox pattern. It is hidden at rest and revealed on row
  // hover / focus-within (via the shared `GUTTER_*` visibility classes), but
  // forced fully visible whenever the block is *selected* so the checkbox
  // doubles as selection feedback — it adds feedback, not chrome (the calm↔
  // discoverability contract from #217). A coarse-pointer device has no hover,
  // so the checkbox is suppressed there (the long-press context menu owns
  // touch block-ops) and only appears once selected.
  const selectCheckbox = onSelect ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <input
          type="checkbox"
          checked={isSelected ?? false}
          onChange={() => onSelect(blockId, 'toggle')}
          // The gutter row also handles clicks (long-press, focus); keep the
          // checkbox's own click from bubbling into block focus/selection.
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className={cn(
            'block-select-checkbox flex-shrink-0 h-3.5 w-3.5 rounded border-border cursor-pointer',
            'transition-opacity focus-ring',
            // Hidden at rest; revealed on hover/focus-within of the row. When
            // selected, force full visibility so it reads as "I'm selected".
            isSelected
              ? 'opacity-100'
              : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:hidden',
          )}
          aria-label={t('block.selectBlock')}
          data-testid="block-select-checkbox"
          tabIndex={-1}
        />
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {t('block.selectTip')}
      </TooltipContent>
    </Tooltip>
  ) : null

  const dragHandle = (
    <GutterButton
      icon={GripVertical}
      label={t('block.reorderTip')}
      ariaLabel={t('block.reorder')}
      testId="drag-handle"
      // #370: the drag handle must follow the same per-block hover contract as
      // every other gutter control — hidden at rest (`opacity-0` from
      // GUTTER_BUTTON_BASE) and revealed only on `group-hover` /
      // `group-focus-within` / `.block-active`. The earlier #217-B2 `opacity-30`
      // at-rest tweak painted a grip on *every* row at all times, which defeated
      // the per-row hover scope (it read as "all blocks hovered") and added
      // persistent gutter chrome. Inherit the base behaviour so the affordance
      // belongs to the single hovered/focused block. Touch is unaffected (it
      // renders `touchDragHandle` below and keeps the `.block-active` reveal).
      className="drag-handle cursor-grab hover:text-foreground"
      // B (#216): expose the keyboard-reorder shortcut to assistive tech.
      // The naming tooltip ("Reorder — Ctrl+Shift+↑/↓") already comes from
      // `block.reorderTip`; this makes the shortcut programmatically discoverable.
      aria-keyshortcuts={t('block.reorderKeyshortcuts')}
      // Stable focus-fallback target for `BlockContextMenu`'s
      // `handleCloseWithFocus` (MAINT-174). The drag handle is the only
      // gutter button guaranteed to render on every block.
      data-context-trigger="true"
      {...dragAttributes}
      {...dragListeners}
    />
  )

  // ── Touch render — drag handle + overflow Sheet ─────────────────
  if (isTouch) {
    const hasOverflow = Boolean(onDelete || onShowHistory)
    // UX-305: on touch, the @dnd-kit PointerSensor requires a 250 ms
    // press-and-hold before the drag activates. The desktop tooltip
    // never fires on touch UAs, so the hint must live in `aria-label`.
    const touchDragHandle = (
      <GutterButton
        icon={GripVertical}
        label={t('block.reorderTouchHint')}
        ariaLabel={t('block.reorderTouchHint')}
        testId="drag-handle"
        className="drag-handle cursor-grab hover:text-foreground"
        // B (#216): keyboard-reorder shortcut for AT (keyboard users on
        // touch UAs with an attached keyboard).
        aria-keyshortcuts={t('block.reorderKeyshortcuts')}
        data-context-trigger="true"
        {...dragAttributes}
        {...dragListeners}
      />
    )
    // UX-306: enumerate the available secondary actions in the
    // overflow button's `aria-label` so screen readers can preview
    // what the Sheet contains before opening it.
    const moreActionsLabel = (() => {
      const parts: string[] = []
      if (onShowHistory) parts.push(t('block.history'))
      if (onDelete) parts.push(t('block.delete'))
      return parts.length > 0
        ? t('block.moreActionsEnumerated', { actions: parts.join(', ') })
        : t('block.moreActionsLabel')
    })()
    return (
      <div className="flex flex-col items-end gap-1">
        {selectCheckbox}
        {touchDragHandle}
        {hasOverflow && (
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <button
              type="button"
              className={cn(GUTTER_BUTTON_BASE, 'rounded-sm hover:bg-accent hover:text-foreground')}
              aria-label={moreActionsLabel}
              aria-haspopup="dialog"
              aria-expanded={sheetOpen}
              data-testid="more-actions"
              onClick={() => setSheetOpen(true)}
            >
              <MoreVertical className="h-4 w-4" />
            </button>
            <SheetContent side="right" className="w-3/4 sm:w-80">
              <SheetHeader>
                <SheetTitle>{t('block.actionsSheetTitle')}</SheetTitle>
                <SheetDescription>{t('block.actionsSheetDescription')}</SheetDescription>
              </SheetHeader>
              <div className="flex flex-col gap-1 px-2 pb-4">
                {onShowHistory && (
                  <SheetClose asChild>
                    <button
                      type="button"
                      className={SHEET_ROW_CLASS}
                      data-testid="more-actions-history"
                      onClick={() => onShowHistory(blockId)}
                    >
                      <Clock className="h-4 w-4 text-muted-foreground" />
                      <span>{t('block.history')}</span>
                    </button>
                  </SheetClose>
                )}
                {onDelete && (
                  <SheetClose asChild>
                    <button
                      type="button"
                      className={cn(
                        SHEET_ROW_CLASS,
                        'hover:bg-destructive/10 hover:text-destructive',
                      )}
                      data-testid="more-actions-delete"
                      onClick={() => onDelete(blockId)}
                    >
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                      <span>{t('block.delete')}</span>
                    </button>
                  </SheetClose>
                )}
              </div>
            </SheetContent>
          </Sheet>
        )}
      </div>
    )
  }

  // ── Desktop render — checkbox + three inline gutter buttons ────
  return (
    <>
      {selectCheckbox}
      {dragHandle}

      {/* History — between grip and delete */}
      {onShowHistory && (
        <GutterButton
          icon={Clock}
          label={t('block.history')}
          ariaLabel={t('block.history')}
          className="hover:text-foreground hover:bg-accent rounded-sm"
          onClick={() => onShowHistory(blockId)}
        />
      )}

      {/* Delete — next to grip */}
      {onDelete && (
        <GutterButton
          icon={Trash2}
          label={t('block.delete')}
          ariaLabel={t('block.delete')}
          className="delete-handle hover:text-destructive rounded-sm hover:bg-destructive/10"
          onPointerDown={(e) => {
            e.stopPropagation()
            e.preventDefault()
            onDelete(blockId)
          }}
          onClick={(e) => {
            // Fallback for keyboard activation (Enter/Space fires click, not pointerDown)
            e.stopPropagation()
            onDelete(blockId)
          }}
        />
      )}
    </>
  )
})
