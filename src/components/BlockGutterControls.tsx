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
}

export const BlockGutterControls = React.memo(function BlockGutterControls({
  blockId,
  onDelete,
  onShowHistory,
  dragAttributes,
  dragListeners,
}: BlockGutterControlsProps): React.ReactElement {
  const { t } = useTranslation()
  const isTouch = useIsTouch()
  const [sheetOpen, setSheetOpen] = useState(false)

  const dragHandle = (
    <GutterButton
      icon={GripVertical}
      label={t('block.reorderTip')}
      ariaLabel={t('block.reorder')}
      testId="drag-handle"
      className="drag-handle cursor-grab hover:text-foreground"
      {...dragAttributes}
      {...dragListeners}
    />
  )

  // ── Touch render — drag handle + overflow Sheet ─────────────────
  if (isTouch) {
    const hasOverflow = Boolean(onDelete || onShowHistory)
    return (
      <div className="flex flex-col items-end gap-1">
        {dragHandle}
        {hasOverflow && (
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <button
              type="button"
              className={cn(GUTTER_BUTTON_BASE, 'rounded-sm hover:bg-accent hover:text-foreground')}
              aria-label={t('block.moreActionsLabel')}
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

  // ── Desktop render — three inline gutter buttons (unchanged) ────
  return (
    <>
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
