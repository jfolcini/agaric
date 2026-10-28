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
 * `ListMarkerDecoration` draws it, redrawn only when it changes. A query or
 * embed block draws block mode's `StaticBlock` after its text, the one or the
 * other shown as the caret is out of it or in it (`page-rendered.ts`). The checkbox
 * and the `cycleTaskState` key (Ctrl+Enter) cycle the state; the badge cycles the
 * priority and the `priority1`–`priority3` keys (Ctrl+Shift+1–3) set it; a
 * date chip opens block mode's date picker, and `openDatePicker`
 * (Ctrl+Shift+D) opens it to link a date at the caret; a property chip opens
 * block mode's property editor, and the `+N` pill and `openPropertiesDrawer`
 * (Ctrl+Shift+P) its property drawer, `openBlockHistory` (Ctrl+Shift+Y) its
 * history sheet, and a ref chip opens its target as a link chip does; the
 * attachment badge opens block mode's attachment list. A file pasted into a
 * block, or dropped on one, is attached to it as block mode attaches it: all
 * through block mode's commands. A
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
import type { Decoration, EditorView, NodeView } from '@tiptap/pm/view'
import { ReactRenderer } from '@tiptap/react'
import type React from 'react'

import {
  BlockInlineControls,
  type BlockInlineControlsProps,
} from '@/components/editor/BlockInlineControls'
import { StaticBlock, type StaticBlockProps } from '@/components/editor/StaticBlock'
import { docShowsListMarker } from '@/editor/extensions/list-marker-decoration'
import { serialize } from '@/editor/markdown-serializer'
import { isCurrentBlock } from '@/editor/page-mode/page-block-focus'
import { foldIn, toggleFold } from '@/editor/page-mode/page-collapse'
import { blockDocJson, PageBlock } from '@/editor/page-mode/page-document'
import { PageGutter } from '@/editor/page-mode/page-gutter'
import type { PageLists } from '@/editor/page-mode/page-lists'
import { RENDERED, renderedText } from '@/editor/page-mode/page-rendered'
import type { PageSaveApi, PageSaveState } from '@/editor/page-mode/page-save'
import {
  PageBlockMetadata,
  type PageBlockMetadataProps,
} from '@/editor/page-mode/PageBlockMetadata'
import { blockIdOf } from '@/editor/token-ids'
import { attachmentRowsEqual } from '@/hooks/useBatchAttachments'
import { arraysShallowEqual, type InlineProperty } from '@/hooks/useExtraBlockProperties'
import type { AttachmentRow, OpRef } from '@/lib/bindings'
import { INTERNAL_PROPERTY_KEYS, processCheckboxSyntax } from '@/lib/block-utils'
import { t } from '@/lib/i18n'
import { matchesShortcutBinding, tipTapShortcutMap } from '@/lib/keyboard-config'
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
  /** Open block mode's history sheet on block `id`. */
  openHistory: (id: string) => void
  /** A property editor, the drawer or the history sheet closed: read the page's properties again. */
  propertiesEdited: () => void
  /** An attachment was deleted, renamed or added: read the page's attachments again. */
  attachmentsChanged: () => void
  /** Attach `files` to block `id`, as block mode's paste and drop do. */
  attach: (id: string, files: File[]) => void
  /** Put the caret in block `id`'s text, as a click on block mode's static block edits it. */
  edit: (id: string) => void
  /** Write the expression block mode's query builder saved for block `id`; resolves whether it did. */
  saveQuery: (id: string, expression: string) => Promise<boolean>
}

/** Where page mode reads block tasks, and what it does to them. */
export interface PageTaskSource extends PageTaskActions {
  /** Block `id`'s row, as the page store holds it. */
  blockOf: (id: string) => FlatBlock | undefined
  /** Block `id`'s properties, as block mode's row draws them. */
  propertiesOf: (id: string) => InlineProperty[]
  /** Block `id`'s attachments. */
  attachmentsOf: (id: string) => AttachmentRow[]
  /** Call `listener` on every change of the page store, the properties or the attachments. */
  subscribe: (listener: () => void) => () => void
  /**
   * Where a ref property's chip, a query result or an embed's open-source goes:
   * block mode's chip navigation.
   */
  navigate: (id: string) => void
  /** Block mode's title for a block, as a query's results name it. */
  resolveBlockTitle: (id: string) => string
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
class Control<P extends BlockInlineControlsProps | PageBlockMetadataProps | StaticBlockProps> {
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
  properties: InlineProperty[]
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
 * block mode's chevron while blocks are under it (`page-gutter.ts`), and its
 * checkbox while the block holds a task state; after it a query's results or
 * an embed while its text is one (`page-rendered.ts`); and under it the
 * attachments, priority badge, date chips, repeat rule and property chips
 * while it holds any.
 */
class PageBlockView implements NodeView {
  readonly dom = document.createElement('div')
  readonly contentDOM = document.createElement('div')
  private readonly gutter = new PageGutter(this.dom, () => this.fold())
  private checkbox: Control<BlockInlineControlsProps> | null = null
  private rendered: Control<StaticBlockProps> | null = null
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
  private readonly lists: PageLists

  constructor(
    node: PMNode,
    attributes: Record<string, unknown>,
    decorations: readonly Decoration[],
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
    // The chevron shows on hovering the block, as block mode's row (`COLLAPSE_TOGGLE_HIDDEN_AT_REST`).
    this.dom.classList.add('group')
    this.contentDOM.className = 'page-block-content'
    this.dom.append(this.contentDOM)
    this.gutter.show(foldIn(decorations))
    this.show()
    this.showRendered(renderedText(node))
    this.unsubscribe = tasks.subscribe(() => this.show())
    const id = blockIdOf(node)
    this.lists = lists
    this.showMarker(this.listMarker())
    this.unsubscribeMarker =
      id === null ? () => {} : lists.subscribe(id, () => this.showMarker(this.listMarker()))
    this.gate.watch(this.dom, id, () => this.reveal())
  }

  /** The marker the block shows: its list style's, while its text opens with a paragraph. */
  private listMarker(): string {
    const id = blockIdOf(this.node)
    return id === null || !docShowsListMarker(this.node) ? '' : this.lists.markerOf(id)
  }

  /** Block mode's list marker, before the text on its first line; none for a plain block. */
  private showMarker(text: string): void {
    // Spaces list items closer than paragraphs (`index.css`).
    this.dom.toggleAttribute('data-list-item', text !== '')
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
    if (this.marker.textContent !== text) this.marker.textContent = text
  }

  /** Mount the controls, and from now on every control the block gains. */
  private reveal(): void {
    this.revealed = true
    this.checkbox?.mount()
    this.rendered?.mount()
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
      this.dom.insertBefore(checkbox.element, this.marker ?? this.contentDOM)
      if (this.revealed) checkbox.mount()
    } else {
      checkbox.update(props)
    }
    checkbox.label(t('block.todoCycleTip', { state }))
  }

  /** Block mode's static block for `text`, a query or an embed, after the editable text; none for null. */
  private showRendered(text: string | null): void {
    const id = blockIdOf(this.node)
    if (id === null || text === null) {
      this.rendered?.destroy()
      this.rendered = null
      this.dom.removeAttribute(RENDERED)
      return
    }
    const props: StaticBlockProps = {
      blockId: id,
      content: text,
      onFocus: this.tasks.edit,
      onNavigate: this.tasks.navigate,
      resolveBlockTitle: this.tasks.resolveBlockTitle,
      onSaveQuery: this.tasks.saveQuery,
    }
    let rendered = this.rendered
    if (rendered === null) {
      rendered = new Control(StaticBlock, props, this.editor, 'page-block-rendered')
      this.rendered = rendered
      this.contentDOM.after(rendered.element)
      if (this.revealed) rendered.mount()
    } else {
      rendered.update(props)
    }
    this.dom.setAttribute(RENDERED, '')
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
      onNavigate: this.tasks.navigate,
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

  /**
   * A new id or depth draws the block anew: its attributes, and the controls of
   * that id. A query's results or an embed follow the text only while the caret
   * is out of the block: while it is in, the text shows instead.
   */
  update(node: PMNode, decorations: readonly Decoration[]): boolean {
    if (
      node.type !== this.node.type ||
      blockIdOf(node) !== blockIdOf(this.node) ||
      node.attrs['depth'] !== this.node.attrs['depth']
    ) {
      return false
    }
    this.node = node
    this.gutter.show(foldIn(decorations))
    this.showMarker(this.listMarker())
    if (!isCurrentBlock(decorations)) this.showRendered(renderedText(node))
    return true
  }

  private fold(): void {
    toggleFold(blockIdOf(this.node) as string)(this.editor.state, this.editor.view.dispatch)
  }

  /** Only the text is the document's: the controls are redrawn by React, and added or removed here. */
  ignoreMutation(mutation: MutationRecord | { type: 'selection'; target: Node }): boolean {
    return mutation.type !== 'selection' && !this.contentDOM.contains(mutation.target)
  }

  /** The controls' own clicks and keys are their buttons', not the editor's. */
  stopEvent(event: Event): boolean {
    const target = event.target as Node | null
    return [this.gutter, this.checkbox, this.rendered, this.metadata].some(
      (control) => control?.element?.contains(target) === true,
    )
  }

  destroy(): void {
    this.unsubscribe()
    this.unsubscribeMarker()
    this.gate.unwatch(this.dom)
    this.checkbox?.destroy()
    this.rendered?.destroy()
    this.metadata?.destroy()
  }
}

/** The block the caret is in. */
export function caretBlockId(state: EditorState): string | null {
  const { $head } = state.selection
  return $head.depth < 1 ? null : blockIdOf($head.node(1))
}

/** The block under `event`'s pointer: ProseMirror calls the drop handler only once it has a position. */
function blockAtPointer(view: EditorView, event: MouseEvent): string | null {
  const at = view.posAtCoords({ left: event.clientX, top: event.clientY }) as { pos: number }
  const $at = view.state.doc.resolve(at.pos)
  return blockIdOf($at.depth >= 1 ? $at.node(1) : (($at.nodeAfter ?? $at.nodeBefore) as PMNode))
}

/**
 * The block a paste goes to: the caret's, or the first a selection of whole
 * blocks (Ctrl+A) holds, which starts before it.
 */
function pasteBlockId(state: EditorState): string | null {
  return caretBlockId(state) ?? blockIdOf(state.selection.$from.nodeAfter as PMNode)
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
// Configured only through `pageTasks`, so `tasks` is always set.
const PageTaskKeys = Extension.create<{ tasks: PageTaskSource }>({
  name: 'pageTaskKeys',
  // Ahead of the hard break's own Mod-Enter.
  priority: 1000,
  addKeyboardShortcuts() {
    const { tasks } = this.options
    const setPriority =
      (level: '1' | '2' | '3') =>
      ({ editor }: { editor: Editor }): boolean => {
        const id = caretBlockId(editor.state)
        if (id === null) return false
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
            if (id === null) return false
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
            if (matchesShortcutBinding(event, 'openBlockHistory')) {
              tasks.openHistory(id)
              return true
            }
            return false
          },
          // As block mode's: files win over any text the clipboard also holds.
          handlePaste(view, event) {
            const files = Array.from(event.clipboardData?.files ?? [])
            const id = files.length === 0 ? null : pasteBlockId(view.state)
            if (id === null) return false
            tasks.attach(id, files)
            return true
          },
          handleDrop(view, event) {
            const files = Array.from(event.dataTransfer?.files ?? [])
            const id = files.length === 0 ? null : blockAtPointer(view, event)
            if (id === null) return false
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
        ({ node, HTMLAttributes, decorations, editor }) =>
          new PageBlockView(node, HTMLAttributes, decorations, editor, tasks, lists),
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
