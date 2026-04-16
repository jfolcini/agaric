/**
 * Tree utilities for the block outliner.
 *
 * Converts a bag of blocks (adjacency-list parent_id) into a flattened,
 * depth-annotated list suitable for rendering + sortable DnD.
 * Also provides a projection algorithm that maps horizontal drag offset
 * to a target depth / parent — enabling drag-to-indent.
 */

import type { BlockRow } from './tauri'

/** Sentinel ID used as drop target after the last block in the list. */
export const SENTINEL_ID = '__drop-after-last__'

/** Dead zone in pixels: horizontal drag must exceed this before any indent change. */
export const DEAD_ZONE_PX = 20

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
): Projection {
  const overIndex = items.findIndex((item) => item.id === overId)
  const activeIndex = items.findIndex((item) => item.id === activeId)
  const activeItem = items[activeIndex]

  if (!activeItem) {
    return { depth: 0, parentId: rootParentId, maxDepth: 0, minDepth: 0 }
  }

  // Sentinel: drop after last item — compute depth/parent from drag offset
  if (overId === SENTINEL_ID) {
    const lastItem = items[items.length - 1]
    const maxEndDepth = lastItem ? lastItem.depth + 1 : 0
    // Use drag offset to allow indentation even at the end
    const effectiveOffset =
      Math.abs(dragOffset) > DEAD_ZONE_PX ? dragOffset - Math.sign(dragOffset) * DEAD_ZONE_PX : 0
    const dragDepthVal = Math.round(effectiveOffset / indentWidth)
    let endDepth = (lastItem?.depth ?? 0) + dragDepthVal
    endDepth = Math.max(0, Math.min(endDepth, maxEndDepth))

    // Walk backwards to find parent at endDepth - 1
    let endParentId = rootParentId
    if (endDepth > 0) {
      const ancestor = [...items].reverse().find((item) => item.depth === endDepth - 1)
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

  // Max depth: can be a child of the previous item (previous.depth + 1)
  const maxDepth = previousItem ? previousItem.depth + 1 : 0

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
      .reverse()
      .find((item) => item.depth === depth - 1)

    return ancestor?.id ?? rootParentId
  }

  return { depth, parentId: getParentId(), maxDepth, minDepth }
}

// ── Position computation ─────────────────────────────────────────────────

/**
 * Compute a safe position value for inserting a block among new siblings.
 *
 * Given the flat tree and the projected parent + drop index, figure out
 * what position integer to pass to moveBlock.
 *
 * @param items      Flattened tree items.
 * @param parentId   The new parent ID (null = root).
 * @param dropIndex  Index in the flat list where the item will be placed.
 * @param activeId   ID of the item being moved (excluded from sibling scan).
 */
export function computePosition(
  items: FlatBlock[],
  parentId: string | null,
  dropIndex: number,
  activeId: string,
): number {
  // Find siblings of the target parent (excluding the active item)
  const siblings = items.filter(
    (item) =>
      item.id !== activeId &&
      (item.parent_id ?? null) === parentId &&
      item.depth ===
        (parentId === null ? 0 : (items.find((i) => i.id === parentId)?.depth ?? -1) + 1),
  )

  if (siblings.length === 0) return 1 // First child

  // Figure out which sibling we're inserting after based on drop index.
  // Find the last sibling that appears before dropIndex in the flat list.
  let insertAfterSibling: FlatBlock | null = null
  for (const sib of siblings) {
    const sibIndex = items.findIndex((item) => item.id === sib.id)
    if (sibIndex < dropIndex) {
      insertAfterSibling = sib
    }
  }

  if (!insertAfterSibling) {
    // Inserting before all siblings
    const firstPos = siblings[0]?.position ?? 1
    return firstPos - 1
  }

  const afterPos = insertAfterSibling.position ?? 0
  const afterIdx = siblings.indexOf(insertAfterSibling)
  const nextSibling = siblings[afterIdx + 1]

  if (!nextSibling) {
    // Inserting after the last sibling
    return afterPos + 1
  }

  const nextPos = nextSibling.position ?? afterPos + 2
  if (nextPos - afterPos > 1) {
    // There's a gap — use it
    return afterPos + 1
  }

  // No gap — place after and rely on backend to handle collisions
  return afterPos + 1
}
