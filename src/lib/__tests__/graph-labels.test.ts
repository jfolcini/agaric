/**
 * Which labels the graph shows (#5430): hubs first and more as the view zooms
 * in, the pinned ones always, and never two that overlap on screen.
 */

import { describe, expect, it } from 'vitest'

import { nodeRadius } from '@/lib/graph-forces'
import { type Box, LABEL_MIN_SCREEN_RADIUS, labelBox, visibleLabels } from '@/lib/graph-labels'

interface Placed {
  id: string
  x: number
  y: number
  degree: number
}

const NONE = new Set<string>()
const textOf = (d: Placed): string => d.id

function overlapping(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

describe('visibleLabels — level of detail', () => {
  // Far apart, so no label covers another: only the zoom decides.
  const hub: Placed = { id: 'Hub', x: 0, y: 0, degree: 36 }
  const mid: Placed = { id: 'Mid', x: 0, y: 1000, degree: 4 }
  const leaf: Placed = { id: 'Leaf', x: 0, y: 2000, degree: 0 }
  const nodes = [leaf, mid, hub]

  it('labels only the hubs when zoomed out, and more nodes as the view zooms in', () => {
    const at = (scale: number): string[] =>
      [...visibleLabels(nodes, scale, NONE, textOf)].toSorted()

    expect(nodeRadius(36)).toBe(12)
    expect(nodeRadius(4)).toBe(6)
    expect(nodeRadius(0)).toBe(3)
    expect(at(0.4)).toEqual([])
    expect(at(0.5)).toEqual(['Hub'])
    expect(at(1)).toEqual(['Hub', 'Mid'])
    expect(at(2)).toEqual(['Hub', 'Leaf', 'Mid'])
  })

  it('a node is labelled from the zoom that makes its disc the threshold radius on screen', () => {
    const k = LABEL_MIN_SCREEN_RADIUS / nodeRadius(leaf.degree)

    expect(visibleLabels([leaf], k, NONE, textOf).has('Leaf')).toBe(true)
    expect(visibleLabels([leaf], k * 0.99, NONE, textOf).has('Leaf')).toBe(false)
  })
})

describe('visibleLabels — no overlap', () => {
  it('hides a label that would overlap one placed before it, placing hubs first', () => {
    // On one row 30 px apart: each label overlaps its neighbours' and no further.
    const row: Placed[] = [
      { id: 'Left label', x: 0, y: 0, degree: 4 },
      { id: 'Middle label', x: 30, y: 0, degree: 9 },
      { id: 'Right label', x: 60, y: 0, degree: 4 },
      { id: 'Far label', x: 140, y: 0, degree: 4 },
    ]
    const box = (d: Placed): Box => labelBox(d, 1, d.id)
    expect(overlapping(box(row[0] as Placed), box(row[1] as Placed))).toBe(true)
    expect(overlapping(box(row[1] as Placed), box(row[2] as Placed))).toBe(true)
    expect(overlapping(box(row[0] as Placed), box(row[2] as Placed))).toBe(true)
    expect(overlapping(box(row[1] as Placed), box(row[3] as Placed))).toBe(false)

    expect([...visibleLabels(row, 1, NONE, textOf)]).toEqual(['Middle label', 'Far label'])
  })

  it('leaves no two visible labels overlapping on a crowded grid, zoomed in or not', () => {
    const grid: Placed[] = Array.from({ length: 144 }, (_, i) => ({
      id: `Page number ${i}`,
      x: (i % 12) * 40,
      y: Math.floor(i / 12) * 25,
      degree: (i * 7) % 30,
    }))

    for (const scale of [1, 2]) {
      const ids = visibleLabels(grid, scale, NONE, textOf)
      const shown = grid.filter((d) => ids.has(d.id))
      const boxes = shown.map((d) => labelBox(d, scale, d.id))
      const clashes = boxes.flatMap((a, i) => boxes.slice(i + 1).filter((b) => overlapping(a, b)))

      expect(shown.length).toBeGreaterThan(1)
      expect(shown.length).toBeLessThan(grid.length)
      expect(clashes).toEqual([])
    }
  })

  it('shows every pinned label, even under another or below the zoom threshold, and places the rest around them', () => {
    const stacked: Placed[] = [
      { id: 'Hub', x: 0, y: 0, degree: 36 },
      { id: 'Pinned one', x: 0, y: 0, degree: 0 },
      { id: 'Pinned two', x: 0, y: 0, degree: 0 },
      { id: 'Clear', x: 0, y: 500, degree: 36 },
    ]

    const shown = visibleLabels(stacked, 0.5, new Set(['Pinned one', 'Pinned two']), textOf)

    expect([...shown]).toEqual(['Pinned one', 'Pinned two', 'Clear'])
  })
})
