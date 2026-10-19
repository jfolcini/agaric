/**
 * Page mode's node view without `PageModeEditor` (#5915): a real editor over
 * page mode's extensions, mounted in `EditorContent` so its controls render,
 * fed by `FakeTasks`, an in-memory page store that redraws as the store does.
 * Also the mock backend's page seeding and `PageModeEditor`'s mount, for the
 * few behaviours that live in the editor's own wiring.
 */

import { act, render } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import { EditorContent } from '@tiptap/react'
import { createRef } from 'react'
import { vi } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import { idMinter, openPage, PAGE, type Row } from '@/editor/page-mode/__tests__/page-mode-fixtures'
import { PageAttachments } from '@/editor/page-mode/page-attachments'
import { PageLists } from '@/editor/page-mode/page-lists'
import type { PageTaskSource } from '@/editor/page-mode/page-tasks'
import { PageModeEditor, type PageModeEditorHandle } from '@/editor/page-mode/PageModeEditor'
import type { InlineProperty } from '@/hooks/useExtraBlockProperties'
import type { BlockRow } from '@/lib/bindings'
import type { NavigateToPageFn } from '@/lib/block-events'
import { t } from '@/lib/i18n'
import type { ListStyle } from '@/lib/list-style'
import { dispatch } from '@/lib/tauri-mock/handlers'
import type { FlatBlock } from '@/lib/tree-utils'
import { createPageBlockStore, PageBlockContext } from '@/stores/page-blocks'

export const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' } as const

const NEXT_STATE: Record<string, string | null> = { TODO: 'DOING', DOING: 'DONE', DONE: null }
const NEXT_PRIORITY: Record<string, string | null> = { '1': '2', '2': '3', '3': null }

/** The page store, properties and attachments the node view reads, as plain maps. */
export class FakeTasks implements PageTaskSource {
  readonly blocks = new Map<string, FlatBlock>()
  readonly properties = new Map<string, InlineProperty[]>()
  readonly attachments = new PageAttachments({})
  private readonly listeners = new Set<() => void>()

  constructor() {
    this.attachments.subscribe(() => this.changed())
  }

  /** Change block `id`'s row as the page store would, and tell the views. */
  setBlock(id: string, patch: Partial<FlatBlock>): void {
    this.blocks.set(id, makeBlock({ ...this.blocks.get(id), id, ...patch }))
    this.changed()
  }

  setProperties(id: string, properties: InlineProperty[]): void {
    this.properties.set(id, properties)
    this.changed()
  }

  changed(): void {
    for (const listener of this.listeners) listener()
  }

  listenerCount(): number {
    return this.listeners.size
  }

  blockOf = (id: string) => this.blocks.get(id)
  propertiesOf = (id: string) => this.properties.get(id) ?? []
  attachmentsOf = (id: string) => this.attachments.of(id)
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  cycle = vi.fn((id: string) => {
    this.setBlock(id, { todo_state: NEXT_STATE[this.blocks.get(id)?.todo_state ?? ''] ?? 'TODO' })
  })
  cyclePriority = vi.fn((id: string) => {
    this.setBlock(id, { priority: NEXT_PRIORITY[this.blocks.get(id)?.priority ?? ''] ?? '1' })
  })
  setPriority = vi.fn((id: string, level: '1' | '2' | '3') => {
    this.setBlock(id, { priority: level })
  })
  openDatePicker = vi.fn<(id: string, mode: 'due' | 'schedule') => void>()
  openDateLinkPicker = vi.fn<() => void>()
  openPropertyDrawer = vi.fn<(id: string) => void>()
  propertiesEdited = vi.fn<() => void>()
  attachmentsChanged = vi.fn<() => void>()
  attach = vi.fn<(id: string, files: File[]) => void>()
  edit = vi.fn<(id: string) => void>()
  saveQuery = vi.fn((_id: string, _expression: string) => Promise.resolve(true))
  navigate = vi.fn<(id: string) => void>()
  resolveBlockTitle = (id: string) => `title of ${id}`
}

/** `lists`, whose `setStyle` shows a style and settles its write at once, as a write that succeeds. */
export function listSource(lists: PageLists) {
  return {
    lists,
    setStyle: vi.fn((id: string, style: ListStyle) => {
      lists.settle(id, lists.want(id, style), style)
    }),
  }
}

/** `rows` in page mode's editor with `tasks`' controls and `lists`' markers, rendered. */
export function mountNodeViews(
  rows: readonly Row[],
  tasks: FakeTasks = new FakeTasks(),
  lists: PageLists = new PageLists(
    {},
    rows.map(([id, depth]) => ({ id, depth })),
  ),
) {
  const source = listSource(lists)
  const editor = openPage(rows, idMinter(), undefined, source, tasks)
  editor.setOptions({ editorProps: { attributes: { 'aria-label': t('pageMode.editorLabel') } } })
  const store = createPageBlockStore(PAGE)
  const view = render(
    <PageBlockContext.Provider value={store}>
      <div data-testid="scroller" style={{ overflowY: 'auto' }}>
        <EditorContent editor={editor} />
      </div>
    </PageBlockContext.Provider>,
  )
  return { ...view, editor, tasks, lists, setStyle: source.setStyle }
}

/** Block `id`'s view in `container`. */
export function blockEl(container: HTMLElement, id: string): HTMLElement {
  const found = container.querySelector(`[data-page-block-id="${id}"]`)
  if (!(found instanceof HTMLElement)) throw new Error(`no block ${id}`)
  return found
}

/** `selector` in `el`, now: a wait would turn a mutant's quick red into a timeout. */
export function getIn(el: HTMLElement, selector: string): HTMLElement {
  const found = el.querySelector(selector)
  if (!(found instanceof HTMLElement)) throw new Error(`no ${selector}`)
  return found
}

/**
 * Let a control's render land: `ReactRenderer` renders on a microtask. No
 * retrying wait, so a mutant that draws nothing goes red at once, not after
 * the setup's long `asyncUtilTimeout`, which Stryker counts as a timeout.
 */
export async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

/**
 * Let the reads a render starts land, over the mock backend: its answers and
 * TanStack Query's notifications each take a task, so this runs a fixed count
 * of them, in order, rather than waiting on the clock.
 */
export async function settleReads(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/** `selector` in `el`, once the renders queued have landed. */
export async function findIn(el: HTMLElement, selector: string): Promise<HTMLElement> {
  await settle()
  return getIn(el, selector)
}

/** A page in the mock backend holding `texts`, one top-level block each; resolves its id. */
export function seedPage(
  texts: readonly string[],
  title = 'Page mode',
): { pageId: string; ids: string[] } {
  const pageId = dispatch('create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: SCOPE.space_id,
  }) as string
  const created = dispatch('create_blocks_batch', {
    specs: texts.map((content) => ({
      blockType: 'content',
      content,
      parentId: pageId,
      position: null,
    })),
  }) as { blocks: BlockRow[] }
  return { pageId, ids: created.blocks.map((block) => block.id) }
}

/** `PageModeEditor` on `pageId`, as `PageEditor` mounts it. */
export function renderPageMode(
  pageId: string,
  props: { onNavigateToPage?: NavigateToPageFn; cursorBlockId?: string } = {},
) {
  const store = createPageBlockStore(pageId)
  const handle = createRef<PageModeEditorHandle>()
  const onBlocked = vi.fn()
  const view = render(
    <PageBlockContext.Provider value={store}>
      <PageModeEditor pageId={pageId} onBlocked={onBlocked} ref={handle} {...props} />
    </PageBlockContext.Provider>,
  )
  return { ...view, store, handle, onBlocked }
}

/**
 * The editor `PageModeEditor` mounts, once its read of the page lands. Turns,
 * each a task so an answer delivered in a task of its own lands, not a timed
 * wait: a mutant that breaks the mount fails at once, where a retrying wait
 * would hold the setup's long `asyncUtilTimeout`.
 */
export async function editorIn(container: HTMLElement): Promise<Editor> {
  for (let turn = 0; turn < 50; turn += 1) {
    const dom = container.querySelector('[data-testid="page-mode-editor"]') as
      | (HTMLElement & { editor?: Editor })
      | null
    if (dom?.editor !== undefined) return dom.editor
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  throw new Error('page mode editor not mounted')
}
