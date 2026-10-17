/**
 * Page mode's tasks (#5743). A block's task state is the todo-state command's,
 * not the document's (#5691): the page store holds it, as it does for block
 * mode, and each block's node view draws block mode's own checkbox
 * (`BlockInlineControls`) from it, beside the editable text. The checkbox and
 * the `cycleTaskState` key (Ctrl+Enter) cycle it through the command, and a
 * change made elsewhere reaches the checkbox with the store's reload, never
 * through the document or its undo history. The checkbox follows the block's
 * id, so a split or a join that moves an id moves the checkbox with it.
 *
 * A task marker typed or pasted at the start of a block, `- [ ] ` or a bare
 * `[ ] ` (`[/]`, `[x]`, `[-]`), becomes the block's state once the caret has
 * left the block: block mode's own commit (`commitCheckboxState`) writes the
 * state, then the text without the marker. `TODO` stays a word, as in block
 * mode.
 */

import { type Editor, Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin } from '@tiptap/pm/state'
import type { NodeView } from '@tiptap/pm/view'
import { ReactRenderer } from '@tiptap/react'

import {
  BlockInlineControls,
  type BlockInlineControlsProps,
} from '@/components/editor/BlockInlineControls'
import { serialize } from '@/editor/markdown-serializer'
import { blockDocJson, PageBlock } from '@/editor/page-mode/page-document'
import type { PageSaveApi, PageSaveState } from '@/editor/page-mode/page-save'
import { blockIdOf } from '@/editor/token-ids'
import type { OpRef } from '@/lib/bindings'
import { processCheckboxSyntax } from '@/lib/block-utils'
import { matchesShortcutBinding } from '@/lib/keyboard-config'
import type { TodoState } from '@/lib/task-states'
import {
  bumpFlushSeq,
  commitCheckboxState,
  type PageBlockStoreLike,
} from '@/stores/inline-property-commit'

/** Where page mode reads and cycles block tasks: the page store and the todo-state command. */
export interface PageTaskSource {
  /** Block `id`'s task state, as the page store holds it. */
  stateOf: (id: string) => string | null
  /** Call `listener` on every change of the page store. */
  subscribe: (listener: () => void) => () => void
  /** Cycle block `id`'s task state, as block mode's checkbox does. */
  cycle: (id: string) => void
}

/**
 * A block as a node view: its text, and before it, outside the editable text,
 * block mode's checkbox while the block holds a task state.
 */
class PageBlockView implements NodeView {
  readonly dom = document.createElement('div')
  readonly contentDOM = document.createElement('div')
  private controls: HTMLElement | null = null
  private renderer: ReactRenderer<unknown, BlockInlineControlsProps> | null = null
  private shown: string | null = null
  private node: PMNode
  private readonly editor: Editor
  private readonly tasks: PageTaskSource
  private readonly unsubscribe: () => void

  constructor(
    node: PMNode,
    attributes: Record<string, unknown>,
    editor: Editor,
    tasks: PageTaskSource,
  ) {
    this.node = node
    this.editor = editor
    this.tasks = tasks
    this.dom.setAttribute('data-page-block', '')
    for (const [key, value] of Object.entries(attributes)) this.dom.setAttribute(key, String(value))
    this.contentDOM.className = 'page-block-content'
    this.dom.append(this.contentDOM)
    this.show()
    this.unsubscribe = tasks.subscribe(() => this.show())
  }

  /** Draw the state the store holds for the block, when it is not the one drawn. */
  private show(): void {
    const id = blockIdOf(this.node)
    const state = id === null ? null : this.tasks.stateOf(id)
    if (state === this.shown) return
    this.shown = state
    if (id === null || state === null) {
      this.renderer?.destroy()
      this.controls?.remove()
      this.renderer = null
      this.controls = null
      this.dom.removeAttribute('data-todo-state')
      return
    }
    this.dom.setAttribute('data-todo-state', state)
    const props = { blockId: id, todoState: state, onToggleTodo: this.tasks.cycle }
    if (this.renderer !== null) {
      this.renderer.updateProps(props)
      return
    }
    this.renderer = new ReactRenderer(BlockInlineControls, { editor: this.editor, props })
    this.controls = document.createElement('div')
    this.controls.contentEditable = 'false'
    this.controls.className = 'page-block-controls'
    this.controls.append(this.renderer.element)
    this.dom.prepend(this.controls)
  }

  /** A new id or depth draws the block anew: its attributes, and the checkbox of that id. */
  update(node: PMNode): boolean {
    if (
      node.type !== this.node.type ||
      blockIdOf(node) !== blockIdOf(this.node) ||
      node.attrs['depth'] !== this.node.attrs['depth']
    ) {
      return false
    }
    this.node = node
    return true
  }

  /** Only the text is the document's: the checkbox is redrawn by React, and added or removed here. */
  ignoreMutation(mutation: MutationRecord | { type: 'selection'; target: Node }): boolean {
    return mutation.type !== 'selection' && !this.contentDOM.contains(mutation.target)
  }

  /** The checkbox's own clicks and keys are its button's, not the editor's. */
  stopEvent(event: Event): boolean {
    return this.controls !== null && this.controls.contains(event.target as Node | null)
  }

  destroy(): void {
    this.unsubscribe()
    this.renderer?.destroy()
  }
}

/** `cycleTaskState` (Ctrl+Enter) cycles the task of the block the caret is in. */
const PageTaskKeys = Extension.create<{ tasks: PageTaskSource | null }>({
  name: 'pageTaskKeys',
  // Ahead of the hard break's own Mod-Enter.
  priority: 1000,
  addOptions() {
    return { tasks: null }
  },
  addProseMirrorPlugins() {
    const { tasks } = this.options
    return [
      new Plugin({
        props: {
          handleKeyDown(view, event) {
            if (tasks === null || !matchesShortcutBinding(event, 'cycleTaskState')) return false
            const { $head } = view.state.selection
            const id = $head.depth < 1 ? null : blockIdOf($head.node(1))
            if (id === null) return false
            tasks.cycle(id)
            return true
          },
        },
      }),
    ]
  },
})

/** Page mode's block, drawn with its task, and the key that cycles it. */
export function pageTasks(tasks: PageTaskSource) {
  return [
    PageBlock.extend({
      addNodeView:
        () =>
        ({ node, HTMLAttributes, editor }) =>
          new PageBlockView(node, HTMLAttributes, editor, tasks),
    }),
    PageTaskKeys.configure({ tasks }),
  ]
}

/**
 * The task marker block `node` starts with as text, and how many characters of
 * its first paragraph it takes: `processCheckboxSyntax`'s marker, or the bare
 * `[ ] ` block mode's input rule takes too (`checkbox-input-rule.ts`).
 */
export function leadingTask(node: PMNode): { todoState: TodoState; length: number } | null {
  const first = node.firstChild
  if (first?.type.name !== 'paragraph') return null
  // An inline node counts one character, as it takes one position.
  const text = first.textBetween(0, first.content.size, undefined, '￼')
  const typed = processCheckboxSyntax(text)
  const found = typed.todoState === null ? processCheckboxSyntax(`- ${text}`) : typed
  if (found.todoState === null) return null
  return { todoState: found.todoState, length: text.length - found.cleanContent.length }
}

/** `node` without the first `length` characters of its first paragraph. */
function withoutMarker(node: PMNode, length: number): PMNode {
  const first = node.firstChild as PMNode
  return node.copy(node.content.replaceChild(0, first.copy(first.content.cut(length))))
}

/**
 * Make the task marker block `id` holds as text, as last saved, its task
 * state, through block mode's commit: the state, then the text without the
 * marker. Resolves the edit's refs, and the block's text as it now stands.
 */
export async function commitPageTask(
  id: string,
  save: PageSaveState,
  api: PageSaveApi,
  pageStore: PageBlockStoreLike,
): Promise<{ refs: OpRef[]; markdown: string | undefined }> {
  const saved = save.saved.get(id)
  const node = saved?.node ?? null
  const task = node === null ? null : leadingTask(node)
  if (saved === undefined || node === null || task === null) {
    return { refs: [], markdown: saved?.markdown }
  }
  const refs: OpRef[] = []
  let markdown = saved.markdown
  await commitCheckboxState({
    blockId: id,
    content: saved.markdown,
    cleanContent: serialize(blockDocJson(withoutMarker(node, task.length))),
    todoState: task.todoState,
    mySeq: bumpFlushSeq(id),
    edit: async (_, text) => {
      // A refused state write keeps the text as it is saved: nothing to write.
      if (text === markdown) return true
      refs.push(...(await api.edit(id, text)))
      save.writes += 1
      markdown = text
      return true
    },
    pageStore,
    rootParentId: save.pageId,
  })
  return { refs, markdown }
}
