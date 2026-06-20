/**
 * Custom render for the cycle-priority button in Group 2 of
 * `FormattingToolbar`.
 *
 * The priority button is a single icon-less Button whose visible label
 * is the current priority badge (`P` / `P1`–`P3` with a colour dot).
 * Because that diverges from `ToolbarButtonConfig`'s icon-based shape
 * it can't go through `renderConfigButton`; the orchestrator dispatches
 * directly to this renderer.
 *
 * The other Group 2 buttons (Date, Due Date, Scheduled Date, TODO,
 * Properties) are plain `ToolbarButtonConfig`s — they ride
 * `renderConfigButton` from `shared.tsx` and don't need a per-group
 * file.
 */

import type React from 'react'

import { dispatchBlockEvent } from '@/lib/block-events'
import { toolbarActiveClass } from '@/lib/toolbar-config'
import { cn } from '@/lib/utils'

import { Button } from '../ui/button'
import { type RenderMode, Tip } from './shared'

interface CyclePriorityButtonProps {
  mode: RenderMode
  t: (key: string) => string
  currentPriority: string | null | undefined
  onAfterOverflowAction: () => void
}

/** Render the cycle-priority button (a custom inline button). */
/**
 * The priority indicator dot. #217 — when no priority is set, render a hollow
 * outline dot (not nothing) so the control reads as an interactive "no
 * priority" state rather than a disabled-looking bare "P".
 */
function priorityDot(currentPriority: string | null | undefined): React.ReactElement {
  if (currentPriority === '1') return <span className="h-2 w-2 rounded-full bg-priority-urgent" />
  if (currentPriority === '2') return <span className="h-2 w-2 rounded-full bg-priority-high" />
  if (currentPriority === '3') return <span className="h-2 w-2 rounded-full bg-priority-normal" />
  return <span className="h-2 w-2 rounded-full border border-muted-foreground/50" />
}

export function renderCyclePriority({
  mode,
  t,
  currentPriority,
  onAfterOverflowAction,
}: CyclePriorityButtonProps): React.ReactElement {
  const tipText = t('toolbar.cyclePriorityTip')
  if (mode === 'overflow') {
    return (
      <Button
        variant="ghost"
        size="sm"
        aria-label={t('toolbar.cyclePriority')}
        aria-pressed={currentPriority != null}
        className={cn(
          'justify-start text-sm w-full [@media(pointer:coarse)]:min-h-11',
          currentPriority != null && toolbarActiveClass,
        )}
        onPointerDown={(e) => {
          e.preventDefault()
          dispatchBlockEvent('CYCLE_PRIORITY')
          onAfterOverflowAction()
        }}
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
    <Tip label={tipText}>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t('toolbar.cyclePriority')}
        aria-pressed={currentPriority != null}
        className={cn(currentPriority != null && toolbarActiveClass)}
        onPointerDown={(e) => {
          e.preventDefault()
          dispatchBlockEvent('CYCLE_PRIORITY')
        }}
      >
        <span className="inline-flex items-center gap-1 text-xs font-semibold leading-none text-muted-foreground">
          {priorityDot(currentPriority)}
          {currentPriority ? `P${currentPriority}` : 'P'}
        </span>
      </Button>
    </Tip>
  )
}
