/**
 * MarkdownReveal (#5689) — with the "Show Markdown syntax around the cursor"
 * preference on, the selection shows the Markdown syntax it is in or touches:
 * the markers of bold, italic, code, strikethrough and external links at a
 * range's edges, and a heading's `#` run at the start of its line, drawn as
 * widget decorations (`revealed-markers.ts` says which). The marker text comes
 * from the serializer, so it is what the block stores (italic is always `*`).
 * Widgets live outside the document: they never reach the stored Markdown, the
 * clipboard or the undo history.
 *
 * A marker is one unit, not text:
 * - Deleting it (Backspace after it, Delete before it) removes its mark from
 *   the whole range, or lowers its heading one level, from 1 to a paragraph,
 *   in one undo step.
 * - Crossing it (ArrowLeft / ArrowRight, or a click on its far side) moves the
 *   caret to the marker's other side without moving in the text. Both sides
 *   are the same document position, told apart by the marks typing there
 *   carries (stored marks): left of a closing marker typing stays in the
 *   mark, right of it typing leaves it. Left of a heading's `#` run the
 *   selection is an `OutsideHeadingMarker`, where typing `#` raises the level.
 *   Typing markers still goes through the marks' own input rules
 *   (`flanking-marks.ts`).
 *
 * A page, tag or block-ref chip beside the caret (or selected) shows its
 * syntax (`[[` `]]`, `#`, `((` `))`) the same way, but only to read: the chip
 * stays an atom whose id is not text, so Backspace and Delete take it whole as
 * before and the syntax is no part of the selection. An unresolved chip's
 * label already reads in its syntax (`[[01ABCDEF...]]`), so it gets none.
 *
 * A link's URL is edited through the link popover (Ctrl+K, or the selection
 * bubble's link button), not in its `](url)`.
 *
 * While an IME composes, the markers stay put, mapped through the edits:
 * adding or removing DOM beside a live composition breaks it on Android.
 */

import { Extension } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import { DOMSerializer, Mark, type Node as PMNode } from '@tiptap/pm/model'
import {
  type EditorState,
  Plugin,
  PluginKey,
  type Selection,
  TextSelection,
} from '@tiptap/pm/state'
import type { Mappable } from '@tiptap/pm/transform'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'

import {
  type HeadingMarker,
  isOutsideHeadingMarker,
  markerBesideCaret,
  marksTypedAt,
  OUTSIDE_HEADING_MARKER,
  revealedChipMarkers,
  revealedMarkers,
  revealedRunsAt,
} from '@/editor/revealed-markers'
import { isMarkdownRevealEnabled } from '@/lib/editor-preferences'

const markdownRevealPluginKey = new PluginKey<DecorationSet>('markdownReveal')

const DEEPEST_HEADING = 6

/** The caret left of a heading's `#` run. Mapped through any edit it becomes a plain caret, right of the run. */
class OutsideHeadingMarker extends TextSelection {
  readonly [OUTSIDE_HEADING_MARKER] = true

  // Undo puts the caret back on the side of the run it was on.
  override getBookmark(): OutsideHeadingMarkerBookmark {
    return new OutsideHeadingMarkerBookmark(this.anchor)
  }
}

/** A caret's bookmark, as a text selection's is, that resolves left of the `#` run while one starts there. */
class OutsideHeadingMarkerBookmark {
  readonly anchor: number
  readonly head: number

  constructor(pos: number) {
    this.anchor = pos
    this.head = pos
  }

  map(mapping: Mappable): OutsideHeadingMarkerBookmark {
    return new OutsideHeadingMarkerBookmark(mapping.map(this.anchor))
  }

  resolve(doc: PMNode): Selection {
    const $pos = doc.resolve(this.anchor)
    return $pos.parent.type.name === 'heading' && $pos.parentOffset === 0
      ? new OutsideHeadingMarker($pos)
      : TextSelection.between($pos, $pos)
  }
}

function markerDom(text: string, kind = 'marker'): HTMLElement {
  const span = document.createElement('span')
  span.className = `md-reveal-${kind}`
  span.setAttribute('data-testid', `md-reveal-${kind}`)
  // Screen readers already announce the formatting from <strong>, <em>, <code>,
  // <s>, <a> and <h1>…<h6>; markers that come and go with the caret would read
  // characters the note does not contain.
  span.setAttribute('aria-hidden', 'true')
  // In-page find matches what the user reads in the note, not these markers.
  span.setAttribute('data-find-skip', '')
  span.textContent = text
  return span
}

/** The label a chip shows: its `renderHTML`'s text, which its node view mirrors. */
function chipLabel(chip: PMNode): string {
  return DOMSerializer.fromSchema(chip.type.schema).serializeNode(chip).textContent ?? ''
}

function revealDecorations(state: EditorState): DecorationSet {
  const chips = revealedChipMarkers(state, chipLabel).map((m) =>
    // Its own class: `stopForClick` counts the drawn `.md-reveal-marker`s against `revealedMarkers`.
    Decoration.widget(m.pos, () => markerDom(m.text, 'chip-marker'), {
      side: m.side,
      key: `md-reveal-chip:${m.text}:${m.side}`,
    }),
  )
  return DecorationSet.create(state.doc, [
    ...chips,
    ...revealedMarkers(state).map((m) => {
      const name = m.kind === 'heading' ? 'heading' : m.run.mark.type.name
      return Decoration.widget(m.pos, () => markerDom(m.text), {
        side: m.side,
        marks: m.marks,
        // PM redraws a widget only when its key changes, so the key carries
        // everything the DOM or its placement depends on.
        key: `md-reveal:${m.role}:${name}:${m.text}:${m.side}:${JSON.stringify(m.marks)}`,
      })
    }),
  ])
}

/** Sets the heading's level, 0 making it a paragraph, keeping the caret's side of the `#` run and what typing carries. */
function setHeadingLevel(view: EditorView, marker: HeadingMarker, level: number): void {
  const { state } = view
  const headingPos = marker.pos - 1
  const tr =
    level === 0
      ? state.tr.setNodeMarkup(headingPos, state.schema.nodes['paragraph'])
      : state.tr.setNodeMarkup(headingPos, undefined, {
          ...state.doc.nodeAt(headingPos)?.attrs,
          level,
        })
  if (level > 0 && isOutsideHeadingMarker(state.selection)) {
    tr.setSelection(new OutsideHeadingMarker(tr.doc.resolve(marker.pos)))
  }
  // Its own undo step: ProseMirror would join it to typing just before it in the heading.
  view.dispatch(closeHistory(tr.setStoredMarks(state.storedMarks)))
}

function deleteMarkerBeside(view: EditorView, side: 'before' | 'after'): boolean {
  const marker = markerBesideCaret(view.state, side)
  if (!marker) return false
  if (marker.kind === 'heading') {
    setHeadingLevel(view, marker, marker.level - 1)
    return true
  }
  const { from, to, mark } = marker.run
  view.dispatch(view.state.tr.removeMark(from, to, mark))
  return true
}

/**
 * Put the caret on the other side of the marker beside it: typing then
 * carries the marker's mark exactly when it did not before. A heading's `#`
 * run swaps the caret's selection.
 */
function crossMarkerBeside(view: EditorView, side: 'before' | 'after'): boolean {
  const { state } = view
  const marker = markerBesideCaret(state, side)
  if (!marker) return false
  if (marker.kind === 'heading') {
    const caret = isOutsideHeadingMarker(state.selection)
      ? TextSelection.create(state.doc, marker.pos)
      : new OutsideHeadingMarker(state.doc.resolve(marker.pos))
    // A new selection drops the stored marks: typing carries the same on both sides of the run.
    view.dispatch(state.tr.setSelection(caret).setStoredMarks(marksTypedAt(state, marker.pos)))
    return true
  }
  const { mark } = marker.run
  const typed = marksTypedAt(state, marker.pos)
  const next = mark.isInSet(typed) ? mark.removeFromSet(typed) : mark.addToSet(typed)
  // A mark the typed marks exclude (code excludes all others) cannot be added: let the arrow move on.
  if (Mark.sameSet(next, typed)) return false
  view.dispatch(state.tr.setStoredMarks(next))
  return true
}

/**
 * ArrowLeft onto the edge of a run: land right of the markers there, the side
 * the caret came from. ProseMirror's default lands inside a run's end and
 * outside its start, which skips the marker's near side. ArrowRight needs no
 * help: the default is already the left side.
 */
function arriveFromRight(view: EditorView): boolean {
  const { state } = view
  const { selection, doc } = state
  if (!selection.empty || !isMarkdownRevealEnabled()) return false
  // Only a child boundary one position back changes what typing carries; the native move lands there too.
  const $target = doc.resolve(selection.from - 1)
  const typed = $target.marks()
  let next = typed
  for (const run of revealedRunsAt(state, $target)) {
    if (run.to === $target.pos) next = run.mark.removeFromSet(next)
    else if (run.from === $target.pos) next = run.mark.addToSet(next)
  }
  if (Mark.sameSet(next, typed)) return false
  view.dispatch(state.tr.setSelection(TextSelection.create(doc, $target.pos)).setStoredMarks(next))
  return true
}

/** Where a click at a position with markers puts the caret. */
interface ClickedStop {
  pos: number
  marks: readonly Mark[]
  outsideHeading: boolean
}

/**
 * The caret a mousedown at a position with markers asks for: each marker
 * left of the click point ends up before the caret.
 */
function stopForClick(view: EditorView, event: MouseEvent): ClickedStop | null {
  // Ctrl/Cmd+Click opens a link (`external-link.ts`).
  if (event.ctrlKey || event.metaKey) return null
  const hit = view.posAtCoords({ left: event.clientX, top: event.clientY })
  if (!hit) return null
  const markers = revealedMarkers(view.state)
    .filter((m) => m.pos === hit.pos)
    .toSorted((a, b) => a.side - b.side)
  if (markers.length === 0) return null
  const drawn = [...view.dom.querySelectorAll('.md-reveal-marker')].filter(
    (el) => view.posAtDOM(el, 0) === hit.pos,
  )
  // A composition froze the drawn markers: they no longer match the state.
  if (drawn.length !== markers.length) return null
  const leftOfClick = drawn.map((el) => {
    const box = el.getBoundingClientRect()
    return (box.left + box.right) / 2 <= event.clientX
  })
  let marks = view.state.doc.resolve(hit.pos).marks()
  let outsideHeading = false
  markers.forEach((m, i) => {
    if (m.kind === 'heading') {
      outsideHeading = !leftOfClick[i]
      return
    }
    // Before the caret: an opening marker whose mark typing carries, a closing one whose mark it does not.
    const carries = m.role === 'open' ? leftOfClick[i] : !leftOfClick[i]
    marks = carries ? m.run.mark.addToSet(marks) : m.run.mark.removeFromSet(marks)
  })
  return { pos: hit.pos, marks, outsideHeading }
}

const DELETE_SIDE: Partial<Record<string, 'before' | 'after'>> = {
  deleteContentBackward: 'before',
  deleteContentForward: 'after',
}

function createMarkdownRevealPlugin(): Plugin<DecorationSet> {
  let pluginView: EditorView | null = null
  let clicked: ClickedStop | null = null
  return new Plugin<DecorationSet>({
    key: markdownRevealPluginKey,
    state: {
      init: (_, state) => revealDecorations(state),
      apply: (tr, previous, _old, state) =>
        pluginView?.composing ? previous.map(tr.mapping, tr.doc) : revealDecorations(state),
    },
    view(view) {
      pluginView = view
      return {}
    },
    props: {
      decorations: (state) => markdownRevealPluginKey.getState(state),
      handleKeyDown(view, event) {
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false
        if (event.key === 'Backspace') return deleteMarkerBeside(view, 'before')
        if (event.key === 'Delete') return deleteMarkerBeside(view, 'after')
        if (event.key === 'ArrowLeft')
          return crossMarkerBeside(view, 'before') || arriveFromRight(view)
        if (event.key === 'ArrowRight') return crossMarkerBeside(view, 'after')
        return false
      },
      // `#` typed left of a heading's `#` run joins it.
      handleTextInput(view, _from, _to, text) {
        if (text !== '#') return false
        const marker = markerBesideCaret(view.state, 'after')
        if (marker?.kind !== 'heading') return false
        if (marker.level < DEEPEST_HEADING) setHeadingLevel(view, marker, marker.level + 1)
        return true
      },
      handleDOMEvents: {
        // Android keyboards send Backspace as an input event, not a usable keydown.
        beforeinput(view, event) {
          const side = DELETE_SIDE[event.inputType]
          if (!side || !deleteMarkerBeside(view, side)) return false
          event.preventDefault()
          return true
        },
        // Judge the click against the markers the user saw, before the caret moves.
        mousedown(view, event) {
          clicked = stopForClick(view, event)
          return false
        },
        compositionend(view) {
          // The composition's own transactions left the markers frozen; once
          // ProseMirror has finished it, draw them for where the caret is. Not
          // into a composition that started since: ProseMirror ends one when a
          // state with stored marks arrives, as it does past a marker.
          setTimeout(() => {
            if (!view.composing) view.dispatch(view.state.tr)
          })
          return false
        },
      },
      handleClick(view, pos) {
        if (clicked?.pos !== pos) return false
        const { marks, outsideHeading } = clicked
        clicked = null
        const { doc } = view.state
        const caret = outsideHeading
          ? new OutsideHeadingMarker(doc.resolve(pos))
          : TextSelection.create(doc, pos)
        view.dispatch(view.state.tr.setSelection(caret).setStoredMarks(marks))
        return true
      },
    },
  })
}

export const MarkdownReveal = Extension.create({
  name: 'markdownReveal',
  // Ahead of the link's own ArrowRight, which at the end of a block leaves the
  // link by typing a space (TipTap's `exitable`), and of every other mark's
  // and list's keys: a marker beside the caret owns them.
  priority: 1001,
  addProseMirrorPlugins() {
    return [createMarkdownRevealPlugin()]
  },
})
