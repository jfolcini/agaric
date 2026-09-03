/**
 * GraphView helpers — data-fetch extraction and shared types.
 *
 * `fetchGraphData` consolidates the tag-dimension-driven page/link/template
 * fetch into a single helper that returns a normalised `{ nodes, edges }`
 * result. Keeping it at module scope lets the calling effect stay linear and
 * testable without hauling d3 types around.
 */

import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type { GraphEdge, GraphFetchResult, GraphNode } from '@/lib/graph-types'
import { t } from '@/lib/i18n'
import { toSpaceScope } from '@/lib/space-scope'
import type { PageHeading } from '@/lib/tauri'
import { listAllPagesInSpace, listTemplatePageIdsInSpace } from '@/lib/tauri'

// Re-export the graph data types from their leaf home (`@/lib/graph-types`,
// #761) so existing `from '@/components/graph/GraphView.helpers'` import sites keep working.
export type { GraphEdge, GraphFetchResult, GraphNode } from '@/lib/graph-types'

/**
 * Fetch every page in the active space (optionally restricted to pages
 * carrying at least one of `tagFilterIds`).  Routes through
 * `list_all_pages_in_space` which has no pagination and no clamp —
 * the graph view genuinely wants every node.
 *
 * `spaceId` is required-active here — `fetchGraphData` short-circuits to
 * an empty graph before this is reached when there is no active space, so
 * a non-null id is always passed.
 */
function fetchPages(tagFilterIds: readonly string[], spaceId: string): Promise<PageHeading[]> {
  const tagIds = tagFilterIds.length > 0 ? [...tagFilterIds] : null
  return listAllPagesInSpace(spaceId, tagIds)
}

/**
 * `backlinksTruncated` mirrors `PageLinksResponse.truncated` (#2298
 * count-then-cap). When the edge fetch was capped, the backend drops the
 * WEAKEST edges first (`ORDER BY edge_count DESC … LIMIT`), so a page with
 * a single inbound link sorts last and can be cut entirely — `backlinkCounts`
 * would then miscount it as zero rather than merely "unknown". Since that
 * bias applies across the whole node set (not just the ones that got cut),
 * every node's `backlink_count` is set to `undefined` rather than computed
 * when truncated (#3314 finding 3), so callers to the boolean
 * `hasBacklinks` filter dimension can tell "no backlinks" apart from
 * "don't know" (see `nodeMatchesFilter` in `@/lib/graph-filters`).
 */
function buildNodes(
  items: PageHeading[],
  templateIds: Set<string>,
  backlinkCounts: Map<string, number>,
  backlinksTruncated: boolean,
): GraphNode[] {
  return items.map((p) => ({
    id: p.id,
    label: p.content && p.content.length > 0 ? p.content : t('common.untitled'),
    todo_state: p.todo_state,
    priority: p.priority,
    due_date: p.due_date,
    scheduled_date: p.scheduled_date,
    is_template: templateIds.has(p.id),
    backlink_count: backlinksTruncated ? undefined : (backlinkCounts.get(p.id) ?? 0),
  }))
}

function countBacklinks(
  links: ReadonlyArray<{ source_id: string; target_id: string }>,
  nodeIds: ReadonlySet<string>,
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const link of links) {
    if (nodeIds.has(link.target_id) && nodeIds.has(link.source_id)) {
      counts.set(link.target_id, (counts.get(link.target_id) ?? 0) + 1)
    }
  }
  return counts
}

/**
 * Fetch pages, page-links, and templates in parallel; return normalised
 * graph nodes + edges suitable for d3-force consumption.
 *
 * The only server-side filter this applies is tag membership; every other
 * dimension is handled client-side via `applyGraphFilters`.
 *
 * `spaceId` — every IPC request is restricted to the active space. The
 * page-list and template-id fetches are required-active (b1): with no
 * active space the graph has nothing to render, so we short-circuit to an
 * empty result before dispatching rather than sending a `Global` scope
 * (which the backend rejects for these commands).
 */
export async function fetchGraphData(
  tagFilterIds: readonly string[],
  spaceId: string | null,
): Promise<GraphFetchResult> {
  if (spaceId == null) return { nodes: [], edges: [], edgesTotal: 0, edgesTruncated: false }
  // Push the active tag filter into `list_page_links`
  // so the backend ships only edges whose **target page** carries one
  // of the requested tags. Pre-Tier-4.5 the renderer fetched every
  // space-wide edge then dropped any whose endpoint was not in the
  // post-filtered `nodeIds` set; with the push-down the response is
  // already shape-restricted to the visible subgraph.
  const linksTagIds: string[] | null = tagFilterIds.length > 0 ? [...tagFilterIds] : null
  const [pages, linksResponse, templateIdList] = await Promise.all([
    fetchPages(tagFilterIds, spaceId),
    commands.listPageLinks(toSpaceScope(spaceId), linksTagIds).then(unwrap),
    listTemplatePageIdsInSpace(spaceId),
  ])

  // #2298 count-then-cap: `list_page_links` now ships a
  // `PageLinksResponse` envelope — the (possibly capped) `edges` plus the
  // TRUE `total` and a `truncated` flag so the view can surface an honest
  // "showing N of M links" notice when the cap fired.
  const links = linksResponse.edges
  const templateIds = new Set<string>(templateIdList)

  const nodeIds = new Set<string>(pages.map((p) => p.id))
  const backlinkCounts = countBacklinks(links, nodeIds)
  const nodes = buildNodes(pages, templateIds, backlinkCounts, linksResponse.truncated)
  const edges: GraphEdge[] = links
    .filter((l) => nodeIds.has(l.source_id) && nodeIds.has(l.target_id))
    .map((l) => ({
      source: l.source_id,
      target: l.target_id,
      ref_count: l.ref_count,
    }))

  return {
    nodes,
    edges,
    edgesTotal: linksResponse.total,
    edgesTruncated: linksResponse.truncated,
  }
}
