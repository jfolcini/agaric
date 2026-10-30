/**
 * Tauri mock — the stateful half of the link model (#6054): which link tokens
 * hold a `block_links` edge, over the mock's own stores. The token grammar and
 * the edge rule are the state-free `link-scan.ts`; this module applies them to
 * `blocks` and keeps `unresolvedLinks` (`block_links_unresolved`), the tokens
 * whose target the INSERT could not link when their source was indexed, and
 * `keptLinkKinds`, the kinds the content no longer spells.
 *
 * `create_block`, `edit_block`, batch create, paste, duplicate, a draft flush,
 * the restores and their undo keep it. A block another writer fills, an
 * import for one, owes nothing, so its tokens link while their target exists,
 * as they did before the mock tracked what is owed.
 *
 * A block's space lives here too, because which tokens link depends on it.
 * Its own module so `handlers/shared.ts` and `revert.ts` can both import it:
 * `shared.ts` imports `revert.ts`.
 */

import {
  type MockLinkEdge,
  type MockLinkKind,
  classifyLinkKind,
  deriveLinkEdges,
  edgeKind,
  holdsLink,
  scanLinkTargets,
} from '@/lib/tauri-mock/link-scan'
import { blocks, keptLinkKinds, unresolvedLinks } from '@/lib/tauri-mock/seed'

/** `holdsLink` over the mock's own state: the `block_links` row test. */
export function linksTo(source: Record<string, unknown>, targetId: string): boolean {
  return holdsLink(source, targetId, blocks, unresolvedLinks)
}

function isLive(id: string): boolean {
  const b = blocks.get(id)
  return b != null && b['deleted_at'] == null
}

/**
 * A block's space: the `space_id` of its OWNING page (`page_id`, falling back
 * to the block's own id when it IS a page or a top-level tag). The space
 * writers fan `space_id` out over the page group (`setPageGroupSpace`), but
 * `create_block` leaves a block it creates under a page unstamped, so a
 * reader that may meet one goes through the owner.
 */
export function ownerSpaceOf(b: Record<string, unknown>): string | null {
  const ownerId = (b['page_id'] as string | null) ?? (b['id'] as string)
  return (blocks.get(ownerId)?.['space_id'] as string | null | undefined) ?? null
}

/**
 * The space whose definitions type `blockId`'s properties, as the backend's
 * `resolve_block_space` reads it: the block's own `space_id`, else its owning
 * page's space.
 */
export function definitionSpaceOf(blockId: string): string | null {
  const block = blocks.get(blockId)
  if (!block || block['deleted_at'] != null) return null
  return (block['space_id'] as string | null) ?? ownerSpaceOf(block)
}

/**
 * Whether the `block_links` INSERT keeps `targetId` for `source`: the target
 * is live, and of the source's space when the source has one. A target in no
 * space fails that too (`NULL = ?3`). No fixture pins a source in no space:
 * the backend harness cannot hold one, its engine parity guard needs a space.
 */
function linkable(source: Record<string, unknown>, targetId: string): boolean {
  if (!isLive(targetId)) return false
  const sourceSpace = definitionSpaceOf(source['id'] as string)
  return sourceSpace === null || definitionSpaceOf(targetId) === sourceSpace
}

/** Every edge the mock's `block_links` holds (`deriveLinkEdges`). */
export function linkEdges(): MockLinkEdge[] {
  return deriveLinkEdges(blocks, unresolvedLinks, keptLinkKinds)
}

/** `edgeKind` over the mock's own state: the `block_links.kind` column. */
export function linkKind(source: Record<string, unknown>, targetId: string): MockLinkKind {
  return edgeKind(source, targetId, keptLinkKinds)
}

/**
 * The targets `source` holds an edge to, with each edge's kind: what a
 * reindex of it diffs against.
 */
export function linkedTargets(source: Record<string, unknown>): Map<string, MockLinkKind> {
  const content = source['content'] as string | null
  return new Map(
    scanLinkTargets(content)
      .filter((t) => linksTo(source, t))
      .map((t) => [t, linkKind(source, t)]),
  )
}

/**
 * `reindex_block_links_conn` for `source`, after its content was written or
 * it was restored (#6054). A token the INSERT declines (`linkable`) gets no
 * edge and is owed one, unless the source held that edge before (`linked`):
 * neither a tombstone nor a space move takes away an edge that already exists,
 * and such an edge keeps the kind it held, as the INSERT's upsert is what
 * re-kinds a pair.
 */
export function indexLinks(
  source: Record<string, unknown>,
  linked: ReadonlyMap<string, MockLinkKind>,
): void {
  const id = source['id'] as string
  const content = source['content'] as string | null
  const tokens = scanLinkTargets(content)
  const owed = tokens.filter((t) => !linked.has(t) && !linkable(source, t))
  if (owed.length > 0) unresolvedLinks.set(id, new Set(owed))
  else unresolvedLinks.delete(id)
  const kept = [...linked].filter(
    ([t, kind]) =>
      tokens.includes(t) && !linkable(source, t) && kind !== classifyLinkKind(content, t),
  )
  if (kept.length > 0) keptLinkKinds.set(id, new Map(kept))
  else keptLinkKinds.delete(id)
}

/**
 * The repair a restore runs for every block it brings back: the block is
 * reindexed as a source, and so is every live source that owes it an edge
 * (`ReindexBlockLinks` → `resolve_referrers_of`), which links it only if the
 * INSERT keeps it now.
 */
export function relinkRestored(restored: readonly string[]): void {
  for (const id of restored) {
    const b = blocks.get(id)
    if (b) indexLinks(b, linkedTargets(b))
  }
  const referrers = [...unresolvedLinks]
    .filter(([sourceId, owed]) => isLive(sourceId) && restored.some((id) => owed.has(id)))
    .map(([sourceId]) => blocks.get(sourceId) as Record<string, unknown>)
  for (const source of referrers) indexLinks(source, linkedTargets(source))
}
