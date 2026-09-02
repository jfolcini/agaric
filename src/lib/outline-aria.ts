/**
 * `aria-setsize` / `aria-posinset` for a depth-annotated flat outline.
 *
 * Extracted from `BlockListRenderer`'s inline memo (#4550) so the host list
 * and an embedded subtree compute these the SAME way. That matters more than
 * de-duplication: an embed's rows must be announced relative to the HOST
 * tree, and "relative to the host tree" is only meaningful if both sides run
 * one algorithm over one notion of depth.
 *
 * Single-pass O(N). A `lastAtDepth` map records the most-recent index seen at
 * each depth, so each item's parent is simply `lastAtDepth[depth - 1]` —
 * matching the semantics of a backward scan (each item is grouped with the
 * nearest preceding item at its parent's depth). Roots (depth 0) share the
 * `-1` sentinel group.
 */

/** The minimum an item must expose to be placed in a sibling group. */
export interface OutlineAriaItem {
  id: string
  depth: number
}

export interface SiblingAriaProps {
  setsize: number
  posinset: number
}

/** Map each item's id to its 1-based position within its sibling group. */
export function computeSiblingAriaProps(
  items: readonly (OutlineAriaItem | undefined)[],
): Map<string, SiblingAriaProps> {
  const result = new Map<string, SiblingAriaProps>()
  const groups = new Map<number, number[]>()
  const lastAtDepth = new Map<number, number>()

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!item) continue
    const parentIdx = item.depth > 0 ? (lastAtDepth.get(item.depth - 1) ?? -1) : -1
    let list = groups.get(parentIdx)
    if (!list) {
      list = []
      groups.set(parentIdx, list)
    }
    list.push(i)
    lastAtDepth.set(item.depth, i)
  }

  for (const indices of groups.values()) {
    const setsize = indices.length
    for (let j = 0; j < indices.length; j++) {
      const idx = indices[j]
      const item = idx != null ? items[idx] : undefined
      if (item) {
        result.set(item.id, { setsize, posinset: j + 1 })
      }
    }
  }

  return result
}
