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

import { Checkbox } from '@/components/ui/checkbox'
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

/** A gutter button's look without its reveal: page mode's grip, shown only on the block it is placed on. */
export const GUTTER_BUTTON_LOOK =
  'flex-shrink-0 p-0.5 rounded-sm text-muted-foreground focus-ring-visible active:scale-95 touch-target'

/** Shared visibility / interaction classes for every gutter button. */
export const GUTTER_BUTTON_BASE = `${GUTTER_BUTTON_LOOK} opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto [.block-active_&]:opacity-100 [.block-active_&]:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto transition-opacity`

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
  // #1735: `openOnLongPress` surfaces the gutter button's label on a touch
  // press-and-hold, since Radix hover tooltips never open on a coarse-pointer tap.
  <Tooltip openOnLongPress>
    <TooltipTrigger asChild>
      <button
        ref={ref}
        type="button"
        className={cn(GUTTER_BUTTON_BASE, className)}
        aria-label={ariaLabel}
        data-testid={testId}
        {...buttonProps}
      >
        <Icon className="size-[1em]" />
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
}

export const BlockGutterControls = React.memo(
  ({
    blockId,
    dragAttributes,
    dragListeners,
    isSelected,
    onSelect,
  }: BlockGutterControlsProps): React.ReactElement => {
    const { t } = useTranslation()
    const isTouch = useIsTouch()
    // Whether a multi-selection is currently in progress anywhere. Multi-select
    // is a rarely-used feature, so the checkbox shouldn't add chrome to the
    // common hover state — it only earns a place once you're actually selecting.
    const hasSelection = useBlockStore((s) => s.selectedBlockIds.length > 0)

    // #966 — snapshot the focus for #923's restore-on-cancel before this press
    // blurs the editor (`pre-drag-focus.ts` says when it is used). We compose
    // with dnd-kit's own `pointerdown` listener so the drag still activates.
    // `getState()` (not a reactive subscription) reads the value at press time
    // without re-rendering the gutter on every focus change.
    const handleDragHandlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
      capturePreDragFocus(useBlockStore.getState().focusedBlockId)
      dragListeners?.['onPointerDown']?.(e)
    }

    // Multi-select checkbox visibility (user feedback 2026-06-20): the checkbox
    // must NEVER reserve gutter space — multi-select is seldom used and the space
    // is precious. On a fine pointer it takes the lane and the grip hangs left of
    // it, out of flow, so a selection moves no text (#6547: a lane holding both
    // outgrew its width) and the grip stays outermost (#7155 R1). It is NOT in
    // the DOM at all unless:
    //   - this block is selected → forced visible, doubling as selection feedback;
    //   - a multi-selection is already active → hover-revealed on other rows so
    //     you can extend the selection by clicking their checkboxes.
    // With no active selection it is omitted entirely (the start affordance is
    // Ctrl/Cmd+Click — the documented chord). Touch has no hover, so there only
    // a selected row shows it (long-press context menu owns touch ops).
    const selectCheckbox =
      onSelect && (isSelected || (hasSelection && !isTouch)) ? (
        <Tooltip>
          <TooltipTrigger asChild>
            {/* The tooltip sits on a wrapper: on the Checkbox it would replace
                the `data-state` the checked styles key on. */}
            <span className="inline-flex flex-shrink-0">
              <Checkbox
                checked={isSelected ?? false}
                onCheckedChange={() => onSelect(blockId, 'toggle')}
                // The gutter row also handles clicks (long-press, focus); keep the
                // checkbox's own click from bubbling into block focus/selection.
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                className={cn(
                  'transition-opacity',
                  isSelected
                    ? // Selected → always visible (selection feedback).
                      'opacity-100'
                    : // A selection is active → hover-reveal so you can extend it.
                      'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100',
                )}
                aria-label={t('block.selectBlock')}
                data-testid="block-select-checkbox"
                tabIndex={-1}
              />
            </span>
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
        // `group-focus-within` / `.block-active`.
        // #997: the drag handle stays text-only on hover (no `hover:bg-accent`)
        // — the grip reads as ambient chrome better without a hover plate.
        className={cn(
          'drag-handle cursor-grab hover:text-foreground',
          selectCheckbox && 'absolute right-full top-1/2 -translate-y-1/2 mr-0.5',
        )}
        // B (#216): expose the keyboard-reorder shortcut to assistive tech.
        aria-keyshortcuts={t('block.reorderKeyshortcuts')}
        // Stable focus-fallback target for `BlockContextMenu`'s
        // `handleCloseWithFocus`. The drag handle is the only
        // gutter button guaranteed to render on every block.
        data-context-trigger="true"
        // #2770 — in WeeklyView the ROW this handle sits in is itself a
        // native HTML5 drag source (reschedule-by-drag). Explicitly opt this
        // button OUT of native drag so a press on the grip always resolves
        // to dnd-kit's own pointer-based reorder drag (`dragAttributes`/
        // `dragListeners` below), never a competing native `dragstart` from
        // the row ancestor.
        draggable={false}
        {...dragAttributes}
        {...dragListeners}
        // #966 — capture pre-drag focus before the press blurs the editor. Must
        // come AFTER `{...dragListeners}` so it wins the `onPointerDown` slot;
        // it re-invokes dnd-kit's own listener so the drag still activates.
        onPointerDown={handleDragHandlePointerDown}
      />
    )

    // ── Touch render — checkbox only ────────────────────────────────
    // The row itself is the touch drag activator (hold, then move — see
    // `SortableBlock`), so on touch this renders ONLY the selection checkbox,
    // and only while a multi-selection is active.
    if (isTouch) {
      return selectCheckbox ? (
        <div className="touch-select-slot flex h-block-line flex-shrink-0 items-center">
          {selectCheckbox}
        </div>
      ) : (
        <></>
      )
    }

    // ── Desktop render — drag handle + checkbox (only while selecting) ──
    // `selectCheckbox` is null unless a selection is active or this block is
    // selected, so at rest the gutter shows only the hover-revealed drag handle.
    // The handle survives selection mode so a multi-selection can still be
    // dragged to a new place (#914).
    return (
      <>
        {dragHandle}
        {selectCheckbox}
      </>
    )
  },
)
BlockGutterControls.displayName = 'BlockGutterControls'
