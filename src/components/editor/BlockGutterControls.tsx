/**
 * BlockGutterControls — drag handle (+ multi-select checkbox) in the narrow
 * left gutter of each sortable block.
 *
 * Extracted from SortableBlock to reduce duplication.
 *
 * History and Delete used to live here as hover-revealed gutter buttons (and,
 * on touch, inside an overflow `Sheet`). They were low-frequency for a
 * permanent gutter slot, so they now live exclusively in the right-click /
 * long-press context menu. The gutter keeps only the two controls that must be
 * reachable directly on the row: the drag handle (reorder) and — while a
 * multi-selection is active — the select checkbox.
 *
 * The drag handle is rendered via the `GutterButton` helper which wraps a
 * `<button>` inside `Tooltip` / `TooltipTrigger` / `TooltipContent`.
 */

import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core'
import type { LucideIcon } from 'lucide-react'
import { GripVertical } from 'lucide-react'
import React from 'react'
import { useTranslation } from 'react-i18next'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIsTouch } from '@/hooks/useIsTouch'
import { capturePreDragFocus } from '@/lib/pre-drag-focus'
import { cn } from '@/lib/utils'
import { useBlockStore } from '@/stores/blocks'

/**
 * Gutter radius scale (#998) — the proportional scale is intentional and
 * best-in-class; do NOT bump small controls to `rounded-md` (it makes tiny
 * icon buttons blobby):
 *   - `rounded-sm` → icon buttons (drag handle)
 *   - `rounded-md` → touch grip
 * The icon-button radius lives in `GUTTER_BUTTON_BASE` so it can't silently
 * diverge.
 */

/** Shared visibility / interaction classes for every gutter button. */
const GUTTER_BUTTON_BASE =
  'flex-shrink-0 p-0.5 rounded-sm text-muted-foreground opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto [.block-active_&]:opacity-100 [.block-active_&]:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto transition-opacity focus-ring-visible active:scale-95 touch-target'

/* ── GutterButton ───────────────────────────────────────────────── */

interface GutterButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon
  /** Text shown inside the tooltip. */
  label: string
  ariaLabel: string
  testId?: string
  ref?: React.Ref<HTMLButtonElement>
  /**
   * Hover-delay override (#1094). The gutter deliberately uses a longer 500ms
   * dwell than the 300ms app baseline so the drag tip doesn't flicker while the
   * pointer simply travels across rows. Passed down from `BlockGutterControls`
   * so the override stays explicit now that the per-surface
   * `<TooltipProvider delayDuration={500}>` is gone.
   */
  delayDuration?: number | undefined
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
  delayDuration,
  ...buttonProps
}: GutterButtonProps) => (
  // Spread the override only when set so we never pass `delayDuration={undefined}`
  // (rejected under exactOptionalPropertyTypes) — an unset value must inherit
  // the app-level baseline, not override it with undefined.
  // #1735: `openOnLongPress` surfaces the gutter button's label on a touch
  // press-and-hold, since Radix hover tooltips never open on a coarse-pointer tap.
  <Tooltip openOnLongPress {...(delayDuration === undefined ? {} : { delayDuration })}>
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
  /** dnd-kit sortable `attributes` — spread onto the drag handle button. */
  dragAttributes?: DraggableAttributes
  /** dnd-kit sortable `listeners` — spread onto the drag handle button. */
  dragListeners?: DraggableSyntheticListeners
  /** Whether this block is part of the active multi-selection (B1, #217). */
  isSelected?: boolean | undefined
  /** Toggle this block's membership in the multi-selection (B1, #217). */
  onSelect?: ((blockId: string, mode: 'toggle' | 'range') => void) | undefined
  /**
   * Hover-delay override for the gutter tooltip (#1094). Forwarded by
   * `SortableBlock` (500ms) so the gutter keeps its deliberately-longer dwell
   * after the per-surface `<TooltipProvider>` was removed in favour of the
   * single app-level baseline.
   */
  tooltipDelayDuration?: number | undefined
}

export const BlockGutterControls = React.memo(
  ({
    blockId,
    dragAttributes,
    dragListeners,
    isSelected,
    onSelect,
    tooltipDelayDuration,
  }: BlockGutterControlsProps): React.ReactElement => {
    const { t } = useTranslation()
    const isTouch = useIsTouch()
    // Whether a multi-selection is currently in progress anywhere. Multi-select
    // is a rarely-used feature, so the checkbox shouldn't add chrome to the
    // common hover state — it only earns a place once you're actually selecting.
    const hasSelection = useBlockStore((s) => s.selectedBlockIds.length > 0)

    // #966 — a handle-initiated drag blurs the contenteditable on `pointerdown`,
    // and `useEditorBlur` tears the editor down (unmount + setFocused(null))
    // BEFORE dnd-kit's 8px threshold fires `handleDragStart`. So the focus is
    // already gone by the time #923 tries to capture it for restore-on-cancel.
    // This `onPointerDown` runs in the same `pointerdown` BEFORE that blur, so it
    // is the last instant the pre-drag focus is still live — snapshot it now.
    // We compose with dnd-kit's own `pointerdown` listener so the drag still
    // activates. `getState()` (not a reactive subscription) reads the value at
    // press time without re-rendering the gutter on every focus change.
    const handleDragHandlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
      capturePreDragFocus(useBlockStore.getState().focusedBlockId)
      dragListeners?.['onPointerDown']?.(e)
    }

    // Multi-select checkbox visibility (user feedback 2026-06-20): the checkbox
    // must NEVER reserve gutter space — multi-select is seldom used and the space
    // is precious, so a one-time layout shift when a selection starts is fine. It
    // is therefore NOT in the DOM at all unless:
    //   - this block is selected → forced visible, doubling as selection feedback;
    //   - a multi-selection is already active → hover-revealed on other rows so
    //     you can extend the selection by clicking their checkboxes.
    // With no active selection it is omitted entirely (the start affordance is
    // Ctrl/Cmd+Click — the documented chord). Coarse pointers have no hover, so
    // the checkbox is suppressed there (long-press context menu owns touch ops).
    const selectCheckbox =
      onSelect && (isSelected || hasSelection) ? (
        <Tooltip
          {...(tooltipDelayDuration === undefined ? {} : { delayDuration: tooltipDelayDuration })}
        >
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
                'transition-opacity focus-ring-visible',
                isSelected
                  ? // Selected → always visible (selection feedback).
                    'opacity-100'
                  : // A selection is active → hover-reveal so you can extend it.
                    'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:hidden',
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
        delayDuration={tooltipDelayDuration}
        // #370: the drag handle must follow the same per-block hover contract as
        // every other gutter control — hidden at rest (`opacity-0` from
        // GUTTER_BUTTON_BASE) and revealed only on `group-hover` /
        // `group-focus-within` / `.block-active`.
        // #997: the drag handle stays text-only on hover (no `hover:bg-accent`)
        // — the grip reads as ambient chrome better without a hover plate.
        className="drag-handle cursor-grab hover:text-foreground"
        // B (#216): expose the keyboard-reorder shortcut to assistive tech.
        aria-keyshortcuts={t('block.reorderKeyshortcuts')}
        // Stable focus-fallback target for `BlockContextMenu`'s
        // `handleCloseWithFocus`. The drag handle is the only
        // gutter button guaranteed to render on every block.
        data-context-trigger="true"
        {...dragAttributes}
        {...dragListeners}
        // #966 — capture pre-drag focus before the press-blur clears it. Must
        // come AFTER `{...dragListeners}` so it wins the `onPointerDown` slot;
        // it re-invokes dnd-kit's own listener so the drag still activates.
        onPointerDown={handleDragHandlePointerDown}
      />
    )

    // ── Touch render — checkbox only ────────────────────────────────
    // #1968: the touch drag handle is gone. The drag activator now lives on the
    // leading collapse chevron (or, on leaves, a small bullet) — see
    // `BlockCollapseControl`. So on touch this gutter renders ONLY the
    // selection checkbox, and only while a multi-selection is active.
    if (isTouch) {
      return selectCheckbox ? (
        <div className="flex flex-col items-end gap-1">{selectCheckbox}</div>
      ) : (
        <></>
      )
    }

    // ── Desktop render — checkbox (only while selecting) + drag handle ──
    // `selectCheckbox` is null unless a selection is active or this block is
    // selected, so at rest the gutter shows only the hover-revealed drag handle.
    // The handle survives selection mode so a multi-selection can still be
    // dragged to a new place (#914).
    return (
      <>
        {selectCheckbox}
        {dragHandle}
      </>
    )
  },
)
BlockGutterControls.displayName = 'BlockGutterControls'
