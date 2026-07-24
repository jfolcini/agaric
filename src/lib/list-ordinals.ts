/**
 * Computed ordered-list numbering (#3000).
 *
 * Ordered-list numbers are never stored — they are derived from a block's
 * position among consecutive same-depth, same-parent `ordered` siblings and
 * recomputed whenever the visible tree changes (reorder / insert / style
 * toggle). This mirrors the markdown serializer, which emits positional
 * numbers (`markdown-serialize.ts` `serializeOrderedList`) and discards any
 * literal ordinal on parse. See `docs/architecture/list-ergonomics.md`.
 */

import type { ListStyle } from '@/lib/list-style'
import type { FlatBlock } from '@/lib/tree-utils'

/**
 * Compute the 1-based ordinal for every `ordered` block in `items`.
 *
 * `items` is the depth-first, position-sorted visible list (the renderer's
 * `visibleItems`). Siblings that share a parent are NOT adjacent in this array
 * — a block's descendants sit between it and its next sibling — so grouping is
 * done by parent using the same single-pass `lastAtDepth` trick the renderer
 * uses for aria set-size. Within each sibling group, the ordinal counts the
 * block's position in the **maximal run of consecutive `ordered` siblings**:
 * the counter resets whenever a sibling's style is not `ordered` (a `bullet` or
 * `none` gap starts a fresh `1.`).
 *
 * Only `ordered` blocks appear in the returned map; `bullet` / `none` blocks
 * are absent.
 */
export function computeListOrdinals(
  items: readonly FlatBlock[],
  styleOf: (id: string) => ListStyle,
): Map<string, number> {
  const result = new Map<string, number>()

  // Group member indices by parent, mirroring BlockListRenderer's aria pass:
  // a block's parent group is the most-recent block seen at `depth - 1`
  // (roots share the `-1` sentinel group).
  const groups = new Map<number, number[]>()
  const lastAtDepth = new Map<number, number>()
  for (let i = 0; i < items.length; i++) {
    const block = items[i]
    if (!block) continue
    const parentIdx = block.depth > 0 ? (lastAtDepth.get(block.depth - 1) ?? -1) : -1
    let list = groups.get(parentIdx)
    if (!list) {
      list = []
      groups.set(parentIdx, list)
    }
    list.push(i)
    lastAtDepth.set(block.depth, i)
  }

  // Within each sibling group, number the consecutive `ordered` runs.
  for (const indices of groups.values()) {
    let run = 0
    for (const idx of indices) {
      const block = items[idx]
      if (block && styleOf(block.id) === 'ordered') {
        run += 1
        result.set(block.id, run)
      } else {
        run = 0
      }
    }
  }

  return result
}
