/**
 * Tree utilities for the block outliner.
 *
 * Converts a bag of blocks (adjacency-list parent_id) into a flattened,
 * depth-annotated list suitable for rendering + sortable DnD.
 * Also provides a projection algorithm that maps horizontal drag offset
 * to a target depth / parent — enabling drag-to-indent.
 */

import { logger } from './logger'
import type { BlockRow } from './tauri'

/** Sentinel ID used as drop target after the last block in the list. */
export const SENTINEL_ID = '__drop-after-last__'

/** Dead zone in pixels: horizontal drag must exceed this before any indent change. */
export const DEAD_ZONE_PX = 20

/**
 * Maximum tree-traversal depth for `dfs()` inside `buildFlatTree`. Mirrors
 * the same defense the markdown parser ships at `MAX_PARSE_DEPTH = 10`
 * (see `editor/markdown-parse.ts`). The `visited` set already breaks
 * cycles, but a pathologically deep linear chain (depth 10 000+) would
 * still blow the JS stack — this bound makes the failure mode loud and
 * recoverable instead of a `RangeError`.
 */
const MAX_TREE_DEPTH = 1000

/**
 * Maximum nesting depth the backend permits for a block subtree (#928). Mirrors
 * the Rust `MAX_BLOCK_DEPTH` in `src-tauri/src/domain/block_ops.rs` (pinned by
 * the `move_block` depth-limit tests in `commands/tests/block_cmd_tests.rs`).
 * Depth is 0-based here (root-level blocks are depth 0), so the deepest legal
 * block depth is `MAX_BLOCK_DEPTH - 1`. The frontend uses this to PREVENT an
 * over-deep drop/indent up front instead of letting the IPC fail with an error
 * toast after the fact.
 */
export const MAX_BLOCK_DEPTH = 20

/** A block with its depth in the visual tree. */
export interface FlatBlock extends BlockRow {
  depth: number
}

// ── Build flat tree ──────────────────────────────────────────────────────

/**
 * Build a flattened, depth-annotated list from a bag of blocks.
 *
 * Blocks are grouped by parent_id, sorted by position within each group,
 * and traversed depth-first. The result is a flat array where each item
 * knows its depth in the hierarchy.
 *
 * @param allBlocks  All blocks in the subtree (any order, any depth).
 * @param rootParentId  The parent_id of the root level (null for top-level).
 */
export function buildFlatTree(
  allBlocks: BlockRow[],
  rootParentId: string | null = null,
): FlatBlock[] {
  // Group blocks by parent_id
  const childrenMap = new Map<string | null, BlockRow[]>()
  for (const block of allBlocks) {
    const pid = block.parent_id ?? null
    const siblings = childrenMap.get(pid)
    if (siblings) {
      siblings.push(block)
    } else {
      childrenMap.set(pid, [block])
    }
  }

  // Sort each group by position (nulls last)
  for (const children of childrenMap.values()) {
    children.sort(
      (a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER),
    )
  }

  // DFS flatten
  const result: FlatBlock[] = []
  const visited = new Set<string>()

  function dfs(parentId: string | null, depth: number): void {
    if (depth > MAX_TREE_DEPTH) {
      logger.warn('tree-utils', 'tree depth limit exceeded', {
        depth,
        maxDepth: MAX_TREE_DEPTH,
      })
      return
    }
    const children = childrenMap.get(parentId)
    if (!children) return
    for (const child of children) {
      if (visited.has(child.id)) continue
      visited.add(child.id)
      result.push({ ...child, depth })
      dfs(child.id, depth + 1)
    }
  }

  dfs(rootParentId, 0)
  return result
}

// ── Drag descendants ─────────────────────────────────────────────────────

/**
 * Get all descendant IDs of a block in the flattened tree.
 *
 * In a DFS-flattened list, descendants of item at index `i` with depth `d`
 * are all consecutive items at index > i with depth > d (until we hit an
 * item at depth <= d).
 */
export function getDragDescendants(items: FlatBlock[], activeId: string): Set<string> {
  const descendants = new Set<string>()
  const activeIndex = items.findIndex((item) => item.id === activeId)
  if (activeIndex < 0) return descendants

  const activeDepth = items[activeIndex]?.depth as number
  for (let i = activeIndex + 1; i < items.length; i++) {
    if ((items[i] as FlatBlock).depth <= activeDepth) break
    descendants.add((items[i] as FlatBlock).id)
  }
  return descendants
}

// ── Selection roots (multi-select drag, #914) ────────────────────────────

/**
 * Given the flat tree and a set of selected block ids, return the ordered list
 * of selection "roots" — selected blocks that are NOT a descendant of any
 * OTHER selected block.
 *
 * Multi-select drag (#914) moves the whole selection as one gesture. A selected
 * block that already lives inside another selected block's subtree must NOT move
 * independently — it travels inside its ancestor's subtree. Computing the
 * minimal set of roots (and dropping nested selected descendants) keeps the move
 * atomic and avoids double-moving / orphaning a block.
 *
 * Roots are returned in **document order** (their order in the flat `items`
 * list), so callers can place them contiguously at the destination while
 * preserving their relative order.
 *
 * Implementation: a selected block at flat index `i` (depth `d`) is a root
 * unless some selected block appears earlier in the list as an ancestor — i.e.
 * a selected block at a shallower depth with no intervening block at depth `<= d`
 * that is NOT that selected ancestor. We detect "is a descendant of a selected
 * block" by walking the DFS-flattened list: track the most recent selected
 * block at each depth; a selected block is nested iff any strictly-shallower
 * depth on the current ancestor chain is itself selected. Because the list is a
 * DFS flatten, the ancestor chain of the item at index `i` is exactly the
 * trailing stack of items whose depth strictly decreases as we walk backwards.
 */
export function computeSelectionRoots(items: FlatBlock[], selectedIds: Iterable<string>): string[] {
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds)
  if (selected.size === 0) return []

  const roots: string[] = []
  // `ancestorStack[d]` holds the id of the block currently open at depth `d`
  // as we DFS-walk the flat list. For the item at index `i`, its ancestors are
  // exactly `ancestorStack[0 .. depth-1]`.
  const ancestorStack: string[] = []

  for (const item of items) {
    // Pop the stack back to this item's depth, then this item owns depth.
    ancestorStack.length = item.depth
    if (selected.has(item.id)) {
      // A root iff none of its ancestors (shallower open blocks) is selected.
      const nested = ancestorStack.some((ancestorId) => selected.has(ancestorId))
      if (!nested) roots.push(item.id)
    }
    ancestorStack[item.depth] = item.id
  }

  return roots
}

// ── Projection ───────────────────────────────────────────────────────────

export interface Projection {
  /** Projected depth for the dragged item. */
  depth: number
  /** Parent ID at the projected depth (null = root level). */
  parentId: string | null
  /** Maximum allowed depth at this position. */
  maxDepth: number
  /** Minimum allowed depth at this position. */
  minDepth: number
}

/**
 * Compute the projected drop position for a sortable tree drag.
 *
 * The algorithm:
 * 1. Simulate moving the active item to the over item's position.
 * 2. Compute projected depth from the horizontal drag offset.
 * 3. Clamp to [minDepth, maxDepth] based on surrounding items.
 * 4. Walk backwards to find the parent at (depth - 1).
 *
 * @param items       Flattened tree (excluding descendants of active item during drag).
 * @param activeId    ID of the item being dragged.
 * @param overId      ID of the item being dragged over.
 * @param dragOffset  Horizontal drag offset in pixels.
 * @param indentWidth Pixels per indent level (e.g. 24).
 * @param rootParentId The parent_id of root-level items (null for top-level).
 */
export function getProjection(
  items: FlatBlock[],
  activeId: string,
  overId: string,
  dragOffset: number,
  indentWidth: number,
  rootParentId: string | null = null,
  /**
   * Height of the dragged subtree (max descendant depth − active depth), so the
   * projection never offers a depth whose descendants would exceed
   * MAX_BLOCK_DEPTH and be rejected by the backend (#928). 0 for a leaf.
   */
  subtreeHeight = 0,
): Projection {
  // The deepest depth the DRAGGED HEAD may legally occupy: its tallest
  // descendant must still satisfy `headDepth + subtreeHeight <= MAX_BLOCK_DEPTH
  // - 1` (0-based). Clamp to ≥0 so a pathologically tall subtree still projects.
  const depthCeiling = Math.max(0, MAX_BLOCK_DEPTH - 1 - subtreeHeight)
  const overIndex = items.findIndex((item) => item.id === overId)
  const activeIndex = items.findIndex((item) => item.id === activeId)

  // Explicit bounds check at function entry. The `!activeItem` guard
  // below also catches a missing active id (via `items[-1] === undefined`),
  // but the indirection between `findIndex` and the downstream
  // `splice(activeIndex, 1)` makes future edits risky — `splice(-1, 1)` would
  // silently remove the last item. We only check `activeIndex` here because
  // `overIndex === -1` is intentional when `overId === SENTINEL_ID` and is
  // handled by the sentinel branch below.
  if (activeIndex < 0) {
    return { depth: 0, parentId: rootParentId, maxDepth: 0, minDepth: 0 }
  }

  const activeItem = items[activeIndex]

  if (!activeItem) {
    return { depth: 0, parentId: rootParentId, maxDepth: 0, minDepth: 0 }
  }

  // Sentinel: drop after last item — compute depth/parent from drag offset
  if (overId === SENTINEL_ID) {
    const lastItem = items[items.length - 1]
    const maxEndDepth = Math.min(lastItem ? lastItem.depth + 1 : 0, depthCeiling)
    // Use drag offset to allow indentation even at the end
    const effectiveOffset =
      Math.abs(dragOffset) > DEAD_ZONE_PX ? dragOffset - Math.sign(dragOffset) * DEAD_ZONE_PX : 0
    const dragDepthVal = Math.round(effectiveOffset / indentWidth)
    let endDepth = (lastItem?.depth ?? 0) + dragDepthVal
    endDepth = Math.max(0, Math.min(endDepth, maxEndDepth))

    // Walk backwards to find parent at endDepth - 1
    let endParentId = rootParentId
    if (endDepth > 0) {
      const ancestor = [...items].toReversed().find((item) => item.depth === endDepth - 1)
      endParentId = ancestor?.id ?? rootParentId
    }

    return { depth: endDepth, parentId: endParentId, maxDepth: maxEndDepth, minDepth: 0 }
  }

  if (overIndex < 0) {
    return { depth: 0, parentId: rootParentId, maxDepth: 0, minDepth: 0 }
  }

  // Simulate the array after moving active to over's position
  const clonedItems = [...items]
  const [moved] = clonedItems.splice(activeIndex, 1)
  clonedItems.splice(overIndex > activeIndex ? overIndex - 1 : overIndex, 0, moved as FlatBlock)

  // The item is now at this index in the cloned array
  const projectedIndex = overIndex > activeIndex ? overIndex - 1 : overIndex

  const previousItem: FlatBlock | undefined = clonedItems[projectedIndex - 1]
  const nextItem: FlatBlock | undefined = clonedItems[projectedIndex + 1]

  // Dead zone: ignore small horizontal movements to prevent accidental indent
  const effectiveOffset =
    Math.abs(dragOffset) > DEAD_ZONE_PX ? dragOffset - Math.sign(dragOffset) * DEAD_ZONE_PX : 0
  const dragDepth = Math.round(effectiveOffset / indentWidth)
  const projectedDepth = activeItem.depth + dragDepth

  // Max depth: can be a child of the previous item (previous.depth + 1),
  // clamped so the dragged subtree's deepest descendant stays within
  // MAX_BLOCK_DEPTH (#928).
  const maxDepth = Math.min(previousItem ? previousItem.depth + 1 : 0, depthCeiling)

  // Min depth: must be at least the depth of the next item (to maintain tree structure)
  const minDepth = nextItem ? nextItem.depth : 0

  let depth = projectedDepth
  if (depth > maxDepth) depth = maxDepth
  if (depth < minDepth) depth = minDepth
  depth = Math.max(0, depth)

  // Determine the parent ID at this depth
  function getParentId(): string | null {
    if (depth === 0 || !previousItem) return rootParentId

    if (depth === previousItem.depth) {
      // Same level as previous → same parent
      return previousItem.parent_id ?? rootParentId
    }

    if (depth > previousItem.depth) {
      // Deeper → child of previous
      return previousItem.id
    }

    // Shallower → walk backwards to find ancestor at (depth - 1)
    const ancestor = clonedItems
      .slice(0, projectedIndex)
      .toReversed()
      .find((item) => item.depth === depth - 1)

    return ancestor?.id ?? rootParentId
  }

  return { depth, parentId: getParentId(), maxDepth, minDepth }
}

// ── Position computation ─────────────────────────────────────────────────

/**
 * Compute a safe position value for inserting a block among new siblings.
 *
 * Given the flat tree, the projected parent, and the drop target, compute the
 * **0-based sibling slot** to pass to `moveBlock(blockId, parentId, newIndex)`
 * (#400). The slot is an insertion index among the target parent's children
 * **excluding the active block** — matching the backend's `LoroTree::mov_to`
 * semantics. The backend derives the convergent fractional key from this slot,
 * so there are no colliding integers and no non-positive positions.
 *
 * This replaces the old sparse-`position` arithmetic (`computePosition`) that
 * produced colliding integers (BUG 1/2) and `position - 1 == 0` for "move to
 * top" / "nest as first child" (BUG 3/4). Computing the slot from the
 * post-removal order fixes all four at once.
 *
 * @param items     Flattened (visible) tree items, active block still present.
 * @param parentId  The projected new parent ID (null = root).
 * @param overId    The drop target id (or {@link SENTINEL_ID} for after-last).
 * @param activeId  ID of the block being moved (excluded from the sibling scan).
 */
export function computeDropIndex(
  items: FlatBlock[],
  parentId: string | null,
  overId: string,
  activeId: string,
): number {
  const activeIndex = items.findIndex((i) => i.id === activeId)
  // The post-removal flat order: where the block lands once it vacates its slot.
  const without = items.filter((i) => i.id !== activeId)

  // Flat index in `without` at which the block is inserted.
  let insertAt: number
  if (overId === SENTINEL_ID) {
    insertAt = without.length
  } else {
    const overIdxInWithout = without.findIndex((i) => i.id === overId)
    if (overIdxInWithout < 0) {
      insertAt = without.length // unknown target → append
    } else {
      // dnd-kit semantics: dragging downward (active was above the target)
      // drops AFTER the target; dragging upward drops BEFORE it.
      const overIdxInItems = items.findIndex((i) => i.id === overId)
      insertAt = overIdxInItems > activeIndex ? overIdxInWithout + 1 : overIdxInWithout
    }
  }

  // Slot = number of the parent's children that appear before `insertAt` in the
  // post-removal order. (Pre-move depth/parent are correct for the non-moved
  // blocks we're counting against.)
  const parentDepth = parentId === null ? -1 : (items.find((i) => i.id === parentId)?.depth ?? -1)
  const childDepth = parentDepth + 1
  let slot = 0
  for (let i = 0; i < insertAt && i < without.length; i++) {
    const item = without[i] as FlatBlock
    if ((item.parent_id ?? null) === parentId && item.depth === childDepth) {
      slot += 1
    }
  }
  return slot
}
