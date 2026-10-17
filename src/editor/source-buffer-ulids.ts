/**
 * ULID tokens in the *Edit as Markdown* buffer (#5686): `[[ULID]]`, `#[ULID]`,
 * `((ULID))` and a `key:: ULID` value (`@/components/pages/ulid-tokens`).
 *
 * - **A title hint.** Each token is decorated with its target's title, which
 *   the stylesheet shows under it on hover or while the cursor touches it
 *   (`.source-ulid-token`). The hint is generated content, so it is not text:
 *   it is neither saved nor copied. The ids are resolved in one batch per
 *   change, and a resolve store update redraws the hints.
 * - **Atomic tokens.** The arrow keys step over a token, Backspace and Delete
 *   beside it remove it whole as one undo step, and typing inside it is
 *   refused. A paste or a typed replacement whose range splits a token is
 *   clamped to the token's edge, so it never removes text the selection did
 *   not hold whole. Any other change that would split one (a cut, a drop, an
 *   IME composition inside it) is refused; undo and redo restore what was.
 */

import { Extension } from '@tiptap/core'
import { closeHistory, isHistoryTransaction } from '@tiptap/pm/history'
import type { Node as PMNode } from '@tiptap/pm/model'
import {
  type EditorState,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'

import {
  findUlidTokens,
  resolveUlidTokens,
  type UlidToken,
  type UlidTokenHint,
  ulidTokenHint,
} from '@/components/pages/ulid-tokens'
import { logger } from '@/lib/logger'
import { useResolveStore } from '@/stores/resolve'

/** How long the buffer waits after a change before resolving its new ids. */
const RESOLVE_DELAY_MS = 300

const tokensByDoc = new WeakMap<PMNode, UlidToken[]>()

/** The ULID tokens of the buffer's `doc`, at document positions. */
export function docUlidTokens(doc: PMNode): UlidToken[] {
  const cached = tokensByDoc.get(doc)
  if (cached !== undefined) return cached
  const tokens: UlidToken[] = []
  doc.forEach((line, offset) => {
    for (const t of findUlidTokens(line.textContent)) {
      tokens.push({ ...t, from: offset + 1 + t.from, to: offset + 1 + t.to })
    }
  })
  tokensByDoc.set(doc, tokens)
  return tokens
}

/** Whether replacing `from`–`to` (an insertion when equal) would split a token. */
function splits(t: UlidToken, from: number, to: number): boolean {
  if (from === to) return t.from < from && from < t.to
  return from < t.to && to > t.from && (from > t.from || to < t.to)
}

/**
 * `from`–`to` with each end that falls inside a token moved to that token's
 * edge outside the range, so a token it split is left whole. A range inside
 * one token becomes the point after it.
 */
export function clampToTokens(doc: PMNode, from: number, to: number): { from: number; to: number } {
  let start = from
  let end = to
  for (const t of docUlidTokens(doc)) {
    if (t.from < start && start < t.to) start = t.to
    if (t.from < end && end < t.to) end = t.from
  }
  return start <= end ? { from: start, to: end } : { from: start, to: start }
}

/** Whether `pos` in `doc` is strictly inside a token, where a picker's pick could only split it. */
export function insideUlidToken(doc: PMNode, pos: number): boolean {
  return docUlidTokens(doc).some((t) => t.from < pos && pos < t.to)
}

/** `tr` with its selection clamped (`clampToTokens`), for a paste over it. */
export function clampSelectionToTokens(tr: Transaction): Transaction {
  const { from, to } = tr.selection
  const clamped = clampToTokens(tr.doc, from, to)
  if (clamped.from !== from || clamped.to !== to) {
    tr.setSelection(TextSelection.create(tr.doc, clamped.from, clamped.to))
  }
  return tr
}

/** Whether `tr` changes text inside a token it does not replace whole. */
function splitsToken(tr: Transaction): boolean {
  return tr.steps.some((step, i) => {
    const tokens = docUlidTokens(tr.docs[i] as PMNode)
    if (tokens.length === 0) return false
    let split = false
    step.getMap().forEach((from, to) => {
      split ||= tokens.some((t) => splits(t, from, to))
    })
    return split
  })
}

export interface ActiveUlidToken {
  token: UlidToken
  hint: UlidTokenHint | null
}

interface UlidTokensState {
  decorations: DecorationSet
  /** The token the cursor is inside or touching. */
  active: ActiveUlidToken | null
}

const ulidTokensKey = new PluginKey<UlidTokensState>('sourceBufferUlids')

function build(state: EditorState): UlidTokensState {
  const { selection, doc } = state
  const tokens = docUlidTokens(doc)
  const head = selection.empty ? selection.head : null
  let active: ActiveUlidToken | null = null
  const decorations = tokens.map((token) => {
    const hint = ulidTokenHint(token)
    const attrs: Record<string, string> = { class: 'source-ulid-token' }
    if (hint !== null) attrs['data-ulid-hint'] = hint.label
    if (hint?.deleted === true) attrs['data-ulid-deleted'] = ''
    if (active === null && head !== null && token.from <= head && head <= token.to) {
      active = { token, hint }
      attrs['data-ulid-active'] = ''
    }
    return Decoration.inline(token.from, token.to, attrs)
  })
  return { decorations: DecorationSet.create(doc, decorations), active }
}

/** The token the cursor in `state` is inside or touching, with its hint. */
export function activeUlidToken(state: EditorState): ActiveUlidToken | null {
  return ulidTokensKey.getState(state)?.active ?? null
}

function tokenAt(state: EditorState, test: (t: UlidToken) => boolean): UlidToken | undefined {
  return docUlidTokens(state.doc).find(test)
}

/** ←/→, with or without Shift: step over a token as over one character. */
function stepOver(view: EditorView, event: KeyboardEvent): boolean {
  const { state } = view
  const { selection } = state
  if (!event.shiftKey && !selection.empty) return false
  const head = selection.head
  const token =
    event.key === 'ArrowRight'
      ? tokenAt(state, (t) => t.from <= head && head < t.to)
      : tokenAt(state, (t) => t.from < head && head <= t.to)
  if (token === undefined) return false
  const to = event.key === 'ArrowRight' ? token.to : token.from
  const anchor = event.shiftKey ? selection.anchor : to
  view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, anchor, to)).scrollIntoView())
  return true
}

/** Backspace/Delete: a token beside the cursor goes whole, a split selection is clamped. */
function deleteWhole(view: EditorView, event: KeyboardEvent): boolean {
  const { state } = view
  const { selection } = state
  let range: { from: number; to: number } | undefined
  if (selection.empty) {
    const head = selection.head
    range =
      event.key === 'Backspace'
        ? tokenAt(state, (t) => t.from < head && head <= t.to)
        : tokenAt(state, (t) => t.from <= head && head < t.to)
  } else {
    const clamped = clampToTokens(state.doc, selection.from, selection.to)
    if (clamped.from === selection.from && clamped.to === selection.to) return false
    range = clamped
  }
  if (range === undefined) return false
  if (range.from < range.to) {
    view.dispatch(closeHistory(state.tr.delete(range.from, range.to)).scrollIntoView())
  }
  return true
}

function isPlain(event: KeyboardEvent): boolean {
  return !event.ctrlKey && !event.metaKey && !event.altKey
}

export const SourceBufferUlids = Extension.create({
  name: 'sourceBufferUlids',
  priority: 1000,
  addProseMirrorPlugins() {
    return [
      new Plugin<UlidTokensState>({
        key: ulidTokensKey,
        state: {
          init: (_, state) => build(state),
          apply: (tr, value, _old, state) =>
            tr.docChanged || tr.selectionSet || tr.getMeta(ulidTokensKey) !== undefined
              ? build(state)
              : value,
        },
        // Undo and redo put back what was, token or not.
        filterTransaction: (tr) => !tr.docChanged || isHistoryTransaction(tr) || !splitsToken(tr),
        props: {
          decorations: (state) => ulidTokensKey.getState(state)?.decorations,
          handleKeyDown(view, event) {
            if (event.isComposing) return false
            if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && isPlain(event)) {
              return stepOver(view, event)
            }
            if ((event.key === 'Backspace' || event.key === 'Delete') && !event.metaKey) {
              return deleteWhole(view, event)
            }
            return false
          },
          // Typing inside a token is refused; typed over a selection that
          // splits one, the text replaces only what the selection holds whole.
          handleTextInput(view, from, to, text) {
            const tokens = docUlidTokens(view.state.doc)
            if (!tokens.some((t) => splits(t, from, to))) return false
            if (from === to) return true
            const clamped = clampToTokens(view.state.doc, from, to)
            view.dispatch(view.state.tr.insertText(text, clamped.from, clamped.to))
            return true
          },
        },
        view(view) {
          let timer: ReturnType<typeof setTimeout> | null = null
          let destroyed = false
          const resolve = (): void => {
            timer = null
            resolveUlidTokens(docUlidTokens(view.state.doc)).catch((err: unknown) => {
              logger.warn('PageSourceBuffer', 'Failed to resolve ULID token titles', undefined, err)
            })
          }
          // A title that lands redraws the hints.
          const unsubscribe = useResolveStore.subscribe((s, prev) => {
            if (destroyed || s.version === prev.version) return
            view.dispatch(view.state.tr.setMeta(ulidTokensKey, 'titles'))
          })
          resolve()
          return {
            update(updated, prevState) {
              if (updated.state.doc === prevState.doc) return
              if (timer !== null) clearTimeout(timer)
              timer = setTimeout(resolve, RESOLVE_DELAY_MS)
            },
            destroy() {
              destroyed = true
              if (timer !== null) clearTimeout(timer)
              unsubscribe()
            },
          }
        },
      }),
    ]
  },
})
