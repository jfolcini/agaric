/**
 * usePriorityLevels — subscribes React components to the user-configurable
 * priority level list (UX-201b).
 *
 * Re-renders when the underlying levels change (boot-time load or after a
 * successful edit in the Properties tab).
 *
 * Pure render-time consumers that only need a snapshot (e.g. `priorityColor`,
 * `priorityRank`) should read `getPriorityLevels()` directly instead of using
 * this hook — subscribing is only needed when the component's output depends
 * on the current levels AND it must re-render on change.
 */

import { useSyncExternalStore } from 'react'
import { getPriorityLevels, subscribePriorityLevels } from '../lib/priority-levels'

export function usePriorityLevels(): readonly string[] {
  return useSyncExternalStore(subscribePriorityLevels, getPriorityLevels, getPriorityLevels)
}
