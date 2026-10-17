/**
 * MarkdownReveal (#5689, spike) — with the "Show Markdown syntax around the
 * cursor" preference on, every bold, italic, code or strikethrough range the
 * selection is in or touches shows its Markdown markers, drawn as widget
 * decorations at the range's edges. The marker text comes from the
 * serializer, so it is what the block stores. Widgets live outside the
 * document: they never reach the serialized Markdown or the clipboard.
 *
 * A marker is a single unit, not text: Delete before one, or Backspace after
 * one, removes that mark from its whole range. Typing markers still goes
 * through the marks' own input rules (`flanking-marks.ts`).
 *
 * Which side of the caret a marker sits on follows what typing there would
 * do: where typed text would carry the mark, the caret is drawn inside the
 * markers, otherwise outside them.
 */

import { Extension } from '@tiptap/core'
import type { Mark, Node as PMNode, ResolvedPos } from '@tiptap/pm/model'
import { type EditorState, Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

import {
  CLOSE_DELIMITER,
  inlineCodeDelimiters,
  MARK_ORDER,
  OPEN_DELIMITER,
} from '@/editor/markdown-serialize'
import { isMarkdownRevealEnabled } from '@/lib/editor-preferences'

const REVEALED_MARKS = ['bold', 'italic', 'strike', 'code'] as const
type RevealedMark = (typeof REVEALED_MARKS)[number]

function isRevealed(name: string): name is RevealedMark {
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

/** What a widget's spec carries for the Backspace / Delete lookup. */
interface RevealSpec {
  revealRun: { from: number; to: number; mark: Mark }
  side: number
}

const markdownRevealPluginKey = new PluginKey<DecorationSet>('markdownReveal')

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
    if (!$pos.parent.inlineContent) continue
    for (const { index, start } of childrenAt($pos)) visit($pos.parent, index, start)
  }
  // Only a range has children strictly inside it, and a caret skips the walk to it.
  if (!selection.empty) {
    doc.nodesBetween(selection.from, selection.to, (node, pos, parent, index) => {
      if (!node.isInline) return true
      if (parent) visit(parent, index, pos)
      return false
    })
  }
  return [...runs.values()]
}

/** Innermost first, as the serializer closes them; code is exclusive, so it never nests. */
function rank(name: RevealedMark): number {
  return name === 'code' ? -1 : MARK_ORDER.indexOf(name)
}

/**
 * The widget's `side`: its sign puts it before (negative) or after the caret
 * at its position, its size orders widgets sharing a position the way the
 * serializer writes delimiters: closes before opens, closes innermost first,
 * opens outermost first.
 */
function sideFor(role: 'open' | 'close', name: RevealedMark, beforeCaret: boolean): number {
  const order = role === 'close' ? 1 + rank(name) : 10 + (5 - rank(name))
  return beforeCaret ? -100 + order : 1 + order
}

/** The marks typing at `pos` would carry: the stored marks at the caret, else the position's. */
function marksTypedAt(state: EditorState, pos: number): readonly Mark[] {
  const { selection, storedMarks } = state
  if (selection.empty && selection.from === pos && storedMarks) return storedMarks
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

function markerDom(text: string): HTMLElement {
  const span = document.createElement('span')
  span.className = 'md-reveal-marker'
  span.setAttribute('data-testid', 'md-reveal-marker')
  span.setAttribute('aria-hidden', 'true')
  // In-page find matches what the user reads in the note, not these markers.
  span.setAttribute('data-find-skip', '')
  span.textContent = text
  return span
}

function widgetsFor(state: EditorState, run: MarkRun): Decoration[] {
  const name = run.mark.type.name as RevealedMark
  const { open, close } =
    name === 'code'
      ? inlineCodeDelimiters(state.doc.textBetween(run.from, run.to))
      : { open: OPEN_DELIMITER[name], close: CLOSE_DELIMITER[name] }
  const { parent, first, last } = run
  const ends = [
    {
      role: 'open' as const,
      pos: run.from,
      text: open,
      // Typing at the start carries the mark: the caret is inside, after the marker.
      beforeCaret: run.mark.isInSet(marksTypedAt(state, run.from)),
      marks: markerMarks(parent.child(first)),
    },
    {
      role: 'close' as const,
      pos: run.to,
      text: close,
      // Typing at the end does not carry the mark: the caret is outside, past the marker.
      beforeCaret: !run.mark.isInSet(marksTypedAt(state, run.to)),
      marks: markerMarks(parent.child(last)),
    },
  ]
  return ends.map((end) => {
    const side = sideFor(end.role, name, end.beforeCaret)
    const spec: RevealSpec & Record<string, unknown> = {
      side,
      marks: end.marks,
      // PM redraws a widget only when its key changes, so the key carries
      // everything the DOM or its placement depends on.
      key: `md-reveal:${end.role}:${name}:${end.text}:${side}:${JSON.stringify(end.marks)}`,
      revealRun: { from: run.from, to: run.to, mark: run.mark },
    }
    return Decoration.widget(end.pos, () => markerDom(end.text), spec)
  })
}

/** The reveal decorations for `state`, or none with the preference off. */
function buildRevealDecorations(state: EditorState): DecorationSet {
  if (!isMarkdownRevealEnabled()) return DecorationSet.empty
  return DecorationSet.create(
    state.doc,
    runsAtSelection(state).flatMap((run) => widgetsFor(state, run)),
  )
}

/**
 * The revealed marker drawn right beside a collapsed caret on `side`, if
 * any: the nearest one when several share the position.
 */
function markerBesideCaret(
  state: EditorState,
  side: 'before' | 'after',
): RevealSpec['revealRun'] | null {
  const { selection } = state
  if (!selection.empty) return null
  const decorations = markdownRevealPluginKey.getState(state) ?? DecorationSet.empty
  const specs = decorations
    .find(selection.from, selection.from)
    .map((d) => d.spec as Partial<RevealSpec>)
    .filter((s): s is RevealSpec => s.revealRun !== undefined)
    .filter((s) => (side === 'before' ? s.side < 0 : s.side >= 0))
    .toSorted((a, b) => (side === 'before' ? b.side - a.side : a.side - b.side))
  return specs[0]?.revealRun ?? null
}

function createMarkdownRevealPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: markdownRevealPluginKey,
    state: {
      init: (_, state) => buildRevealDecorations(state),
      apply: (_tr, _previous, _old, state) => buildRevealDecorations(state),
    },
    props: {
      decorations: (state) => markdownRevealPluginKey.getState(state),
      handleKeyDown(view, event) {
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false
        const side = event.key === 'Backspace' ? 'before' : event.key === 'Delete' ? 'after' : null
        if (!side) return false
        const run = markerBesideCaret(view.state, side)
        if (!run) return false
        view.dispatch(view.state.tr.removeMark(run.from, run.to, run.mark))
        return true
      },
    },
  })
}

export const MarkdownReveal = Extension.create({
  name: 'markdownReveal',
  addProseMirrorPlugins() {
    return [createMarkdownRevealPlugin()]
  },
})
