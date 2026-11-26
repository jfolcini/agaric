/**
 * Page mode's collapse (#5691): a collapsed block hides the deeper blocks that
 * follow it, as block mode's tree hides its children, and a collapsed heading
 * its section too (`section-fold.ts`, #7040). Which blocks are
 * collapsed is block mode's own layout, per page and device
 * (`loadCollapsedIds`, `saveCollapsedIds`), so both modes show the same; it is
 * no part of the document, so no save and no undo touches it.
 *
 * The caret's block is never hidden: a collapsed block above it shows what it
 * hides until the caret leaves, without that being saved, as block mode shows
 * the block it focuses (#4002). A split of a collapsed block (Enter, a paste
 * of blocks) puts the blocks it makes after what the collapsed block hides
 * (`keepHidden`), as block mode's new blocks go after its children; a split of
 * a collapsed heading expands it instead, so the new block opens its section.
 *
 * Each block with blocks under it carries a node decoration saying whether it
 * is collapsed, which its node view draws as its chevron (`foldIn`), and each
 * hidden block one that hides it. They are worked out again only when blocks or
 * the layout change (`changesBlocks`), or the reveal does; typing maps them.
 */

import { Extension } from '@tiptap/core'
import type { Node as PMNode, NodeType } from '@tiptap/pm/model'
import {
  type Command,
  type EditorState,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

import {
  loadCollapsedIds,
  sameIds,
  saveCollapsedIds,
} from '@/components/block-tree/use-block-collapse'
import { changesBlocks } from '@/editor/page-mode/page-block-ids'
import {
  blockIndex,
  depthOf,
  firstTokenPos,
  PAGE_BLOCK,
  startOf,
  subtreeEnd,
} from '@/editor/page-mode/page-document'
import { blockIdOf } from '@/editor/token-ids'
import { matchesShortcutBinding } from '@/lib/keyboard-config'
import { canFold, foldEnd, foldsOver, hiddenRows, type Outline } from '@/lib/section-fold'

/** A block with blocks under it: collapsed, or not. */
export type Fold = 'collapsed' | 'expanded'

/** The class a hidden block wears (`index.css`). */
export const HIDDEN_CLASS = 'page-block-hidden'

const NONE: ReadonlySet<string> = new Set()

interface CollapseState {
  /** The saved layout: block mode's. */
  collapsed: ReadonlySet<string>
  /** The collapsed blocks above the caret's, shown until it leaves them; never saved. */
  revealed: ReadonlySet<string>
  /** The blocks hidden now. */
  hidden: ReadonlySet<string>
  decorations: DecorationSet
}

export const pageCollapseKey = new PluginKey<CollapseState>('pageCollapse')

/** The meta that expands the block it names, whether it is revealed for the caret or not. */
const EXPAND = 'pageCollapseExpand'

// A block's id is null only inside the transaction that made the block, until
// the id rules mint one (`page-block-ids.ts`); as an id it matches nothing.
const idOf = (node: PMNode): string => blockIdOf(node) as string

/** The index of the block the caret is in; none for a selection of whole blocks. */
function caretIndex(state: EditorState): number | null {
  const { $head } = state.selection
  return $head.depth < 1 ? null : $head.index(0)
}

/** The level of the heading block `node` opens with; null for any other block. */
function headingLevelOf(node: PMNode): number | null {
  const first = node.firstChild
  return first?.type.name === 'heading' ? (first.attrs['level'] as number) : null
}

/** The document's blocks as an outline (`section-fold.ts`). */
function outlineOf(doc: PMNode): Outline {
  return {
    length: doc.childCount,
    depth: (index) => depthOf(doc.child(index)),
    level: (index) => headingLevelOf(doc.child(index)),
  }
}

/** The blocks of `collapsed` whose folds hold the block at `index`. */
function collapsedAbove(doc: PMNode, index: number, collapsed: ReadonlySet<string>): Set<string> {
  const folded: number[] = []
  doc.forEach((node, _pos, i) => {
    if (i < index && collapsed.has(idOf(node))) folded.push(i)
  })
  return new Set(foldsOver(outlineOf(doc), index, folded).map((i) => idOf(doc.child(i))))
}

/** What `collapsed`, less `revealed`, hides of `doc`, and each block's chevron. */
function layout(
  doc: PMNode,
  collapsed: ReadonlySet<string>,
  revealed: ReadonlySet<string>,
): Pick<CollapseState, 'hidden' | 'decorations'> {
  const outline = outlineOf(doc)
  const folded = (index: number): boolean => {
    const id = idOf(doc.child(index))
    return collapsed.has(id) && !revealed.has(id) && canFold(outline, index)
  }
  const hiddenAt = hiddenRows(outline, folded)
  const hidden = new Set<string>()
  const decorations: Decoration[] = []
  doc.forEach((node, pos, index) => {
    const end = pos + node.nodeSize
    if (hiddenAt[index]) {
      hidden.add(idOf(node))
      decorations.push(Decoration.node(pos, end, { class: HIDDEN_CLASS }))
    }
    if (!canFold(outline, index)) return
    const fold: Fold = folded(index) ? 'collapsed' : 'expanded'
    decorations.push(Decoration.node(pos, end, {}, { pageFold: fold }))
  })
  return { hidden, decorations: DecorationSet.create(doc, decorations) }
}

// Every page-mode editor has the plugin (`pageModeExtensions`).
const stateOf = (state: EditorState): CollapseState =>
  pageCollapseKey.getState(state) as CollapseState

/** Whether block `id` is collapsed now: saved so, and not shown for the caret. */
export function isCollapsed(state: EditorState, id: string): boolean {
  const { collapsed, revealed } = stateOf(state)
  return collapsed.has(id) && !revealed.has(id)
}

/** The blocks a collapsed block hides now. */
export function hiddenBlocks(state: EditorState): ReadonlySet<string> {
  return stateOf(state).hidden
}

/** Whether `pos` is in a block a collapsed block hides now; never in block mode, which has no such plugin. */
export function isHiddenAt(state: EditorState, pos: number): boolean {
  const hidden = pageCollapseKey.getState(state)?.hidden
  const $pos = state.doc.resolve(pos)
  return hidden !== undefined && $pos.depth >= 1 && hidden.has(idOf($pos.node(1)))
}

/** The fold of the block at `index`: none for a block with nothing to fold. */
export function foldAt(state: EditorState, index: number): Fold | null {
  const { doc } = state
  if (!canFold(outlineOf(doc), index)) return null
  return isCollapsed(state, idOf(doc.child(index))) ? 'collapsed' : 'expanded'
}

/**
 * The index just past what a drag of the block at `index` carries: the blocks
 * under it, and a collapsed heading's section (#7040).
 */
export function carriedEnd(state: EditorState, index: number): number {
  const { doc } = state
  return foldAt(state, index) === 'collapsed'
    ? foldEnd(outlineOf(doc), index)
    : subtreeEnd(doc, index)
}

/** The fold of block `id`, for its block menu. */
export function foldOf(state: EditorState, id: string): Fold | null {
  const index = blockIndex(state.doc, id)
  return index === null ? null : foldAt(state, index)
}

/** A block's fold, from the decorations its node view is drawn with. */
export function foldIn(decorations: readonly Decoration[]): Fold | null {
  for (const { spec } of decorations) {
    const fold = (spec as { pageFold?: Fold }).pageFold
    if (fold !== undefined) return fold
  }
  return null
}

/**
 * Collapse block `id`, or expand it. A caret in what it is to hide goes to the
 * start of the block, as block mode takes the focus out first.
 */
export function toggleFold(id: string): Command {
  return (state, dispatch) => {
    const index = blockIndex(state.doc, id)
    if (index === null || foldAt(state, index) === null) return false
    if (dispatch) {
      const tr = state.tr.setMeta(pageCollapseKey, id)
      // A caret under the block shows it (the reveal): the block is expanded. None is past every block.
      const caret = caretIndex(state) ?? state.doc.childCount
      if (caret > index && caret < foldEnd(outlineOf(state.doc), index)) {
        const start = firstTokenPos(state.doc.child(index), startOf(state.doc, index))
        tr.setSelection(TextSelection.near(tr.doc.resolve(start)))
      }
      dispatch(tr)
    }
    return true
  }
}

function withId(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
  return ids.has(id) ? ids : new Set([...ids, id])
}

function withoutId(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(ids)
  next.delete(id)
  return next
}

/**
 * What a split of a collapsed block (Enter, a paste of blocks) leaves: the
 * blocks it made sit between the block and what it hides, which would then be
 * theirs, shown. Those go after what it hides, as block mode's new blocks go
 * after the children, and the cursor with them. Null where nothing came between.
 */
function keepHidden(before: EditorState, after: EditorState): Transaction | null {
  const index = caretIndex(before)
  if (index === null || foldAt(before, index) !== 'collapsed') return null
  const { doc } = after
  const id = idOf(before.doc.child(index))
  const head = blockIndex(doc, id)
  const first = blockIndex(doc, idOf(before.doc.child(index + 1)))
  if (head === null || first === null) return null
  const depth = depthOf(doc.child(head))
  // The blocks that came in under the block stay its, hidden with the rest.
  let made = head + 1
  while (made < first && depthOf(doc.child(made)) > depth) made += 1
  if (made === first) return null
  if (headingLevelOf(before.doc.child(index)) !== null) return after.tr.setMeta(EXPAND, id)
  let past = first
  while (past < doc.childCount && depthOf(doc.child(past)) > depth) past += 1
  const from = startOf(doc, made)
  const to = startOf(doc, first)
  const at = startOf(doc, past)
  // The new blocks move, never what it hides: an undo puts back what a step took out, which
  // would take back a peer's edit of a hidden block since (`remote-patch.ts`).
  const tr = after.tr.insert(at, doc.slice(from, to).content).delete(from, to)
  const { anchor, head: caret } = after.selection
  if (anchor >= from && caret <= to) {
    tr.setSelection(TextSelection.create(tr.doc, anchor + at - to, caret + at - to))
  }
  return tr
}

interface PageCollapseOptions {
  /** The page whose saved layout the document opens with and writes; null keeps it in memory. */
  pageId: string | null
}

export const PageCollapse = Extension.create<PageCollapseOptions>({
  name: 'pageCollapse',
  // After the id rules (`page-block-ids.ts`): `keepHidden` needs the blocks a split made to hold
  // their ids, and plugins run by priority, the last registered first among equals.
  priority: 90,
  addProseMirrorPlugins() {
    const { pageId } = this.options
    const type = this.editor.schema.nodes[PAGE_BLOCK] as NodeType
    return [
      new Plugin<CollapseState>({
        key: pageCollapseKey,
        state: {
          init: (_config, state) => {
            const collapsed = pageId === null ? NONE : loadCollapsedIds(pageId)
            const caret = caretIndex(state)
            const revealed = caret === null ? NONE : collapsedAbove(state.doc, caret, collapsed)
            return { collapsed, revealed, ...layout(state.doc, collapsed, revealed) }
          },
          apply: (tr, value, _old, state) => {
            const toggled = tr.getMeta(pageCollapseKey) as string | undefined
            const expanded = tr.getMeta(EXPAND) as string | undefined
            let { collapsed } = value
            if (toggled !== undefined) {
              collapsed =
                collapsed.has(toggled) && !value.revealed.has(toggled)
                  ? withoutId(collapsed, toggled)
                  : withId(collapsed, toggled)
            }
            if (expanded !== undefined) collapsed = withoutId(collapsed, expanded)
            const reshaped =
              toggled !== undefined ||
              expanded !== undefined ||
              (tr.docChanged && changesBlocks(tr, type))
            const caret = caretIndex(state)
            const revealed = caret === null ? NONE : collapsedAbove(state.doc, caret, collapsed)
            if (reshaped || !sameIds(revealed, value.revealed)) {
              return { collapsed, revealed, ...layout(state.doc, collapsed, revealed) }
            }
            return { ...value, decorations: value.decorations.map(tr.mapping, tr.doc) }
          },
        },
        appendTransaction: (_transactions, before, after) => keepHidden(before, after),
        view: () => ({
          update: (view, previous) => {
            const now = stateOf(view.state).collapsed
            if (pageId === null || now === stateOf(previous).collapsed) return
            const known = new Set<string>()
            view.state.doc.forEach((node) => known.add(idOf(node)))
            saveCollapsedIds(pageId, now, known)
          },
        }),
        props: {
          decorations: (state) => stateOf(state).decorations,
          // Block mode's `collapseExpand` (Ctrl+.), on the caret's block when it has blocks under it.
          handleKeyDown(view, event) {
            const caret = caretIndex(view.state)
            if (caret === null || !matchesShortcutBinding(event, 'collapseExpand')) return false
            return toggleFold(idOf(view.state.doc.child(caret)))(view.state, view.dispatch)
          },
        },
      }),
    ]
  },
})
