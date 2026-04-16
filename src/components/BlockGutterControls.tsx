/**
 * BlockGutterControls — drag handle, history, and delete buttons
 * that appear in the narrow left gutter of each sortable block.
 *
 * Extracted from SortableBlock to reduce duplication (M-25).
 *
 * Each button is rendered via the `GutterButton` helper which wraps
 * a `<button>` inside `Tooltip` / `TooltipTrigger` / `TooltipContent`.
 */

import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core'
import type { LucideIcon } from 'lucide-react'
import { Clock, GripVertical, Trash2 } from 'lucide-react'
import React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

/** Shared visibility / interaction classes for every gutter button. */
const GUTTER_BUTTON_BASE =
  'flex-shrink-0 p-0.5 text-muted-foreground opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto [.block-active_&]:opacity-100 [.block-active_&]:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto transition-opacity focus-ring active:scale-95 touch-target'

/* ── GutterButton ───────────────────────────────────────────────── */

interface GutterButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon
  /** Text shown inside the tooltip. */
  label: string
  ariaLabel: string
  testId?: string
}

/**
 * A single gutter button wrapped in a Radix Tooltip.
 *
 * Extra props (dnd-kit `attributes`/`listeners`, `onPointerDown`, etc.)
 * are forwarded to the underlying `<button>`.
 */
export const GutterButton = React.forwardRef<HTMLButtonElement, GutterButtonProps>(
  ({ icon: Icon, label, ariaLabel, testId, className, ...buttonProps }, ref) => (
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
  ),
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

  return (
    <>
      {/* Drag handle — far left */}
      <GutterButton
        icon={GripVertical}
        label={t('block.reorderTip')}
        ariaLabel={t('block.reorder')}
        testId="drag-handle"
        className="drag-handle cursor-grab hover:text-foreground"
        {...dragAttributes}
        {...dragListeners}
      />

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
