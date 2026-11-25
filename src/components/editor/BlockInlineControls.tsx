import { ChevronRight, Link2, Paperclip, Repeat } from 'lucide-react'
import React from 'react'
import { useTranslation } from 'react-i18next'

import { DateChip } from '@/components/common/DateChip'
import { PdfSourceChip } from '@/components/editor/PdfSourceChip'
import { TaskMarkerButton } from '@/components/editor/TaskMarkerButton'
import { InlinePropertyChip } from '@/components/properties/InlinePropertyChip'
import { ChevronToggle } from '@/components/ui/chevron-toggle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { InlineProperty } from '@/hooks/useExtraBlockProperties'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useIsTouch } from '@/hooks/useIsTouch'
import { useSpacePropertyDefs } from '@/hooks/useSpacePropertyDefs'
import { dueDateColor, formatCompactDate } from '@/lib/date-utils'
import { pdfSourceOf } from '@/lib/pdf-highlights'
import { priorityColor } from '@/lib/priority-color'
import { isUnfit } from '@/lib/property-fit'
import { formatRepeatLabel } from '@/lib/repeat-utils'
import { cn } from '@/lib/utils'

/**
 * Display label for a priority level: `P{level}`, so a level from before the
 * levels were fixed (#5841), which can be any string, renders too.
 */
export function priorityLabel(priority: string): string {
  return `P${priority}`
}

// Re-exported from date-utils so existing call sites + tests that import these
// Names from BlockInlineControls keep working after
// deduplication.
export { dueDateColor, formatCompactDate }

/**
 * #217 C2 / A3 (#1021) — the responsive cap on how many property chips render
 * inline before collapsing the rest into the `+N` overflow pill. A dense block
 * can carry priority + due + scheduled + repeat + N props + attachments; on
 * phones that wraps badly, so narrow viewports show fewer chips. Exporting the
 * limits (rather than burying `isMobile ? 2 : 3` in the component body) makes
 * the responsive display contract inspectable and testable, and keeps the
 * breakpoint values in one named place if they ever change.
 */
export const INLINE_PROPERTY_LIMITS = { mobile: 2, desktop: 3 } as const

/** Resolve the inline-property cap for the current viewport. */
export function getInlinePropertyLimit(isMobile: boolean): number {
  return isMobile ? INLINE_PROPERTY_LIMITS.mobile : INLINE_PROPERTY_LIMITS.desktop
}

export interface BlockInlineControlsProps {
  blockId: string
  todoState?: (string | null) | undefined
  onToggleTodo?: ((blockId: string) => void | Promise<void>) | undefined
}

export interface BlockMetadataRowProps {
  blockId: string
  priority?: (string | null) | undefined
  onTogglePriority?: ((blockId: string) => void | Promise<void>) | undefined
  dueDate?: (string | null) | undefined
  scheduledDate?: (string | null) | undefined
  /**
   * Opens a date chip's picker. It takes the row's own id: a chip keeps focus
   * where it was, so the focus-keyed command bus would open the picker for
   * whichever block is being edited, or for none (#5736).
   */
  onOpenDatePicker?: ((blockId: string, mode: 'due' | 'schedule') => void) | undefined
  properties?: InlineProperty[] | undefined
  filteredProperties: InlineProperty[]
  /**
   * A3 (#1021) — max number of property chips to render inline before the `+N`
   * overflow pill. When omitted, falls back to `getInlinePropertyLimit(isMobile)`
   * (the responsive default). A parent that already knows the viewport can pass
   * it explicitly so the display contract is inspectable at the call site rather
   * than hidden inside this component.
   */
  maxInlineProperties?: number | undefined
  attachmentCount: number
  showAttachments: boolean
  onToggleAttachments: () => void
  onEditProp: (prop: { key: string; value: string }) => void
  onEditKey: (keyInfo: { oldKey: string; value: string }) => void
  /**
   * Opens this block's property drawer from the `+N` pill. It takes the row's
   * own id: the pill keeps focus where it was, so the focus-keyed command bus
   * would open the drawer for whichever block is being edited, or for none.
   */
  onShowProperties?: ((blockId: string) => void) | undefined
  /** Follows a ref property's chip to its target. */
  onNavigate?: ((id: string) => void) | undefined
  /** How many blocks reference this one (#6746); none shows no chip. */
  refCount?: number | undefined
  /** Opens this block's references: block mode zooms it. Takes the row's own id. */
  onOpenReferences?: ((blockId: string) => void) | undefined
  /**
   * Draws every chip with no control, as an embedded row does (#6747): the
   * row shows the block's metadata, and its own page is where it changes.
   */
  readOnly?: boolean | undefined
}

/** The collapse chevron's classes, page mode's chevron's too. */
export const COLLAPSE_TOGGLE_BASE =
  'collapse-toggle flex-shrink-0 w-5 p-0.5 text-muted-foreground hover:text-foreground transition-opacity focus-ring-visible active:scale-95 touch-target'

/** An expanded parent's chevron on a fine pointer: hidden at rest (see `BlockCollapseControl`). */
export const COLLAPSE_TOGGLE_HIDDEN_AT_REST =
  'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto [.block-active_&]:opacity-100 [.block-active_&]:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto'

export interface BlockCollapseControlProps {
  blockId: string
  hasChildren: boolean
  isCollapsed: boolean
  /** Coarse pointer: the chevron sits at the right end of the row, always visible. */
  isTouch: boolean
  onToggleCollapse?: ((blockId: string) => void) | undefined
}

/**
 * The collapse chevron of a block WITH children; a leaf renders nothing.
 * Desktop: the row-leading control in the gutter lane (#1968), hover-revealed
 * while expanded. Touch: after the block text at the right end of the row,
 * always visible and centred on the first text line (#5332 item 10); the row
 * itself is the touch drag activator, so the chevron only toggles.
 */
export function BlockCollapseControl({
  blockId,
  hasChildren,
  isCollapsed,
  isTouch,
  onToggleCollapse,
}: BlockCollapseControlProps): React.ReactElement | null {
  const { t } = useTranslation()

  if (!hasChildren) return null

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            COLLAPSE_TOGGLE_BASE,
            // #1243: an EXPANDED parent hides its chevron at rest. Its
            // children are already visible below, so a persistent caret
            // just floats in the empty left gutter, detached from the
            // block text (the "caret too far left" report). It reveals on
            // the SAME per-block hover / focus-within / .block-active
            // contract as the gutter controls and the zoom bullet, so the
            // tree reads clean at rest and the toggle is right there the
            // moment you engage a block. Touch has no hover → always shown.
            !isCollapsed && !isTouch && COLLAPSE_TOGGLE_HIDDEN_AT_REST,
            // C4 (#216): the chevron signals collapsed/expanded by rotation
            // alone, which colour-blind users (and anyone who misses the
            // subtle 90° turn) can't reliably perceive, so the collapsed
            // state needs a cue that is NOT the rotation. That cue now
            // lives on the GLYPH: `solidWhenCollapsed` swaps the hairline
            // outline chevron for a solid caret (see the ChevronToggle
            // render below), a shape+fill difference — the strongest
            // non-colour signal — reinforced here by the darker
            // `text-foreground` ink. It replaces the boxed plate this line
            // used to carry (`rounded-sm bg-muted/60 ring-1 ring-border`):
            // on a phone the filled box around a gutter caret read as a
            // stray button and looked like chrome bolted onto the outline,
            // which is what the reporter objected to. Colour alone would be
            // the weaker cue, hence the glyph swap doing the real work. A
            // collapsed block ALSO stays visible at rest (above): it is the
            // only affordance to reveal the hidden children.
            isCollapsed && 'text-foreground',
            // Touch: a 44px target at the row's top edge (the row is
            // `items-start`), its glyph 8px down — the centre of the text's
            // first line (`py-1` + half a 24px line), measured in
            // `e2e/block-dnd-touch.spec.ts`. The text box is top-aligned too,
            // so this holds for a single line and a wrap alike.
            isTouch
              ? 'flex items-start justify-center pt-2'
              : 'max-sm:flex max-sm:items-center max-sm:justify-center',
          )}
          data-testid="collapse-toggle"
          data-collapsed={isCollapsed}
          // The context menu's `handleCloseWithFocus` falls back to this marker;
          // on touch the chevron is the row's only persistent button.
          {...(isTouch ? { 'data-context-trigger': 'true' } : {})}
          // #1498: the gutter controls live OUTSIDE the contenteditable, so a
          // plain press would blur the block's editor and end the edit.
          // preventDefault on mousedown keeps the editor focused and the caret
          // where it was through the click. Mirrors the Mermaid toggle (#1438).
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onToggleCollapse?.(blockId)}
          aria-label={isCollapsed ? t('block.expandChildren') : t('block.collapseChildren')}
          aria-expanded={!isCollapsed}
          // D4 (#217): expose the Ctrl+. collapse/expand shortcut to AT.
          aria-keyshortcuts={t('block.collapseKeyshortcuts')}
        >
          <ChevronToggle isExpanded={!isCollapsed} size="lg" solidWhenCollapsed />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {isCollapsed ? t('block.expandTip') : t('block.collapseTip')}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * A date chip's handlers in a block's metadata row. #1498: the press keeps the
 * editor focused, its caret where it was, so the picker opens for the block
 * being edited (see the collapse-toggle note above).
 */
function chipTrigger(
  open: () => void,
): Pick<React.ComponentProps<'button'>, 'onMouseDown' | 'onClick'> {
  return { onMouseDown: (e) => e.preventDefault(), onClick: open }
}

/** The priority badge toggle (rendered only when a priority is set). */
function PriorityBadge({
  blockId,
  priority,
  onTogglePriority,
  readOnly,
}: {
  blockId: string
  priority: string
  onTogglePriority?: ((blockId: string) => void | Promise<void>) | undefined
  readOnly: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  const badge = (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded px-1.5 py-0.75 text-xs font-bold leading-none max-sm:px-2.5',
        priorityColor(priority),
      )}
    >
      {priorityLabel(priority)}
    </span>
  )
  if (readOnly) {
    return (
      <span className="priority-badge flex-shrink-0 flex items-center" data-testid="priority-badge">
        {badge}
      </span>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="priority-badge flex-shrink-0 transition-colors focus-ring-visible active:scale-95 touch-hit-area flex items-center justify-center"
          data-testid="priority-badge"
          aria-label={t('block.priorityCycle', { level: priorityLabel(priority) })}
          // #976 (item 9) — the badge is a toggle button cycling the block's
          // priority; expose its set/unset state per WAI-ARIA toggle-button
          // semantics. The badge only renders when a priority is set, so the
          // pressed state is always `true` here.
          aria-pressed
          // #1498: keep editor focus on click (see collapse-toggle note).
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation()
            void onTogglePriority?.(blockId)
          }}
        >
          {badge}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {t('block.priorityTip', { level: priorityLabel(priority) })}
      </TooltipContent>
    </Tooltip>
  )
}

/** The repeat-rule indicator chip (rendered only when a `repeat` property is set). */
function RepeatIndicator({ repeatValue }: { repeatValue: string }): React.ReactElement {
  const { t } = useTranslation()
  const label = formatRepeatLabel(repeatValue, t)
  return (
    <output
      className="repeat-indicator flex items-center gap-0.5 rounded-sm px-1.5 py-0.5 text-xs font-medium leading-none select-none bg-indicator-repeat text-indicator-repeat-foreground"
      aria-label={t('block.repeats', { value: label })}
    >
      <Repeat className="size-[calc(var(--agaric-font-size,1rem)*0.75)] flex-shrink-0" />
      {label}
    </output>
  )
}

/**
 * The `+N` chip after the property chips: outlined, as a property is
 * (`Badge`'s `property` tone, whose icon size these chips cannot take: theirs
 * follows the font-size setting, #5369).
 */
const OVERFLOW_CHIP =
  'inline-flex items-center flex-shrink-0 rounded-sm border border-border px-1.5 py-0.5 text-xs font-medium leading-none text-muted-foreground select-none'

/** A count (attachments, references): plain muted text, as `Badge`'s `metadata` tone is. */
const COUNT_CHIP =
  'flex items-center gap-0.5 rounded-sm text-xs leading-none tabular-nums text-muted-foreground select-none cursor-pointer hover:text-foreground focus-ring-visible touch-hit-area'

/** The inline property chips, each marked if it doesn't fit its key, + `+N` overflow pill. */
function InlineProperties({
  blockId,
  filteredProperties,
  inlinePropLimit,
  onEditProp,
  onEditKey,
  onShowProperties,
  onNavigate,
  readOnly,
}: {
  blockId: string
  filteredProperties: InlineProperty[]
  inlinePropLimit: number
  readOnly: boolean
  onEditProp: (prop: { key: string; value: string }) => void
  onEditKey: (keyInfo: { oldKey: string; value: string }) => void
  onShowProperties?: ((blockId: string) => void) | undefined
  onNavigate?: ((id: string) => void) | undefined
}): React.ReactElement {
  const { t } = useTranslation()
  const defs = useSpacePropertyDefs()
  return (
    <>
      {filteredProperties.slice(0, inlinePropLimit).map((p) => {
        const def = defs?.get(p.key)
        return (
          <InlinePropertyChip
            key={p.key}
            blockId={blockId}
            property={p}
            onEditProp={onEditProp}
            onEditKey={onEditKey}
            onNavigate={onNavigate}
            onShowProperties={onShowProperties}
            unfit={isUnfit(p.key, p.kind ?? 'text', p.value, def, p.items ?? null)}
            refItems={def?.value_type === 'ref'}
            readOnly={readOnly}
          />
        )
      })}
      {filteredProperties.length > inlinePropLimit && readOnly && (
        <span className={cn(OVERFLOW_CHIP, 'property-overflow')}>
          +{filteredProperties.length - inlinePropLimit}
        </span>
      )}
      {filteredProperties.length > inlinePropLimit && !readOnly && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(
                OVERFLOW_CHIP,
                'property-overflow touch-hit-area hover:bg-accent/50 hover:text-foreground transition-colors focus-ring-visible active:scale-95',
              )}
              data-testid="property-overflow"
              aria-label={t('block.showAllProperties', { count: filteredProperties.length })}
              // #1498: keep editor focus on click (see collapse-toggle note).
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation()
                onShowProperties?.(blockId)
              }}
            >
              +{filteredProperties.length - inlinePropLimit}
              <ChevronRight
                className="size-[calc(var(--agaric-font-size,1rem)*0.75)] ml-0.5 opacity-60"
                aria-hidden="true"
              />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            {t('block.showAllProperties', { count: filteredProperties.length })}
          </TooltipContent>
        </Tooltip>
      )}
    </>
  )
}

/** How many blocks reference this one (rendered only when some do), opening its references. */
function ReferenceCountChip({
  blockId,
  count,
  onOpenReferences,
}: {
  blockId: string
  count: number
  onOpenReferences?: ((blockId: string) => void) | undefined
}): React.ReactElement {
  const { t } = useTranslation()
  const label = t('refCount.label', { count })
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(COUNT_CHIP, 'ref-count-chip')}
          data-testid="ref-count-chip"
          aria-label={label}
          // #1498: keep editor focus on click (see collapse-toggle note).
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onOpenReferences?.(blockId)}
        >
          <Link2 className="size-[calc(var(--agaric-font-size,1rem)*0.75)] flex-shrink-0" />
          {count}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

/** The collapsible-attachments badge (rendered only when the block has attachments). */
function AttachmentBadge({
  attachmentCount,
  showAttachments,
  animKey,
  onToggleAttachments,
}: {
  attachmentCount: number
  showAttachments: boolean
  animKey: number | null
  onToggleAttachments: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          key={animKey ?? 'initial'}
          type="button"
          className={cn(
            COUNT_CHIP,
            'attachment-badge',
            animKey !== null && 'animate-in fade-in-0 zoom-in-95 duration-normal',
          )}
          data-testid="attachment-badge"
          aria-label={t('block.attachments', { count: attachmentCount })}
          aria-expanded={showAttachments}
          // #1498: keep editor focus on click (see collapse-toggle note).
          onMouseDown={(e) => e.preventDefault()}
          onClick={onToggleAttachments}
        >
          <Paperclip className="size-[calc(var(--agaric-font-size,1rem)*0.75)] flex-shrink-0" />
          {attachmentCount}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {t('block.attachmentsTip', { count: attachmentCount })}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * Task checkbox rendered immediately before the block text. Everything else
 * (priority, dates, repeat, property chips, attachments) moved to the
 * below-block `BlockMetadataRow` (user feedback 2026-06-20).
 *
 * #1968: the collapse chevron is no longer rendered here — it moved into the
 * leading gutter lane as `BlockCollapseControl`, co-located with the drag
 * handle. This component renders only the task marker, in selection mode too
 * (#6547): hiding it moved the text left under the user's eyes.
 */
export const BlockInlineControls = React.memo(
  ({ blockId, todoState, onToggleTodo }: BlockInlineControlsProps): React.ReactElement | null => {
    const isTouch = useIsTouch()

    // Only a task has a checkbox, so a plain line keeps no room for one: a
    // task is set by `/todo`, Ctrl+Enter or the block menu. On touch the empty
    // box stays, as the row gap after it lines a plain line's text up with the
    // heading (`BlockListRenderer`).
    const task = todoState || null
    if (task === null && !isTouch) return null

    return (
      <div
        className={cn(
          // `min-h-block-line` is the first text line box, so the checkbox
          // centres on the first line of a wrapped block (#5332).
          'inline-controls flex items-center flex-shrink-0 gap-1 min-h-block-line max-sm:flex-shrink max-sm:w-auto max-sm:gap-x-1',
          // Touch: the checkbox starts on the text edge of a plain line (the text box's
          // `px-3`), and the row's gap is all that parts it from the text box, so the
          // editing frame starts clear of it.
          isTouch && task !== null && 'pl-3.5 [&>.task-marker]:pr-0',
        )}
      >
        {task !== null && (
          <TaskMarkerButton blockId={blockId} todoState={task} onToggleTodo={onToggleTodo} />
        )}
      </div>
    )
  },
)
BlockInlineControls.displayName = 'BlockInlineControls'

/**
 * Below-block metadata row (user feedback 2026-06-20): the interactive chips
 * that used to crowd the inline-control cluster — priority badge, due /
 * scheduled date chips, repeat indicator, a PDF highlight's or comment's source chip,
 * property chips (+ overflow), the attachment badge and the reference count — now render on their
 * own row under the block text, left-aligned with it. They stay fully
 * interactive (priority cycles, dates open pickers, chips edit, the source chip
 * opens the reader, attachments toggle) and ALWAYS visible at rest, since
 * each carries meaningful state worth seeing at a glance.
 *
 * Renders nothing when the block carries no metadata, so leaves add no row.
 */
export const BlockMetadataRow = React.memo(
  ({
    blockId,
    priority,
    onTogglePriority,
    dueDate,
    scheduledDate,
    onOpenDatePicker,
    properties,
    filteredProperties,
    maxInlineProperties,
    attachmentCount,
    showAttachments,
    onToggleAttachments,
    onEditProp,
    onEditKey,
    onShowProperties,
    onNavigate,
    refCount = 0,
    onOpenReferences,
    readOnly = false,
  }: BlockMetadataRowProps): React.ReactElement | null => {
    // #217 C2 / A3 (#1021): cap how many property chips render inline before the
    // `+N` overflow pill, relieving chip density on narrow viewports. The parent
    // may pass `maxInlineProperties` explicitly (inspectable contract); otherwise
    // we derive it from the viewport via the named limits.
    const isMobile = useIsMobile()
    const inlinePropLimit = maxInlineProperties ?? getInlinePropertyLimit(isMobile)

    // Play a one-shot bump animation when the attachment count changes
    // (file dropped/pasted). `animKey` starts as null so the very first render
    // has no animation classes; subsequent count changes set it to the new
    // count, which (a) re-keys the badge to force a remount and replay the
    // CSS animation, and (b) flips the className to include `animate-in
    // fade-in-0 zoom-in-95 duration-normal`. `prefers-reduced-motion` collapses
    // the duration tokens to 0ms in `index.css`.
    const prevAttachmentCountRef = React.useRef(attachmentCount)
    const [animKey, setAnimKey] = React.useState<number | null>(null)
    React.useEffect(() => {
      if (prevAttachmentCountRef.current !== attachmentCount) {
        prevAttachmentCountRef.current = attachmentCount
        setAnimKey(attachmentCount)
      }
    }, [attachmentCount])

    // The `repeat` property (if any) drives the repeat indicator chip.
    const repeatValue = properties?.find((p) => p.key === 'repeat')?.value
    // A PDF highlight's or comment's place (#6629) drives its source chip.
    const pdfSource = pdfSourceOf(properties)

    const hasContent =
      Boolean(priority) ||
      Boolean(dueDate) ||
      Boolean(scheduledDate) ||
      repeatValue !== undefined ||
      pdfSource !== null ||
      filteredProperties.length > 0 ||
      attachmentCount > 0 ||
      refCount > 0

    // No metadata → no row (leaves don't add an empty gap below the text).
    if (!hasContent) return null

    return (
      // `px-3` is NOT decoration — it is what makes this row line up with the
      // block's text, which is the whole point of it sitting here (see the
      // content-column comment in `SortableBlock.tsx`: "left-aligned with the
      // text", user feedback 2026-06-20). The row and the text are siblings in
      // one flex column, so they share a left EDGE, but the text is inset from
      // that edge by its own horizontal padding and the row was not — leaving
      // the chips ~12px left of the first character.
      //
      // The inset is `px-3` in BOTH render paths, so one value matches both and
      // the alignment cannot shift when a block gains or loses focus:
      //   - unfocused: `block-static` in `StaticBlock.tsx` (`px-3 py-1`)
      //   - focused:   `.ProseMirror` in `index.css` (`@apply px-3 py-1`)
      // `px-3` rather than `pl-3` so the chips also wrap against the same right
      // boundary the text wraps against.
      //
      // That makes three copies of one value, the third of which is in CSS and
      // cannot import a shared constant.
      // `editor/__tests__/metadata-row-text-alignment.test.tsx` (describe:
      // "metadata row / block text alignment") pins the relationship rather
      // than the literal, so changing the inset in one place fails loudly
      // instead of drifting.
      <div
        className="block-metadata-row flex items-center flex-wrap gap-1 mt-0.5 px-3"
        data-testid="block-metadata-row"
      >
        {priority && (
          <PriorityBadge
            blockId={blockId}
            priority={priority}
            onTogglePriority={onTogglePriority}
            readOnly={readOnly}
          />
        )}

        {dueDate && (
          <DateChip
            kind="due"
            date={dueDate}
            {...(readOnly ? {} : chipTrigger(() => onOpenDatePicker?.(blockId, 'due')))}
          />
        )}

        {scheduledDate && (
          <DateChip
            kind="scheduled"
            date={scheduledDate}
            {...(readOnly ? {} : chipTrigger(() => onOpenDatePicker?.(blockId, 'schedule')))}
          />
        )}

        {repeatValue !== undefined && <RepeatIndicator repeatValue={repeatValue} />}

        {pdfSource && <PdfSourceChip attachmentId={pdfSource.attachmentId} page={pdfSource.page} />}

        {filteredProperties.length > 0 && (
          <InlineProperties
            blockId={blockId}
            filteredProperties={filteredProperties}
            inlinePropLimit={inlinePropLimit}
            onEditProp={onEditProp}
            onEditKey={onEditKey}
            onShowProperties={onShowProperties}
            onNavigate={onNavigate}
            readOnly={readOnly}
          />
        )}

        {attachmentCount > 0 && (
          <AttachmentBadge
            attachmentCount={attachmentCount}
            showAttachments={showAttachments}
            animKey={animKey}
            onToggleAttachments={onToggleAttachments}
          />
        )}

        {refCount > 0 && (
          <ReferenceCountChip
            blockId={blockId}
            count={refCount}
            onOpenReferences={onOpenReferences}
          />
        )}
      </div>
    )
  },
)
BlockMetadataRow.displayName = 'BlockMetadataRow'
