/**
 * MarkdownReveal (#5689) — with the "Show Markdown syntax around the cursor"
 * preference on, every bold, italic, code or strikethrough range the selection
 * is in or touches shows its Markdown markers, drawn as widget decorations at
 * the range's edges (`revealed-markers.ts` says which). The marker text comes
 * from the serializer, so it is what the block stores (italic is always `*`).
 * Widgets live outside the document: they never reach the stored Markdown, the
 * clipboard or the undo history.
 *
 * A marker is one unit, not text:
 * - Deleting it (Backspace after it, Delete before it) removes its mark from
 *   the whole range in one undo step.
 * - Crossing it (ArrowLeft / ArrowRight, or a click on its far side) moves the
 *   caret to the marker's other side without moving in the text. Both sides
 *   are the same document position, told apart by the marks typing there
 *   carries (stored marks): left of a closing marker typing stays in the
 *   mark, right of it typing leaves it. Typing markers still goes through the
 *   marks' own input rules (`flanking-marks.ts`).
 *
 * While an IME composes, the markers stay put, mapped through the edits:
 * adding or removing DOM beside a live composition breaks it on Android.
 */

import { Extension } from '@tiptap/core'
import { Mark } from '@tiptap/pm/model'
import { type EditorState, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'

import {
  isRevealed,
  markerBesideCaret,
  marksTypedAt,
  revealedMarkers,
} from '@/editor/revealed-markers'
import { isMarkdownRevealEnabled } from '@/lib/editor-preferences'

const markdownRevealPluginKey = new PluginKey<DecorationSet>('markdownReveal')

function markerDom(text: string): HTMLElement {
  const span = document.createElement('span')
  span.className = 'md-reveal-marker'
  span.setAttribute('data-testid', 'md-reveal-marker')
  // Screen readers already announce the formatting from <strong>, <em>, <code>
  // and <s>; markers that come and go with the caret would read characters
  // the note does not contain.
  span.setAttribute('aria-hidden', 'true')
  // In-page find matches what the user reads in the note, not these markers.
  span.setAttribute('data-find-skip', '')
  span.textContent = text
  return span
}

function revealDecorations(state: EditorState): DecorationSet {
  return DecorationSet.create(
    state.doc,
    revealedMarkers(state).map((m) =>
      Decoration.widget(m.pos, () => markerDom(m.text), {
        side: m.side,
        marks: m.marks,
        // PM redraws a widget only when its key changes, so the key carries
        // everything the DOM or its placement depends on.
        key: `md-reveal:${m.role}:${m.run.mark.type.name}:${m.text}:${m.side}:${JSON.stringify(m.marks)}`,
      }),
    ),
  )
}

function deleteMarkerBeside(view: EditorView, side: 'before' | 'after'): boolean {
  const marker = markerBesideCaret(view.state, side)
  if (!marker) return false
  const { from, to, mark } = marker.run
  view.dispatch(view.state.tr.removeMark(from, to, mark))
  return true
}

/**
 * Put the caret on the other side of the marker beside it: typing then
 * carries the marker's mark exactly when it did not before.
 */
function crossMarkerBeside(view: EditorView, side: 'before' | 'after'): boolean {
  const marker = markerBesideCaret(view.state, side)
  if (!marker) return false
  const { mark } = marker.run
  const typed = marksTypedAt(view.state, marker.pos)
  const next = mark.isInSet(typed) ? mark.removeFromSet(typed) : mark.addToSet(typed)
  // A mark the typed marks exclude (code excludes all others) cannot be added: let the arrow move on.
  if (Mark.sameSet(next, typed)) return false
  view.dispatch(view.state.tr.setStoredMarks(next))
  return true
}

/**
 * ArrowLeft onto the edge of a run: land right of the markers there, the side
 * the caret came from. ProseMirror's default lands inside a run's end and
 * outside its start, which skips the marker's near side. ArrowRight needs no
 * help: the default is already the left side.
 */
function arriveFromRight(view: EditorView): boolean {
  const { selection, doc } = view.state
  if (!selection.empty || !isMarkdownRevealEnabled()) return false
  // Only a child boundary one position back changes what typing carries; the native move lands there too.
  const $target = doc.resolve(selection.from - 1)
  const left = $target.nodeBefore?.marks ?? Mark.none
  const right = $target.nodeAfter?.marks ?? Mark.none
  const typed = $target.marks()
  let next = typed
  for (const m of left)
    if (isRevealed(m.type.name) && !m.isInSet(right)) next = m.removeFromSet(next)
  for (const m of right) if (isRevealed(m.type.name) && !m.isInSet(left)) next = m.addToSet(next)
  if (Mark.sameSet(next, typed)) return false
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(doc, $target.pos)).setStoredMarks(next),
  )
  return true
}

interface ClickedSide {
  pos: number
  marks: readonly Mark[]
}

/**
 * The marks typing should carry after a mousedown at a position with markers:
 * each marker left of the click point ends up before the caret.
 */
function marksForClick(view: EditorView, event: MouseEvent): ClickedSide | null {
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
  markers.forEach((m, i) => {
    // Before the caret: an opening marker whose mark typing carries, a closing one whose mark it does not.
    const carries = m.role === 'open' ? leftOfClick[i] : !leftOfClick[i]
    marks = carries ? m.run.mark.addToSet(marks) : m.run.mark.removeFromSet(marks)
  })
  return { pos: hit.pos, marks }
}

const DELETE_SIDE: Partial<Record<string, 'before' | 'after'>> = {
  deleteContentBackward: 'before',
  deleteContentForward: 'after',
}

function createMarkdownRevealPlugin(): Plugin<DecorationSet> {
  let pluginView: EditorView | null = null
  let clicked: ClickedSide | null = null
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
          clicked = marksForClick(view, event)
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
        const { marks } = clicked
        clicked = null
        view.dispatch(
          view.state.tr
            .setSelection(TextSelection.create(view.state.doc, pos))
            .setStoredMarks(marks),
        )
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
