/**
 * Whether an editing toolbar is pinned to the bottom of the screen (touch,
 * `ToolbarFrame`). The quick-capture button steps aside while one is, since
 * both claim the bottom edge (#5932). A count, because a toolbar can mount
 * before the one it replaces unmounts.
 */

import { useEffect, useSyncExternalStore } from 'react'

let pinned = 0
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Count this toolbar as pinned while `active`. */
export function usePinToolbar(active: boolean): void {
  useEffect(() => {
    if (!active) return
    pinned += 1
    emit()
    return () => {
      pinned -= 1
      emit()
    }
  }, [active])
}

export function usePinnedToolbarShown(): boolean {
  return useSyncExternalStore(subscribe, () => pinned > 0)
}

/**
 * How far up from the window's foot `bar`, a toolbar pinned on touch, reaches; 0 without one.
 * ProseMirror scrolls the cursor into the window, under it, unless its scroll margins add this.
 */
export function pinnedToolbarCover(bar: Element | null | undefined): number {
  return bar ? Math.max(0, window.innerHeight - bar.getBoundingClientRect().top) : 0
}
