/**
 * The Markdown markers MarkdownReveal (`extensions/markdown-reveal.ts`, #5689)
 * draws for an editor state: the delimiters of bold, italic, strikethrough,
 * code and external links, and a heading's `#` run. Kept free of ProseMirror
 * values so `useBlockKeyboard`, on the cold-start path (#2939), can ask whether
 * a marker sits beside the caret without loading the editor chunk.
 */

import type { Mark, Node as PMNode, ResolvedPos } from '@tiptap/pm/model'
import type { EditorState, Selection } from '@tiptap/pm/state'

import {
  CLOSE_DELIMITER,
  inlineCodeDelimiters,
  MARK_ORDER,
  OPEN_DELIMITER,
  writesBareUrl,
} from '@/editor/markdown-serialize'
import { isMarkdownRevealEnabled } from '@/lib/editor-preferences'

const EMPHASIS_MARKS = ['bold', 'italic', 'strike', 'code'] as const
type EmphasisMark = (typeof EMPHASIS_MARKS)[number]
type RevealedMark = EmphasisMark | 'link'

function isEmphasis(name: string): name is EmphasisMark {
  return (EMPHASIS_MARKS as readonly string[]).includes(name)
}

/** A mark whose runs show their Markdown delimiters, a link's unless `isBareLink`. */
function isRevealed(name: string): name is RevealedMark {
  return isEmphasis(name) || name === 'link'
}

/** A maximal range of one mark inside a textblock. */
interface MarkRun {
  mark: Mark
  from: number
  to: number
  parent: PMNode
  /** Indexes in `parent` of the run's first and last child. */
  first: number
  last: number
}

interface MarkerPlacement {
  pos: number
  text: string
  /** Negative when drawn before the caret at `pos`, positive after it; see `sideFor`. */
  side: number
  /** The marks the widget is drawn in. */
  marks: readonly Mark[]
}

/** One end of a mark run, drawn as a widget at `pos`. */
export interface MarkMarker extends MarkerPlacement {
  kind: 'mark'
  role: 'open' | 'close'
  run: MarkRun
}

/** A heading's `#` run, drawn as a widget at the start of its text. */
export interface HeadingMarker extends MarkerPlacement {
  kind: 'heading'
  role: 'open'
  level: number
}

export type Marker = MarkMarker | HeadingMarker

/**
 * The property of the selection `markdown-reveal.ts` puts left of a heading's
 * `#` run. Both sides of the run are the heading's first text position, so the
 * selection, not the position, tells them apart.
 */
export const OUTSIDE_HEADING_MARKER = 'outsideHeadingMarker'

/** The caret sits left of a heading's `#` run, where typing `#` raises the level. */
export function isOutsideHeadingMarker(selection: Selection): boolean {
  return selection.empty && OUTSIDE_HEADING_MARKER in selection
}

/** The run of `mark` through child `index` of `parent`, which starts at `start`. */
function runThrough(parent: PMNode, index: number, start: number, mark: Mark): MarkRun {
  let from = start
  let first = index
  while (first > 0 && mark.isInSet(parent.child(first - 1).marks)) {
    first -= 1
    from -= parent.child(first).nodeSize
  }
  let to = start + parent.child(index).nodeSize
  let last = index
  while (last + 1 < parent.childCount && mark.isInSet(parent.child(last + 1).marks)) {
    last += 1
    to += parent.child(last).nodeSize
  }
  return { mark, from, to, parent, first, last }
}

/** The children of `$pos.parent` that `$pos` is inside of or touches. */
function childrenAt($pos: ResolvedPos): Array<{ index: number; start: number }> {
  const index = $pos.index()
  if ($pos.textOffset > 0) return [{ index, start: $pos.pos - $pos.textOffset }]
  const out: Array<{ index: number; start: number }> = []
  const before = index > 0 ? $pos.parent.child(index - 1) : null
  if (before) out.push({ index: index - 1, start: $pos.pos - before.nodeSize })
  if (index < $pos.parent.childCount) out.push({ index, start: $pos.pos })
  return out
}

/** A link the serializer writes as its bare URL (#1441): it has no syntax to reveal. */
function isBareLink(state: EditorState, run: MarkRun): boolean {
  for (let i = run.first; i <= run.last; i++) {
    const child = run.parent.child(i)
    if (!child.isText || child.marks.length !== 1) return false
  }
  return writesBareUrl(state.doc.textBetween(run.from, run.to), String(run.mark.attrs['href']))
}

/** Collects the runs with revealed syntax that the visited children are part of. */
function runCollector(state: EditorState) {
  // Keyed `name:from`: a textblock holds one run of a mark type from any position.
  const runs = new Map<string, MarkRun>()
  const visit = (parent: PMNode, index: number, start: number): void => {
    for (const mark of parent.child(index).marks) {
      const name = mark.type.name
      if (!isRevealed(name)) continue
      const run = runThrough(parent, index, start, mark)
      if (name === 'link' && isBareLink(state, run)) continue
      runs.set(`${name}:${run.from}`, run)
    }
  }
  const visitAt = ($pos: ResolvedPos): void => {
    for (const { index, start } of childrenAt($pos)) visit($pos.parent, index, start)
  }
  return { visit, visitAt, runs: () => [...runs.values()] }
}

/** The runs with revealed syntax that `$pos` is inside of or touches. */
export function revealedRunsAt(state: EditorState, $pos: ResolvedPos): MarkRun[] {
  const { visitAt, runs } = runCollector(state)
  visitAt($pos)
  return runs()
}

/** Every run with revealed syntax the selection is inside of or touches. */
function runsAtSelection(state: EditorState): MarkRun[] {
  const { visit, visitAt, runs } = runCollector(state)
  const { selection, doc } = state
  visitAt(selection.$from)
  visitAt(selection.$to)
  // Only a range has children strictly inside it; a caret skips the walk, which
  // would cover the block's children up to the caret on every transaction.
  if (!selection.empty) {
    doc.nodesBetween(selection.from, selection.to, (_node, pos, parent, index) => {
      if (parent) visit(parent, index, pos)
    })
  }
  return runs()
}

/** The text start and level of every heading the selection is in. */
function headingsAtSelection(state: EditorState): Map<number, number> {
  const headings = new Map<number, number>()
  const add = (node: PMNode, start: number): void => {
    if (node.type.name === 'heading') headings.set(start, Number(node.attrs['level']))
  }
  const { selection, doc } = state
  for (const $pos of [selection.$from, selection.$to]) add($pos.parent, $pos.start())
  if (!selection.empty) {
    doc.nodesBetween(selection.from, selection.to, (node, pos) => add(node, pos + 1))
  }
  return headings
}

/**
 * Left to right, the markers sharing a position as the serializer writes
 * them: a heading's `#` run, closes innermost first, then opens outermost
 * first. Emphasis is written inside a link's brackets, so a link is the
 * outermost; code (-1) excludes every other mark.
 */
const NESTING: readonly string[] = [...MARK_ORDER, 'link']
const HEADING_ORDER = 0

function markOrder(role: 'open' | 'close', name: string): number {
  const rank = NESTING.indexOf(name)
  return role === 'close' ? 2 + rank : 13 - rank
}

/** The widget's `side`: its sign puts it before (negative) or after the caret at its position, `order` orders it. */
function sideFor(order: number, beforeCaret: boolean): number {
  return beforeCaret ? -100 + order : 1 + order
}

/** The marks typing at `pos` would carry: the stored marks at the caret, else the position's. */
export function marksTypedAt(state: EditorState, pos: number): readonly Mark[] {
  const { selection, storedMarks } = state
  if (selection.from === pos && storedMarks) return storedMarks
  return state.doc.resolve(pos).marks()
}

/**
 * The marks a marker is drawn in: those of the run's own end, less the
 * revealed emphasis and the run's own mark. The serializer writes emphasis
 * inside a link's brackets, so an emphasis marker at the edge of linked text
 * stays in the link, and the link's own brackets are drawn outside it.
 */
function markerMarks(edge: PMNode, run: MarkRun): readonly Mark[] {
  return edge.marks.filter((m) => !isEmphasis(m.type.name) && !m.eq(run.mark))
}

function delimiters(state: EditorState, run: MarkRun): { open: string; close: string } {
  const name = run.mark.type.name as RevealedMark
  if (name === 'code') return inlineCodeDelimiters(state.doc.textBetween(run.from, run.to))
  if (name === 'link') return { open: '[', close: `](${String(run.mark.attrs['href'])})` }
  return { open: OPEN_DELIMITER[name], close: CLOSE_DELIMITER[name] }
}

function markersOf(state: EditorState, run: MarkRun): MarkMarker[] {
  const name = run.mark.type.name
  const { open, close } = delimiters(state, run)
  const typedCarries = (pos: number) => run.mark.isInSet(marksTypedAt(state, pos))
  return [
    {
      kind: 'mark',
      role: 'open',
      run,
      pos: run.from,
      text: open,
      // Typing at the start carries the mark: the caret is inside, after the marker.
      side: sideFor(markOrder('open', name), typedCarries(run.from)),
      marks: markerMarks(run.parent.child(run.first), run),
    },
    {
      kind: 'mark',
      role: 'close',
      run,
      pos: run.to,
      text: close,
      // Typing at the end does not carry the mark: the caret is outside, past the marker.
      side: sideFor(markOrder('close', name), !typedCarries(run.to)),
      marks: markerMarks(run.parent.child(run.last), run),
    },
  ]
}

function headingMarker(state: EditorState, start: number, level: number): HeadingMarker {
  // A caret reveals only its own heading, so a caret left of a `#` run is left of this one.
  const outside = isOutsideHeadingMarker(state.selection)
  return {
    kind: 'heading',
    role: 'open',
    level,
    pos: start,
    // The serializer's prefix (`serializeHeading`).
    text: `${'#'.repeat(level)} `,
    side: sideFor(HEADING_ORDER, !outside),
    marks: [],
  }
}

/** The markers `state` reveals, none with the preference off. */
export function revealedMarkers(state: EditorState): Marker[] {
  if (!isMarkdownRevealEnabled()) return []
  const headings = [...headingsAtSelection(state)].map(([start, level]) =>
    headingMarker(state, start, level),
  )
  return [...headings, ...runsAtSelection(state).flatMap((run) => markersOf(state, run))]
}

/**
 * The revealed marker drawn right beside a collapsed caret on `side`, if any:
 * the nearest one when several share the position.
 */
export function markerBesideCaret(state: EditorState, side: 'before' | 'after'): Marker | null {
  if (!state.selection.empty) return null
  const caret = state.selection.from
  let nearest: Marker | null = null
  for (const m of revealedMarkers(state)) {
    const onSide = side === 'before' ? m.side < 0 : m.side > 0
    if (m.pos !== caret || !onSide) continue
    if (!nearest || (side === 'before' ? m.side > nearest.side : m.side < nearest.side)) nearest = m
  }
  return nearest
}
