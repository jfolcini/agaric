/**
 * Tauri mock — the SINGLE owner of the `[[ULID]]` link-token scan.
 *
 * #3332. The mock has no materialized `block_links` table, so every
 * link-serving surface derives edges live by scanning block content. That scan
 * was written out eight times (once in `deriveLinkEdges`, six times inline in
 * `handlers/links.ts`, once in the conformance snapshot builder), which made
 * the arrangement silently one-directional: change the backend's link
 * semantics, update the helper and the snapshot copy, and the Rust/TS
 * `page_links` snapshots still agree while all six backlink/graph handlers keep
 * serving the OLD semantics to every Playwright spec. Nothing failed. The
 * inverse was equally silent — a fix in one copy never reached the other five.
 *
 * The token grammar mirrors `fakeId()` in `seed.ts` and the backend's
 * `[[<26-char Crockford base32>]]` reference form (#762).
 *
 * This module is a LEAF: it holds no mock state, so the state-free conformance
 * snapshot builder and the stateful handlers can both consume it.
 */

/**
 * Build a fresh `[[ULID]]` scanner.
 *
 * A function, not a shared const: the regex is `g`-flagged and therefore
 * stateful (`lastIndex`), and handing the same object to interleaved
 * `exec`/`test` callers is a classic source of skipped matches. `matchAll`
 * clones internally, but the callers here should not have to know that.
 */
export function linkTokenRe(): RegExp {
  return /\[\[([0-9A-Z]{26})\]\]/g
}

/** Every `[[ULID]]` target id in `content`, in occurrence order (duplicates kept). */
export function scanLinkTargets(content: string | null | undefined): string[] {
  if (!content || !content.includes('[[')) return []
  const targets: string[] = []
  for (const m of content.matchAll(linkTokenRe())) targets.push(m[1] as string)
  return targets
}

/** Whether `content` carries at least one `[[targetId]]` token. */
export function contentLinksTo(content: string | null | undefined, targetId: string): boolean {
  if (!content || !content.includes('[[')) return false
  for (const m of content.matchAll(linkTokenRe())) {
    if (m[1] === targetId) return true
  }
  return false
}

/**
 * A `[[ULID]]`-derived block-link edge — mock stand-in for `block_links`.
 * `sourcePageId` is the owning page of the source block (a page block owns
 * itself, a descendant carries its ancestor `page_id`, an orphan is `null`).
 * It is what the same-page/self/orphan-source exclusion (migration 0070)
 * reads to decide whether an edge counts toward a target page's inbound total.
 */
export interface MockLinkEdge {
  sourceId: string
  targetId: string
  sourcePageId: string | null
}

/**
 * Scan every non-deleted block's content for `[[ULID]]` tokens and return the
 * implied block-link edges. The faithful mock stand-in for the backend's
 * `block_links` table — used to evaluate the link facets (`Orphan` /
 * `HasNoInboundLinks`) and the `MostLinked` sort. Mirrors the `get_backlinks`
 * scan. Each edge captures the source block's `page_id` so `pageLinkStats`
 * can apply the same-page/self/orphan-source inbound exclusion (migration
 * 0070 + `recompute_pages_cache_counts_for_pages`).
 *
 * Deliberately UNSCOPED: the `SpaceScope` filter the link-serving handlers
 * apply is the caller's business (see `inSpaceScope` in `handlers/shared.ts`),
 * and the conformance snapshot — the one place the mock's derivation is
 * compared against the backend's real `block_links` table — is single-space.
 */
export function deriveLinkEdges(allBlocks: Map<string, Record<string, unknown>>): MockLinkEdge[] {
  const edges: MockLinkEdge[] = []
  for (const blk of allBlocks.values()) {
    if (blk['deleted_at']) continue
    const sourcePageId = (blk['page_id'] as string | null) ?? null
    for (const targetId of scanLinkTargets(blk['content'] as string | null)) {
      edges.push({ sourceId: blk['id'] as string, targetId, sourcePageId })
    }
  }
  return edges
}
