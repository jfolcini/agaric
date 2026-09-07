/**
 * Which embed currently hosts the roving editor (#4550 phase 2).
 *
 * `AGENTS.md` invariant 4 is one roving TipTap instance, and an unlocked embed
 * borrows the host tree's editable row rather than mounting a second one. Two
 * embeds of the SAME block therefore need an arbiter, because neither
 * `canEdit` nor the mounted-tree registry can tell them apart: focus is global
 * and by id, so `editable && isFocused` is true in BOTH at once. A host page
 * holding `{{embed ((B))}}` twice — or a journal week where two mounted days
 * each embed B — then renders two `<EditorSurface>` and two `id="editor-B"`
 * nodes driven by one `Editor`, and the second mount takes the ProseMirror
 * view away from the first.
 *
 * So exactly one embed is "active" at a time: unlocking claims the slot, which
 * relocks whoever held it. That also reads better than the alternative — two
 * embeds of one block showing an editable row each would be two carets for one
 * piece of text.
 *
 * A module slot rather than a store, for the same reason as
 * `src/editor/active-editor.ts`: it is one process-wide fact about the editor,
 * not page state, and nothing persists or syncs it.
 */

let activeEmbedId: string | null = null
const listeners = new Set<() => void>()

/** Claim the slot for `id`, or release it with `null`. */
export function setActiveEmbed(id: string | null): void {
  if (activeEmbedId === id) return
  activeEmbedId = id
  for (const listener of listeners) listener()
}

/**
 * Release the slot only if `id` still holds it.
 *
 * A relocking embed must not clear a slot another embed has since claimed:
 * unlocking B claims the slot and relocks A, and A's own cleanup then runs
 * with B already active.
 */
export function releaseActiveEmbed(id: string): void {
  if (activeEmbedId === id) setActiveEmbed(null)
}

/** The embed holding the slot, or `null` when none is unlocked. */
export function getActiveEmbed(): string | null {
  return activeEmbedId
}

/** Subscribe to slot changes. Pairs with {@link getActiveEmbed}. */
export function subscribeActiveEmbed(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}
