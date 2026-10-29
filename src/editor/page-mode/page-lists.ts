/**
 * Page mode's lists (#5743). A block's list style is its `listStyle`
 * property (`src/lib/list-style.ts`), as in block mode, not the document's:
 * page mode reads it with the page's properties (`readPageFit`) and again each
 * time it brings the page in. Each block's node view draws block mode's marker
 * outside the editable text (`page-tasks.ts`), a numbered block's ordinal
 * counted as block mode counts it (`computeListOrdinals`): its place in the
 * run of numbered siblings it is in.
 *
 * The keys are block mode's (#4552): `- ` or `1. ` typed at the start of a
 * block, then a character, makes it a bullet or numbered block and takes the
 * prefix out of the text; a `[` after the `- ` waits, so `- [ ] ` stays a task
 * marker. Enter on a list block gives the block it makes the same style, and
 * Enter on an empty one leaves the list instead; Backspace at a list block's
 * start takes its style off, and the next one joins it. A list block whose
 * text stops opening with a paragraph leaves the list (`leftTheirList`). A
 * style shows at once and is written through block mode's command after the
 * save, so a new block exists first (`setStyle`, `PageModeEditor`).
 *
 * A task is a list kind too (#5691 D3): a block holding a task state shows its
 * checkbox and no marker, whatever style it stores, and is numbered and keyed
 * as a plain block (`shownStyleOf`).
 *
 * Ctrl+Z here is the editor's history, which gives back text only. A style a
 * block's leaving its list took off comes back with the undo of that change
 * (#6156, `leave`, `undone`), and one an undo took off with the redo of that
 * undo (`leaveByUndo`): no other change brings it back.
 */

import { Extension, InputRule } from '@tiptap/core'
import { isHistoryTransaction, redoDepth, undoDepth } from '@tiptap/pm/history'
import type { Node as PMNode } from '@tiptap/pm/model'
import { type EditorState, Plugin } from '@tiptap/pm/state'

import { docShowsListMarker } from '@/editor/extensions/list-marker-decoration'
import { serialize } from '@/editor/markdown-serializer'
import { blockDocJson, depthOf, REMOTE_PATCH } from '@/editor/page-mode/page-document'
import { inOwnTextblock, pickerOpen, splitPageBlock } from '@/editor/page-mode/page-keys'
import { blockIdOf } from '@/editor/token-ids'
import type { PropertyRow } from '@/lib/bindings'
import { listMarkerText } from '@/lib/list-marker-glyph'
import { computeListOrdinals } from '@/lib/list-ordinals'
import { type ListStyle, listStyleFromRows, shownListStyle } from '@/lib/list-style'
import type { FlatBlock } from '@/lib/tree-utils'

/** A block in the page's order, and whether it shows a list marker (`docShowsListMarker`). */
type OutlineItem = Pick<FlatBlock, 'id' | 'depth'> & { marked: boolean }

const itemOf = (node: PMNode): OutlineItem => ({
  id: blockIdOf(node) ?? '',
  depth: depthOf(node),
  marked: docShowsListMarker(node),
})

/**
 * Where `doc` differs from `before`: nowhere (-1), inside one block alone (its
 * index), or past that (null). ProseMirror's diff passes an unchanged block by
 * identity, so a key typed costs no other block's `itemOf`; and it stops at a
 * block whose attributes differ, before it from the start and after it from
 * the end, so both ends fall in one block only when its content alone changed.
 */
function differsInside(before: PMNode, doc: PMNode): number | null {
  if (before.childCount !== doc.childCount) return null
  const start = doc.content.findDiffStart(before.content)
  const end = doc.content.findDiffEnd(before.content)
  if (start === null || end === null) return -1
  const index = doc.resolve(start).index(0)
  return index === doc.resolve(end.a).index(0) ? index : null
}

const sameItems = (a: readonly OutlineItem[], b: readonly OutlineItem[]): boolean =>
  a.length === b.length &&
  a.every(
    (item, i) => item.id === b[i]?.id && item.depth === b[i]?.depth && item.marked === b[i]?.marked,
  )

/** The page's list styles, as last read or as given since, and the marker each block shows. */
export class PageLists {
  private read = new Map<string, ListStyle>()
  /** Styles given here whose write has not settled, with the number of that write. */
  private readonly wanted = new Map<string, { style: ListStyle; seq: number }>()
  private seq = 0
  private items: OutlineItem[]
  /** The document `items` were taken from; none before the first `layout`. */
  private laidOut: PMNode | null = null
  private markers = new Map<string, string>()
  private readonly listeners = new Map<string, Set<() => void>>()
  /** The style each block last left its list with, and the editor's undo depth just after. */
  private readonly left = new Map<string, { style: ListStyle; depth: number }>()
  /** The style each block last left its list with in an undo, and the editor's redo depth just after. */
  private readonly leftByUndo = new Map<string, { style: ListStyle; depth: number }>()
  private readonly isTask: (id: string) => boolean

  /**
   * `blocks` are the page's blocks in order, as its document opens on them;
   * `isTask` says whether a block holds a task state, as the page store has it.
   */
  constructor(
    rows: Record<string, PropertyRow[]>,
    blocks: readonly Pick<FlatBlock, 'id' | 'depth'>[],
    isTask: (id: string) => boolean,
  ) {
    // Each shows its marker until `layout` reads the document.
    this.items = blocks.map(({ id, depth }) => ({ id, depth, marked: true }))
    this.isTask = isTask
    this.take(rows)
  }

  /** The style block `id` stores, or is given until that write settles. */
  styleOf(id: string): ListStyle {
    return this.wanted.get(id)?.style ?? this.read.get(id) ?? 'none'
  }

  /** The style block `id` shows: none while it is a task. */
  shownStyleOf(id: string): ListStyle {
    return shownListStyle(this.styleOf(id), this.isTask(id))
  }

  /** A block's task state may have changed: its marker and the numbering follow. */
  tasksChanged(): void {
    this.redraw()
  }

  /** The marker block `id` shows: `•`, `N.`, or nothing. */
  markerOf(id: string): string {
    return this.markers.get(id) ?? ''
  }

  /** Hold the styles a read of the page found. */
  take(rows: Record<string, PropertyRow[]>): void {
    this.read = new Map()
    for (const [id, list] of Object.entries(rows)) {
      const style = listStyleFromRows(list)
      if (style !== 'none') this.read.set(id, style)
    }
    this.redraw()
  }

  /** Show `style` on block `id` until its write settles; resolves that write's number. */
  want(id: string, style: ListStyle): number {
    this.seq += 1
    this.wanted.set(id, { style, seq: this.seq })
    this.redraw()
    return this.seq
  }

  /** Write `seq` on block `id` is done: `written` is the style it stored, null if none. */
  settle(id: string, seq: number, written: ListStyle | null): void {
    if (written === 'none') this.read.delete(id)
    else if (written !== null) this.read.set(id, written)
    if (this.wanted.get(id)?.seq === seq) this.wanted.delete(id)
    this.redraw()
  }

  /** Take the blocks' order, depths and kinds from `doc`: the ordinals follow them. */
  layout(doc: PMNode): void {
    const at = this.laidOut === null ? null : differsInside(this.laidOut, doc)
    this.laidOut = doc
    if (at === -1) return
    if (at === null) {
      const items: OutlineItem[] = []
      doc.forEach((node) => items.push(itemOf(node)))
      if (sameItems(items, this.items)) return
      this.items = items
    } else {
      // Its id and depth are attributes, alike in both: only whether it is marked can change.
      const item = itemOf(doc.child(at))
      if (item.marked === this.items[at]?.marked) return
      this.items = this.items.with(at, item)
    }
    this.redraw()
  }

  /** Block `id` leaves its list in a change that left the editor's undo depth at `depth`. */
  leave(id: string, depth: number): void {
    this.left.set(id, { style: this.styleOf(id), depth })
  }

  /** Block `id` leaves its list in an undo that left the editor's redo depth at `depth`. */
  leaveByUndo(id: string, depth: number): void {
    this.leftByUndo.set(id, { style: this.styleOf(id), depth })
  }

  /** The editor's redo history is gone: what its redos were to give back is not due. */
  forgetUndone(): void {
    this.leftByUndo.clear()
  }

  /**
   * The styles an undo or a redo from `before` to `doc`, now at undo depth
   * `undo` and redo depth `redo`, gives back: to each block that left its list
   * in the change an undo took back, or in the undo a redo took back, so it
   * shows a marker now where it showed none and stores no style. A block made a
   * task since gets none: a task shows no marker, and a style written would take
   * its task state off (#5691 D3). The depth names that change, but not alone,
   * as the history renumbers its events once it drops the oldest. What it was
   * due to give back is forgotten.
   */
  undone(before: PMNode, doc: PMNode, undo: number, redo: number): [string, ListStyle][] {
    const due = new Map<string, ListStyle>()
    const take = (held: Map<string, { style: ListStyle; depth: number }>, depth: number) => {
      for (const [id, left] of held) {
        if (left.depth !== depth + 1) continue
        due.set(id, left.style)
        held.delete(id)
      }
    }
    take(this.left, undo)
    take(this.leftByUndo, redo)
    const was = new Set<string>()
    before.forEach((node) => {
      const id = blockIdOf(node)
      if (id !== null && due.has(id) && docShowsListMarker(node)) was.add(id)
    })
    const back: [string, ListStyle][] = []
    doc.forEach((node) => {
      const id = blockIdOf(node)
      const style = id === null ? undefined : due.get(id)
      if (id === null || style === undefined || was.has(id) || this.styleOf(id) !== 'none') return
      if (docShowsListMarker(node) && !this.isTask(id)) back.push([id, style])
    })
    return back
  }

  /** Call `listener` when the marker block `id` shows changes. */
  subscribe(id: string, listener: () => void): () => void {
    let set = this.listeners.get(id)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(id, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(id)
    }
  }

  /** Work the markers out again, and tell the blocks whose marker changed. */
  private redraw(): void {
    // A block that shows no marker breaks a run of numbered siblings, as a plain one does.
    const unmarked = new Set(this.items.filter((item) => !item.marked).map((item) => item.id))
    const styleOf = (id: string): ListStyle => (unmarked.has(id) ? 'none' : this.shownStyleOf(id))
    const ordinals = computeListOrdinals(this.items, styleOf)
    const next = new Map<string, string>()
    for (const { id } of this.items) {
      const style = styleOf(id)
      if (style !== 'none') next.set(id, listMarkerText(style, ordinals.get(id)))
    }
    const changed = [...next]
      .filter(([id, text]) => this.markers.get(id) !== text)
      .map(([id]) => id)
    for (const id of this.markers.keys()) if (!next.has(id)) changed.push(id)
    this.markers = next
    for (const id of changed) for (const listener of this.listeners.get(id) ?? []) listener()
  }
}

/** Where page mode keeps list styles, and how it gives a block one. */
export interface PageListSource {
  lists: PageLists
  /** Give block `id` list style `style`: shown at once, written after the save. */
  setStyle: (id: string, style: ListStyle) => void
}

/** The block the selection starts in. */
function fromBlockId(state: EditorState): string | null {
  const { $from } = state.selection
  return $from.depth < 1 ? null : blockIdOf($from.node(1))
}

/** Every block id in `state`'s document. */
function idsIn(state: EditorState): Set<string> {
  const ids = new Set<string>()
  state.doc.forEach((node) => {
    const id = blockIdOf(node)
    if (id !== null) ids.add(id)
  })
  return ids
}

/**
 * The list blocks of `doc` whose text opened with a paragraph in `before` and
 * no longer does: a heading, a fence, a quote, a rule or a table typed, pasted
 * or picked there. A marker is only for a bullet or numbered block, so they
 * leave the list. A block whose text did not open with one keeps its style,
 * and a change brought in from elsewhere (`REMOTE_PATCH`) clears nothing.
 */
function leftTheirList(before: PMNode, doc: PMNode, lists: PageLists): string[] {
  const at = differsInside(before, doc)
  if (at === -1) return []
  if (at !== null) {
    const id = blockIdOf(doc.child(at))
    const left =
      id !== null &&
      lists.styleOf(id) !== 'none' &&
      !docShowsListMarker(doc.child(at)) &&
      docShowsListMarker(before.child(at))
    return left ? [id] : []
  }
  const left: string[] = []
  let shown: Map<string, boolean> | null = null
  doc.forEach((node) => {
    const id = blockIdOf(node)
    if (id === null || lists.styleOf(id) === 'none' || docShowsListMarker(node)) return
    if (shown === null) {
      const was = new Map<string, boolean>()
      before.forEach((old) => {
        const oldId = blockIdOf(old)
        if (oldId !== null) was.set(oldId, docShowsListMarker(old))
      })
      shown = was
    }
    if (shown.get(id) === true) left.push(id)
  })
  return left
}

// Configured only through `pageListKeys`, so `source` is always set.
const PageListKeys = Extension.create<{ source: PageListSource }, { depth: number }>({
  name: 'pageListKeys',
  // Ahead of page mode's own Enter and Backspace (`PageKeys`).
  priority: 1001,
  addKeyboardShortcuts() {
    const { source } = this.options
    const { editor } = this
    return {
      Enter: () => {
        const { state, view } = editor
        const id = fromBlockId(state)
        if (pickerOpen(state) || id === null) return false
        const style = source.lists.shownStyleOf(id)
        if (style === 'none') return false
        // An empty list block leaves the list, as block mode's Enter does.
        if (serialize(blockDocJson(state.selection.$from.node(1))).trim() === '') {
          source.setStyle(id, 'none')
          return true
        }
        const before = idsIn(state)
        if (!splitPageBlock(state, view.dispatch, view)) return false
        // The block the split made continues the list: the one whose id is new.
        const made = [...idsIn(editor.state)].find((other) => !before.has(other))
        if (made !== undefined) source.setStyle(made, style)
        return true
      },
      Backspace: () => {
        const { state } = editor
        const { $from, empty } = state.selection
        if (pickerOpen(state) || !empty || !inOwnTextblock($from)) return false
        if ($from.parentOffset !== 0 || $from.index(1) !== 0) return false
        const id = blockIdOf($from.node(1))
        if (id === null || source.lists.shownStyleOf(id) === 'none') return false
        source.setStyle(id, 'none')
        return true
      },
    }
  },
  addInputRules() {
    const { source } = this.options
    // Block mode's `- ` and `1. ` (the stock list rules), then the character
    // its `ListStyleInputRule` waits for: a bullet's not `[`, a checkbox's start.
    // Not `\n` either: TipTap runs the rules on Enter with that text.
    const rule = (find: RegExp, style: ListStyle) =>
      new InputRule({
        find,
        // Backspace after it deletes the character typed, rather than giving the prefix back.
        undoable: false,
        handler: ({ state, range, match }) => {
          const { $from } = state.selection
          const id = $from.depth === 2 ? blockIdOf($from.node(1)) : null
          if (id === null || $from.parent.type.name !== 'paragraph' || $from.index(1) !== 0) {
            return null
          }
          state.tr.insertText(match[1] ?? '', range.from, range.to)
          source.setStyle(id, style)
          return undefined
        },
      })
    return [rule(/^\s*[-+*]\s([^[\n])$/, 'bullet'), rule(/^\d+\.\s(.)$/, 'ordered')]
  },
  addStorage: () => ({ depth: 0 }),
  onTransaction({ editor, transaction }) {
    if (!transaction.docChanged || transaction.getMeta(REMOTE_PATCH) === true) return
    const { source } = this.options
    const { state } = editor
    const depth = undoDepth(state)
    const history = isHistoryTransaction(transaction)
    // An undo that leaves a list took back a change that gave the list: its redo gives it again.
    const undoing = history && depth < this.storage.depth
    this.storage.depth = depth
    const redo = redoDepth(state)
    if (!history && redo === 0) source.lists.forgetUndone()
    for (const id of leftTheirList(transaction.before, state.doc, source.lists)) {
      if (undoing) source.lists.leaveByUndo(id, redo)
      else source.lists.leave(id, depth)
      source.setStyle(id, 'none')
    }
    // Only an undo or a redo can give a style back: a key typed does no more here.
    if (!history) return
    for (const [id, style] of source.lists.undone(transaction.before, state.doc, depth, redo)) {
      source.setStyle(id, style)
    }
  },
  addProseMirrorPlugins() {
    const { source } = this.options
    return [
      new Plugin({
        view: (view) => {
          source.lists.layout(view.state.doc)
          return {
            update: (next, previous) => {
              if (next.state.doc !== previous.doc) source.lists.layout(next.state.doc)
            },
          }
        },
      }),
    ]
  },
})

/** Page mode's list keys and input rules, on `source`'s list styles. */
export function pageListKeys(source: PageListSource) {
  return PageListKeys.configure({ source })
}
