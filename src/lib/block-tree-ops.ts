/**
 * Pure tree algorithms used by the page-blocks store.
 *
 * Extracted from `src/stores/page-blocks.ts` per these are
 * referentially-transparent helpers (no IPC, no Zustand state) that
 * operate on flat-tree arrays: the store's `FlatBlock[]`, and page mode's
 * blocks (#5691), so Tab and Shift+Tab mean the same in both. Keep new pure
 * tree helpers here rather than back in the store factory.
 */

import { notifyUnknownNodeTypeToast } from '@/editor/markdown-serialize-toast'
import { parse, serialize } from '@/editor/markdown-serializer'
import type { BlockLevelNode } from '@/editor/types'
import {
  buildIndexById,
  getDragDescendants,
  MAX_BLOCK_DEPTH,
  type TreeItem,
} from '@/lib/tree-utils'

// ── splitBlock helpers ───────────────────────────────────────────────────

/**
 * Plan produced by {@link planSplit}, describing what `splitBlock` should do:
 *
 * - `noop` — parsing produced no work (empty markdown, or a single block that
 *   round-trips to the same markdown, or a set of blocks that are all empty
 *   paragraphs).
 * - `edit-only` — the parsed content is a single block whose serialized form
 *   differs from the input markdown; edit the existing block in place.
 * - `split` — multiple non-empty blocks; edit the existing block with `first`
 *   and create new blocks below for each entry in `rest`.
 */
export type SplitPlan =
  | { kind: 'noop' }
  | { kind: 'edit-only'; content: string }
  | { kind: 'split'; first: string; rest: readonly string[] }

/** True when a block carries content — non-paragraph blocks, or paragraphs with inline nodes. */
export function isNonEmptyBlock(b: BlockLevelNode): boolean {
  return b.type !== 'paragraph' || (b.content != null && b.content.length > 0)
}

/** Serialize a single block-level node by wrapping it in a one-element doc. */
function serializeSingleBlock(b: BlockLevelNode): string {
  return serialize({ type: 'doc', content: [b] }, notifyUnknownNodeTypeToast)
}

/**
 * Pure classifier for `splitBlock`: parse the markdown and decide whether to
 * do nothing, edit the target block in place, or split into multiple blocks.
 *
 * Keeping this pure (no store access, no IO) lets the store action stay a
 * thin orchestrator and makes the branching logic unit-testable in isolation.
 */
export function planSplit(markdown: string): SplitPlan {
  const doc = parse(markdown)
  const blocks = doc.content ?? []
  if (blocks.length <= 1) {
    const content = blocks.length === 1 ? serializeSingleBlock(blocks[0] as BlockLevelNode) : ''
    return content === markdown ? { kind: 'noop' } : { kind: 'edit-only', content }
  }
  const nonEmpty = blocks.filter(isNonEmptyBlock)
  if (nonEmpty.length === 0) return { kind: 'noop' }
  const serialized = nonEmpty.map((b) => serializeSingleBlock(b as BlockLevelNode))
  const [first, ...rest] = serialized
  return { kind: 'split', first: first as string, rest }
}

// ── indent helpers ───────────────────────────────────────────────────────

/**
 * Walk backwards from `idx` in a flat-tree slice and return the previous
 * sibling of `blocks[idx]` — the nearest earlier block at the same depth and
 * with the same `parent_id`. Returns `null` when there is no such sibling
 * (the block is the first child of its parent, or `idx` is out of range).
 *
 * Mirrors the inline loop from the `indent` action but is pure and easily
 * testable. The walk short-circuits if a block at a *shallower* depth is
 * encountered first, matching the original semantics.
 */
export function findPrevSiblingAt<T extends TreeItem>(blocks: readonly T[], idx: number): T | null {
  const block = blocks[idx]
  if (!block) return null
  for (let i = idx - 1; i >= 0; i--) {
    const candidate = blocks[i]
    if (!candidate) continue
    if (candidate.depth < block.depth) return null
    if (
      candidate.depth === block.depth &&
      (candidate.parent_id ?? null) === (block.parent_id ?? null)
    ) {
      return candidate
    }
  }
  return null
}

/**
 * Pure computation of the flat-tree state that results from indenting
 * `blockId` under `prevSibling`:
 *
 * - `blockId` and all of its descendants have their `depth` incremented by 1.
 * - `blockId` itself is re-parented to `prevSibling.id` with a provisional
 *   `position: 1` (the real dense rank — #400 — is assigned by the backend;
 *   ordering here is governed by the splice, not the integer).
 * - The moved subtree is spliced back after `prevSibling` and any existing
 *   descendants of `prevSibling` (so it lands at the tail of the new parent).
 *
 * Callers are responsible for validating that `prevSibling` is a legal
 * indent target (same depth + parent as `blockId` before the move).
 */
export function computeIndentedBlocks<T extends TreeItem>(
  blocks: readonly T[],
  blockId: string,
  prevSibling: T,
): T[] {
  const arr = [...blocks]
  const descendantIds = getDragDescendants(arr, blockId)
  const movedSet = new Set<string>([blockId, ...descendantIds])

  const movedItems: T[] = arr
    .filter((b) => movedSet.has(b.id))
    .map((b) =>
      b.id === blockId
        ? Object.assign({}, b, { depth: b.depth + 1, parent_id: prevSibling.id, position: 1 })
        : Object.assign({}, b, { depth: b.depth + 1 }),
    )

  const remaining = arr.filter((b) => !movedSet.has(b.id))
  // `remaining` is scanned twice below for prevSibling's slot (getDragDescendants
  // + the insertion anchor). Build the id→index map once so both become O(1)
  // lookups (#2041/#2200 — mirrors the dedent/moveDown conversion).
  const remainingIndex = buildIndexById(remaining)
  const prevSibDescendants = getDragDescendants(remaining, prevSibling.id, remainingIndex)
  let insertAt = (remainingIndex.get(prevSibling.id) ?? -1) + 1
  while (insertAt < remaining.length && prevSibDescendants.has((remaining[insertAt] as T).id)) {
    insertAt++
  }

  remaining.splice(insertAt, 0, ...movedItems)
  return remaining
}

/**
 * #928 — whether indenting `blockId` under `prevSibling` would push its
 * deepest descendant past `MAX_BLOCK_DEPTH`: after the indent it sits at
 * `prevSibling.depth + 1`, and its subtree's height carries the rest. Checked
 * up front rather than left to the backend's rejection.
 */
export function indentTooDeep<T extends TreeItem>(
  blocks: readonly T[],
  blockId: string,
  prevSibling: T,
  indexById?: ReadonlyMap<string, number>,
): boolean {
  const block = blocks[(indexById ?? buildIndexById(blocks)).get(blockId) ?? -1]
  if (block === undefined) return false
  const descendants = getDragDescendants(blocks, blockId, indexById)
  let subtreeHeight = 0
  for (const b of blocks) {
    if (descendants.has(b.id)) subtreeHeight = Math.max(subtreeHeight, b.depth - block.depth)
  }
  return prevSibling.depth + 1 + subtreeHeight > MAX_BLOCK_DEPTH - 1
}

// ── dedent helpers ───────────────────────────────────────────────────────

/**
 * Pure computation of the flat-tree state that results from dedenting
 * `blockId` out of `parentId` (#400): it and its descendants move up a level,
 * re-parented to `newParentId`, and land right AFTER the parent's remaining
 * subtree, so the siblings that followed it stay under the parent.
 */
export function computeDedentedBlocks<T extends TreeItem>(
  blocks: readonly T[],
  blockId: string,
  parentId: string,
  newParentId: string | null,
): T[] {
  const descendantIds = getDragDescendants(blocks, blockId)
  const movedSet = new Set([blockId, ...descendantIds])

  const movedItems: T[] = blocks
    .filter((b) => movedSet.has(b.id))
    .map((b) => {
      const moved = Object.assign({}, b, { depth: b.depth - 1 })
      if (b.id === blockId) moved.parent_id = newParentId
      return moved
    })

  const remaining = blocks.filter((b) => !movedSet.has(b.id))
  // `remaining` is scanned twice for the parent's slot below
  // (getDragDescendants + the insertion anchor). Build the id→index map
  // once so both become O(1) lookups (#2041/#2200).
  const remainingIndex = buildIndexById(remaining)
  const parentDescendants = getDragDescendants(remaining, parentId, remainingIndex)
  let insertAt = (remainingIndex.get(parentId) ?? -1) + 1
  while (insertAt < remaining.length && parentDescendants.has((remaining[insertAt] as T).id)) {
    insertAt++
  }

  remaining.splice(insertAt, 0, ...movedItems)
  return remaining
}
