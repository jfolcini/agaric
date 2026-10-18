/**
 * Page mode's tasks (#5743): a block's task state, priority, dates,
 * properties and attachments are the block commands', not the document's
 * (#5691). The page store holds the first three, as it does for block mode,
 * and page mode reads the properties and attachments with the page
 * (`page-properties.ts`, `page-attachments.ts`). Each block's node view draws
 * block mode's own controls from them beside the editable text: the checkbox
 * (`BlockInlineControls`) before it, and under it the attachments' previews,
 * then the priority badge, the due and scheduled chips, the repeat rule, the
 * property chips and the attachment badge (`BlockMetadataRow`, in
 * `PageBlockMetadata`). A bullet or numbered block's
 * marker (`page-lists.ts`) leads its first line, plain DOM as block mode's
 * `ListMarkerDecoration` draws it, redrawn only when it changes. The checkbox
 * and the `cycleTaskState` key (Ctrl+Enter) cycle the state; the badge cycles the
 * priority and the `priority1`–`priority3` keys (Ctrl+Shift+1–3) set it; a
 * date chip opens block mode's date picker, and `openDatePicker`
 * (Ctrl+Shift+D) opens it to link a date at the caret; a property chip opens
 * block mode's property editor, and the `+N` pill and `openPropertiesDrawer`
 * (Ctrl+Shift+P) its property drawer; the attachment badge opens block mode's
 * attachment list. A file pasted into a block, or dropped on one, is attached
 * to it as block mode attaches it: all through block mode's commands. A
 * change made elsewhere reaches the controls with the page's reload, never
 * through the document or its undo history. The controls follow the block's
 * id, so a split or a join that moves an id moves them with it.
 *
 * A block's controls mount the first time it comes within a screen of the
 * viewport or the caret enters it, and then stay (`ControlsGate`): mounting a
 * long page's all at once held the frame it opened in. Until then each
 * control's box is there, empty: the row's as tall as the row, so nothing moves
 * as it mounts, and the checkbox's naming the task state to assistive
 * technology.
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
import type { EditorView, NodeView } from '@tiptap/pm/view'
import { ReactRenderer } from '@tiptap/react'
import type React from 'react'

import {
  BlockInlineControls,
  type BlockInlineControlsProps,
} from '@/components/editor/BlockInlineControls'
import { serialize } from '@/editor/markdown-serializer'
import { blockDocJson, PageBlock } from '@/editor/page-mode/page-document'
import type { PageLists } from '@/editor/page-mode/page-lists'
import type { ShownProperty } from '@/editor/page-mode/page-properties'
import type { PageSaveApi, PageSaveState } from '@/editor/page-mode/page-save'
import {
  PageBlockMetadata,
  type PageBlockMetadataProps,
} from '@/editor/page-mode/PageBlockMetadata'
import { blockIdOf } from '@/editor/token-ids'
import { attachmentRowsEqual } from '@/hooks/useBatchAttachments'
import { arraysShallowEqual } from '@/hooks/useExtraBlockProperties'
import type { AttachmentRow, OpRef } from '@/lib/bindings'
import { INTERNAL_PROPERTY_KEYS, processCheckboxSyntax } from '@/lib/block-utils'
import { t } from '@/lib/i18n'
import { matchesShortcutBinding, tipTapShortcutMap } from '@/lib/keyboard-config'
import { notify } from '@/lib/notify'
import { scrollParentY } from '@/lib/scroll-parent'
import type { TodoState } from '@/lib/task-states'
import type { FlatBlock } from '@/lib/tree-utils'
import {
  bumpFlushSeq,
  commitCheckboxState,
  type PageBlockStoreLike,
} from '@/stores/inline-property-commit'

/** What page mode does to a block's task, priority, dates and properties: block mode's commands. */
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
  /** Open block mode's property drawer on block `id`. */
  openPropertyDrawer: (id: string) => void
  /** A property editor or the drawer closed: read the page's properties again. */
  propertiesEdited: () => void
  /** An attachment was deleted, renamed or added: read the page's attachments again. */
  attachmentsChanged: () => void
  /** Attach `files` to block `id`, as block mode's paste and drop do. */
  attach: (id: string, files: File[]) => void
}

/** Where page mode reads block tasks, and what it does to them. */
export interface PageTaskSource extends PageTaskActions {
  /** Block `id`'s row, as the page store holds it. */
  blockOf: (id: string) => FlatBlock | undefined
  /** Block `id`'s properties, as block mode's row draws them. */
  propertiesOf: (id: string) => ShownProperty[]
  /** Block `id`'s attachments. */
  attachmentsOf: (id: string) => AttachmentRow[]
  /** Call `listener` on every change of the page store, the properties or the attachments. */
  subscribe: (listener: () => void) => () => void
}

/**
 * When the blocks' controls mount: one `IntersectionObserver` per editor, whose
 * root is the scroller the page is in, mounts a block's the first time it
 * comes within a screen of the viewport. The caret's block mounts at once,
 * and so does a block drawn anew (a new depth) whose id has mounted before. A
 * runtime without the observer mounts everything.
 */
class ControlsGate {
  private readonly waiting = new Map<Element, () => void>()
  private readonly shown = new Set<string>()
  private observer: IntersectionObserver | null = null
  private readonly editor: Editor

  constructor(editor: Editor) {
    this.editor = editor
  }

  /** Call `reveal` once `dom`, block `id`'s, nears the viewport. */
  watch(dom: Element, id: string | null, reveal: () => void): void {
    if (typeof IntersectionObserver === 'undefined' || (id !== null && this.shown.has(id))) {
      reveal()
      return
    }
    this.waiting.set(dom, () => {
      if (id !== null) this.shown.add(id)
      reveal()
    })
    if (this.observer !== null) {
      this.observer.observe(dom)
      return
    }
    // Not before the editor is in the page: its scroller is the root.
    // `EditorContent` builds the node views again once it is.
    const host = this.editor.options.element
    if (!(host instanceof HTMLElement) || !host.isConnected) return
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) this.reveal(entry.target)
      },
      { root: scrollParentY(host), rootMargin: '100% 0px' },
    )
    for (const waiting of this.waiting.keys()) this.observer.observe(waiting)
  }

  reveal(dom: Node | null): void {
    if (!(dom instanceof Element)) return
    const reveal = this.waiting.get(dom)
    if (reveal === undefined) return
    this.unwatch(dom)
    reveal()
  }

  unwatch(dom: Element): void {
    this.waiting.delete(dom)
    this.observer?.unobserve(dom)
  }
}

const gates = new WeakMap<Editor, ControlsGate>()

function gateOf(editor: Editor): ControlsGate {
  let gate = gates.get(editor)
  if (gate === undefined) {
    gate = new ControlsGate(editor)
    gates.set(editor, gate)
  }
  return gate
}

/**
 * Block mode's component, outside the block's editable text: its box at
 * once, the component in it from `mount` on.
 */
class Control<P extends BlockInlineControlsProps | PageBlockMetadataProps> {
  readonly element = document.createElement('div')
  private renderer: ReactRenderer<unknown, P> | null = null
  private props: P
  private readonly component: React.ComponentType<P>
  private readonly editor: Editor

  constructor(component: React.ComponentType<P>, props: P, editor: Editor, className: string) {
    this.component = component
    this.props = props
    this.editor = editor
    this.element.contentEditable = 'false'
    this.element.className = className
  }

  /** What the empty box says to assistive technology, until the component says it. */
  label(text: string): void {
    if (this.renderer !== null) return
    this.element.setAttribute('role', 'img')
    this.element.setAttribute('aria-label', text)
  }

  mount(): void {
    if (this.renderer !== null) return
    this.renderer = new ReactRenderer(this.component, { editor: this.editor, props: this.props })
    this.element.removeAttribute('role')
    this.element.removeAttribute('aria-label')
    this.element.append(this.renderer.element)
  }

  update(props: P): void {
    this.props = props
    this.renderer?.updateProps(props)
  }

  destroy(): void {
    this.renderer?.destroy()
    this.element.remove()
  }
}

interface Metadata {
  priority: string | null
  dueDate: string | null
  scheduledDate: string | null
  properties: ShownProperty[]
  attachments: AttachmentRow[]
}

const sameMetadata = (a: Metadata | null, b: Metadata): boolean =>
  a !== null &&
  a.priority === b.priority &&
  a.dueDate === b.dueDate &&
  a.scheduledDate === b.scheduledDate &&
  arraysShallowEqual(a.properties, b.properties) &&
  attachmentRowsEqual(a.attachments, b.attachments)

/**
 * A block as a node view: its text; before it, outside the editable text,
 * block mode's checkbox while the block holds a task state; and under it the
 * attachments, priority badge, date chips, repeat rule and property chips
 * while it holds any.
 */
class PageBlockView implements NodeView {
  readonly dom = document.createElement('div')
  readonly contentDOM = document.createElement('div')
  private checkbox: Control<BlockInlineControlsProps> | null = null
  private metadata: Control<PageBlockMetadataProps> | null = null
  private marker: HTMLElement | null = null
  private shownState: string | null = null
  private shownMetadata: Metadata | null = null
  private revealed = false
  private node: PMNode
  private readonly editor: Editor
  private readonly tasks: PageTaskSource
  private readonly gate: ControlsGate
  private readonly unsubscribe: () => void
  private readonly unsubscribeMarker: () => void

  constructor(
    node: PMNode,
    attributes: Record<string, unknown>,
    editor: Editor,
    tasks: PageTaskSource,
    lists: PageLists,
  ) {
    this.node = node
    this.editor = editor
    this.tasks = tasks
    this.gate = gateOf(editor)
    this.dom.setAttribute('data-page-block', '')
    for (const [key, value] of Object.entries(attributes)) this.dom.setAttribute(key, String(value))
    this.contentDOM.className = 'page-block-content'
    this.dom.append(this.contentDOM)
    this.show()
    this.unsubscribe = tasks.subscribe(() => this.show())
    const id = blockIdOf(node)
    if (id === null) this.unsubscribeMarker = () => {}
    else {
      this.showMarker(lists.markerOf(id))
      this.unsubscribeMarker = lists.subscribe(id, () => this.showMarker(lists.markerOf(id)))
    }
    this.gate.watch(this.dom, id, () => this.reveal())
  }

  /** Block mode's list marker, before the text on its first line; none for a plain block. */
  private showMarker(text: string): void {
    if (text === '') {
      this.marker?.remove()
      this.marker = null
      return
    }
    if (this.marker === null) {
      this.marker = document.createElement('span')
      this.marker.className = 'list-marker'
      this.marker.contentEditable = 'false'
      this.marker.setAttribute('aria-hidden', 'true')
      this.marker.setAttribute('data-testid', 'list-marker')
      this.dom.insertBefore(this.marker, this.contentDOM)
    }
    this.marker.textContent = text
  }

  /** Mount the controls, and from now on every control the block gains. */
  private reveal(): void {
    this.revealed = true
    this.checkbox?.mount()
    this.metadata?.mount()
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
      properties: id === null ? [] : this.tasks.propertiesOf(id),
      attachments: id === null ? [] : this.tasks.attachmentsOf(id),
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
    const props: BlockInlineControlsProps = {
      blockId: id,
      todoState: state,
      onToggleTodo: this.tasks.cycle,
    }
    let checkbox = this.checkbox
    if (checkbox === null) {
      checkbox = new Control(BlockInlineControls, props, this.editor, 'page-block-controls')
      this.checkbox = checkbox
      this.dom.prepend(checkbox.element)
      if (this.revealed) checkbox.mount()
    } else {
      checkbox.update(props)
    }
    checkbox.label(t('block.todoCycleTip', { state }))
  }

  private showMetadata(id: string | null, metadata: Metadata): void {
    if (sameMetadata(this.shownMetadata, metadata)) return
    this.shownMetadata = metadata
    const { priority, dueDate, scheduledDate, properties, attachments } = metadata
    // As `SortableBlock` filters them: the repeat rule has its own chip, the rest are the app's.
    const filteredProperties = properties.filter(({ key }) => !INTERNAL_PROPERTY_KEYS.has(key))
    const repeats = properties.some(({ key }) => key === 'repeat')
    const drawn =
      priority !== null ||
      dueDate !== null ||
      scheduledDate !== null ||
      repeats ||
      filteredProperties.length > 0 ||
      attachments.length > 0
    if (id === null || !drawn) {
      this.metadata?.destroy()
      this.metadata = null
      return
    }
    const props: PageBlockMetadataProps = {
      blockId: id,
      priority,
      dueDate,
      scheduledDate,
      properties,
      filteredProperties,
      attachments,
      onTogglePriority: this.tasks.cyclePriority,
      onOpenDatePicker: this.tasks.openDatePicker,
      onShowProperties: this.tasks.openPropertyDrawer,
      onEdited: this.tasks.propertiesEdited,
      onAttachmentsChanged: this.tasks.attachmentsChanged,
    }
    let row = this.metadata
    if (row === null) {
      row = new Control(PageBlockMetadata, props, this.editor, 'page-block-metadata')
      this.metadata = row
      this.dom.append(row.element)
      if (this.revealed) row.mount()
    } else {
      row.update(props)
    }
    // The badge is the row's tallest, then a property chip: its empty box keeps that
    // height (`index.css`).
    row.element.toggleAttribute('data-priority', priority !== null)
    row.element.toggleAttribute('data-properties', filteredProperties.length > 0)
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
    this.unsubscribeMarker()
    this.gate.unwatch(this.dom)
    this.checkbox?.destroy()
    this.metadata?.destroy()
  }
}

/** The block the caret is in. */
function caretBlockId(state: EditorState): string | null {
  const { $head } = state.selection
  return $head.depth < 1 ? null : blockIdOf($head.node(1))
}

/** The block under `event`'s pointer: ProseMirror calls the drop handler only once it has a position. */
function blockAtPointer(view: EditorView, event: MouseEvent): string | null {
  const at = view.posAtCoords({ left: event.clientX, top: event.clientY }) as { pos: number }
  const $at = view.state.doc.resolve(at.pos)
  return blockIdOf($at.depth >= 1 ? $at.node(1) : (($at.nodeAfter ?? $at.nodeBefore) as PMNode))
}

/** The block a paste goes to: the caret's, or the first a selection between blocks (Ctrl+A) holds. */
function pasteBlockId(state: EditorState): string | null {
  const { $from } = state.selection
  const block = $from.depth >= 1 ? $from.node(1) : $from.nodeAfter
  return caretBlockId(state) ?? (block === null ? null : blockIdOf(block))
}

/**
 * Block mode's task keys, on the block the caret is in: `cycleTaskState`
 * (Ctrl+Enter) cycles its task, `priority1`–`priority3` (Ctrl+Shift+1–3) set
 * its priority, bound as block mode's `PriorityShortcuts` binds them,
 * `openDatePicker` (Ctrl+Shift+D) opens the date picker to link a date at the
 * caret, and `openPropertiesDrawer` (Ctrl+Shift+P) opens its property drawer.
 * Files pasted go to the caret's block, and files dropped to the block they
 * land on.
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
    const gate = gateOf(this.editor)
    return [
      new Plugin({
        // The caret's block shows its controls at once, which its keys change.
        view: () => ({
          update: (view) => {
            const { $head } = view.state.selection
            if ($head.depth >= 1) gate.reveal(view.nodeDOM($head.before(1)))
          },
        }),
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
            if (matchesShortcutBinding(event, 'openPropertiesDrawer')) {
              tasks.openPropertyDrawer(id)
              return true
            }
            return false
          },
          // As block mode's: files win over any text the clipboard also holds.
          handlePaste(view, event) {
            const files = Array.from(event.clipboardData?.files ?? [])
            if (tasks === null || files.length === 0) return false
            const id = pasteBlockId(view.state)
            // Taken either way: a file is never left to a text paste that drops it.
            if (id === null) notify.error(t('blockTree.attachFileFailed'))
            else tasks.attach(id, files)
            return true
          },
          handleDrop(view, event) {
            const files = Array.from(event.dataTransfer?.files ?? [])
            const id = files.length === 0 ? null : blockAtPointer(view, event)
            if (tasks === null || id === null) return false
            tasks.attach(id, files)
            return true
          },
        },
      }),
    ]
  },
})

/**
 * Page mode's block, drawn with its task, priority, dates, properties and
 * `lists`' marker, and the keys that set them.
 */
export function pageTasks(tasks: PageTaskSource, lists: PageLists) {
  return [
    PageBlock.extend({
      addNodeView:
        () =>
        ({ node, HTMLAttributes, editor }) =>
          new PageBlockView(node, HTMLAttributes, editor, tasks, lists),
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
