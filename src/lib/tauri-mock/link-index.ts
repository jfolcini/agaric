/**
 * Tauri mock — the stateful half of the link model (#6054): which link tokens
 * hold a `block_links` edge, over the mock's own stores. The token grammar and
 * the edge rule are the state-free `link-scan.ts`; this module applies them to
 * `blocks` and keeps `unresolvedLinks` (`block_links_unresolved`), the tokens
 * whose target was not live when their source was indexed.
 *
 * `create_block`, `edit_block`, the restores and their undo keep it. A block
 * another writer fills owes nothing, so its tokens link while their target
 * exists, as they did before the mock tracked what is owed.
 *
 * Its own module so `handlers/shared.ts` and `revert.ts` can both import it:
 * `shared.ts` imports `revert.ts`.
 */

import {
  type MockLinkEdge,
  deriveLinkEdges,
  holdsLink,
  scanLinkTargets,
} from '@/lib/tauri-mock/link-scan'
import { blocks, unresolvedLinks } from '@/lib/tauri-mock/seed'

/** `holdsLink` over the mock's own state: the `block_links` row test. */
export function linksTo(source: Record<string, unknown>, targetId: string): boolean {
  return holdsLink(source, targetId, blocks, unresolvedLinks)
}

function isLive(id: string): boolean {
  const b = blocks.get(id)
  return b != null && b['deleted_at'] == null
}

/** Every edge the mock's `block_links` holds (`deriveLinkEdges`). */
export function linkEdges(): MockLinkEdge[] {
  return deriveLinkEdges(blocks, unresolvedLinks)
}

/** The targets `source` holds an edge to: what a reindex of it diffs against. */
export function linkedTargets(source: Record<string, unknown>): Set<string> {
  const content = source['content'] as string | null
  return new Set(scanLinkTargets(content).filter((t) => linksTo(source, t)))
}

/**
 * `reindex_block_links_conn` for `source`, after its content was written or
 * it was restored (#6054). A token whose target is missing or in the trash
 * gets no edge and is owed one, unless the source held that edge before
 * (`linked`): a tombstone never takes away an edge that already exists. The
 * backend also declines a target of another space or of none (`NULL = ?3`),
 * which the mock does not model: a write naming one of another space is
 * refused unless its page already holds that token (#5272).
 */
export function indexLinks(source: Record<string, unknown>, linked: ReadonlySet<string>): void {
  const id = source['id'] as string
  const owed = scanLinkTargets(source['content'] as string | null).filter(
    (t) => !linked.has(t) && !isLive(t),
  )
  if (owed.length > 0) unresolvedLinks.set(id, new Set(owed))
  else unresolvedLinks.delete(id)
}

/**
 * The repair a restore runs for every block it brings back: the block is
 * reindexed as a source, and every live source owed an edge to it gets one
 * (`ReindexBlockLinks` → `resolve_referrers_of`).
 */
export function relinkRestored(restored: readonly string[]): void {
  for (const id of restored) {
    const b = blocks.get(id)
    if (b) indexLinks(b, linkedTargets(b))
  }
  for (const [sourceId, owed] of unresolvedLinks) {
    if (!isLive(sourceId)) continue
    for (const id of restored) owed.delete(id)
    if (owed.size === 0) unresolvedLinks.delete(sourceId)
  }
}
