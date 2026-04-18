/**
 * GraphView — force-directed graph of page relationships (F-33).
 *
 * Nodes = pages, edges = [[links]] between pages.
 * Force simulation runs in a WebWorker (PERF-9b) with a main-thread
 * fallback when Workers are unavailable.  SVG rendering, zoom, and drag
 * remain on the main thread.
 */

import { drag } from 'd3-drag'
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force'
import { select } from 'd3-selection'
import { type ZoomBehavior, zoom, zoomIdentity } from 'd3-zoom'
import { Maximize2, Minus, Network, Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { applyGraphFilters, type GraphFilter } from '@/lib/graph-filters'
import {
  listBlocks,
  listPageLinks,
  listTagsByPrefix,
  queryByProperty,
  queryByTags,
} from '@/lib/tauri'
import { useNavigationStore } from '@/stores/navigation'
import { matchesShortcutBinding } from '../lib/keyboard-config'
import { logger } from '../lib/logger'
import type { WorkerOutboundMessage } from '../workers/graph-worker-types'
import { EmptyState } from './EmptyState'
import { GraphFilterBar } from './GraphFilterBar'
import { LoadingSkeleton } from './LoadingSkeleton'
import { Badge } from './ui/badge'
import { Button } from './ui/button'

interface GraphNode extends SimulationNodeDatum {
  id: string
  label: string
  todo_state: string | null
  priority: string | null
  due_date: string | null
  scheduled_date: string | null
  is_template: boolean
  backlink_count: number
}

interface GraphEdge extends SimulationLinkDatum<GraphNode> {
  source: string | GraphNode
  target: string | GraphNode
  ref_count: number
}

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
  const navigateToPage = useNavigationStore((s) => s.navigateToPage)
  const svgRef = useRef<SVGSVGElement>(null)
  const zoomBehaviorRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null)
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

  // Stable-ish key to trigger refetch when the tag set changes.
  const tagCacheKey = useMemo(() => getCacheKey(tagFilterIds), [tagFilterIds])

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

    async function fetchData() {
      try {
        // Pages: server-side tag filter (single tag → listBlocks, multi → queryByTags).
        let pagesPromise: Promise<{ items: Array<Record<string, unknown>>; has_more: boolean }>
        if (tagFilterIds.length === 0) {
          pagesPromise = listBlocks({ blockType: 'page', limit: 5000 }) as Promise<{
            items: Array<Record<string, unknown>>
            has_more: boolean
          }>
        } else if (tagFilterIds.length === 1) {
          pagesPromise = listBlocks({ tagId: tagFilterIds[0], limit: 5000 }) as Promise<{
            items: Array<Record<string, unknown>>
            has_more: boolean
          }>
        } else {
          pagesPromise = queryByTags({
            tagIds: tagFilterIds,
            prefixes: [],
            mode: 'or',
            limit: 5000,
          }) as Promise<{ items: Array<Record<string, unknown>>; has_more: boolean }>
        }

        const [pagesResp, links, templatesResp] = await Promise.all([
          pagesPromise,
          listPageLinks(),
          queryByProperty({ key: 'template', valueText: 'true', limit: 1000 }),
        ])

        if (cancelled) return

        // When filtering by tag, the API may return non-page blocks — keep only pages
        const items =
          tagFilterIds.length > 0
            ? pagesResp.items.filter((p) => (p['block_type'] as string | undefined) === 'page')
            : pagesResp.items

        const templateIds = new Set(
          templatesResp.items.map((p) => p.id).filter((id): id is string => typeof id === 'string'),
        )

        // Compute backlink count per node from edges (target_id appearances).
        const nodeIds = new Set(items.map((p) => p['id'] as string))
        const backlinkCounts = new Map<string, number>()
        for (const link of links) {
          if (nodeIds.has(link.target_id) && nodeIds.has(link.source_id)) {
            backlinkCounts.set(link.target_id, (backlinkCounts.get(link.target_id) ?? 0) + 1)
          }
        }

        const pageNodes: GraphNode[] = items.map((p) => {
          const id = p['id'] as string
          return {
            id,
            label: (p['content'] as string | null | undefined) || 'Untitled',
            todo_state: (p['todo_state'] as string | null | undefined) ?? null,
            priority: (p['priority'] as string | null | undefined) ?? null,
            due_date: (p['due_date'] as string | null | undefined) ?? null,
            scheduled_date: (p['scheduled_date'] as string | null | undefined) ?? null,
            is_template: templateIds.has(id),
            backlink_count: backlinkCounts.get(id) ?? 0,
          }
        })

        const pageEdges: GraphEdge[] = links
          .filter((l) => nodeIds.has(l.source_id) && nodeIds.has(l.target_id))
          .map((l) => ({
            source: l.source_id,
            target: l.target_id,
            ref_count: l.ref_count,
          }))

        // Update cache
        graphCacheMap.set(tagCacheKey, {
          nodes: pageNodes,
          edges: pageEdges,
          hasMore: pagesResp.has_more,
          timestamp: Date.now(),
        })

        setNodes(pageNodes)
        setEdges(pageEdges)
        setHasMore(pagesResp.has_more)
      } catch (err) {
        if (!cancelled) {
          logger.error('GraphView', 'failed to load graph data', undefined, err)
          setError(t('graph.loadFailed'))
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    fetchData()
    return () => {
      cancelled = true
    }
  }, [t, tagCacheKey, tagFilterIds])

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

  // D3 simulation
  useEffect(() => {
    if (filteredNodes.length === 0 || !svgRef.current) return

    const svg = svgRef.current
    const width = svg.clientWidth || 800
    const height = svg.clientHeight || 600

    const svgSel = select(svg)

    // Clear previous content
    svgSel.selectAll('*').remove()

    // Container group for zoom/pan
    const g = svgSel.append('g')

    // Clone nodes/edges so d3 can mutate them without React state issues
    const simNodes: GraphNode[] = filteredNodes.map((n) => ({ ...n }))
    const simEdges: GraphEdge[] = filteredEdges.map((e) => ({ ...e }))

    // Build a lookup map for quick position updates from the worker
    const nodeById = new Map<string, GraphNode>()
    for (const n of simNodes) {
      nodeById.set(n.id, n)
    }

    // Draw edges
    const link = g
      .selectAll<SVGLineElement, GraphEdge>('line')
      .data(simEdges)
      .join('line')
      .attr('stroke', 'var(--muted-foreground)')
      .attr('stroke-opacity', (d: GraphEdge) => {
        const count = Math.max(1, d.ref_count ?? 1)
        return Math.min(0.5 + 0.1 * count, 1)
      })
      .attr('stroke-width', (d: GraphEdge) => {
        const count = Math.max(1, d.ref_count ?? 1)
        return Math.min(1 + Math.log2(count), 6)
      })

    // Draw node groups
    const node = g
      .selectAll<SVGGElement, GraphNode>('g.node')
      .data(simNodes)
      .join('g')
      .attr('class', 'node')
      .attr('tabindex', '0')
      .attr('role', 'button')
      .style('cursor', 'pointer')

    // Hit-area circle for touch targets (44px diameter = 22px radius)
    node
      .append('circle')
      .attr('r', 22)
      .attr('fill', 'transparent')
      .style('pointer-events', 'all')
      .attr('class', 'hit-area')

    // Node circles
    node.append('circle').attr('r', 6).attr('fill', 'var(--primary)')

    // Node labels
    node
      .append('text')
      .text((d) => (d.label.length > 20 ? `${d.label.slice(0, 20)}…` : d.label))
      .attr('dx', 10)
      .attr('dy', 4)
      .attr('fill', 'var(--foreground)')
      .attr('font-size', '12px')
      .style('pointer-events', 'none')
      .style('user-select', 'none')

    // Click handler — navigate to page
    node.on('click', (_event, d) => {
      navigateToPage(d.id, d.label)
    })

    // Keyboard handler — Enter/Space navigates to page (UX-102)
    node.on('keydown', (event, d) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        navigateToPage(d.id, d.label)
      }
    })

    // Focus ring for keyboard navigation (UX-102)
    node.on('focus', function () {
      select(this)
        .select('circle:nth-child(2)')
        .attr('stroke', 'var(--ring)')
        .attr('stroke-width', 2)
      select(this).select('text').attr('font-size', '14px').attr('font-weight', '600')
    })
    node.on('blur', function () {
      select(this).select('circle:nth-child(2)').attr('stroke', null).attr('stroke-width', null)
      select(this).select('text').attr('font-size', '12px').attr('font-weight', null)
    })

    // Hover/active feedback (UX-103)
    node.on('mouseenter', function () {
      const self = select(this)
      self.select('circle:nth-child(2)').attr('r', 8)
      self
        .select('text')
        .attr('font-size', '14px')
        .attr('font-weight', '600')
        .style('paint-order', 'stroke')
        .attr('stroke', 'var(--background)')
        .attr('stroke-width', '3px')
      // Dim other nodes
      node
        .filter(function () {
          return this !== self.node()
        })
        .style('opacity', '0.3')
      // Dim unconnected edges
      link.style('opacity', (d: GraphEdge) => {
        const src = typeof d.source === 'string' ? d.source : (d.source as GraphNode).id
        const tgt = typeof d.target === 'string' ? d.target : (d.target as GraphNode).id
        const nodeId = self.datum() as GraphNode
        return src === nodeId.id || tgt === nodeId.id ? '1' : '0.15'
      })
    })
    node.on('mouseleave', function () {
      const self = select(this)
      self.select('circle:nth-child(2)').attr('r', 6)
      self
        .select('text')
        .attr('font-size', '12px')
        .attr('font-weight', null)
        .style('paint-order', null)
        .attr('stroke', null)
        .attr('stroke-width', null)
      // Restore all nodes and edges
      node.style('opacity', null)
      link.style('opacity', null)
    })
    node.on('pointerdown', function () {
      select(this).select('circle:nth-child(2)').attr('r', 5)
    })
    node.on('pointerup', function () {
      select(this).select('circle:nth-child(2)').attr('r', 8)
    })

    // ── Helper: apply positions to SVG elements ──────────────────────
    function applyPositions() {
      link
        .attr('x1', (d) => (d.source as GraphNode).x ?? 0)
        .attr('y1', (d) => (d.source as GraphNode).y ?? 0)
        .attr('x2', (d) => (d.target as GraphNode).x ?? 0)
        .attr('y2', (d) => (d.target as GraphNode).y ?? 0)

      node.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`)
    }

    // ── Helper: update simNodes from worker positions ────────────────
    function applyWorkerPositions(positions: Array<{ id: string; x: number; y: number }>) {
      for (const pos of positions) {
        const n = nodeById.get(pos.id)
        if (n) {
          n.x = pos.x
          n.y = pos.y
        }
      }
      // Also propagate into edge source/target objects (d3 resolves string refs
      // into object refs after forceLink runs, but when the worker resolves them
      // we still have strings on the main thread).  To keep applyPositions simple
      // we update edges to point at the simNode objects.
      for (const e of simEdges) {
        if (typeof e.source === 'string') {
          const src = nodeById.get(e.source)
          if (src) e.source = src
        }
        if (typeof e.target === 'string') {
          const tgt = nodeById.get(e.target)
          if (tgt) e.target = tgt
        }
      }
      applyPositions()
    }

    // Zoom behavior
    const zoomBehavior: ZoomBehavior<SVGSVGElement, unknown> = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => {
        g.attr('transform', event.transform)
      })

    svgSel.call(zoomBehavior)
    zoomBehaviorRef.current = zoomBehavior

    // Keyboard zoom handler (UX-146, rebindable via BUG-18)
    svg.setAttribute('tabindex', '0')
    function handleZoomKey(e: KeyboardEvent) {
      // Guard: don't intercept +/- when the user is typing in any input
      // field (e.g. if a foreignObject ever hosts one, or events bubble from
      // an overlay). Consistent with App.tsx handlers.
      const target = e.target as HTMLElement | null
      if (
        target?.isContentEditable ||
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA'
      ) {
        return
      }
      const svgSelection = select(svg)
      if (matchesShortcutBinding(e, 'graphZoomIn')) {
        e.preventDefault()
        zoomBehavior.scaleBy(svgSelection.transition().duration(200), 1.3)
      } else if (matchesShortcutBinding(e, 'graphZoomOut')) {
        e.preventDefault()
        zoomBehavior.scaleBy(svgSelection.transition().duration(200), 1 / 1.3)
      } else if (matchesShortcutBinding(e, 'graphZoomReset')) {
        e.preventDefault()
        zoomBehavior.transform(svgSelection.transition().duration(300), zoomIdentity)
      }
    }
    svg.addEventListener('keydown', handleZoomKey)

    // Respect prefers-reduced-motion (UX-104)
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    // ── WebWorker path (PERF-9b) ─────────────────────────────────────
    const hasWorkerSupport = typeof Worker !== 'undefined'

    if (hasWorkerSupport) {
      const worker = new Worker(new URL('../workers/graph-worker.ts', import.meta.url), {
        type: 'module',
      })

      let tickCount = 0

      worker.addEventListener('message', (evt: MessageEvent<WorkerOutboundMessage>) => {
        const msg = evt.data

        if (msg.type === 'tick') {
          tickCount++
          applyWorkerPositions(msg.positions)

          // prefers-reduced-motion: stop after 300 ticks
          if (prefersReducedMotion && tickCount >= 300) {
            worker.postMessage({ type: 'stop' })
          }
        } else if (msg.type === 'done') {
          applyWorkerPositions(msg.positions)
        }
      })

      // Send initial data to the worker
      worker.postMessage({
        type: 'start',
        nodes: simNodes.map((n) => ({ id: n.id, label: n.label })),
        edges: simEdges.map((e) => ({
          source: typeof e.source === 'string' ? e.source : (e.source as GraphNode).id,
          target: typeof e.target === 'string' ? e.target : (e.target as GraphNode).id,
          ref_count: e.ref_count,
        })),
        width,
        height,
      })

      // Drag behavior — communicates with the worker
      const dragBehavior = drag<SVGGElement, GraphNode>()
        .on('start', (event, d) => {
          if (!event.active) {
            worker.postMessage({
              type: 'drag',
              nodeId: d.id,
              x: event.x,
              y: event.y,
              phase: 'start' as const,
            })
          }
          d.fx = d.x
          d.fy = d.y
        })
        .on('drag', (event, d) => {
          worker.postMessage({
            type: 'drag',
            nodeId: d.id,
            x: event.x,
            y: event.y,
            phase: 'drag' as const,
          })
          d.fx = event.x
          d.fy = event.y
        })
        .on('end', (event, d) => {
          if (!event.active) {
            worker.postMessage({
              type: 'drag',
              nodeId: d.id,
              x: event.x,
              y: event.y,
              phase: 'end' as const,
            })
          }
          d.fx = null
          d.fy = null
        })

      node.call(dragBehavior)

      return () => {
        worker.terminate()
        svg.removeEventListener('keydown', handleZoomKey)
      }
    }

    // ── Fallback: main-thread simulation ─────────────────────────────
    const sim = forceSimulation(simNodes)
      .force(
        'link',
        forceLink<GraphNode, GraphEdge>(simEdges)
          .id((d) => d.id)
          .distance(60),
      )
      .force('charge', forceManyBody().strength(-100))
      .force('center', forceCenter(width / 2, height / 2))
      .force('collide', forceCollide(20))
      .force('x', forceX(width / 2).strength(0.05))
      .force('y', forceY(height / 2).strength(0.05))

    // Drag behavior (main-thread fallback)
    const dragBehavior = drag<SVGGElement, GraphNode>()
      .on('start', (event, d) => {
        if (!event.active) sim.alpha(0.3).restart()
        d.fx = d.x
        d.fy = d.y
      })
      .on('drag', (event, d) => {
        d.fx = event.x
        d.fy = event.y
      })
      .on('end', (event, d) => {
        if (!event.active) sim.alpha(0).restart()
        d.fx = null
        d.fy = null
      })

    node.call(dragBehavior)

    if (prefersReducedMotion) {
      sim.alphaDecay(1)
      sim.tick(300)
      applyPositions()
      sim.stop()
      return () => {
        sim.stop()
        svg.removeEventListener('keydown', handleZoomKey)
      }
    }

    // Tick handler — update positions
    sim.on('tick', () => {
      applyPositions()
    })

    return () => {
      sim.stop()
      svg.removeEventListener('keydown', handleZoomKey)
    }
  }, [filteredNodes, filteredEdges, navigateToPage])

  // Zoom button handlers (UX-146)
  const handleZoomIn = useCallback(() => {
    if (!svgRef.current) return
    const svgSel = select(svgRef.current)
    zoomBehaviorRef.current?.scaleBy(svgSel.transition().duration(200), 1.3)
  }, [])

  const handleZoomOut = useCallback(() => {
    if (!svgRef.current) return
    const svgSel = select(svgRef.current)
    zoomBehaviorRef.current?.scaleBy(svgSel.transition().duration(200), 1 / 1.3)
  }, [])

  const handleZoomReset = useCallback(() => {
    if (!svgRef.current) return
    const svgSel = select(svgRef.current)
    zoomBehaviorRef.current?.transform(svgSel.transition().duration(300), zoomIdentity)
  }, [])

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
      <svg ref={svgRef} className="w-full h-full" role="img" aria-label={t('graph.title')} />
      <div className="absolute bottom-3 right-3 flex flex-col gap-1">
        <Button variant="outline" size="icon" onClick={handleZoomIn} aria-label={t('graph.zoomIn')}>
          <Plus className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          onClick={handleZoomOut}
          aria-label={t('graph.zoomOut')}
        >
          <Minus className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          onClick={handleZoomReset}
          aria-label={t('graph.zoomReset')}
        >
          <Maximize2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
