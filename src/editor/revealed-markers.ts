/**
 * The Markdown markers MarkdownReveal (`extensions/markdown-reveal.ts`, #5689)
 * draws for an editor state. Kept free of ProseMirror values so
 * `useBlockKeyboard`, on the cold-start path (#2939), can ask whether a marker
 * sits beside the caret without loading the editor chunk.
 */

import type { Mark, Node as PMNode, ResolvedPos } from '@tiptap/pm/model'
import type { EditorState } from '@tiptap/pm/state'

import {
  CLOSE_DELIMITER,
  inlineCodeDelimiters,
  MARK_ORDER,
  OPEN_DELIMITER,
} from '@/editor/markdown-serialize'
import { isMarkdownRevealEnabled } from '@/lib/editor-preferences'

const REVEALED_MARKS = ['bold', 'italic', 'strike', 'code'] as const
type RevealedMark = (typeof REVEALED_MARKS)[number]

export function isRevealed(name: string): name is RevealedMark {
  return (REVEALED_MARKS as readonly string[]).includes(name)
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

/** One end of a run, drawn as a widget at `pos`. */
export interface Marker {
  role: 'open' | 'close'
  run: MarkRun
  pos: number
  text: string
  /** Negative when drawn before the caret at `pos`, positive after it; see `sideFor`. */
  side: number
  /** The marks the widget is drawn in. */
  marks: readonly Mark[]
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

/** Every run of a revealed mark the selection is inside of or touches. */
function runsAtSelection(state: EditorState): MarkRun[] {
  // Keyed `name:from`; the revealed marks carry no attributes.
  const runs = new Map<string, MarkRun>()
  const visit = (parent: PMNode, index: number, start: number): void => {
    for (const mark of parent.child(index).marks) {
      if (!isRevealed(mark.type.name)) continue
      const run = runThrough(parent, index, start, mark)
      runs.set(`${mark.type.name}:${run.from}`, run)
    }
  }
  const { selection, doc } = state
  for (const $pos of [selection.$from, selection.$to]) {
    for (const { index, start } of childrenAt($pos)) visit($pos.parent, index, start)
  }
  // Only a range has children strictly inside it; a caret skips the walk, which
  // would cover the block's children up to the caret on every transaction.
  if (!selection.empty) {
    doc.nodesBetween(selection.from, selection.to, (_node, pos, parent, index) => {
      if (parent) visit(parent, index, pos)
    })
  }
  return [...runs.values()]
}

/** Innermost first, as the serializer closes them; code (-1) excludes every other mark. */
function rank(name: RevealedMark): number {
  return (MARK_ORDER as readonly string[]).indexOf(name)
}

/**
 * The widget's `side`: its sign puts it before (negative) or after the caret
 * at its position, its size orders widgets sharing a position the way the
 * serializer writes delimiters: closes before opens, closes innermost first,
 * opens outermost first.
 */
function sideFor(role: Marker['role'], name: RevealedMark, beforeCaret: boolean): number {
  const order = role === 'close' ? 1 + rank(name) : 10 + (5 - rank(name))
  return beforeCaret ? -100 + order : 1 + order
}

/** The marks typing at `pos` would carry: the stored marks at the caret, else the position's. */
export function marksTypedAt(state: EditorState, pos: number): readonly Mark[] {
  const { selection, storedMarks } = state
  if (selection.from === pos && storedMarks) return storedMarks
  return state.doc.resolve(pos).marks()
}

/**
 * The marks a marker is drawn in: those of the run's own end, other than
 * revealed ones. The serializer writes emphasis inside a link's brackets, so
 * a marker at the edge of linked text stays in the link.
 */
function markerMarks(edge: PMNode): readonly Mark[] {
  return edge.marks.filter((m) => !isRevealed(m.type.name))
}

function markersOf(state: EditorState, run: MarkRun): Marker[] {
  const name = run.mark.type.name as RevealedMark
  const { open, close } =
    name === 'code'
      ? inlineCodeDelimiters(state.doc.textBetween(run.from, run.to))
      : { open: OPEN_DELIMITER[name], close: CLOSE_DELIMITER[name] }
  const typedCarries = (pos: number) => run.mark.isInSet(marksTypedAt(state, pos))
  return [
    {
      role: 'open',
      run,
      pos: run.from,
      text: open,
      // Typing at the start carries the mark: the caret is inside, after the marker.
      side: sideFor('open', name, typedCarries(run.from)),
      marks: markerMarks(run.parent.child(run.first)),
    },
    {
      role: 'close',
      run,
      pos: run.to,
      text: close,
      // Typing at the end does not carry the mark: the caret is outside, past the marker.
      side: sideFor('close', name, !typedCarries(run.to)),
      marks: markerMarks(run.parent.child(run.last)),
    },
  ]
}

/** The markers `state` reveals, none with the preference off. */
export function revealedMarkers(state: EditorState): Marker[] {
  if (!isMarkdownRevealEnabled()) return []
  return runsAtSelection(state).flatMap((run) => markersOf(state, run))
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
