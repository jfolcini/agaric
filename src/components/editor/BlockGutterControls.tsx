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

import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIsTouch } from '@/hooks/useIsTouch'
import { capturePreDragFocus } from '@/lib/pre-drag-focus'
import { cn } from '@/lib/utils'
import { useBlockStore } from '@/stores/blocks'

/**
 * Gutter radius scale (#998) — the proportional scale is intentional and
 * best-in-class; do NOT bump small controls to `rounded-md` (it makes tiny
 * icon buttons blobby):
 *   - `rounded-sm` → icon buttons (drag handle, history, delete, more-actions)
 *   - `rounded-md` → padded rows / touch grip (SHEET_ROW_CLASS, touch handle)
 *   - `rounded-lg` → popover containers
 * The icon-button radius lives in `GUTTER_BUTTON_BASE` (and the touch
 * more-actions base) so the three small buttons can't silently diverge.
 */

/** Shared visibility / interaction classes for every gutter button. */
const GUTTER_BUTTON_BASE =
  'flex-shrink-0 p-0.5 rounded-sm text-muted-foreground opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto [.block-active_&]:opacity-100 [.block-active_&]:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto transition-opacity focus-ring-visible active:scale-95 touch-target'

/**
 * Gutter hover palettes (#997) — centralized so a future tweak can't silently
 * diverge across the five gutter sites. The neutral-vs-destructive colour
 * distinction is intentional and preserved.
 */
const GUTTER_HOVER_NEUTRAL = 'hover:bg-accent hover:text-foreground'
const GUTTER_HOVER_DESTRUCTIVE = 'hover:bg-destructive/10 hover:text-destructive'

/**
 * Touch drag-handle grip (#918).
 *
 * Unlike the desktop gutter buttons, the touch grip must be *visible and
 * hittable at rest* — coarse-pointer devices have no hover to reveal it, and
 * it is the only element carrying the dnd-kit drag listeners. We therefore do
 * NOT inherit `GUTTER_BUTTON_BASE` (which hides controls behind hover /
 * `pointer-events-none`). Instead:
 *  - `touch-target` guarantees a ≥44×44 hit area (WCAG 2.5.5).
 *  - `touch-action: none` (via `touch-none`) stops the browser from claiming
 *    the press-drag as a scroll gesture so the dnd-kit activator can start the
 *    drag. The handle is the activator, so the touch-action must live here.
 *  - It is calm at rest (muted, low-contrast grip) and firms up on
 *    press/active, so it reads as intentional chrome, not a permanent button.
 */
const TOUCH_DRAG_HANDLE_CLASS =
  'drag-handle touch-none flex-shrink-0 flex items-center justify-center rounded-md text-muted-foreground/60 active:text-foreground active:bg-accent transition-colors focus-ring-visible active:scale-95 touch-target cursor-grab'

/**
 * Layout for the action rows inside the touch overflow Sheet.
 *
 * #995: uses the canonical `focus-ring-visible` (inset 3px `ring-ring/50`, no
 * offset). The Sheet clips overflow, but an inset ring with no offset paints
 * inside the row's own box, so the 3px ring is not clipped.
 */
const SHEET_ROW_CLASS =
  'flex w-full items-center gap-3 rounded-md px-3 py-3 text-left text-sm font-medium text-foreground transition-colors hover:bg-accent focus-visible:bg-accent focus-ring-visible touch-target'

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
   * dwell than the 300ms app baseline so the drag/history/delete tips don't
   * flicker while the pointer simply travels across rows. Passed down from
   * `BlockGutterControls` so the override stays explicit now that the
   * per-surface `<TooltipProvider delayDuration={500}>` is gone.
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
  /**
   * Hover-delay override for the gutter tooltips (#1094). Forwarded by
   * `SortableBlock` (500ms) so the gutter keeps its deliberately-longer dwell
   * after the per-surface `<TooltipProvider>` was removed in favour of the
   * single app-level baseline.
   */
  tooltipDelayDuration?: number | undefined
}

export const BlockGutterControls = React.memo(function BlockGutterControls({
  blockId,
  onDelete,
  onShowHistory,
  dragAttributes,
  dragListeners,
  isSelected,
  onSelect,
  tooltipDelayDuration,
}: BlockGutterControlsProps): React.ReactElement {
  const { t } = useTranslation()
  const isTouch = useIsTouch()
  const [sheetOpen, setSheetOpen] = useState(false)
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

  // Multi-select checkbox visibility (user feedback 2026-06-12): the checkbox
  // is NOT shown on a casual hover. It appears only when:
  //   - this block is selected → forced visible, doubling as selection feedback;
  //   - a multi-selection is already active → hover-revealed on other rows so
  //     you can extend the selection by clicking their checkboxes.
  // With no active selection it stays fully out of the way (the start affordance
  // is Ctrl/Cmd+Click — the documented chord). Coarse pointers have no hover, so
  // the checkbox is suppressed there (long-press context menu owns touch ops).
  const selectCheckbox = onSelect ? (
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
              : hasSelection
                ? // A selection is active → hover-reveal so you can extend it.
                  'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:hidden'
                : // No selection → never clutter a casual hover; Ctrl/Cmd+Click starts one.
                  'opacity-0 pointer-events-none',
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
      // `group-focus-within` / `.block-active`. The earlier #217-B2 `opacity-30`
      // at-rest tweak painted a grip on *every* row at all times, which defeated
      // the per-row hover scope (it read as "all blocks hovered") and added
      // persistent gutter chrome. Inherit the base behaviour so the affordance
      // belongs to the single hovered/focused block. Touch is unaffected (it
      // renders `touchDragHandle` below and keeps the `.block-active` reveal).
      // #997: the drag handle stays text-only on hover (no `hover:bg-accent`)
      // — adding the neutral bg would be a visible change, and the grip reads
      // as ambient chrome better without a hover plate. So it deliberately does
      // NOT use GUTTER_HOVER_NEUTRAL; only the text-foreground half applies.
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
      // #966 — capture pre-drag focus before the press-blur clears it. Must
      // come AFTER `{...dragListeners}` so it wins the `onPointerDown` slot;
      // it re-invokes dnd-kit's own listener so the drag still activates.
      onPointerDown={handleDragHandlePointerDown}
    />
  )

  // Multiselect mode (user feedback 2026-06-12 / Fix 6): once a selection is
  // active, the row is in "select" mode — we keep ONLY the select checkbox
  // (extend/adjust the selection) and the DRAG HANDLE (so a multi-selection can
  // still be dragged to a new place — #914). History, delete, and the (touch)
  // overflow trigger are suppressed on EVERY row to keep selection mode calm and
  // uncluttered; the other bulk ops (delete/todo/priority/move) are reached via
  // the batch toolbar or the long-press / right-click context menu, which apply
  // to the whole selection. (Keeping the handle preserves drag-to-move, which a
  // checkbox-only gutter would silently break.)
  if (hasSelection) {
    if (isTouch) {
      return <div className="flex flex-col items-end gap-1">{selectCheckbox}</div>
    }
    return (
      <>
        {selectCheckbox}
        {dragHandle}
      </>
    )
  }

  // ── Touch render — drag handle + overflow Sheet ─────────────────
  if (isTouch) {
    const hasOverflow = Boolean(onDelete || onShowHistory)
    // UX-305: on touch, the @dnd-kit PointerSensor requires a press-and-hold
    // before the drag activates; the desktop tooltip never fires on touch UAs,
    // so the hint lives in `aria-label`.
    // #918: render the grip as a plain, always-visible button (NOT the
    // hover-hidden `GutterButton`) so it is hittable at rest on touch. This
    // button is the dnd-kit drag activator, so the listeners — and the
    // `touch-action: none` that lets them win the gesture over scrolling —
    // must live here.
    const touchDragHandle = (
      <button
        type="button"
        className={TOUCH_DRAG_HANDLE_CLASS}
        aria-label={t('block.reorderTouchHint')}
        data-testid="drag-handle"
        // B (#216): keyboard-reorder shortcut for AT (keyboard users on
        // touch UAs with an attached keyboard).
        aria-keyshortcuts={t('block.reorderKeyshortcuts')}
        data-context-trigger="true"
        {...dragAttributes}
        {...dragListeners}
        // #966 — same pre-drag focus capture as the desktop handle (see above).
        onPointerDown={handleDragHandlePointerDown}
      >
        {/* #996: bump to 20px on coarse pointers so the grip reads as a solid
            affordance, not a floaty 16px glyph in the 44px box. */}
        <GripVertical className="h-4 w-4 [@media(pointer:coarse)]:h-5 [@media(pointer:coarse)]:w-5" />
      </button>
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
              className={cn(GUTTER_BUTTON_BASE, GUTTER_HOVER_NEUTRAL)}
              aria-label={moreActionsLabel}
              aria-haspopup="dialog"
              aria-expanded={sheetOpen}
              data-testid="more-actions"
              onClick={() => setSheetOpen(true)}
            >
              {/* #996: bump to 20px on coarse pointers for legibility in the
                  44px touch box; desktop p-0.5 + 16px icon is unchanged. */}
              <MoreVertical className="h-4 w-4 [@media(pointer:coarse)]:h-5 [@media(pointer:coarse)]:w-5" />
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
                      className={cn(SHEET_ROW_CLASS, GUTTER_HOVER_DESTRUCTIVE)}
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
          className={GUTTER_HOVER_NEUTRAL}
          delayDuration={tooltipDelayDuration}
          // #1498: the gutter controls live OUTSIDE the contenteditable. With the
          // block's editor focused, a plain click blurs it first (flush →
          // re-render/remount) and the pending click gets swallowed. preventDefault
          // on mousedown retains editor focus so the click fires. (The delete
          // button already prevents this via its own onPointerDown handler; the
          // drag handle and select-checkbox INTENTIONALLY keep their pointerdown
          // behaviour for drag activation / selection.)
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onShowHistory(blockId)}
        />
      )}

      {/* Delete — next to grip */}
      {onDelete && (
        <GutterButton
          icon={Trash2}
          label={t('block.delete')}
          ariaLabel={t('block.delete')}
          className={cn('delete-handle', GUTTER_HOVER_DESTRUCTIVE)}
          delayDuration={tooltipDelayDuration}
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
