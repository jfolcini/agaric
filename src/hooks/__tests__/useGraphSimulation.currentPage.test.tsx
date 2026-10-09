/**
 * The current-page accent follows the active tab while the graph stays
 * mounted (#5429). Real d3 against the DOM: the sibling
 * `useGraphSimulation.test.ts` mocks d3 wholesale. The worker is a recorder,
 * so the test can see that moving the accent does not re-run the layout.
 */

import { render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { useGraphSimulation } from '@/hooks/useGraphSimulation'
import type { GraphEdge, GraphNode } from '@/lib/graph-types'

class RecordingWorker {
  static posted: Array<{ type: string }> = []
  postMessage(message: { type: string }): void {
    RecordingWorker.posted.push(message)
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  terminate(): void {}
}

function makeNode(id: string, label: string): GraphNode {
  return {
    id,
    label,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    is_template: false,
    is_journal: false,
    backlink_count: 0,
  }
}

const NODES = [makeNode('a', 'Alpha'), makeNode('b', 'Beta'), makeNode('c', 'Gamma')]
const EDGES: GraphEdge[] = [{ source: 'a', target: 'b', ref_count: 1 }]

function Graph({
  currentPageId,
  nodes = NODES,
}: {
  currentPageId: string | null
  nodes?: GraphNode[]
}): React.ReactElement {
  const svgRef = useRef<SVGSVGElement>(null)
  useGraphSimulation({
    svgRef,
    nodes,
    edges: EDGES,
    navigateToPage: () => {},
    currentPageId,
  })
  return <svg ref={svgRef} aria-label="Graph" />
}

function paint(container: HTMLElement): Array<[string | null, string | null]> {
  return Array.from(container.querySelectorAll('g.node')).map((g) => [
    g.querySelector('circle:nth-child(2)')?.getAttribute('fill') ?? null,
    g.getAttribute('aria-current'),
  ])
}

const NEUTRAL = ['var(--graph-node)', null]
const ACCENT = ['var(--graph-accent)', 'page']

beforeEach(() => {
  RecordingWorker.posted = []
  vi.stubGlobal('Worker', RecordingWorker)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useGraphSimulation — the current-page accent (#5429)', () => {
  it('moves with the active tab without re-running the layout', () => {
    const { container, rerender } = render(<Graph currentPageId="a" />)
    expect(paint(container)).toEqual([ACCENT, NEUTRAL, NEUTRAL])
    expect(RecordingWorker.posted.map((m) => m.type)).toEqual(['start'])

    rerender(<Graph currentPageId="b" />)
    expect(paint(container)).toEqual([NEUTRAL, ACCENT, NEUTRAL])

    rerender(<Graph currentPageId={null} />)
    expect(paint(container)).toEqual([NEUTRAL, NEUTRAL, NEUTRAL])

    expect(RecordingWorker.posted.map((m) => m.type)).toEqual(['start'])
  })

  it('accents the current page when the nodes arrive after mount', () => {
    const { container, rerender } = render(<Graph currentPageId="b" nodes={[]} />)
    rerender(<Graph currentPageId="b" />)

    expect(paint(container)).toEqual([NEUTRAL, ACCENT, NEUTRAL])
  })

  it('keeps the accent on the current page when a filter brings it back', () => {
    const { container, rerender } = render(<Graph currentPageId="c" />)
    rerender(<Graph currentPageId="c" nodes={NODES.slice(0, 2)} />)
    rerender(<Graph currentPageId="c" nodes={[...NODES]} />)

    expect(paint(container)).toEqual([NEUTRAL, NEUTRAL, ACCENT])
    expect(RecordingWorker.posted.map((m) => m.type)).toEqual(['start', 'update', 'update'])
  })

  it('has no axe violations with the accented node rendered', async () => {
    const { container } = render(<Graph currentPageId="a" />)
    expect(container.querySelectorAll('g.node[aria-current="page"]')).toHaveLength(1)

    expect(await axe(container)).toHaveNoViolations()
  })
})
