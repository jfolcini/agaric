/**
 * GraphView helpers — data-fetch extraction (MAINT-56) and shared types.
 *
 * `fetchGraphData` consolidates the tag-dimension-driven page/link/template
 * fetch into a single helper that returns a normalised `{ nodes, edges, hasMore }`
 * result. Keeping it at module scope lets the calling effect stay linear and
 * testable without hauling d3 types around.
 */

import type { SimulationLinkDatum, SimulationNodeDatum } from 'd3-force'
import { listBlocks, listPageLinks, queryByProperty, queryByTags } from '@/lib/tauri'

export interface GraphNode extends SimulationNodeDatum {
  id: string
  label: string
  todo_state: string | null
  priority: string | null
  due_date: string | null
  scheduled_date: string | null
  is_template: boolean
  backlink_count: number
}

export interface GraphEdge extends SimulationLinkDatum<GraphNode> {
  source: string | GraphNode
  target: string | GraphNode
  ref_count: number
}

export interface GraphFetchResult {
  nodes: GraphNode[]
  edges: GraphEdge[]
  hasMore: boolean
}

type PageItem = Record<string, unknown>
interface PagesResponse {
  items: PageItem[]
  has_more: boolean
}

/**
 * Select the right page-listing call based on how many tag IDs were picked.
 * Server-side tag filter paths diverge (no tag / single tag / multi tag), so
 * we centralise the decision here.
 */
function fetchPages(tagFilterIds: readonly string[]): Promise<PagesResponse> {
  if (tagFilterIds.length === 0) {
    return listBlocks({ blockType: 'page', limit: 5000 }) as Promise<PagesResponse>
  }
  if (tagFilterIds.length === 1) {
    return listBlocks({ tagId: tagFilterIds[0], limit: 5000 }) as Promise<PagesResponse>
  }
  return queryByTags({
    tagIds: [...tagFilterIds],
    prefixes: [],
    mode: 'or',
    limit: 5000,
  }) as Promise<PagesResponse>
}

function readString(p: PageItem, key: string): string | null {
  const value = p[key]
  return typeof value === 'string' ? value : null
}

function buildNodes(
  items: PageItem[],
  templateIds: Set<string>,
  backlinkCounts: Map<string, number>,
): GraphNode[] {
  return items.map((p) => {
    const id = p['id'] as string
    const content = readString(p, 'content')
    return {
      id,
      label: content && content.length > 0 ? content : 'Untitled',
      todo_state: readString(p, 'todo_state'),
      priority: readString(p, 'priority'),
      due_date: readString(p, 'due_date'),
      scheduled_date: readString(p, 'scheduled_date'),
      is_template: templateIds.has(id),
      backlink_count: backlinkCounts.get(id) ?? 0,
    }
  })
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
 */
export async function fetchGraphData(tagFilterIds: readonly string[]): Promise<GraphFetchResult> {
  const [pagesResp, links, templatesResp] = await Promise.all([
    fetchPages(tagFilterIds),
    listPageLinks(),
    queryByProperty({ key: 'template', valueText: 'true', limit: 1000 }),
  ])

  // When filtering by tag, the API may return non-page blocks — keep only pages.
  const items =
    tagFilterIds.length > 0
      ? pagesResp.items.filter((p) => (p['block_type'] as string | undefined) === 'page')
      : pagesResp.items

  const templateIds = new Set(
    templatesResp.items.map((p) => p.id).filter((id): id is string => typeof id === 'string'),
  )

  const nodeIds = new Set(items.map((p) => p['id'] as string))
  const backlinkCounts = countBacklinks(links, nodeIds)
  const nodes = buildNodes(items, templateIds, backlinkCounts)
  const edges: GraphEdge[] = links
    .filter((l) => nodeIds.has(l.source_id) && nodeIds.has(l.target_id))
    .map((l) => ({
      source: l.source_id,
      target: l.target_id,
      ref_count: l.ref_count,
    }))

  return { nodes, edges, hasMore: pagesResp.has_more }
}
