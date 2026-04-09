/**
 * StatusIcon -- shared icon component for todo states.
 *
 * Maps todo_state to the corresponding Lucide icon:
 *   DOING  -> Clock   (text-task-doing)
 *   DONE   -> CheckCircle2 (text-task-done)
 *   TODO   -> Circle  (text-muted-foreground)
 *
 * When `showDone` is false, returns null for DONE state
 * (used by UnfinishedTasks which only shows TODO/DOING).
 */

import { CheckCircle2, Circle, Clock } from 'lucide-react'
import type React from 'react'

export interface StatusIconProps {
  /** The todo state to render an icon for. */
  state: string | null
  /** Whether to show the DONE icon. Defaults to true. Set to false to hide DONE state. */
  showDone?: boolean
}

/** Return the appropriate status icon component for a todo_state. */
export function StatusIcon({ state, showDone = true }: StatusIconProps): React.ReactElement | null {
  if (state === 'DONE' && !showDone) return null

  if (state === 'DOING')
    return (
      <Clock
        className="h-4 w-4 shrink-0 text-task-doing"
        aria-hidden="true"
        data-testid="icon-doing"
      />
    )
  if (state === 'DONE')
    return (
      <CheckCircle2
        className="h-4 w-4 shrink-0 text-task-done"
        aria-hidden="true"
        data-testid="icon-done"
      />
    )
  // Default: TODO or unknown
  return (
    <Circle
      className="h-4 w-4 shrink-0 text-muted-foreground"
      aria-hidden="true"
      data-testid="icon-todo"
    />
  )
}
