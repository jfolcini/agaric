/**
 * GraphView — force-directed graph of page relationships (F-33).
 *
 * Nodes = pages, edges = [[links]] between pages.
 * Uses d3-force for simulation, SVG for rendering.
 * Click node to navigate to page.
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
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { listBlocks, listPageLinks } from '@/lib/tauri'
import { useNavigationStore } from '@/stores/navigation'
import { logger } from '../lib/logger'
import { EmptyState } from './EmptyState'
import { LoadingSkeleton } from './LoadingSkeleton'
import { Button } from './ui/button'

interface GraphNode extends SimulationNodeDatum {
  id: string
  label: string
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
  timestamp: number
}

let graphCache: GraphCache | null = null

/** @internal — exported for test isolation only. */
export function clearGraphCache(): void {
  graphCache = null
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

  // Fetch data with stale-while-revalidate caching (UX-113)
  useEffect(() => {
    let cancelled = false

    // Serve cached data immediately if available
    if (graphCache) {
      setNodes(graphCache.nodes)
      setEdges(graphCache.edges)
      setLoading(false)

      // If cache is still fresh, skip refetch
      if (Date.now() - graphCache.timestamp < GRAPH_CACHE_TTL_MS) return
    }

    async function fetchData() {
      try {
        const [pagesResp, links] = await Promise.all([
          listBlocks({ blockType: 'page', limit: 5000 }),
          listPageLinks(),
        ])

        if (cancelled) return

        const pageNodes: GraphNode[] = pagesResp.items.map((p) => ({
          id: p.id,
          label: p.content || 'Untitled',
        }))

        // Only include edges where both source and target exist in the nodes set
        const nodeIds = new Set(pageNodes.map((n) => n.id))
        const pageEdges: GraphEdge[] = links
          .filter((l) => nodeIds.has(l.source_id) && nodeIds.has(l.target_id))
          .map((l) => ({
            source: l.source_id,
            target: l.target_id,
            ref_count: l.ref_count,
          }))

        // Update cache
        graphCache = { nodes: pageNodes, edges: pageEdges, timestamp: Date.now() }

        setNodes(pageNodes)
        setEdges(pageEdges)
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
  }, [t])

  // D3 simulation
  useEffect(() => {
    if (nodes.length === 0 || !svgRef.current) return

    const svg = svgRef.current
    const width = svg.clientWidth || 800
    const height = svg.clientHeight || 600

    const svgSel = select(svg)

    // Clear previous content
    svgSel.selectAll('*').remove()

    // Container group for zoom/pan
    const g = svgSel.append('g')

    // Clone nodes/edges so d3 can mutate them without React state issues
    const simNodes: GraphNode[] = nodes.map((n) => ({ ...n }))
    const simEdges: GraphEdge[] = edges.map((e) => ({ ...e }))

    // Create simulation
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

    // Drag behavior
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

    // Zoom behavior
    const zoomBehavior: ZoomBehavior<SVGSVGElement, unknown> = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => {
        g.attr('transform', event.transform)
      })

    svgSel.call(zoomBehavior)
    zoomBehaviorRef.current = zoomBehavior

    // Keyboard zoom handler (UX-146)
    svg.setAttribute('tabindex', '0')
    function handleZoomKey(e: KeyboardEvent) {
      const svgSelection = select(svg)
      if (e.key === '+' || e.key === '=') {
        e.preventDefault()
        zoomBehavior.scaleBy(svgSelection.transition().duration(200), 1.3)
      } else if (e.key === '-') {
        e.preventDefault()
        zoomBehavior.scaleBy(svgSelection.transition().duration(200), 1 / 1.3)
      } else if (e.key === '0') {
        e.preventDefault()
        zoomBehavior.transform(svgSelection.transition().duration(300), zoomIdentity)
      }
    }
    svg.addEventListener('keydown', handleZoomKey)

    // Respect prefers-reduced-motion (UX-104)
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (prefersReducedMotion) {
      sim.alphaDecay(1)
      sim.tick(300)

      // Render final static layout once
      link
        .attr('x1', (d) => (d.source as GraphNode).x ?? 0)
        .attr('y1', (d) => (d.source as GraphNode).y ?? 0)
        .attr('x2', (d) => (d.target as GraphNode).x ?? 0)
        .attr('y2', (d) => (d.target as GraphNode).y ?? 0)

      node.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`)

      sim.stop()
      return () => {
        sim.stop()
        svg.removeEventListener('keydown', handleZoomKey)
      }
    }

    // Tick handler — update positions
    sim.on('tick', () => {
      link
        .attr('x1', (d) => (d.source as GraphNode).x ?? 0)
        .attr('y1', (d) => (d.source as GraphNode).y ?? 0)
        .attr('x2', (d) => (d.target as GraphNode).x ?? 0)
        .attr('y2', (d) => (d.target as GraphNode).y ?? 0)

      node.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`)
    })

    return () => {
      sim.stop()
      svg.removeEventListener('keydown', handleZoomKey)
    }
  }, [nodes, edges, navigateToPage])

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
    <div className="graph-view relative h-full w-full" data-testid="graph-view">
      <svg
        ref={svgRef}
        className="w-full h-full min-h-[400px]"
        role="img"
        aria-label={t('graph.title')}
      />
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
