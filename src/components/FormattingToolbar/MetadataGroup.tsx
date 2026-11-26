/**
 * Custom renders for the Task group (group 2) of `FormattingToolbar`: the
 * cycle-priority button and the Date menu.
 *
 * The priority button is a single icon-less Button whose visible label
 * is the current priority badge (`P` / `P1`–`P3` with a colour dot).
 * Because that diverges from `ToolbarButtonConfig`'s icon-based shape
 * it can't go through `renderConfigButton`; the orchestrator dispatches
 * directly to this renderer.
 *
 * The Date menu is one button for Insert date, Set due date and Set
 * scheduled date, which it lists with their glyphs and names.
 *
 * The group's other buttons (TODO, Properties) are plain
 * `ToolbarButtonConfig`s that ride `renderConfigButton` from `shared.tsx`.
 */

import { CalendarDays } from 'lucide-react'
import type React from 'react'
import { Fragment } from 'react'

import {
  type RenderMode,
  renderConfigButton,
  toolbarPressHandlers,
} from '@/components/FormattingToolbar/shared'
import {
  toolbarActiveClass,
  toolbarMenuRowClass,
  type ToolbarButtonConfig,
} from '@/components/FormattingToolbar/toolbar-config'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { MenuPopoverContent } from '@/components/ui/menu-popover-content'
import { Popover, PopoverAnchor } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { dispatchBlockCommand } from '@/stores/block-command-bus'

interface CyclePriorityButtonProps {
  mode: RenderMode
  t: (key: string) => string
  currentPriority: string | null | undefined
  onAfterOverflowAction: () => void
  /** What a press does: the focused block's cycle, or *Edit as Markdown*'s (#5160). */
  onCycle?: () => void
}

/** Render the cycle-priority button (a custom inline button). */
/**
 * The priority indicator dot. #217 — when no priority is set, render a hollow
 * outline dot (not nothing) so the control reads as an interactive "no
 * priority" state rather than a disabled-looking bare "P".
 */
function priorityDot(currentPriority: string | null | undefined): React.ReactElement {
  // The ink scale at dot size: solid, half, faint (#7040). The P2 and P3 chip fills
  // are tints that vanish at dot size.
  if (currentPriority === '1') return <span className="h-2 w-2 rounded-full bg-priority-urgent" />
  if (currentPriority === '2')
    return <span className="h-2 w-2 rounded-full bg-priority-urgent/50" />
  if (currentPriority === '3')
    return <span className="h-2 w-2 rounded-full bg-priority-urgent/20" />
  return <span className="h-2 w-2 rounded-full border border-muted-foreground/50" />
}

export function renderCyclePriority({
  mode,
  t,
  currentPriority,
  onAfterOverflowAction,
  onCycle = () => dispatchBlockCommand('CYCLE_PRIORITY'),
}: CyclePriorityButtonProps): React.ReactElement {
  if (mode === 'overflow') {
    return (
      <Button
        variant="ghost"
        size="sm"
        aria-label={t('toolbar.cyclePriority')}
        aria-pressed={currentPriority != null}
        className={cn(toolbarMenuRowClass, currentPriority != null && toolbarActiveClass)}
        {...toolbarPressHandlers(() => {
          onCycle()
          onAfterOverflowAction()
        })}
      >
        <span className="inline-flex items-center gap-1 text-xs font-semibold leading-none mr-2">
          {priorityDot(currentPriority)}
          {currentPriority ? `P${currentPriority}` : 'P'}
        </span>
        <span>{t('toolbar.cyclePriority')}</span>
      </Button>
    )
  }
  return (
    // No shortcut: the priority keys set a level (Ctrl+Shift+1–3); none cycles it.
    <IconButton
      variant="ghost"
      size="icon-xs"
      tooltip={t('toolbar.cyclePriority')}
      ariaLabel={t('toolbar.cyclePriority')}
      aria-pressed={currentPriority != null}
      className={cn(currentPriority != null && toolbarActiveClass)}
      {...toolbarPressHandlers(onCycle)}
    >
      <span className="inline-flex items-center gap-1 text-xs font-semibold leading-none text-muted-foreground">
        {priorityDot(currentPriority)}
        {currentPriority ? `P${currentPriority}` : 'P'}
      </span>
    </IconButton>
  )
}

interface DateMenuProps {
  mode: RenderMode
  t: (key: string) => string
  open: boolean
  setOpen: (next: boolean | ((prev: boolean) => boolean)) => void
  /** The menu's rows: Insert date, Set due date, Set scheduled date (`createDateButtons`). */
  dates: ToolbarButtonConfig[]
  /** Closes More, when the rows are in it. */
  onOverflowClose: () => void
}

/** The rows, each its glyph and name; a press runs it, then `after`. */
function dateRows(dates: ToolbarButtonConfig[], t: (key: string) => string, after: () => void) {
  return dates.map((date) => (
    <Fragment key={date.label}>{renderConfigButton(date, {}, 'overflow', t, after)}</Fragment>
  ))
}

/** Render the Date menu: a bottom sheet on a phone, as More is (`sheetTitle`). */
export function renderDateMenu({
  mode,
  t,
  open,
  setOpen,
  dates,
  onOverflowClose,
}: DateMenuProps): React.ReactElement {
  // In More the dates are its rows, one press each, not a menu inside a menu.
  if (mode === 'overflow') return <>{dateRows(dates, t, onOverflowClose)}</>
  if (mode === 'sentinel') {
    return (
      <Button variant="ghost" size="icon-xs" aria-hidden tabIndex={-1}>
        <CalendarDays />
      </Button>
    )
  }
  return (
    <Popover open={open} onOpenChange={setOpen} sheetTitle={t('toolbar.date')}>
      <PopoverAnchor asChild>
        <IconButton
          variant="ghost"
          size="icon-xs"
          tooltip={t('toolbar.dateTip')}
          ariaLabel={t('toolbar.date')}
          aria-haspopup="dialog"
          aria-expanded={open}
          {...toolbarPressHandlers(() => setOpen((prev) => !prev))}
        >
          <CalendarDays />
        </IconButton>
      </PopoverAnchor>
      <MenuPopoverContent
        align="start"
        data-editor-portal
        data-testid="toolbar-date-menu"
        // The rows act on the focused block through the editor's focus: keep it there.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex flex-col gap-0.5">{dateRows(dates, t, () => setOpen(false))}</div>
      </MenuPopoverContent>
    </Popover>
  )
}
