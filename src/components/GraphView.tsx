/**
 * GraphView — force-directed graph of page relationships (F-33).
 *
 * Nodes = pages, edges = [[links]] between pages.
 *
 * Force simulation runs in a WebWorker (PERF-9b) with a main-thread
 * fallback. If the worker fails at runtime (module-resolution error,
 * CSP block, runtime throw) the component transparently falls back to
 * the main-thread path — see `useGraphSimulation` (MAINT-57 + BUG-45).
 *
 * Data fetching lives in `GraphView.helpers.ts::fetchGraphData`
 * (MAINT-56). SVG rendering, zoom, and drag are owned by the hook.
 */

import { Maximize2, Minus, Network, Plus } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useGraphSimulation } from '@/hooks/useGraphSimulation'
import { applyGraphFilters, type GraphFilter } from '@/lib/graph-filters'
import { listTagsByPrefix } from '@/lib/tauri'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'
import { logger } from '../lib/logger'
import { EmptyState } from './EmptyState'
import { GraphFilterBar } from './GraphFilterBar'
import { fetchGraphData, type GraphEdge, type GraphNode } from './GraphView.helpers'
import { LoadingSkeleton } from './LoadingSkeleton'
import { Badge } from './ui/badge'
import { Button } from './ui/button'

// ── Module-level cache for stale-while-revalidate (UX-113) ────────────
const GRAPH_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

interface GraphCache {
  nodes: GraphNode[]
  edges: GraphEdge[]
  hasMore: boolean
  timestamp: number
}

const graphCacheMap = new Map<string, GraphCache>()

/** Sentinel value for "all pages" (no tag filter). */
const TAG_ALL_KEY = '__all__'

/**
 * Cache key is derived from the sorted set of tag IDs being used for the
 * server-side fetch. Client-side filters (status, priority, has-*, etc.) do
 * not invalidate the cache — they are applied after fetch.
 */
function getCacheKey(tagIds: readonly string[]): string {
  if (tagIds.length === 0) return TAG_ALL_KEY
  return [...tagIds].sort().join(',')
}

/** @internal — exported for test isolation only. */
export function clearGraphCache(): void {
  graphCacheMap.clear()
}

export function GraphView(): React.ReactElement {
  const { t } = useTranslation()
  const navigateToPage = useTabsStore((s) => s.navigateToPage)
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const svgRef = useRef<SVGSVGElement>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nodes, setNodes] = useState<GraphNode[]>([])
  const [edges, setEdges] = useState<GraphEdge[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [tags, setTags] = useState<Array<{ tag_id: string; name: string }>>([])
  const [filters, setFilters] = useState<GraphFilter[]>([])

  // Extract the tag filter's tagIds — these drive server-side fetching.
  // Every other filter is applied client-side via `applyGraphFilters`.
  const tagFilterIds = useMemo((): string[] => {
    const tagFilter = filters.find((f) => f.type === 'tag')
    return tagFilter && tagFilter.type === 'tag' ? tagFilter.tagIds : []
  }, [filters])

  // Stable-ish key to trigger refetch when the tag set or active space
  // changes — the cache is keyed by (spaceId, tagIds) so switching
  // spaces doesn't show the wrong space's nodes from cache.
  const tagCacheKey = useMemo(
    () => `${currentSpaceId ?? '__null__'}|${getCacheKey(tagFilterIds)}`,
    [currentSpaceId, tagFilterIds],
  )

  // Fetch available tags on mount
  useEffect(() => {
    listTagsByPrefix({ prefix: '' })
      .then((result) => setTags(result ?? []))
      .catch((err) => logger.error('GraphView', 'Failed to load tags', undefined, err))
  }, [])

  // Fetch data with stale-while-revalidate caching (UX-113)
  useEffect(() => {
    let cancelled = false

    const graphCache = graphCacheMap.get(tagCacheKey) ?? null

    // Serve cached data immediately if available
    if (graphCache) {
      setNodes(graphCache.nodes)
      setEdges(graphCache.edges)
      setHasMore(graphCache.hasMore)
      setLoading(false)

      // If cache is still fresh, skip refetch
      if (Date.now() - graphCache.timestamp < GRAPH_CACHE_TTL_MS) return
    }

    async function run() {
      try {
        const result = await fetchGraphData(tagFilterIds, currentSpaceId)
        if (cancelled) return

        graphCacheMap.set(tagCacheKey, {
          nodes: result.nodes,
          edges: result.edges,
          hasMore: result.hasMore,
          timestamp: Date.now(),
        })

        setNodes(result.nodes)
        setEdges(result.edges)
        setHasMore(result.hasMore)
      } catch (err) {
        if (cancelled) return
        logger.error('GraphView', 'failed to load graph data', undefined, err)
        setError(t('graph.loadFailed'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    run()
    return () => {
      cancelled = true
    }
  }, [t, tagCacheKey, tagFilterIds, currentSpaceId])

  // Client-side filtering (status, priority, has-date, has-backlinks, exclude-templates).
  // Tag filter is pass-through here because tag_ids is not populated on nodes
  // — the tag dimension is enforced by the server-side fetch above.
  const filteredNodes = useMemo(() => applyGraphFilters(nodes, filters), [nodes, filters])
  const filteredEdges = useMemo(() => {
    if (filteredNodes.length === nodes.length) return edges
    const visibleIds = new Set(filteredNodes.map((n) => n.id))
    return edges.filter((e) => {
      const src = typeof e.source === 'string' ? e.source : (e.source as GraphNode).id
      const tgt = typeof e.target === 'string' ? e.target : (e.target as GraphNode).id
      return visibleIds.has(src) && visibleIds.has(tgt)
    })
  }, [edges, filteredNodes, nodes.length])

  // d3-force simulation + worker lifecycle + zoom handlers.
  const { zoomIn, zoomOut, zoomReset } = useGraphSimulation({
    svgRef,
    nodes: filteredNodes,
    edges: filteredEdges,
    navigateToPage,
  })

  if (loading) return <LoadingSkeleton count={3} height="h-16" />
  if (error)
    return (
      <div role="alert" className="rounded-md bg-destructive/10 p-4 text-sm text-destructive">
        {error}
      </div>
    )
  if (nodes.length === 0) return <EmptyState icon={Network} message={t('graph.noPages')} />

  return (
    <div
      className="graph-view relative h-full w-full flex-1 min-h-0 overflow-hidden rounded-lg border border-border bg-background"
      data-testid="graph-view"
    >
      {/* Multi-dimension filter bar (UX-205) */}
      <div
        className="absolute top-2 left-2 right-2 z-10 max-w-[calc(100%-1rem)]"
        data-testid="graph-tag-filter"
      >
        <GraphFilterBar
          filters={filters}
          onFiltersChange={setFilters}
          allTags={tags}
          totalCount={nodes.length}
          filteredCount={filteredNodes.length}
        />
      </div>
      {hasMore && (
        <Badge
          variant="secondary"
          className="absolute bottom-2 left-2 z-10"
          data-testid="graph-truncated-badge"
        >
          {tagFilterIds.length > 0
            ? t('graph.truncated', { count: nodes.length })
            : t('graph.truncatedFilterHint', { count: nodes.length })}
        </Badge>
      )}
      {/*
       * UX-244: `position: absolute; inset: 0` is required for the SVG to fill
       * the `.graph-view` (relative) container. Bare `h-full` on an inline SVG
       * does NOT resolve against a block-level flex-item parent in Chromium —
       * it falls back to the SVG's intrinsic 150 px default height, which was
       * the symptom (nodes clustered in the top 150 px of an 800 px container).
       * All other children of `.graph-view` are already absolutely positioned
       * (filter bar, truncated badge, zoom buttons); this keeps every child in
       * the same layout model and stacks via source order (SVG first → z-0,
       * overlays after → above).
       */}
      {/*
       * UX-270: dropped `role="img"` from the SVG wrapper. The graph's nodes
       * are interactive (`role="button"` + `tabindex=0` + Enter/Space handlers
       * via `useGraphSimulation`), and `role="img"` on a container of
       * interactive descendants is incorrect — ATs treat it as one opaque
       * graphic and hide the buttons. The accessible name lives on the
       * `aria-label`, which still gives the SVG a label when ATs surface it
       * via its default graphics role.
       */}
      <svg
        ref={svgRef}
        className="absolute inset-0 h-full w-full"
        aria-label={t('graph.title')}
        data-testid="graph-svg"
      />
      <div className="absolute bottom-3 right-3 flex flex-col gap-1">
        <Button variant="outline" size="icon" onClick={zoomIn} aria-label={t('graph.zoomIn')}>
          <Plus className="h-4 w-4" />
        </Button>
        <Button variant="outline" size="icon" onClick={zoomOut} aria-label={t('graph.zoomOut')}>
          <Minus className="h-4 w-4" />
        </Button>
        <Button variant="outline" size="icon" onClick={zoomReset} aria-label={t('graph.zoomReset')}>
          <Maximize2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
