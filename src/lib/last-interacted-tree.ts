/**
 * #774 — last-interacted BlockTree registry.
 *
 * Journal week/month views mount many BlockTrees, each installing its own
 * document-level zoom-out-Escape listener (`useBlockTreeKeyboardShortcuts`).
 * They all bail on `e.defaultPrevented`, so the FIRST listener to run (which
 * is mount order — earliest-mounted day) wins and calls `preventDefault()`,
 * zooming out a tree the user may not have touched. The user expects Escape
 * to zoom out the tree they LAST interacted with.
 *
 * This tiny registry tracks which tree was most recently interacted with
 * (identified by an opaque, stable token — in practice each tree's per-page
 * Zustand store reference). The zoom-out handler consults it to decide
 * whether THIS tree should claim the Escape, breaking the mount-order tie in
 * favour of recency. Framework-free and side-effect-light on purpose; it
 * holds a single reference and is reset between tests.
 */

/**
 * Opaque identity for a mounted tree. Callers pass a stable per-tree value
 * (the per-page store reference); the registry only ever compares by
 * reference identity, never reads into it.
 */
export type TreeToken = object

let lastInteracted: TreeToken | null = null

/** Record that `token`'s tree was just interacted with (focus / pointer). */
export function markTreeInteracted(token: TreeToken): void {
  lastInteracted = token
}

/**
 * True when `token` is the most-recently-interacted tree. Used to break the
 * mount-order tie for the shared zoom-out Escape shortcut.
 *
 * Fail-open: when NO tree has registered an interaction yet (`null`), returns
 * `true` so a lone zoomed tree (the common single-PageEditor case) still
 * handles Escape without requiring a prior interaction event.
 */
export function isLastInteractedTree(token: TreeToken): boolean {
  return lastInteracted === null || lastInteracted === token
}

/**
 * Drop `token` if it is the current holder (called on unmount), so a stale
 * reference to an unmounted tree can't keep claiming Escape.
 */
export function clearTreeInteractionIfHolder(token: TreeToken): void {
  if (lastInteracted === token) lastInteracted = null
}

/** Test-only reset hook — clears the registry between tests. */
export function __resetLastInteractedTreeForTests(): void {
  lastInteracted = null
}
