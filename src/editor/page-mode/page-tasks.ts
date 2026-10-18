/**
 * Page mode's tasks (#5743): a block's task state, priority and dates are the
 * block commands', not the document's (#5691). The page store holds them, as
 * it does for block mode, and each block's node view draws block mode's own
 * controls from it beside the editable text: the checkbox
 * (`BlockInlineControls`) before it, and the priority badge and the due and
 * scheduled chips (`BlockMetadataRow`) under it. The checkbox and the
 * `cycleTaskState` key (Ctrl+Enter) cycle the state, the badge cycles the
 * priority and the `priority1`–`priority3` keys (Ctrl+Shift+1–3) set it, a
 * chip opens block mode's date picker, and `openDatePicker` (Ctrl+Shift+D)
 * opens it to link a date at the caret, all through block mode's commands. A
 * change made elsewhere reaches the controls with the store's reload, never
 * through the document or its undo history. The controls follow the block's
 * id, so a split or a join that moves an id moves them with it.
 *
 * A task marker typed or pasted at the start of a block, `- [ ] ` or a bare
 * `[ ] ` (`[/]`, `[x]`, `[-]`), becomes the block's state once the caret has
 * left the block: block mode's own commit (`commitCheckboxState`) writes the
 * state, then the text without the marker. `TODO` stays a word, as in block
 * mode.
 */

import { type Editor, Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { type EditorState, Plugin } from '@tiptap/pm/state'
import type { NodeView } from '@tiptap/pm/view'
import { ReactRenderer } from '@tiptap/react'
import type React from 'react'

import {
  BlockInlineControls,
  type BlockInlineControlsProps,
  BlockMetadataRow,
  type BlockMetadataRowProps,
} from '@/components/editor/BlockInlineControls'
import { serialize } from '@/editor/markdown-serializer'
import { blockDocJson, PageBlock } from '@/editor/page-mode/page-document'
import type { PageSaveApi, PageSaveState } from '@/editor/page-mode/page-save'
import { blockIdOf } from '@/editor/token-ids'
import type { OpRef } from '@/lib/bindings'
import { processCheckboxSyntax } from '@/lib/block-utils'
import { matchesShortcutBinding, tipTapShortcutMap } from '@/lib/keyboard-config'
import type { TodoState } from '@/lib/task-states'
import type { FlatBlock } from '@/lib/tree-utils'
import {
  bumpFlushSeq,
  commitCheckboxState,
  type PageBlockStoreLike,
} from '@/stores/inline-property-commit'

/** What page mode does to a block's task, priority and dates: block mode's commands. */
export interface PageTaskActions {
  /** Cycle block `id`'s task state, as block mode's checkbox does. */
  cycle: (id: string) => void
  /** Cycle block `id`'s priority, as block mode's badge does. */
  cyclePriority: (id: string) => void
  /** Set block `id`'s priority, as block mode's priority keys do. */
  setPriority: (id: string, level: '1' | '2' | '3') => void
  /** Open block mode's date picker on block `id`'s due or scheduled date. */
  openDatePicker: (id: string, mode: 'due' | 'schedule') => void
  /** Open block mode's date picker to link a date's page at the caret. */
  openDateLinkPicker: () => void
}

/** Where page mode reads block tasks, and what it does to them. */
export interface PageTaskSource extends PageTaskActions {
  /** Block `id`'s row, as the page store holds it. */
  blockOf: (id: string) => FlatBlock | undefined
  /** Call `listener` on every change of the page store. */
  subscribe: (listener: () => void) => () => void
}

/** Block mode's component, mounted outside the block's editable text. */
class Control<P extends BlockInlineControlsProps | BlockMetadataRowProps> {
  readonly element = document.createElement('div')
  private readonly renderer: ReactRenderer<unknown, P>

  constructor(component: React.ComponentType<P>, props: P, editor: Editor, className: string) {
    this.renderer = new ReactRenderer(component, { editor, props })
    this.element.contentEditable = 'false'
    this.element.className = className
    this.element.append(this.renderer.element)
  }

  update(props: P): void {
    this.renderer.updateProps(props)
  }

  destroy(): void {
    this.renderer.destroy()
    this.element.remove()
  }
}

type Metadata = Pick<BlockMetadataRowProps, 'priority' | 'dueDate' | 'scheduledDate'>

const sameMetadata = (a: Metadata | null, b: Metadata): boolean =>
  a !== null &&
  a.priority === b.priority &&
  a.dueDate === b.dueDate &&
  a.scheduledDate === b.scheduledDate

/**
 * A block as a node view: its text; before it, outside the editable text,
 * block mode's checkbox while the block holds a task state; and under it the
 * priority badge and date chips while it holds any.
 */
class PageBlockView implements NodeView {
  readonly dom = document.createElement('div')
  readonly contentDOM = document.createElement('div')
  private checkbox: Control<BlockInlineControlsProps> | null = null
  private metadata: Control<BlockMetadataRowProps> | null = null
  private shownState: string | null = null
  private shownMetadata: Metadata | null = null
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

  /** Draw what the store holds for the block, where it is not what is drawn. */
  private show(): void {
    const id = blockIdOf(this.node)
    const block = id === null ? undefined : this.tasks.blockOf(id)
    this.showState(id, block?.todo_state ?? null)
    this.showMetadata(id, {
      priority: block?.priority ?? null,
      dueDate: block?.due_date ?? null,
      scheduledDate: block?.scheduled_date ?? null,
    })
  }

  private showState(id: string | null, state: string | null): void {
    if (state === this.shownState) return
    this.shownState = state
    if (id === null || state === null) {
      this.checkbox?.destroy()
      this.checkbox = null
      this.dom.removeAttribute('data-todo-state')
      return
    }
    this.dom.setAttribute('data-todo-state', state)
    const props = { blockId: id, todoState: state, onToggleTodo: this.tasks.cycle }
    if (this.checkbox !== null) {
      this.checkbox.update(props)
      return
    }
    this.checkbox = new Control(BlockInlineControls, props, this.editor, 'page-block-controls')
    this.dom.prepend(this.checkbox.element)
  }

  private showMetadata(id: string | null, metadata: Metadata): void {
    if (sameMetadata(this.shownMetadata, metadata)) return
    this.shownMetadata = metadata
    const { priority, dueDate, scheduledDate } = metadata
    if (id === null || (priority === null && dueDate === null && scheduledDate === null)) {
      this.metadata?.destroy()
      this.metadata = null
      return
    }
    // Block mode's row, without what page mode does not show yet: properties and attachments.
    const props: BlockMetadataRowProps = {
      blockId: id,
      ...metadata,
      onTogglePriority: this.tasks.cyclePriority,
      onOpenDatePicker: this.tasks.openDatePicker,
      filteredProperties: [],
      attachmentCount: 0,
      showAttachments: false,
      onToggleAttachments: () => {},
      onEditProp: () => {},
      onEditKey: () => {},
    }
    if (this.metadata !== null) {
      this.metadata.update(props)
      return
    }
    this.metadata = new Control(BlockMetadataRow, props, this.editor, 'page-block-metadata')
    this.dom.append(this.metadata.element)
  }

  /** A new id or depth draws the block anew: its attributes, and the controls of that id. */
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

  /** Only the text is the document's: the controls are redrawn by React, and added or removed here. */
  ignoreMutation(mutation: MutationRecord | { type: 'selection'; target: Node }): boolean {
    return mutation.type !== 'selection' && !this.contentDOM.contains(mutation.target)
  }

  /** The controls' own clicks and keys are their buttons', not the editor's. */
  stopEvent(event: Event): boolean {
    const target = event.target as Node | null
    return [this.checkbox, this.metadata].some((control) => control?.element.contains(target))
  }

  destroy(): void {
    this.unsubscribe()
    this.checkbox?.destroy()
    this.metadata?.destroy()
  }
}

/** The block the caret is in. */
function caretBlockId(state: EditorState): string | null {
  const { $head } = state.selection
  return $head.depth < 1 ? null : blockIdOf($head.node(1))
}

/**
 * Block mode's task keys, on the block the caret is in: `cycleTaskState`
 * (Ctrl+Enter) cycles its task, `priority1`–`priority3` (Ctrl+Shift+1–3) set
 * its priority, bound as block mode's `PriorityShortcuts` binds them, and
 * `openDatePicker` (Ctrl+Shift+D) opens the date picker to link a date at the
 * caret.
 */
const PageTaskKeys = Extension.create<{ tasks: PageTaskSource | null }>({
  name: 'pageTaskKeys',
  // Ahead of the hard break's own Mod-Enter.
  priority: 1000,
  addOptions() {
    return { tasks: null }
  },
  addKeyboardShortcuts() {
    const { tasks } = this.options
    const setPriority =
      (level: '1' | '2' | '3') =>
      ({ editor }: { editor: Editor }): boolean => {
        const id = caretBlockId(editor.state)
        if (tasks === null || id === null) return false
        tasks.setPriority(id, level)
        return true
      }
    return {
      ...tipTapShortcutMap('priority1', setPriority('1')),
      ...tipTapShortcutMap('priority2', setPriority('2')),
      ...tipTapShortcutMap('priority3', setPriority('3')),
    }
  },
  addProseMirrorPlugins() {
    const { tasks } = this.options
    return [
      new Plugin({
        props: {
          handleKeyDown(view, event) {
            const id = caretBlockId(view.state)
            if (tasks === null || id === null) return false
            if (matchesShortcutBinding(event, 'cycleTaskState')) {
              tasks.cycle(id)
              return true
            }
            if (matchesShortcutBinding(event, 'openDatePicker')) {
              tasks.openDateLinkPicker()
              return true
            }
            return false
          },
        },
      }),
    ]
  },
})

/** Page mode's block, drawn with its task, priority and dates, and the keys that set them. */
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
 * marker. Only a marker the edit typed counts: `loaded`, the block before it
 * was edited (none for a new block), holding one already keeps it text, as
 * block mode's `classifyUnmountFlush` does. Resolves the edit's refs, and the
 * block's text as it now stands.
 */
export async function commitPageTask(
  id: string,
  loaded: PMNode | null,
  save: PageSaveState,
  api: PageSaveApi,
  pageStore: PageBlockStoreLike,
): Promise<{ refs: OpRef[]; markdown: string | undefined }> {
  const saved = save.saved.get(id)
  const node = saved?.node ?? null
  const typed = loaded !== null && leadingTask(loaded) !== null
  const task = node === null || typed ? null : leadingTask(node)
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
