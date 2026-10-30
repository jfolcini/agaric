/**
 * Page mode's block menu (#5972) over the mock backend: a right click on a
 * block, a click on the grip on the block under the pointer, or the menu key or
 * the touch toolbar's button at the caret's block opens block mode's menu on
 * it, and each row's effect is read back from the backend after the save.
 */

import type { InvokeArgs } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { EnteringIntersectionObserver } from '@/__tests__/helpers/viewport-observer-mocks'
import {
  editorIn,
  renderPageMode,
  SCOPE,
} from '@/editor/page-mode/__tests__/page-node-view-fixtures'
import type { BlockRow, PropertyRow } from '@/lib/bindings'
import { writeText } from '@/lib/clipboard'
import { t } from '@/lib/i18n'
import { LIST_STYLE_KEY, listStyleFromRows } from '@/lib/list-style'
import { PREFERENCES, readPreference } from '@/lib/preferences'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { seedBlocks } from '@/lib/tauri-mock/seed'
import { useNavigationStore } from '@/stores/navigation'
import { addRecentCommand, getRecentCommands, RECENT_SLASH_PREFIX } from '@/stores/recent-commands'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'
import { useUndoStore } from '@/stores/undo'

vi.mock('@/lib/clipboard', () => ({ writeText: vi.fn().mockResolvedValue(undefined) }))
let touch = false
vi.mock('@/hooks/useIsTouch', () => ({ useIsTouch: () => touch }))

const mockedInvoke = vi.mocked(invoke)
const mockedWriteText = vi.mocked(writeText)

type Row = [depth: number, text: string]

/** A page in the mock backend holding `rows`, nested by depth; resolves its id and each block's. */
function seedTree(rows: readonly Row[]): { pageId: string; ids: string[] } {
  const pageId = dispatch('create_page_in_space', {
    parentId: null,
    content: 'Block menu',
    spaceId: SCOPE.space_id,
  }) as string
  const ids: string[] = []
  const atDepth: string[] = [pageId]
  for (const [depth, content] of rows) {
    const row = dispatch('create_block', {
      blockType: 'content',
      content,
      parentId: atDepth[depth],
      index: null,
      scope: SCOPE,
    }) as BlockRow
    atDepth[depth + 1] = row.id
    ids.push(row.id)
  }
  return { pageId, ids }
}

/** The page's live blocks in the backend, in order, as `[id, depth, text]`. */
function backendTree(pageId: string): Array<[string, number, string]> {
  const { blocks } = dispatch('load_page_subtree', { rootBlockId: pageId, scope: SCOPE }) as {
    blocks: BlockRow[]
  }
  const out: Array<[string, number, string]> = []
  const walk = (parent: string, depth: number) => {
    for (const b of blocks
      .filter((x) => x.parent_id === parent)
      .toSorted((x, y) => (x.position ?? 0) - (y.position ?? 0))) {
      out.push([b.id, depth, b.content ?? ''])
      walk(b.id, depth + 1)
    }
  }
  walk(pageId, 0)
  return out
}

const backendBlock = (id: string) => dispatch('get_block', { blockId: id }) as BlockRow

/** Open page mode on `rows`. */
async function open(rows: readonly Row[]) {
  const seeded = seedTree(rows)
  const view = renderPageMode(seeded.pageId)
  const editor = await editorIn(view.container)
  return { ...seeded, ...view, editor }
}

type Opened = Awaited<ReturnType<typeof open>>

function blockText(view: Opened, id: string): HTMLElement {
  const el = view.container.querySelector(`[data-page-block-id="${id}"] .page-block-content p`)
  if (!(el instanceof HTMLElement)) throw new Error(`no text for block ${id}`)
  return el
}

/** Point at block `id`, and resolve the grip once it has followed the pointer there. */
async function gripOn(view: Opened, id: string): Promise<HTMLElement> {
  fireEvent.pointerMove(blockText(view, id))
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve))
  })
  const el = view.container.querySelector('[data-page-grip]')
  if (!(el instanceof HTMLElement)) throw new Error(`no grip on block ${id}`)
  return el
}

/** Right-click block `id`'s text, and wait for the menu. */
async function rightClick(view: Opened, id: string, target?: Element): Promise<HTMLElement> {
  await act(async () => {
    fireEvent.contextMenu(target ?? blockText(view, id), { clientX: 40, clientY: 30 })
  })
  return screen.findByRole('menu', { name: t('contextMenu.blockActions') })
}

/** The row named `name`, which a shortcut hint may follow. */
const rowName = (name: string | RegExp): RegExp =>
  typeof name === 'string' ? new RegExp(`^${name.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) : name
const row = (name: string | RegExp) => screen.getByRole('menuitem', { name: rowName(name) })
const maybeRow = (name: string | RegExp) => screen.queryByRole('menuitem', { name: rowName(name) })

/** Click a menu row, then save what the click changed in the document. */
async function choose(view: Opened, name: string | RegExp, arrange = false): Promise<void> {
  if (arrange) fireEvent.click(row(t('contextMenu.moveArrange')))
  fireEvent.click(row(name))
  await settled(view)
}

async function settled(view: Opened): Promise<void> {
  await act(async () => {
    await view.handle.current?.flush()
  })
}

/** Select from the start of block `from` to the end of block `to`. */
function selectBlocks(editor: Editor, from: number, to: number): void {
  const starts: number[] = []
  let pos = 0
  editor.state.doc.forEach((node) => {
    starts.push(pos)
    pos += node.nodeSize
  })
  const last = editor.state.doc.child(to)
  act(() => {
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(
          editor.state.doc,
          (starts[from] as number) + 2,
          (starts[to] as number) + last.nodeSize - 2,
        ),
      ),
    )
  })
}

const passThrough = async (cmd: string, args?: InvokeArgs) => structuredClone(dispatch(cmd, args))

beforeEach(() => {
  touch = false
  vi.clearAllMocks()
  localStorage.clear()
  vi.stubGlobal('IntersectionObserver', EnteringIntersectionObserver)
  seedBlocks()
  useSpaceStore.setState({ currentSpaceId: SCOPE.space_id })
  useUndoStore.setState({ pages: new Map() })
  useNavigationStore.setState({ selectedBlockId: null })
  mockedInvoke.mockImplementation(passThrough)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('PageBlockMenu: opening', () => {
  it('opens block mode’s menu on the block under the pointer, with the rows page mode can do', async () => {
    const view = await open([
      [0, 'first'],
      [0, 'second'],
    ])

    const menu = await rightClick(view, view.ids[1] as string)

    const names = within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent)
    expect(names.join('|')).toContain(t('contextMenu.copyBlockRef'))
    expect(names.join('|')).toContain(t('contextMenu.history'))
    expect(names.join('|')).toContain(t('contextMenu.delete'))
    expect(names.join('|')).toContain(t('contextMenu.turnInto'))
    expect(names.join('|')).not.toContain(t('contextMenu.zoomIn'))
    expect(await axe(menu)).toHaveNoViolations()
  })

  it('keeps the webview’s own menu on text selected inside one block, and not elsewhere in it', async () => {
    const view = await open([[0, 'hello world']])
    const { editor } = view
    act(() => {
      editor.commands.setTextSelection({ from: 3, to: 8 })
    })
    // jsdom lays nothing out: the pointer is where the test says it is.
    const at = vi.spyOn(editor.view, 'posAtCoords')

    at.mockReturnValue({ pos: 5, inside: 4 })
    const native = fireEvent.contextMenu(blockText(view, view.ids[0] as string))
    await act(async () => {})
    expect(native).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()

    at.mockReturnValue({ pos: 11, inside: 4 })
    await rightClick(view, view.ids[0] as string)
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('opens from the menu key and from Shift+F10, at the caret’s block', async () => {
    const view = await open([
      [0, 'first'],
      [0, 'second'],
    ])
    const { editor } = view
    vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({ left: 5, right: 5, top: 5, bottom: 20 })
    act(() => {
      editor.commands.setTextSelection(editor.state.doc.child(0).nodeSize + 3)
    })

    await act(async () => {
      fireEvent.keyDown(editor.view.dom, { key: 'ContextMenu' })
    })
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Copy block reference/ }))
    await waitFor(() => expect(mockedWriteText).toHaveBeenCalledWith(`((${view.ids[1]}))`))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    mockedWriteText.mockClear()
    act(() => {
      editor.commands.setTextSelection(3)
    })
    await act(async () => {
      fireEvent.keyDown(editor.view.dom, { key: 'F10', shiftKey: true })
    })
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Copy block reference/ }))
    await waitFor(() => expect(mockedWriteText).toHaveBeenCalledWith(`((${view.ids[0]}))`))
  })

  it('opens from a click on the grip, on the block under the pointer, not the caret’s, and gives the editor the focus back', async () => {
    const user = userEvent.setup()
    const view = await open([
      [0, 'first'],
      [0, 'second'],
    ])
    act(() => {
      view.editor.commands.setTextSelection(3)
    })

    await act(async () => {
      fireEvent.click(await gripOn(view, view.ids[1] as string))
    })
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(view.editor.view.dom).toHaveFocus()

    await act(async () => {
      fireEvent.click(await gripOn(view, view.ids[1] as string))
    })
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Copy block reference/ }))
    await waitFor(() => expect(mockedWriteText).toHaveBeenCalledWith(`((${view.ids[1]}))`))
  })

  it('with the grip on another block, the menu key still opens the caret’s block’s menu', async () => {
    const view = await open([
      [0, 'first'],
      [0, 'second'],
    ])
    const { editor } = view
    vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({ left: 5, right: 5, top: 5, bottom: 20 })
    act(() => {
      editor.commands.setTextSelection(3)
    })
    expect(await gripOn(view, view.ids[1] as string)).toHaveAttribute('tabindex', '-1')

    await act(async () => {
      fireEvent.keyDown(editor.view.dom, { key: 'ContextMenu' })
    })
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Copy block reference/ }))

    await waitFor(() => expect(mockedWriteText).toHaveBeenCalledWith(`((${view.ids[0]}))`))
  })

  it('offers Collapse on a block with blocks under it, which hides them as block mode saves it, and Expand then', async () => {
    const view = await open([
      [0, 'parent'],
      [1, 'child'],
      [0, 'leaf'],
    ])
    const child = () =>
      view.container.querySelector(`[data-page-block-id="${view.ids[1]}"]`) as HTMLElement
    act(() => {
      view.editor.commands.setTextSelection(view.editor.state.doc.content.size - 2)
    })

    // The menu key on the parent's focused chevron: the parent's menu, not the caret's block's.
    const fold = view.container.querySelector(
      `[data-page-block-id="${view.ids[0]}"] [data-testid="collapse-toggle"]`,
    ) as HTMLElement
    act(() => fold.focus())
    await act(async () => {
      fireEvent.keyDown(fold, { key: 'ContextMenu' })
    })
    await screen.findByRole('menu')
    await choose(view, t('contextMenu.collapse'))

    expect(child()).toHaveClass('page-block-hidden')
    expect(readPreference(PREFERENCES.blockCollapse, view.pageId)).toEqual([view.ids[0]])
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await rightClick(view, view.ids[0] as string)
    await choose(view, t('contextMenu.expand'))
    expect(child()).not.toHaveClass('page-block-hidden')

    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await rightClick(view, view.ids[2] as string)
    expect(maybeRow(t('contextMenu.collapse'))).toBeNull()
    expect(maybeRow(t('contextMenu.expand'))).toBeNull()
  })

  it('returns the focus to the document when it closes', async () => {
    const view = await open([[0, 'first']])
    act(() => view.editor.view.focus())
    await rightClick(view, view.ids[0] as string)

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })

    expect(screen.queryByRole('menu')).toBeNull()
    expect(view.editor.view.hasFocus()).toBe(true)
  })
})

describe('PageBlockMenu: the touch toolbar’s button', () => {
  const blockMenuButton = () => screen.getByRole('button', { name: t('contextMenu.blockActions') })

  async function pressBlockMenu(): Promise<HTMLElement> {
    await act(async () => {
      fireEvent.pointerDown(blockMenuButton(), { button: 0 })
    })
    return screen.findByRole('menu', { name: t('contextMenu.blockActions') })
  }

  it('opens the menu on the caret’s block, saying so on the button, and gives the editor the focus back', async () => {
    touch = true
    const view = await open([
      [0, 'first'],
      [0, 'second'],
    ])
    const { editor } = view
    act(() => {
      editor.commands.setTextSelection(editor.state.doc.child(0).nodeSize + 3)
      editor.view.focus()
    })

    await pressBlockMenu()
    expect(blockMenuButton()).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(row(t('contextMenu.copyBlockRef')))

    await waitFor(() => expect(mockedWriteText).toHaveBeenCalledWith(`((${view.ids[1]}))`))
    await waitFor(() => expect(blockMenuButton()).toHaveAttribute('aria-expanded', 'false'))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(editor.view.hasFocus()).toBe(true)
  })

  it('opens the menu for a selection across blocks, whose Delete takes every selected block', async () => {
    touch = true
    const view = await open([
      [0, 'a'],
      [0, 'b'],
      [0, 'c'],
    ])
    selectBlocks(view.editor, 0, 1)

    await pressBlockMenu()
    fireEvent.click(row(t('contextMenu.deleteSelected', { count: 2 })))
    await settled(view)

    expect(backendTree(view.pageId).map(([id]) => id)).toEqual([view.ids[2]])
  })
})

describe('PageBlockMenu: the document’s rows, read back from the backend', () => {
  const rows: Row[] = [
    [0, 'a'],
    [0, 'b'],
    [1, 'c'],
    [0, 'd'],
  ]

  it('Indent moves a block under the one before it, with the blocks under it', async () => {
    const view = await open(rows)
    await rightClick(view, view.ids[1] as string)

    await choose(view, t('contextMenu.indent'), true)

    expect(backendTree(view.pageId)).toEqual([
      [view.ids[0], 0, 'a'],
      [view.ids[1], 1, 'b'],
      [view.ids[2], 2, 'c'],
      [view.ids[3], 0, 'd'],
    ])
  })

  it('Dedent moves a nested block out past the blocks after it', async () => {
    const view = await open(rows)
    await rightClick(view, view.ids[2] as string)

    await choose(view, t('contextMenu.dedent'), true)

    expect(backendTree(view.pageId).map(([, depth]) => depth)).toEqual([0, 0, 0, 0])
  })

  it('Move Up and Move Down swap a block with its siblings, the last block down going nowhere', async () => {
    const view = await open(rows)
    await rightClick(view, view.ids[3] as string)
    await choose(view, t('contextMenu.moveUp'), true)
    expect(backendTree(view.pageId).map(([id]) => id)).toEqual([
      view.ids[0],
      view.ids[3],
      view.ids[1],
      view.ids[2],
    ])

    await rightClick(view, view.ids[0] as string)
    await choose(view, t('contextMenu.moveDown'), true)
    expect(backendTree(view.pageId).map(([id]) => id)).toEqual([
      view.ids[3],
      view.ids[0],
      view.ids[1],
      view.ids[2],
    ])

    await rightClick(view, view.ids[2] as string)
    await choose(view, t('contextMenu.moveDown'), true)
    // The last child leaves its parent for the place after it.
    expect(backendTree(view.pageId).map(([, depth]) => depth)).toEqual([0, 0, 0, 0])
  })

  it('Move Up on the first block changes nothing', async () => {
    const view = await open(rows)
    const before = backendTree(view.pageId)
    await rightClick(view, view.ids[0] as string)

    await choose(view, t('contextMenu.moveUp'), true)

    expect(backendTree(view.pageId)).toEqual(before)
  })

  it('Duplicate puts a copy of the block and its subtree after them, as new blocks', async () => {
    const view = await open(rows)
    await rightClick(view, view.ids[1] as string)

    await choose(view, t('contextMenu.duplicate'), true)

    const tree = backendTree(view.pageId)
    expect(tree.map(([, depth, text]) => [depth, text])).toEqual([
      [0, 'a'],
      [0, 'b'],
      [1, 'c'],
      [0, 'b'],
      [1, 'c'],
      [0, 'd'],
    ])
    expect(tree.slice(0, 3).map(([id]) => id)).toEqual(view.ids.slice(0, 3))
    expect(new Set(tree.map(([id]) => id)).size).toBe(6)
  })

  it('Merge joins a block to the one before it, which keeps its id; the first block has none', async () => {
    const view = await open([
      [0, 'one '],
      [0, 'two'],
    ])
    await rightClick(view, view.ids[0] as string)
    expect(maybeRow(t('contextMenu.moveArrange'))).not.toBeNull()
    fireEvent.click(row(t('contextMenu.moveArrange')))
    expect(maybeRow(t('contextMenu.merge'))).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    await rightClick(view, view.ids[1] as string)
    await choose(view, t('contextMenu.merge'), true)

    expect(backendTree(view.pageId)).toEqual([[view.ids[0], 0, 'one two']])
  })

  it('Delete removes the block and the blocks under it, and Ctrl+Z brings them back by id', async () => {
    const view = await open(rows)
    await rightClick(view, view.ids[1] as string)

    await choose(view, t('contextMenu.delete'))
    expect(backendTree(view.pageId).map(([id]) => id)).toEqual([view.ids[0], view.ids[3]])

    act(() => {
      view.editor.commands.undo()
    })
    await settled(view)
    expect(backendTree(view.pageId).map(([id]) => id)).toEqual(view.ids)
  })

  it('Delete on the page’s only block leaves one empty block to type in', async () => {
    const view = await open([[0, 'alone']])
    await rightClick(view, view.ids[0] as string)

    await choose(view, t('contextMenu.delete'))

    const tree = backendTree(view.pageId)
    expect(tree.length).toBeLessThanOrEqual(1)
    expect(view.container.querySelectorAll('[data-page-block]')).toHaveLength(1)
  })

  it('acts on the block under the pointer, not the one the caret is in', async () => {
    const view = await open([
      [0, 'a'],
      [0, 'b'],
    ])
    act(() => {
      view.editor.commands.setTextSelection(3)
    })
    await rightClick(view, view.ids[1] as string)

    await choose(view, t('contextMenu.delete'))

    expect(backendTree(view.pageId).map(([id]) => id)).toEqual([view.ids[0]])
  })
})

describe('PageBlockMenu: the commands’ rows', () => {
  it('cycles a task’s state, and a block’s priority, on the block under the pointer', async () => {
    const view = await open([
      [0, 'a'],
      [0, 'b'],
    ])
    dispatch('set_todo_state', { blockId: view.ids[1], state: 'TODO' })
    await act(async () => {
      await view.store.getState().load()
    })
    await rightClick(view, view.ids[1] as string)
    expect(row(t('contextMenu.todoToDoing'))).toBeInTheDocument()

    fireEvent.click(row(t('contextMenu.todoToDoing')))
    await settled(view)
    await waitFor(() => expect(backendBlock(view.ids[1] as string).todo_state).toBe('DOING'))
    expect(backendBlock(view.ids[0] as string).todo_state).toBeNull()

    // Opened again on the same block, it reads the state the click set.
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await rightClick(view, view.ids[1] as string)
    expect(row(t('contextMenu.doingToDone'))).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    await rightClick(view, view.ids[0] as string)
    fireEvent.click(row(t('contextMenu.setPriority1')))
    await settled(view)
    await waitFor(() => expect(backendBlock(view.ids[0] as string).priority).toBe('1'))
  })

  it('Properties opens the drawer on the block, and History its history', async () => {
    const view = await open([[0, 'a']])
    await rightClick(view, view.ids[0] as string)
    fireEvent.click(row(t('contextMenu.properties')))
    await settled(view)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    await rightClick(view, view.ids[0] as string)
    fireEvent.click(row(t('contextMenu.history')))
    await settled(view)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('copies the block’s reference, its content and its subtree’s', async () => {
    const view = await open([
      [0, 'parent'],
      [1, 'child'],
    ])
    await rightClick(view, view.ids[0] as string)
    fireEvent.click(row(t('contextMenu.copyBlockRef')))
    await waitFor(() => expect(mockedWriteText).toHaveBeenCalledWith(`((${view.ids[0]}))`))

    await rightClick(view, view.ids[0] as string)
    fireEvent.click(row(t('contextMenu.copySubtreeContent')))
    // The clipboard carries the Document dialect, which a paste reads (#6190).
    await waitFor(() => expect(mockedWriteText).toHaveBeenLastCalledWith('parent\n\n  child\n'))

    await rightClick(view, view.ids[0] as string)
    fireEvent.click(row(t('contextMenu.copyPageRef')))
    await waitFor(() => expect(mockedWriteText).toHaveBeenLastCalledWith(`[[${view.pageId}]]`))
  })

  it('tells the user when a command is refused, and leaves the document as it was', async () => {
    const view = await open([[0, 'a']])
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'set_todo_state') throw new Error('disk full')
      return structuredClone(dispatch(cmd, args))
    })
    await rightClick(view, view.ids[0] as string)

    fireEvent.click(row(t('contextMenu.setTodo')))
    await settled(view)

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(backendBlock(view.ids[0] as string).todo_state).toBeNull()
    expect(backendTree(view.pageId)).toEqual([[view.ids[0], 0, 'a']])
  })
})

describe('PageBlockMenu: Turn into', () => {
  const turnInto = (type: string) => t(`contextMenu.turnIntoType.${type}`)

  it('turns the block under the pointer into a heading in the document, and the save writes it', async () => {
    const view = await open([
      [0, 'first'],
      [0, 'second'],
    ])
    await rightClick(view, view.ids[1] as string)

    fireEvent.click(row(t('contextMenu.turnInto')))
    await choose(view, turnInto('h1'))

    await waitFor(() =>
      expect(backendTree(view.pageId)).toEqual([
        [view.ids[0], 0, 'first'],
        [view.ids[1], 0, '# second'],
      ]),
    )
    expect(view.container.querySelector(`[data-page-block-id="${view.ids[1]}"] h1`)).not.toBeNull()
  })

  it('leaves the slash menu’s recent commands alone, as block mode’s menu does', async () => {
    addRecentCommand('todo', RECENT_SLASH_PREFIX)
    const view = await open([[0, 'first']])
    await rightClick(view, view.ids[0] as string)

    fireEvent.click(row(t('contextMenu.turnInto')))
    await choose(view, turnInto('h1'))

    await waitFor(() => expect(backendBlock(view.ids[0] as string).content).toBe('# first'))
    expect(getRecentCommands(RECENT_SLASH_PREFIX).map((c) => c.id)).toEqual(['todo'])
  })

  it('marks the block’s current type', async () => {
    const view = await open([[0, '# first']])
    const heading = view.container.querySelector(`[data-page-block-id="${view.ids[0]}"] h1`)
    await rightClick(view, view.ids[0] as string, heading as Element)
    fireEvent.click(row(t('contextMenu.turnInto')))

    expect(row(turnInto('h1'))).toHaveAttribute('aria-current', 'true')
    expect(row(turnInto('h2'))).not.toHaveAttribute('aria-current')
  })

  it('turns a block into a bulleted list, which writes its list style, and into a heading, which clears it', async () => {
    const view = await open([[0, 'first']])
    const id = view.ids[0] as string
    const listStyle = () =>
      (dispatch('get_properties', { blockId: id }) as Array<{ key: string; value_text: string }>)
        .filter((p) => p.key === 'listStyle')
        .map((p) => p.value_text)
    await rightClick(view, id)
    fireEvent.click(row(t('contextMenu.turnInto')))
    await choose(view, turnInto('bulletList'))
    await waitFor(() => expect(listStyle()).toEqual(['bullet']))

    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await rightClick(view, id)
    fireEvent.click(row(t('contextMenu.turnInto')))
    await choose(view, turnInto('h1'))
    await waitFor(() => expect(listStyle()).toEqual([]))
  })

  it('keeps what was typed in the block, and in another, before it converts', async () => {
    const view = await open([
      [0, 'a'],
      [0, 'b'],
    ])
    const typeAt = (index: number, text: string) => {
      let start = 0
      for (let i = 0; i < index; i += 1) start += view.editor.state.doc.child(i).nodeSize
      act(() => {
        view.editor
          .chain()
          .setTextSelection(start + 1 + 1)
          .insertContent(text)
          .run()
      })
    }
    typeAt(1, '!')
    typeAt(0, '?')
    await rightClick(view, view.ids[1] as string)

    fireEvent.click(row(t('contextMenu.turnInto')))
    await choose(view, turnInto('h2'))

    await waitFor(() =>
      expect(backendTree(view.pageId)).toEqual([
        [view.ids[0], 0, '?a'],
        [view.ids[1], 0, '## !b'],
      ]),
    )
  })

  it('waits for the save that creates a new block before it writes the block’s list style', async () => {
    const view = await open([[0, 'a']])
    act(() => {
      view.editor.commands.setTextSelection(3)
      view.editor.view.focus()
    })
    act(() => {
      view.editor.view.someProp('handleKeyDown', (f) =>
        f(view.editor.view, new KeyboardEvent('keydown', { key: 'Enter' })),
      )
    })
    const fresh = view.editor.state.doc.child(1).attrs['blockId'] as string
    // As the backend does: a property of a block that does not exist yet is refused.
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'set_property' || cmd === 'delete_property') {
        dispatch('get_block', { blockId: (args as { blockId: string }).blockId })
      }
      return structuredClone(dispatch(cmd, args))
    })
    await rightClick(view, fresh)

    fireEvent.click(row(t('contextMenu.turnInto')))
    await choose(view, turnInto('bulletList'))

    await waitFor(() =>
      expect(
        (dispatch('get_properties', { blockId: fresh }) as Array<{ key: string }>).map(
          (p) => p.key,
        ),
      ).toEqual(['listStyle']),
    )
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('converts a collapsed block’s own text and leaves the blocks it hides alone', async () => {
    const view = await open([
      [0, 'parent'],
      [1, 'child'],
      [0, 'leaf'],
    ])
    await rightClick(view, view.ids[0] as string)
    await choose(view, t('contextMenu.collapse'))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    await rightClick(view, view.ids[0] as string)
    fireEvent.click(row(t('contextMenu.turnInto')))
    await choose(view, turnInto('h1'))

    await waitFor(() =>
      expect(backendTree(view.pageId)).toEqual([
        [view.ids[0], 0, '# parent'],
        [view.ids[1], 1, 'child'],
        [view.ids[2], 0, 'leaf'],
      ]),
    )
    expect(readPreference(PREFERENCES.blockCollapse, view.pageId)).toEqual([view.ids[0]])
  })

  it('converts only the block under the pointer when a selection across blocks is open', async () => {
    const view = await open([
      [0, 'a'],
      [0, 'b'],
      [0, 'c'],
    ])
    selectBlocks(view.editor, 0, 1)
    vi.spyOn(view.editor.view, 'posAtCoords').mockReturnValue({ pos: 3, inside: 1 })
    await rightClick(view, view.ids[0] as string)

    fireEvent.click(row(t('contextMenu.turnInto')))
    await choose(view, turnInto('h1'))

    await waitFor(() =>
      expect(backendTree(view.pageId).map((r) => r[2])).toEqual(['# a', 'b', 'c']),
    )
  })

  it('turns a block into the callout variant picked', async () => {
    const view = await open([[0, 'first']])
    await rightClick(view, view.ids[0] as string)
    fireEvent.click(row(t('contextMenu.turnInto')))
    fireEvent.click(row(turnInto('callout')))
    await choose(view, t('callout.warning'))

    await waitFor(() =>
      expect(backendBlock(view.ids[0] as string).content).toBe('> [!WARNING] first'),
    )
  })

  it('turns a bulleted block into a callout that is no longer a list', async () => {
    const seeded = seedTree([[0, 'first']])
    const id = seeded.ids[0] as string
    dispatch('set_property', {
      blockId: id,
      key: LIST_STYLE_KEY,
      value: {
        value_text: 'bullet',
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
    })
    const rendered = renderPageMode(seeded.pageId)
    const view = { ...seeded, ...rendered, editor: await editorIn(rendered.container) }
    const marker = () =>
      view.container.querySelector(`[data-page-block-id="${id}"] > [data-testid="list-marker"]`)
    expect(marker()?.textContent).toBe('•')

    await rightClick(view, id)
    fireEvent.click(row(t('contextMenu.turnInto')))
    fireEvent.click(row(turnInto('callout')))
    await choose(view, t('callout.warning'))

    await waitFor(() => expect(backendBlock(id).content).toBe('> [!WARNING] first'))
    const rows = dispatch('get_properties', { blockId: id }) as PropertyRow[]
    expect(listStyleFromRows(rows)).toBe('none')
    await waitFor(() => expect(marker()).toBeNull())
  })
})

describe('PageBlockMenu: chips and links', () => {
  it('opens a page link’s page in a background tab, from a right click on its chip', async () => {
    const target = dispatch('create_page_in_space', {
      parentId: null,
      content: 'Linked page',
      spaceId: SCOPE.space_id,
    }) as string
    const view = await open([[0, `see [[${target}]]`]])
    const chip = view.container.querySelector('[data-type="block-link"]')
    expect(chip).not.toBeNull()

    await rightClick(view, view.ids[0] as string, chip as Element)
    fireEvent.click(row(t('tabs.openInNewTab')))

    await waitFor(() =>
      expect(
        useTabsStore.getState().tabs.some((tab) => tab.pageStack.some((p) => p.pageId === target)),
      ).toBe(true),
    )
  })

  it('offers an external link’s Open and Copy URL, and copies the URL', async () => {
    const view = await open([[0, '[docs](https://example.com/docs)']])
    const link = view.container.querySelector('a.external-link')
    expect(link).not.toBeNull()

    await rightClick(view, view.ids[0] as string, link as Element)
    expect(row(t('contextMenu.openLink'))).toBeInTheDocument()
    fireEvent.click(row(t('contextMenu.copyUrl')))

    await waitFor(() => expect(mockedWriteText).toHaveBeenCalledWith('https://example.com/docs'))
  })
})

describe('PageBlockMenu: a selection of several blocks', () => {
  const rows: Row[] = [
    [0, 'a'],
    [0, 'b'],
    [1, 'c'],
    [0, 'd'],
  ]

  it('opens the menu for the selection, even on selected text, and Delete takes every selected block, and the blocks under them', async () => {
    const view = await open(rows)
    selectBlocks(view.editor, 0, 1)
    const at = vi.spyOn(view.editor.view, 'posAtCoords')
    at.mockReturnValue({ pos: 3, inside: 1 })

    await rightClick(view, view.ids[0] as string)
    fireEvent.click(row(t('contextMenu.deleteSelected', { count: 2 })))
    await settled(view)

    expect(backendTree(view.pageId).map(([id]) => id)).toEqual([view.ids[3]])
  })

  it('cycles the task state of each selected block', async () => {
    const view = await open(rows)
    selectBlocks(view.editor, 0, 1)
    await rightClick(view, view.ids[1] as string)

    fireEvent.click(row(t('contextMenu.cycleTodoSelected')))
    await settled(view)

    await waitFor(() =>
      expect(view.ids.map((id) => backendBlock(id).todo_state)).toEqual([
        'TODO',
        'TODO',
        null,
        null,
      ]),
    )
  })

  describe('setting one task state, as block mode’s batch toolbar does', () => {
    const tree: Row[] = [
      [0, 'a'],
      [0, 'b'],
      [1, 'c'],
      [0, 'd'],
      [1, 'e'],
    ]
    const states = (view: Opened) => view.ids.map((id) => backendBlock(id).todo_state)

    /** Page mode on `tree`, `c` DONE and `e` TODO, with `b` to `d` selected and the menu open on `c`. */
    async function openOnSelection(): Promise<{ view: Opened; menu: HTMLElement }> {
      const view = await open(tree)
      dispatch('set_todo_state', { blockId: view.ids[2], state: 'DONE' })
      dispatch('set_todo_state', { blockId: view.ids[4], state: 'TODO' })
      await act(async () => {
        await view.store.getState().load()
      })
      selectBlocks(view.editor, 1, 3)
      const menu = await rightClick(view, view.ids[2] as string)
      return { view, menu }
    }

    it('sets it on every selected block, not on the blocks under them', async () => {
      const { view, menu } = await openOnSelection()
      expect(await axe(menu)).toHaveNoViolations()
      const reads = () => mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'load_page_subtree')
      const readsBefore = reads().length

      await choose(view, t('contextMenu.setTodoSelected', { state: 'DOING' }))

      await waitFor(() => expect(states(view)).toEqual([null, 'DOING', 'DOING', 'DOING', 'TODO']))
      await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1))
      await settled(view)
      // One step for the page's undo, as block mode's toolbar records it.
      expect(useUndoStore.getState().pages.get(view.pageId)?.undoStack).toHaveLength(1)
      // What it showed is what it wrote: the page is not read again.
      expect(reads()).toHaveLength(readsBefore)
    })

    it('lists Clear first, as block mode’s batch toolbar does', async () => {
      const { menu } = await openOnSelection()

      const expected = [
        t('contextMenu.clearTodoSelected'),
        t('contextMenu.setTodoSelected', { state: 'TODO' }),
        t('contextMenu.setTodoSelected', { state: 'DOING' }),
        t('contextMenu.setTodoSelected', { state: 'DONE' }),
      ]
      const offered = within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent ?? '')
        .filter((name) => expected.includes(name))
      expect(offered).toEqual(expected)
    })

    it('clears it on every selected block', async () => {
      const { view } = await openOnSelection()

      await choose(view, t('contextMenu.clearTodoSelected'))

      await waitFor(() => expect(states(view)).toEqual([null, null, null, null, 'TODO']))
    })

    it('one undo gives every selected block back the state it had', async () => {
      // The setup's ops a minute before the row's, out of the undo's group.
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const { view } = await openOnSelection()
      vi.setSystemTime(new Date('2026-01-01T00:01:00Z'))
      await choose(view, t('contextMenu.setTodoSelected', { state: 'DOING' }))
      await waitFor(() => expect(states(view)).toEqual([null, 'DOING', 'DOING', 'DOING', 'TODO']))

      await act(async () => {
        await useUndoStore.getState().undo(view.pageId)
      })

      expect(states(view)).toEqual([null, null, 'DONE', null, 'TODO'])
    })

    it('tells the user when the command is refused, and shows the states the backend kept', async () => {
      mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
        if (cmd === 'set_todo_state_batch') throw new Error('disk full')
        return structuredClone(dispatch(cmd, args))
      })
      const { view } = await openOnSelection()

      await choose(view, t('contextMenu.setTodoSelected', { state: 'DONE' }))

      const failed = t('blockTree.updateFailedMessage', { failCount: 3, totalCount: 3 })
      await waitFor(() =>
        expect(vi.mocked(toast.error).mock.calls.map(([message]) => message)).toContain(failed),
      )
      expect(states(view)).toEqual([null, null, 'DONE', null, 'TODO'])
      await waitFor(() =>
        expect(view.ids.map((id) => view.store.getState().blocksById.get(id)?.todo_state)).toEqual([
          null,
          null,
          'DONE',
          null,
          'TODO',
        ]),
      )
    })

    it('waits for a save in flight, and keeps what it saves', async () => {
      const { view } = await openOnSelection()
      let release = (): void => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
        if (cmd === 'edit_block') await gate
        return structuredClone(dispatch(cmd, args))
      })
      act(() => {
        view.editor.view.dispatch(view.editor.state.tr.insertText('!', 8))
      })
      const saving = view.handle.current?.flush()

      fireEvent.click(row(t('contextMenu.setTodoSelected', { state: 'DONE' })))
      expect(states(view)).toEqual([null, null, 'DONE', null, 'TODO'])
      release()
      await act(async () => {
        await saving
      })

      await waitFor(() => expect(states(view)).toEqual([null, 'DONE', 'DONE', 'DONE', 'TODO']))
      expect(backendBlock(view.ids[1] as string).content).toBe('b!')
    })

    it('is not offered on one block', async () => {
      const view = await open(tree)
      await rightClick(view, view.ids[2] as string)

      expect(maybeRow(t('contextMenu.clearTodoSelected'))).toBeNull()
    })
  })

  it('indents the selection once, its top blocks, in their order', async () => {
    const view = await open([
      [0, 'x'],
      [0, 'a'],
      [0, 'b'],
      [1, 'c'],
    ])
    selectBlocks(view.editor, 1, 3)
    await rightClick(view, view.ids[1] as string)

    await choose(view, t('contextMenu.indent'), true)

    expect(backendTree(view.pageId)).toEqual([
      [view.ids[0], 0, 'x'],
      [view.ids[1], 1, 'a'],
      [view.ids[2], 1, 'b'],
      [view.ids[3], 2, 'c'],
    ])
  })

  it('moves the selection down together, keeping its order', async () => {
    const view = await open([
      [0, 'a'],
      [0, 'b'],
      [0, 'c'],
      [0, 'd'],
    ])
    selectBlocks(view.editor, 0, 1)
    await rightClick(view, view.ids[0] as string)

    await choose(view, t('contextMenu.moveDown'), true)

    expect(backendTree(view.pageId).map(([id]) => id)).toEqual([
      view.ids[2],
      view.ids[0],
      view.ids[1],
      view.ids[3],
    ])
  })

  it('copies the selection as Markdown', async () => {
    const view = await open(rows)
    selectBlocks(view.editor, 0, 1)
    await rightClick(view, view.ids[0] as string)

    fireEvent.click(row(t('contextMenu.copySelectionContent')))

    await waitFor(() => expect(mockedWriteText).toHaveBeenCalledWith('a\n\nb\n\n  c\n'))
  })

  it('offers no Duplicate or Merge on a selection', async () => {
    const view = await open(rows)
    selectBlocks(view.editor, 0, 1)
    await rightClick(view, view.ids[1] as string)
    fireEvent.click(row(t('contextMenu.moveArrange')))

    expect(maybeRow(t('contextMenu.duplicate'))).toBeNull()
    expect(maybeRow(t('contextMenu.merge'))).toBeNull()
  })

  it('treats a right click outside the selection as a click on that block alone', async () => {
    const view = await open(rows)
    selectBlocks(view.editor, 0, 1)

    await rightClick(view, view.ids[3] as string)

    expect(row(t('contextMenu.delete'))).toBeInTheDocument()
    expect(maybeRow(/selected/)).toBeNull()
  })
})

describe('PageBlockMenu: a save in flight', () => {
  it('keeps the text being saved and still runs the row, after it', async () => {
    const view = await open([[0, 'first']])
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'edit_block') await gate
      return structuredClone(dispatch(cmd, args))
    })
    act(() => {
      view.editor.chain().setTextSelection(7).insertContent('!').run()
    })
    const saving = view.handle.current?.flush()
    await rightClick(view, view.ids[0] as string)

    fireEvent.click(row(t('contextMenu.setTodo')))
    expect(backendBlock(view.ids[0] as string).todo_state).toBeNull()
    release()
    await act(async () => {
      await saving
    })

    await waitFor(() => expect(backendBlock(view.ids[0] as string).todo_state).toBe('TODO'))
    expect(backendBlock(view.ids[0] as string).content).toBe('first!')
  })

  it('saves what was typed before a structural row takes the block', async () => {
    const view = await open([
      [0, 'a'],
      [0, 'b'],
    ])
    act(() => {
      view.editor
        .chain()
        .setTextSelection(view.editor.state.doc.child(0).nodeSize + 3)
        .insertContent('!')
        .run()
    })
    await rightClick(view, view.ids[1] as string)

    await choose(view, t('contextMenu.moveUp'), true)

    expect(backendTree(view.pageId)).toEqual([
      [view.ids[1], 0, 'b!'],
      [view.ids[0], 0, 'a'],
    ])
  })
})

describe('PageBlockMenu: other blocks', () => {
  it('opens on an empty block, which has every row but a reference to what is not saved yet', async () => {
    const view = await open([[0, 'a']])
    act(() => {
      view.editor.commands.setTextSelection(3)
      view.editor.view.focus()
    })
    // Enter makes a block that exists only in the document until it holds something.
    act(() => {
      view.editor.view.someProp('handleKeyDown', (f) =>
        f(view.editor.view, new KeyboardEvent('keydown', { key: 'Enter' })),
      )
    })
    const fresh = view.editor.state.doc.child(1).attrs['blockId'] as string

    await rightClick(view, fresh)

    expect(maybeRow(t('contextMenu.copyBlockRef'))).toBeNull()
    expect(row(t('contextMenu.delete'))).toBeInTheDocument()
    expect(row(t('contextMenu.history'))).toBeInTheDocument()
  })

  it('opens on a block holding a list, and Duplicate copies the list', async () => {
    const view = await open([
      [0, 'plain'],
      [0, '- one\n- two'],
    ])
    await rightClick(view, view.ids[1] as string)

    await choose(view, t('contextMenu.duplicate'), true)

    const texts = backendTree(view.pageId).map(([, , text]) => text)
    expect(texts).toHaveLength(3)
    expect(texts[2]).toBe(texts[1])
  })

  it('opens on a block with an attachment, and Delete removes the block', async () => {
    const { pageId, ids } = seedTree([[0, 'with a file']])
    dispatch('add_attachment_with_bytes', {
      blockId: ids[0],
      filename: 'notes.txt',
      mimeType: 'text/plain',
      bytes: [104, 105],
    })
    const view = renderPageMode(pageId)
    await editorIn(view.container)
    const opened = { ...view, ids, pageId } as unknown as Opened

    await rightClick(opened, ids[0] as string)
    await choose(opened, t('contextMenu.delete'))

    expect(backendTree(pageId)).toEqual([])
  })
})
