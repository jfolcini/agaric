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
 * - A link's `](url)` holds its URL in a field the arrows walk through as if
 *   it were text. Leaving the field sets its URL on the whole link in one undo
 *   step; Escape restores the URL first.
 *
 * While an IME composes, the markers stay put, mapped through the edits:
 * adding or removing DOM beside a live composition breaks it on Android.
 */

import { Extension, getMarkRange } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import { Mark, type Node as PMNode, type ResolvedPos } from '@tiptap/pm/model'
import {
  type EditorState,
  Plugin,
  PluginKey,
  type Selection,
  TextSelection,
  type Transaction,
} from '@tiptap/pm/state'
import type { Mappable } from '@tiptap/pm/transform'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'

import {
  type HeadingMarker,
  isOutsideHeadingMarker,
  isRevealed,
  type Marker,
  markerBesideCaret,
  marksTypedAt,
  OUTSIDE_HEADING_MARKER,
  revealedMarkers,
  revealedRunsAt,
} from '@/editor/revealed-markers'
import { isMarkdownRevealEnabled } from '@/lib/editor-preferences'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { normalizeUrl } from '@/lib/url-validation'

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

function markerRoot(): HTMLElement {
  const span = document.createElement('span')
  span.className = 'md-reveal-marker'
  span.setAttribute('data-testid', 'md-reveal-marker')
  // In-page find matches what the user reads in the note, not these markers.
  span.setAttribute('data-find-skip', '')
  return span
}

/**
 * Screen readers already announce the formatting from <strong>, <em>, <code>,
 * <s>, <a> and <h1>…<h6>; markers that come and go with the caret would read
 * characters the note does not contain.
 */
function hiddenText(span: HTMLElement, text: string): HTMLElement {
  span.setAttribute('aria-hidden', 'true')
  span.textContent = text
  return span
}

function markerDom(text: string): HTMLElement {
  return hiddenText(markerRoot(), text)
}

function isLinkClose(m: Marker): boolean {
  return m.kind === 'mark' && m.role === 'close' && m.run.mark.type.name === 'link'
}

/** An event inside a link's URL field, which belongs to the field rather than the editor. */
function isInUrlField(event: Event): boolean {
  return event.target instanceof Element && event.target.closest('.md-reveal-url') !== null
}

function revealDecorations(state: EditorState): DecorationSet {
  return DecorationSet.create(
    state.doc,
    revealedMarkers(state).map((m) => {
      const name = m.kind === 'heading' ? 'heading' : m.run.mark.type.name
      const spec = {
        side: m.side,
        marks: m.marks,
        // PM redraws a widget only when its key changes, so the key carries
        // everything the DOM or its placement depends on.
        key: `md-reveal:${m.role}:${name}:${m.text}:${m.side}:${JSON.stringify(m.marks)}`,
      }
      if (m.kind === 'mark' && isLinkClose(m)) {
        const link = m.run.mark
        return Decoration.widget(m.pos, (view, getPos) => linkCloseDom(view, getPos, link), {
          ...spec,
          stopEvent: isInUrlField,
        })
      }
      return Decoration.widget(m.pos, () => markerDom(m.text), spec)
    }),
  )
}

/** A link's `](url)`, its URL in a field. */
function linkCloseDom(view: EditorView, getPos: () => number | undefined, link: Mark): HTMLElement {
  const href = String(link.attrs['href'])
  const root = markerRoot()
  const field = document.createElement('span')
  field.className = 'md-reveal-url'
  // The field sizes to this copy of its text (index.css).
  field.dataset['value'] = href
  const input = document.createElement('input')
  input.type = 'url'
  input.size = 1
  input.spellcheck = false
  input.value = href
  input.setAttribute('aria-label', t('editor.revealedLinkUrl'))
  field.append(input)
  root.append(
    hiddenText(document.createElement('span'), ']('),
    field,
    hiddenText(document.createElement('span'), ')'),
  )
  wireUrlField(view, getPos, link, input, field)
  return root
}

/**
 * The marks typing at a link's end carries with the caret just inside its
 * `](url)` or just past it: never the emphasis closing there, which the
 * serializer closes inside the brackets.
 */
function marksAtLinkEnd($pos: ResolvedPos, link: Mark, inside: boolean): readonly Mark[] {
  const after = $pos.nodeAfter?.marks ?? Mark.none
  let marks = $pos.marks()
  for (const m of $pos.nodeBefore?.marks ?? Mark.none) {
    if (isRevealed(m.type.name) && !m.isInSet(after)) marks = m.removeFromSet(marks)
  }
  return inside ? link.addToSet(marks) : marks
}

/** Points the link ending at `pos` at `href`; false when no link ends there. */
function retargetLink(tr: Transaction, pos: number, link: Mark, href: string): boolean {
  // One position back, inside the link: at its end the next node may be another link.
  const range = getMarkRange(tr.doc.resolve(pos - 1), link.type)
  if (!range) return false
  // The new link mark replaces the old one, which it excludes; an equal one adds no step.
  tr.addMark(range.from, range.to, link.type.create({ ...link.attrs, href }))
  return true
}

/**
 * The URL field of a link's `](url)`. Leaving it sets its URL on the link, or
 * drops it when invalid. Enter, or an arrow past its first or last character,
 * leaves it for the text beside the `](url)`, refusing an invalid URL in
 * place; Escape restores the URL first.
 */
function wireUrlField(
  view: EditorView,
  getPos: () => number | undefined,
  link: Mark,
  input: HTMLInputElement,
  field: HTMLElement,
): void {
  const stored = String(link.attrs['href'])

  /** The URL to set: the link's own while the field is unchanged, else the one typed, made absolute; null when invalid. */
  const draft = (): string | null => (input.value === stored ? stored : normalizeUrl(input.value))

  /** The field shows `href`: a widget the URL change does not redraw keeps this input. */
  const show = (href: string): void => {
    input.value = href
    field.dataset['value'] = href
    input.removeAttribute('aria-invalid')
  }

  const commit = (): void => {
    const pos = getPos()
    if (pos === undefined) return
    const href = draft() ?? stored
    show(href)
    const tr = view.state.tr
    if (retargetLink(tr, pos, link, href)) view.dispatch(tr)
    else logger.warn('MarkdownReveal', 'no link ends at its URL field', { pos, href })
  }

  /** Back to the editor, whose focus commits the field, with the caret just inside or past the `](url)`. */
  const leave = (caret: 'inside' | 'outside'): void => {
    const pos = getPos()
    if (pos === undefined) return
    view.focus()
    const $pos = view.state.doc.resolve(pos)
    // The link as the commit left it.
    const current = link.type.isInSet($pos.nodeBefore?.marks ?? Mark.none) ?? link
    view.dispatch(
      view.state.tr
        .setSelection(TextSelection.create(view.state.doc, pos))
        .setStoredMarks(marksAtLinkEnd($pos, current, caret === 'inside')),
    )
  }

  // `useBlockKeyboard` listens on the editor's container in the capture phase;
  // only a capture listener on the document runs before it.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.target !== input) return
    event.stopPropagation()
    if (event.isComposing || event.keyCode === 229) return
    const plain = !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
    const caretAt = (offset: number) =>
      input.selectionStart === offset && input.selectionEnd === offset
    let caret: 'inside' | 'outside' | null = null
    if (event.key === 'Enter') caret = 'outside'
    else if (event.key === 'Escape') caret = 'inside'
    else if (plain && event.key === 'ArrowLeft' && caretAt(0)) caret = 'inside'
    else if (plain && event.key === 'ArrowRight' && caretAt(input.value.length)) caret = 'outside'
    if (!caret) return
    event.preventDefault()
    if (event.key === 'Escape') show(stored)
    else if (draft() === null) {
      input.setAttribute('aria-invalid', 'true')
      return
    }
    leave(caret)
  }

  // A press elsewhere gives focus back to the editor before anything else sees
  // it: a press on another block keeps this editor focused until the click
  // saves it (`keepEditorUntilClick`), so the field's focusout would come too late.
  const onPointerDown = (event: PointerEvent): void => {
    if (event.target instanceof Node && field.contains(event.target)) return
    view.focus()
  }

  input.addEventListener('input', () => {
    field.dataset['value'] = input.value
    input.removeAttribute('aria-invalid')
  })
  input.addEventListener('focus', () => {
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', onPointerDown, true)
  })
  // Before the block's own focusout (`useEditorBlur`), which saves the block.
  input.addEventListener('focusout', () => {
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('pointerdown', onPointerDown, true)
    commit()
  })
}

/**
 * Moves focus into the URL field of the link ending at the caret, the caret at
 * its start or end. It is the first one drawn: another link touching the caret
 * starts there and ends after it.
 */
function focusUrlField(view: EditorView, at: 'start' | 'end'): boolean {
  const input = view.dom.querySelector<HTMLInputElement>('.md-reveal-url input')
  // A composition froze the drawn markers: no field is drawn for this link.
  if (!input) return false
  input.focus()
  const offset = at === 'start' ? 0 : input.value.length
  input.setSelectionRange(offset, offset)
  // A long URL scrolls in its field; Chrome leaves it scrolled to the end whatever the caret.
  input.scrollLeft = at === 'start' ? 0 : input.scrollWidth
  return true
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
 * run swaps the caret's selection; a link's `](url)` is entered at its URL.
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
  if (isLinkClose(marker)) return focusUrlField(view, side === 'after' ? 'start' : 'end')
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
