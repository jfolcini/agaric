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
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force'
import { select } from 'd3-selection'
import { type ZoomBehavior, zoom } from 'd3-zoom'
import { Network } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { listBlocks, listPageLinks } from '@/lib/tauri'
import { useNavigationStore } from '@/stores/navigation'
import { logger } from '../lib/logger'
import { EmptyState } from './EmptyState'
import { LoadingSkeleton } from './LoadingSkeleton'

interface GraphNode extends SimulationNodeDatum {
  id: string
  label: string
}

interface GraphEdge extends SimulationLinkDatum<GraphNode> {
  source: string | GraphNode
  target: string | GraphNode
}

export function GraphView(): React.ReactElement {
  const { t } = useTranslation()
  const navigateToPage = useNavigationStore((s) => s.navigateToPage)
  const svgRef = useRef<SVGSVGElement>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nodes, setNodes] = useState<GraphNode[]>([])
  const [edges, setEdges] = useState<GraphEdge[]>([])

  // Fetch data
  useEffect(() => {
    let cancelled = false

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
          }))

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
          .distance(80),
      )
      .force('charge', forceManyBody().strength(-200))
      .force('center', forceCenter(width / 2, height / 2))
      .force('collide', forceCollide(20))

    // Draw edges
    const link = g
      .selectAll<SVGLineElement, GraphEdge>('line')
      .data(simEdges)
      .join('line')
      .attr('stroke', 'var(--border)')
      .attr('stroke-opacity', 0.5)
      .attr('stroke-width', 1)

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
    })
    node.on('blur', function () {
      select(this).select('circle:nth-child(2)').attr('stroke', null).attr('stroke-width', null)
    })

    // Hover/active feedback (UX-103)
    node.on('mouseenter', function () {
      select(this).select('circle:nth-child(2)').attr('r', 8)
    })
    node.on('mouseleave', function () {
      select(this).select('circle:nth-child(2)').attr('r', 6)
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
    }
  }, [nodes, edges, navigateToPage])

  if (loading) return <LoadingSkeleton count={3} height="h-16" />
  if (error)
    return (
      <div role="alert" className="rounded-md bg-destructive/10 p-4 text-sm text-destructive">
        {error}
      </div>
    )
  if (nodes.length === 0) return <EmptyState icon={Network} message={t('graph.noPages')} />

  return (
    <div className="graph-view h-full w-full" data-testid="graph-view">
      <svg
        ref={svgRef}
        className="w-full h-full min-h-[400px]"
        role="img"
        aria-label={t('graph.title')}
      />
    </div>
  )
}
