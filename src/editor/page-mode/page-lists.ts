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
 * start takes its style off, and the next one joins it. A style shows at once
 * and is written through block mode's command after the save, so a new block
 * exists first (`setStyle`, `PageModeEditor`).
 */

import { Extension, InputRule } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { type EditorState, Plugin } from '@tiptap/pm/state'

import { serialize } from '@/editor/markdown-serializer'
import { blockDocJson, depthOf } from '@/editor/page-mode/page-document'
import { inOwnTextblock, pickerOpen, splitPageBlock } from '@/editor/page-mode/page-keys'
import { blockIdOf } from '@/editor/token-ids'
import type { PropertyRow } from '@/lib/bindings'
import { listMarkerText } from '@/lib/list-marker-glyph'
import { computeListOrdinals } from '@/lib/list-ordinals'
import { type ListStyle, listStyleFromRows } from '@/lib/list-style'

interface Item {
  id: string
  depth: number
}

const sameItems = (a: readonly Item[], b: readonly Item[]): boolean =>
  a.length === b.length && a.every((item, i) => item.id === b[i]?.id && item.depth === b[i]?.depth)

/** The page's list styles, as last read or as given since, and the marker each block shows. */
export class PageLists {
  private read = new Map<string, ListStyle>()
  /** Styles given here whose write has not settled, with the number of that write. */
  private readonly wanted = new Map<string, { style: ListStyle; seq: number }>()
  private seq = 0
  private items: Item[]
  private markers = new Map<string, string>()
  private readonly listeners = new Map<string, Set<() => void>>()

  /** `blocks` are the page's blocks in order, as its document opens on them. */
  constructor(rows: Record<string, PropertyRow[]>, blocks: readonly Item[]) {
    this.items = blocks.map(({ id, depth }) => ({ id, depth }))
    this.take(rows)
  }

  styleOf(id: string): ListStyle {
    return this.wanted.get(id)?.style ?? this.read.get(id) ?? 'none'
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

  /** Take the blocks' order and depths from `doc`: the ordinals follow them. */
  layout(doc: PMNode): void {
    const items: Item[] = []
    doc.forEach((node) => items.push({ id: blockIdOf(node) ?? '', depth: depthOf(node) }))
    if (sameItems(items, this.items)) return
    this.items = items
    this.redraw()
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
    const styleOf = (id: string) => this.styleOf(id)
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

const PageListKeys = Extension.create<{ source: PageListSource | null }>({
  name: 'pageListKeys',
  // Ahead of page mode's own Enter and Backspace (`PageKeys`).
  priority: 1001,
  addOptions() {
    return { source: null }
  },
  addKeyboardShortcuts() {
    const { source } = this.options
    const { editor } = this
    if (source === null) return {}
    return {
      Enter: () => {
        const { state, view } = editor
        const id = fromBlockId(state)
        if (pickerOpen(state) || id === null) return false
        const style = source.lists.styleOf(id)
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
        if (id === null || source.lists.styleOf(id) === 'none') return false
        source.setStyle(id, 'none')
        return true
      },
    }
  },
  addInputRules() {
    const { source } = this.options
    if (source === null) return []
    // Block mode's `- ` and `1. ` (the stock list rules), then the character
    // its `ListStyleInputRule` waits for: a bullet's not `[`, a checkbox's start.
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
    return [rule(/^\s*[-+*]\s([^[])$/, 'bullet'), rule(/^\d+\.\s(.)$/, 'ordered')]
  },
  addProseMirrorPlugins() {
    const { source } = this.options
    if (source === null) return []
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
