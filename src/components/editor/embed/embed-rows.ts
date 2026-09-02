/**
 * Slice an embed's rows out of the source page's flat tree and re-base their
 * depth to 0 (#4550).
 *
 * The re-basing is a hard requirement, not a style choice. `MAX_BLOCK_DEPTH`
 * bounds storage depth *per page* and bounds nothing an embed does: a block
 * embed sitting at storage depth 19 of the host page whose target sits at
 * storage depth 19 of the source page is 38 legal levels of visual nesting,
 * which overflows any window horizontally at the current `--indent-width`.
 * The re-based depth is also exactly the input `aria-level` needs to be
 * host-relative rather than inherited from the source page.
 */

import type { FlatBlock } from '@/lib/tree-utils'

export interface EmbeddedRowSelection {
  /** Rows to render, re-based so the shallowest is depth 0. */
  rows: FlatBlock[]
  /** Rows past the mount limit that are NOT rendered. */
  hiddenCount: number
  /** True when `targetId` was not found in the source page's flat tree. */
  missing: boolean
}

/**
 * @param flat        the source page's flat tree (`buildFlatTree` output)
 * @param targetId    the embed target
 * @param sourcePageId the page whose store produced `flat`
 * @param limit       max rows to render (see `EMBED_MOUNT_LIMIT`)
 */
export function selectEmbeddedRows(
  flat: readonly FlatBlock[],
  targetId: string,
  sourcePageId: string,
  limit: number,
): EmbeddedRowSelection {
  // A page embed. The page block itself is not a row in its own flat tree —
  // `buildFlatTree(blocks, pageId)` starts at the page's CHILDREN — so the
  // whole list is already re-based and the breadcrumb collapses to the page
  // title alone (there are no ancestors to show).
  if (targetId === sourcePageId) {
    return truncate([...flat], limit, false)
  }

  const startIndex = flat.findIndex((b) => b.id === targetId)
  if (startIndex === -1) return { rows: [], hiddenCount: 0, missing: true }

  const start = flat[startIndex]
  // Defensive: `findIndex` guarantees this, but the index read is not typed
  // as non-nullable under `noUncheckedIndexedAccess`.
  if (!start) return { rows: [], hiddenCount: 0, missing: true }
  const baseDepth = start.depth

  // In a DFS-flattened list, a block's descendants are the consecutive
  // following rows with depth > its own — the same contract
  // `getDescendantIds` relies on.
  const subtree: FlatBlock[] = [{ ...start, depth: 0 }]
  for (let i = startIndex + 1; i < flat.length; i++) {
    const row = flat[i]
    if (!row || row.depth <= baseDepth) break
    subtree.push({ ...row, depth: row.depth - baseDepth })
  }

  return truncate(subtree, limit, false)
}

function truncate(rows: FlatBlock[], limit: number, missing: boolean): EmbeddedRowSelection {
  if (rows.length <= limit) return { rows, hiddenCount: 0, missing }
  return { rows: rows.slice(0, limit), hiddenCount: rows.length - limit, missing }
}

/**
 * The source-page ancestor chain of `targetId`, outermost first, EXCLUDING
 * the target itself and the page root. Feeds the container's breadcrumb.
 */
export function embedAncestors(
  blocksById: ReadonlyMap<string, FlatBlock>,
  targetId: string,
  sourcePageId: string,
): FlatBlock[] {
  const chain: FlatBlock[] = []
  const seen = new Set<string>([targetId])
  let cursor = blocksById.get(targetId)?.parent_id ?? null
  while (cursor != null && cursor !== sourcePageId && !seen.has(cursor)) {
    seen.add(cursor)
    const parent = blocksById.get(cursor)
    if (!parent) break
    chain.unshift(parent)
    cursor = parent.parent_id
  }
  return chain
}
