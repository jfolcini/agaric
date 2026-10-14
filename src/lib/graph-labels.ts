/**
 * Which node labels the graph shows (#5430). The pinned labels show first,
 * whatever they cover; then the rest, hubs first, each while its node is big
 * enough on screen and its label clears every label already placed.
 *
 * Works in screen pixels, where every label is `LABEL_FONT_PX` tall at any
 * zoom. A label's width is estimated from its length rather than measured, so
 * the pass reads no layout, and a hidden label, which has no box to measure,
 * gets the same estimate as a shown one.
 */

import { type ForceNode, nodeRadius } from '@/lib/graph-forces'

/** On-screen label size and halo width, the same at every zoom. */
export const LABEL_FONT_PX = 12
export const LABEL_HALO_PX = 3
/** Graph units between a node's disc and the start of its label. */
export const LABEL_GAP = 4
/** Width per character, in em: above the bundled Inter's mixed-case average, so the estimate errs wide. */
const LABEL_EM_PER_CHAR = 0.62
/** Height of a label's box, in em: its line box, ascenders to descenders. */
const LABEL_HEIGHT_EM = 1.25
/** An unpinned node is labelled only once its disc is at least this many pixels in radius on screen. */
export const LABEL_MIN_SCREEN_RADIUS = 6

export interface Box {
  left: number
  right: number
  top: number
  bottom: number
}

/** Where a label sits on screen, relative to the origin: right of its node, centred on it vertically. */
export function labelBox(d: ForceNode, scale: number, text: string): Box {
  const left = ((d.x ?? 0) + nodeRadius(d.degree ?? 0) + LABEL_GAP) * scale
  const centre = (d.y ?? 0) * scale
  const halfHeight = (LABEL_HEIGHT_EM * LABEL_FONT_PX) / 2
  return {
    left,
    right: left + text.length * LABEL_EM_PER_CHAR * LABEL_FONT_PX,
    top: centre - halfHeight,
    bottom: centre + halfHeight,
  }
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

/**
 * The ids of the nodes whose label shows at zoom `scale`: every pinned node,
 * then, by degree, each node whose disc is at least `LABEL_MIN_SCREEN_RADIUS`
 * on screen and whose label overlaps none already shown.
 */
export function visibleLabels<N extends ForceNode>(
  nodes: readonly N[],
  scale: number,
  pinned: ReadonlySet<string>,
  textOf: (d: N) => string,
): Set<string> {
  const shown = new Set<string>()
  const placed: Box[] = []
  const candidates: N[] = []
  for (const d of nodes) {
    if (pinned.has(d.id)) {
      shown.add(d.id)
      placed.push(labelBox(d, scale, textOf(d)))
    } else if (nodeRadius(d.degree ?? 0) * scale >= LABEL_MIN_SCREEN_RADIUS) {
      candidates.push(d)
    }
  }
  candidates.sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0))
  for (const d of candidates) {
    const box = labelBox(d, scale, textOf(d))
    if (placed.some((other) => overlaps(box, other))) continue
    shown.add(d.id)
    placed.push(box)
  }
  return shown
}
