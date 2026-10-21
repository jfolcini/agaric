/**
 * Shared fixtures for page mode's tests (#5691): a real TipTap editor over page
 * mode's extensions, readers for its blocks, and `FakeBackend`, an in-memory
 * stand-in for the block commands with the backend's semantics: a sibling slot
 * counts live children only, a delete soft-deletes the live subtree under one
 * `deleted_at`, a restore needs that `deleted_at` and brings back its cohort
 * and any deleted ancestors, and a create refuses an id that exists, deleted
 * or not.
 */

import { Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'

import { serialize } from '@/editor/markdown-serializer'
import { blockDocJson, depthOf, pageDocContent } from '@/editor/page-mode/page-document'
import type { PageListSource } from '@/editor/page-mode/page-lists'
import { pageModeExtensions } from '@/editor/page-mode/page-mode-extensions'
import type { PageSaveApi, TreeRow } from '@/editor/page-mode/page-save'
import type { PageTaskSource } from '@/editor/page-mode/page-tasks'
import { blockIdOf } from '@/editor/token-ids'
import type { OpRef } from '@/lib/bindings'

export const PAGE = '01PAGE0000000000000000000P'

/** A block as `[id, depth, markdown]`. */
export type Row = [id: string, depth: number, markdown: string]

/** `01J…` ids for seeded blocks: `blockId(3)`. */
export function blockId(n: number): string {
  return `01J${String(n).padStart(23, '0')}`
}

/** A minter of fresh, ordered ids, distinct from `blockId`'s and from another prefix's. */
export function idMinter(prefix = '01NEW'): () => string {
  let next = 0
  return () => `${prefix}${String((next += 1)).padStart(26 - prefix.length, '0')}`
}

const noPickerItems = () => Promise.resolve([])

export function openPage(
  rows: readonly Row[],
  mintId: () => string = idMinter(),
  onCreateTag: (name: string) => Promise<string> = () => Promise.resolve(''),
  lists?: PageListSource,
  tasks?: PageTaskSource,
  /** The page whose saved collapse layout it opens with and writes. */
  pageId?: string,
): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: pageModeExtensions({
      resolveTagName: (id) => `#${id}`,
      resolveBlockTitle: (id) => id,
      resolveBlockStatus: () => 'active',
      resolveTagStatus: () => 'active',
      searchTags: noPickerItems,
      searchPages: noPickerItems,
      searchBlockRefs: noPickerItems,
      onCreatePage: () => Promise.resolve(''),
      onCreateTag,
      onNavigate: () => {},
      onTagClick: () => {},
      placeholder: '',
      mintId,
      ...(lists === undefined ? {} : { lists }),
      ...(tasks === undefined ? {} : { tasks }),
      ...(pageId === undefined ? {} : { pageId }),
    }),
    content: pageDocContent(
      rows.map(([id, depth, content]) => ({ id, depth, content })),
      mintId,
    ),
  })
}

export function markdownOf(node: PMNode): string {
  return serialize(blockDocJson(node))
}

export function rowsOf(doc: PMNode): Row[] {
  const rows: Row[] = []
  doc.forEach((node) => rows.push([blockIdOf(node) ?? '', depthOf(node), markdownOf(node)]))
  return rows
}

export function idsOf(doc: PMNode): string[] {
  return rowsOf(doc).map(([id]) => id)
}

/** The page's rows as the store holds them: parent ids from depths, in order. */
export function treeRows(rows: readonly Row[], pageId = PAGE): TreeRow[] {
  const atDepth: string[] = []
  return rows.map(([id, depth, content]) => {
    atDepth[depth] = id
    return { id, parent_id: depth === 0 ? pageId : (atDepth[depth - 1] as string), content }
  })
}

/** The position `offset` characters into the first textblock of block `index`. */
export function posIn(editor: Editor, index: number, offset: number): number {
  let pos = 0
  for (let i = 0; i < index; i += 1) pos += editor.state.doc.child(i).nodeSize
  // The block's own position, then into its first child, then into that textblock.
  return pos + 2 + offset
}

export function caret(editor: Editor, index: number, offset: number): void {
  editor.commands.setTextSelection(posIn(editor, index, offset))
}

/** Press `key`; true when the editor took it, so the browser does not act on it. */
export function press(editor: Editor, key: string, init: KeyboardEventInit = {}): boolean {
  return (
    editor.view.someProp('handleKeyDown', (f) =>
      f(editor.view, new KeyboardEvent('keydown', { key, ...init })),
    ) ?? false
  )
}

/** Type `text` at the cursor as the keyboard does, input rules included. */
export function type(editor: Editor, text: string): void {
  for (const ch of text) {
    const { from, to } = editor.state.selection
    const insert = () => editor.state.tr.insertText(ch, from, to)
    const handled = editor.view.someProp('handleTextInput', (f) =>
      f(editor.view, from, to, ch, insert),
    )
    if (handled !== true) editor.view.dispatch(insert())
  }
}

interface FakeBlock {
  id: string
  parentId: string
  content: string
  deletedAt: number | null
}

export type ApiKind = 'create' | 'restore' | 'move' | 'edit' | 'delete'

export class FakeBackend implements PageSaveApi {
  readonly pageId: string
  readonly blocks = new Map<string, FakeBlock>()
  /** Every child, deleted ones too, in sibling order by parent. */
  private readonly order = new Map<string, string[]>()
  readonly calls: string[] = []
  /** Throws for the calls it returns true for, as a refused command would. */
  failing: ((kind: ApiKind, id: string) => boolean) | null = null
  private clock = 0
  private seq = 0

  constructor(rows: readonly Row[], pageId = PAGE) {
    this.pageId = pageId
    for (const row of treeRows(rows, pageId)) {
      this.blocks.set(row.id, {
        id: row.id,
        parentId: row.parent_id ?? pageId,
        content: row.content ?? '',
        deletedAt: null,
      })
      this.siblings(row.parent_id ?? pageId).push(row.id)
    }
  }

  private siblings(parentId: string): string[] {
    let list = this.order.get(parentId)
    if (list === undefined) {
      list = []
      this.order.set(parentId, list)
    }
    return list
  }

  private isLive(id: string): boolean {
    return id === this.pageId || this.blocks.get(id)?.deletedAt === null
  }

  private liveChildren(parentId: string): string[] {
    return this.siblings(parentId).filter((id) => this.isLive(id))
  }

  private check(kind: ApiKind, id: string): void {
    this.calls.push(`${kind} ${id}`)
    if (this.failing?.(kind, id) === true) throw new Error(`refused: ${kind} ${id}`)
  }

  private ref(): OpRef[] {
    this.seq += 1
    return [{ device_id: 'fake', seq: this.seq }]
  }

  private place(parentId: string, id: string, index: number): void {
    const all = this.siblings(parentId)
    const live = this.liveChildren(parentId)
    const before = live[index]
    if (before === undefined) {
      const last = live.at(-1)
      all.splice(last === undefined ? all.length : all.indexOf(last) + 1, 0, id)
    } else {
      all.splice(all.indexOf(before), 0, id)
    }
  }

  private subtree(id: string, keep: (block: FakeBlock) => boolean): string[] {
    const out = [id]
    for (let i = 0; i < out.length; i += 1) {
      for (const child of this.siblings(out[i] as string)) {
        const block = this.blocks.get(child)
        if (block !== undefined && keep(block)) out.push(child)
      }
    }
    return out
  }

  create = (id: string, parentId: string, index: number, markdown: string): Promise<OpRef[]> => {
    this.check('create', id)
    if (this.blocks.has(id)) throw new Error(`create: block ${id} already exists`)
    if (!this.isLive(parentId)) throw new Error(`create: parent ${parentId} is not live`)
    this.blocks.set(id, { id, parentId, content: markdown, deletedAt: null })
    this.place(parentId, id, index)
    return Promise.resolve(this.ref())
  }

  move = (id: string, parentId: string, index: number): Promise<OpRef[]> => {
    this.check('move', id)
    const block = this.blocks.get(id)
    if (block === undefined || !this.isLive(id)) throw new Error(`move: ${id} is not live`)
    if (!this.isLive(parentId)) throw new Error(`move: parent ${parentId} is not live`)
    if (this.subtree(id, () => true).includes(parentId)) throw new Error('move: cycle')
    const old = this.siblings(block.parentId)
    old.splice(old.indexOf(id), 1)
    block.parentId = parentId
    this.place(parentId, id, index)
    return Promise.resolve(this.ref())
  }

  edit = (id: string, markdown: string): Promise<OpRef[]> => {
    this.check('edit', id)
    const block = this.blocks.get(id)
    if (block === undefined || !this.isLive(id)) throw new Error(`edit: ${id} is not live`)
    block.content = markdown
    return Promise.resolve(this.ref())
  }

  remove = (id: string): Promise<{ deletedAt: number; refs: OpRef[] }> => {
    this.check('delete', id)
    if (!this.isLive(id)) throw new Error(`delete: ${id} is not live`)
    this.clock += 1
    for (const member of this.subtree(id, (block) => block.deletedAt === null)) {
      ;(this.blocks.get(member) as FakeBlock).deletedAt = this.clock
    }
    return Promise.resolve({ deletedAt: this.clock, refs: this.ref() })
  }

  restore = (id: string, deletedAt: number): Promise<void> => {
    this.check('restore', id)
    const block = this.blocks.get(id)
    if (block?.deletedAt !== deletedAt)
      throw new Error(`restore: ${id} is not deleted at ${deletedAt}`)
    for (const member of this.subtree(id, (b) => b.deletedAt === deletedAt)) {
      ;(this.blocks.get(member) as FakeBlock).deletedAt = null
    }
    for (let up = this.blocks.get(block.parentId); up?.deletedAt != null;) {
      up.deletedAt = null
      up = this.blocks.get(up.parentId)
    }
    return Promise.resolve()
  }

  tree = (): Promise<TreeRow[]> => {
    this.calls.push('tree')
    return Promise.resolve(
      this.live().map(([id, , content]) => {
        const { parentId } = this.blocks.get(id) as FakeBlock
        return { id, parent_id: parentId, content }
      }),
    )
  }

  /** The live page, parents first and siblings in order, as rows. */
  live(): Row[] {
    const rows: Row[] = []
    const walk = (parentId: string, depth: number): void => {
      for (const id of this.liveChildren(parentId)) {
        rows.push([id, depth, (this.blocks.get(id) as FakeBlock).content])
        walk(id, depth + 1)
      }
    }
    walk(this.pageId, 0)
    return rows
  }

  /** Clear the call log. */
  reset(): void {
    this.calls.length = 0
    this.failing = null
  }
}
