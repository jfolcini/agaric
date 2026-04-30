/**
 * Pure tree algorithms used by the page-blocks store.
 *
 * Extracted from `src/stores/page-blocks.ts` per MAINT-127 — these are
 * referentially-transparent helpers (no IPC, no Zustand state) that
 * operate on `FlatBlock[]` arrays. Keep new pure tree helpers here
 * rather than back in the store factory.
 */

import { parse, serialize } from '../editor/markdown-serializer'
import type { BlockLevelNode } from '../editor/types'
import { type FlatBlock, getDragDescendants } from './tree-utils'

/**
 * Compute a midpoint position between two sibling positions, nudging up by one
 * when the floored midpoint would collide with `beforePos`. Callers rely on
 * the returned value being strictly greater than `beforePos`.
 */
export function midpointPosition(beforePos: number, afterPos: number): number {
  const mid = Math.floor((beforePos + afterPos) / 2)
  return mid <= beforePos ? beforePos + 1 : mid
}

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
  return serialize({ type: 'doc', content: [b] })
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
export function findPrevSiblingAt(blocks: readonly FlatBlock[], idx: number): FlatBlock | null {
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
 * - `blockId` itself is re-parented to `prevSibling.id` with `position: 1`.
 * - The moved subtree is spliced back after `prevSibling` and any existing
 *   descendants of `prevSibling` (so it lands at the tail of the new parent).
 *
 * Callers are responsible for validating that `prevSibling` is a legal
 * indent target (same depth + parent as `blockId` before the move).
 */
export function computeIndentedBlocks(
  blocks: readonly FlatBlock[],
  blockId: string,
  prevSibling: FlatBlock,
): FlatBlock[] {
  const arr = [...blocks]
  const descendantIds = getDragDescendants(arr, blockId)
  const movedSet = new Set<string>([blockId, ...descendantIds])

  const movedItems: FlatBlock[] = arr
    .filter((b) => movedSet.has(b.id))
    .map((b) => ({
      ...b,
      depth: b.depth + 1,
      ...(b.id === blockId ? { parent_id: prevSibling.id, position: 1 } : {}),
    }))

  const remaining = arr.filter((b) => !movedSet.has(b.id))
  const prevSibDescendants = getDragDescendants(remaining, prevSibling.id)
  let insertAt = remaining.findIndex((b) => b.id === prevSibling.id) + 1
  while (
    insertAt < remaining.length &&
    prevSibDescendants.has((remaining[insertAt] as FlatBlock).id)
  ) {
    insertAt++
  }

  remaining.splice(insertAt, 0, ...movedItems)
  return remaining
}
