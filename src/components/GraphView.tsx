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

import { AlertCircle, Maximize2, Minus, Network, Plus } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useGraphSimulation } from '@/hooks/useGraphSimulation'
import { applyGraphFilters, type GraphFilter } from '@/lib/graph-filters'
import { getShortcutKeys } from '@/lib/keyboard-config'
import { listTagsByPrefix } from '@/lib/tauri'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'

import { logger } from '../lib/logger'
import { EmptyState } from './EmptyState'
import { FeatureErrorBoundary } from './FeatureErrorBoundary'
import { GraphFilterBar } from './GraphFilterBar'
import { fetchGraphData, type GraphEdge, type GraphNode } from './GraphView.helpers'
import { LoadingSkeleton } from './LoadingSkeleton'
import { FeaturePageHeader } from './ui/feature-page-header'
import { IconButton } from './ui/icon-button'

// ── Module-level cache for stale-while-revalidate (UX-113) ────────────
const GRAPH_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

export interface GraphCache {
  nodes: GraphNode[]
  edges: GraphEdge[]
  timestamp: number
}

/**
 * Maximum cached (spaceId, tagIds) entries. The map is keyed by every
 * distinct tag-filter combination the user tries, so without a bound it
 * grows for the whole session (each entry holds full node/edge arrays).
 * A handful of entries covers realistic back-and-forth filter toggling;
 * older combinations are cheap to refetch (#758 item 4).
 *
 * @internal exported for tests.
 */
export const GRAPH_CACHE_MAX_ENTRIES = 8

const graphCacheMap = new Map<string, GraphCache>()

/**
 * LRU read: refresh the entry's recency (Map preserves insertion order, so
 * delete + re-set moves it to the back of the eviction queue).
 * @internal exported for tests.
 */
export function getGraphCacheEntry(key: string): GraphCache | null {
  const entry = graphCacheMap.get(key)
  if (!entry) return null
  graphCacheMap.delete(key)
  graphCacheMap.set(key, entry)
  return entry
}

/**
 * LRU write: insert as most-recent and evict the least-recently-used
 * entries beyond `GRAPH_CACHE_MAX_ENTRIES`.
 * @internal exported for tests.
 */
export function setGraphCacheEntry(key: string, entry: GraphCache): void {
  graphCacheMap.delete(key)
  graphCacheMap.set(key, entry)
  while (graphCacheMap.size > GRAPH_CACHE_MAX_ENTRIES) {
    const oldest = graphCacheMap.keys().next().value
    if (oldest === undefined) break
    graphCacheMap.delete(oldest)
  }
}

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

/**
 * UX-356: append the current keyboard shortcut binding (if any) to a label
 * so icon-only buttons surface their hotkey via the accessible name. Returns
 * the bare label when no binding is configured to avoid a stray "()".
 */
function withShortcut(label: string, shortcutId: string): string {
  const keys = getShortcutKeys(shortcutId)
  return keys ? `${label} (${keys})` : label
}

// Stable reference for the "no tag filter" case so the fetch effect's
// `tagFilterIds` dependency doesn't change identity on every unrelated
// (client-side) filter toggle and re-fire the graph fetch.
const EMPTY_TAG_IDS: string[] = []

export function GraphView(): React.ReactElement {
  const { t } = useTranslation()
  const navigateToPage = useTabsStore((s) => s.navigateToPage)
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const svgRef = useRef<SVGSVGElement>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nodes, setNodes] = useState<GraphNode[]>([])
  const [edges, setEdges] = useState<GraphEdge[]>([])
  const [tags, setTags] = useState<Array<{ tag_id: string; name: string }>>([])
  const [filters, setFilters] = useState<GraphFilter[]>([])

  // Extract the tag filter's tagIds — these drive server-side fetching.
  // Every other filter is applied client-side via `applyGraphFilters`.
  const tagFilterIds = useMemo((): string[] => {
    const tagFilter = filters.find((f) => f.type === 'tag')
    return tagFilter && tagFilter.type === 'tag' ? tagFilter.tagIds : EMPTY_TAG_IDS
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

    // Clear any stale error from a prior failed load: the `if (error)`
    // render guard sits before the populated-graph branch, so without this
    // a successful refetch (tag/space change) would stay masked by the old
    // "failed to load" screen until a full remount.
    setError(null)

    const graphCache = getGraphCacheEntry(tagCacheKey)

    // Serve cached data immediately if available
    if (graphCache) {
      setNodes(graphCache.nodes)
      setEdges(graphCache.edges)
      setLoading(false)

      // If cache is still fresh, skip refetch
      if (Date.now() - graphCache.timestamp < GRAPH_CACHE_TTL_MS) return
    }

    async function run() {
      try {
        const result = await fetchGraphData(tagFilterIds, currentSpaceId)
        if (cancelled) return

        setGraphCacheEntry(tagCacheKey, {
          nodes: result.nodes,
          edges: result.edges,
          timestamp: Date.now(),
        })

        setNodes(result.nodes)
        setEdges(result.edges)
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

  // PEND-UX item 5 — wrap the loading / error / empty bodies in a flex
  // column with the shared `<h1>` landmark so the page header stays
  // consistent across all four render states (loading, error, no-pages,
  // graph). Without this, only the populated graph carries a header and
  // the four states render different top-level structures.
  const headerNode = <FeaturePageHeader title={t('sidebar.graph')} className="graph-view-header" />
  if (loading)
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col gap-4">
        {headerNode}
        <LoadingSkeleton count={3} height="h-16" />
      </div>
    )
  // PEND-23 M9: render `error` via the shared EmptyState primitive instead
  // of an ad-hoc `role="alert"` card so the failure mode reuses the same
  // visual language as the empty / no-data path.
  if (error)
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col gap-4">
        {headerNode}
        <EmptyState icon={AlertCircle} message={error} />
      </div>
    )
  if (nodes.length === 0)
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col gap-4">
        {headerNode}
        <EmptyState icon={Network} message={t('graph.noPages')} />
      </div>
    )

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-4">
      {headerNode}
      <div
        className="graph-view relative h-full w-full flex-1 min-h-0 overflow-hidden rounded-lg border border-border bg-background"
        data-testid="graph-view"
      >
        {/* Multi-dimension filter bar (UX-205).
            Wrapped in FeatureErrorBoundary so a crash in the filter / cytoscape
            integration doesn't blank the entire GraphView (UX Tier 3). */}
        <div
          className="absolute top-2 left-2 right-2 z-10 max-w-[calc(100%-1rem)]"
          data-testid="graph-tag-filter"
        >
          <FeatureErrorBoundary name="GraphFilterBar">
            <GraphFilterBar
              filters={filters}
              onFiltersChange={setFilters}
              allTags={tags}
              totalCount={nodes.length}
              filteredCount={filteredNodes.length}
            />
          </FeatureErrorBoundary>
        </div>
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
        {/*
         * UX-355: pair the SVG with a visually-hidden hint so keyboard users
         * discover that nodes are activatable. `aria-describedby` points at
         * the `sr-only` paragraph so ATs read the hint alongside the SVG's
         * accessible name without affecting visual layout.
         */}
        <p id="graph-keyboard-hint" className="sr-only">
          {t('graph.keyboardHint')}
        </p>
        <svg
          ref={svgRef}
          className="absolute inset-0 h-full w-full"
          aria-label={t('graph.title')}
          aria-describedby="graph-keyboard-hint"
          data-testid="graph-svg"
        />
        <div className="absolute bottom-3 right-3 flex flex-col gap-1">
          <IconButton
            variant="outline"
            onClick={zoomIn}
            tooltip={t('graph.zoomIn')}
            ariaLabel={withShortcut(t('graph.zoomIn'), 'graphZoomIn')}
          >
            <Plus className="h-4 w-4" />
          </IconButton>
          <IconButton
            variant="outline"
            onClick={zoomOut}
            tooltip={t('graph.zoomOut')}
            ariaLabel={withShortcut(t('graph.zoomOut'), 'graphZoomOut')}
          >
            <Minus className="h-4 w-4" />
          </IconButton>
          <IconButton
            variant="outline"
            onClick={zoomReset}
            tooltip={t('graph.zoomReset')}
            ariaLabel={withShortcut(t('graph.zoomReset'), 'graphZoomReset')}
          >
            <Maximize2 className="h-4 w-4" />
          </IconButton>
        </div>
      </div>
    </div>
  )
}
