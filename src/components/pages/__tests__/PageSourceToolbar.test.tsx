/**
 * PageSourceToolbar — the block editor's toolbar and block menu on *Edit as
 * Markdown* (#5160 phase 5). Every IPC goes to the REAL tauri-mock: each
 * action is pressed on the toolbar, the buffer's lines are read, and a save
 * is read back from the mock. The mock models no task checkbox, list marker
 * or property line in a save (the Rust tests own that grammar), so for those
 * the re-read buffer line is what a test checks.
 */

import type { InvokeArgs } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { writeText as pluginWriteText } from '@tauri-apps/plugin-clipboard-manager'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Editor } from '@tiptap/core'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { PageSourceEditor } from '@/components/pages/PageSourceEditor'
import { readLines } from '@/editor/source-buffer'
import type { PageBuffer } from '@/lib/bindings'
import { convertBlockContent } from '@/lib/block-type-convert'
import { t } from '@/lib/i18n'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'
import { useNavigationStore } from '@/stores/navigation'
import { createPageBlockStore, PageBlockContext } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'
import { useUndoStore } from '@/stores/undo'

const touch = vi.hoisted(() => ({ value: false }))
vi.mock('@/hooks/useIsTouch', () => ({ useIsTouch: () => touch.value }))

// The grid is virtualised; what the toolbar owns is opening the dialog and
// writing the emoji it hands back at the caret.
vi.mock('@/components/EmojiPicker/EmojiPicker', () => ({
  EmojiPicker: ({ onSelect }: { onSelect: (char: string) => void }) => (
    <button type="button" onClick={() => onSelect('🎉')}>
      party popper
    </button>
  ),
}))

const mockedInvoke = vi.mocked(invoke)

const { PAGE_GETTING_STARTED: PAGE, BLOCK_GS_1: GS1, BLOCK_GS_2: GS2, BLOCK_GS_3: GS3 } = SEED_IDS
const WELCOME_TEXT = 'Welcome to Agaric! This is your personal knowledge base.'
const WELCOME = `- ${WELCOME_TEXT}`
const CREATE = '- Create new blocks by pressing Enter at the end of any block.'

type Line = [text: string, id: string | null]

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  touch.value = false
  seedBlocks()
  useSpaceStore.setState({ currentSpaceId: 'SPACE_PERSONAL' })
  useUndoStore.setState({ pages: new Map() })
  useNavigationStore.setState({ currentView: 'page-editor', selectedBlockId: null })
  useTabsStore.setState({ tabs: [{ id: '0', pageStack: [], label: '' }], activeTabIndex: 0 })
  mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
})

afterEach(() => {
  vi.restoreAllMocks()
})

function pageBuffer(): PageBuffer {
  return dispatch('get_page_buffer', { pageId: PAGE }) as PageBuffer
}

function renderEditor() {
  const onClose = vi.fn()
  const store = createPageBlockStore(PAGE)
  const utils = render(
    <PageBlockContext.Provider value={store}>
      <PageSourceEditor pageId={PAGE} onClose={onClose} />
    </PageBlockContext.Provider>,
  )
  return { ...utils, onClose, store }
}

async function loadedEditor(): Promise<Editor> {
  const box = await screen.findByRole('textbox', { name: t('pageSource.editorLabel') })
  await screen.findByRole('toolbar', { name: t('toolbar.formatting') })
  return (box as HTMLElement & { editor: Editor }).editor
}

function lines(ed: Editor): Line[] {
  const { text, lineIds } = readLines(ed.state.doc)
  return text.split('\n').map((line, i) => [line, lineIds[i] ?? null])
}

function lineOf(ed: Editor, find: string): Line {
  const line = lines(ed).find(([text]) => text.includes(find))
  if (line === undefined) throw new Error(`no line holds ${find}`)
  return line
}

/** Where `find` starts in the buffer, `offset` characters on. */
function positionOf(ed: Editor, find: string, offset = 0): number {
  let found: number | null = null
  ed.state.doc.forEach((line, start) => {
    const at = line.textContent.indexOf(find)
    if (found === null && at >= 0) found = start + 1 + at + offset
  })
  if (found === null) throw new Error(`no line holds ${find}`)
  return found
}

function caretAfter(ed: Editor, find: string): void {
  act(() => {
    ed.commands.setTextSelection(positionOf(ed, find, find.length))
  })
}

function select(ed: Editor, find: string): void {
  act(() => {
    ed.commands.setTextSelection({
      from: positionOf(ed, find),
      to: positionOf(ed, find, find.length),
    })
  })
}

/** A block-menu row by its label, which its shortcut hint follows. */
function menuRow(label: string): (name: string) => boolean {
  return (name) => name.startsWith(label)
}

/** What an open picker matched, from the Suggestion plugin's decoration; null when none is open. */
function picked(ed: Editor): string | null {
  return ed.view.dom.querySelector('.suggestion')?.textContent ?? null
}

function toolbar(): HTMLElement {
  return screen.getByRole('toolbar', { name: t('toolbar.formatting') })
}

function button(name: string): HTMLElement {
  return within(toolbar()).getByRole('button', { name })
}

async function saveAndClose(onClose: () => void): Promise<void> {
  await userEvent.setup().click(screen.getByRole('button', { name: t('action.save') }))
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
}

describe('the toolbar', () => {
  it('shows the block editor’s buttons the buffer does, in their order, then the block menu', async () => {
    renderEditor()
    await loadedEditor()

    const names = within(toolbar())
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'))

    expect(names).toEqual([
      t('toolbar.format'),
      t('toolbar.turnInto'),
      t('toolbar.internalLink'),
      t('toolbar.insertBlockRef'),
      t('toolbar.insertTag'),
      t('toolbar.insertQuery'),
      t('toolbar.emoji'),
      t('toolbar.newLine'),
      t('toolbar.cyclePriority'),
      t('toolbar.insertDate'),
      t('toolbar.setDueDate'),
      t('toolbar.setScheduledDate'),
      t('toolbar.todoToggle'),
      t('toolbar.undo'),
      t('toolbar.redo'),
      t('toolbar.discard'),
      t('contextMenu.blockActions'),
    ])
    expect(screen.queryByRole('button', { name: t('toolbar.insertTable') })).toBeNull()
    expect(screen.queryByRole('button', { name: t('toolbar.properties') })).toBeNull()
  })

  it('has no a11y violations', async () => {
    const { container } = renderEditor()
    await loadedEditor()

    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})

describe('toolbar actions at the cursor', () => {
  it('Format’s Bold wraps the selection in its markdown', async () => {
    renderEditor()
    const ed = await loadedEditor()
    const user = userEvent.setup()
    select(ed, 'Welcome')

    await user.click(button(t('toolbar.format')))
    await user.click(
      within(await screen.findByRole('toolbar', { name: t('toolbar.format') })).getByRole(
        'button',
        { name: t('toolbar.bold') },
      ),
    )

    expect(lineOf(ed, 'Agaric!')).toEqual([
      `- **Welcome** to Agaric! ${WELCOME_TEXT.slice(19)}`,
      GS1,
    ])
  })

  it('Internal link closes [[ ]] around the selection, which the save links by title', async () => {
    const { onClose, store } = renderEditor()
    const ed = await loadedEditor()
    select(ed, 'Agaric')

    await userEvent.setup().click(button(t('toolbar.internalLink')))
    expect(lineOf(ed, 'Welcome')).toEqual([
      '- Welcome to [[Agaric]]! This is your personal knowledge base.',
      GS1,
    ])

    await saveAndClose(onClose)
    expect(store.getState().blocksById.get(GS1)?.content).toMatch(
      /^Welcome to \[\[[0-9A-Z]{26}\]\]!/,
    )
  })

  it('Insert tag and Block reference type their picker’s trigger, which opens it', async () => {
    renderEditor()
    const ed = await loadedEditor()
    const user = userEvent.setup()
    caretAfter(ed, 'knowledge base.')

    await user.click(button(t('toolbar.insertTag')))
    expect(lineOf(ed, 'Welcome')[0]).toBe(`${WELCOME} #`)
    // As in the block editor's buffer rule, `#` opens once a name starts.
    act(() => {
      ed.commands.insertContent('wor')
    })
    expect(picked(ed)).toBe('#wor')

    caretAfter(ed, 'Create')
    await user.click(button(t('toolbar.insertBlockRef')))
    expect(lineOf(ed, 'by pressing')[0]).toBe(
      '- Create(( new blocks by pressing Enter at the end of any block.',
    )
    expect(picked(ed)).toBe('((')
  })

  it('New line breaks the line at the cursor without a marker, a new block of no id', async () => {
    renderEditor()
    const ed = await loadedEditor()
    caretAfter(ed, 'Welcome to Agaric!')

    await userEvent.setup().click(button(t('toolbar.newLine')))

    const at = lines(ed).findIndex(([, id]) => id === GS1)
    expect(lines(ed).slice(at, at + 2)).toEqual([
      ['- Welcome to Agaric!', GS1],
      [' This is your personal knowledge base.', null],
    ])
  })

  it('TODO cycles the block’s checkbox, and Undo and Redo step back and forth', async () => {
    renderEditor()
    const ed = await loadedEditor()
    const user = userEvent.setup()
    caretAfter(ed, 'Welcome')

    await user.click(button(t('toolbar.todoToggle')))
    expect(lineOf(ed, 'Welcome')).toEqual([`- [ ] ${WELCOME_TEXT}`, GS1])

    await user.click(button(t('toolbar.undo')))
    expect(lineOf(ed, 'Welcome')).toEqual([WELCOME, GS1])
    await user.click(button(t('toolbar.redo')))
    expect(lineOf(ed, 'Welcome')).toEqual([`- [ ] ${WELCOME_TEXT}`, GS1])
  })

  it('Cycle priority writes the block’s priority:: line, which the badge shows and the save keeps', async () => {
    const { onClose } = renderEditor()
    const ed = await loadedEditor()
    const user = userEvent.setup()
    caretAfter(ed, 'Create')

    await user.click(button(t('toolbar.cyclePriority')))
    await user.click(button(t('toolbar.cyclePriority')))

    const at = lines(ed).findIndex(([, id]) => id === GS3)
    expect(lines(ed)[at + 1]).toEqual(['  priority:: 2', null])
    expect(button(t('toolbar.cyclePriority'))).toHaveTextContent('P2')
    await saveAndClose(onClose)
    const reread = pageBuffer().text.split('\n')
    expect(reread[reread.indexOf(CREATE) + 1]).toBe('  priority:: 2')
  })

  it('Set due date writes the date picked as the block’s due_date:: line', async () => {
    renderEditor()
    const ed = await loadedEditor()
    const user = userEvent.setup()
    caretAfter(ed, 'Create')

    await user.click(button(t('toolbar.setDueDate')))
    await user.type(await screen.findByLabelText(t('journal.typeDateLabel')), '2026-10-15{Enter}')

    const at = lines(ed).findIndex(([, id]) => id === GS3)
    expect(lines(ed).slice(at, at + 2)).toEqual([
      [CREATE, GS3],
      ['  due_date:: 2026-10-15', null],
    ])
  })

  it('Insert date writes a link to the day’s page at the cursor', async () => {
    renderEditor()
    const ed = await loadedEditor()
    const user = userEvent.setup()
    caretAfter(ed, 'knowledge base.')

    await user.click(button(t('toolbar.insertDate')))
    await user.type(await screen.findByLabelText(t('journal.typeDateLabel')), '2026-10-15{Enter}')

    expect(lineOf(ed, 'Welcome')).toEqual([`${WELCOME}[[2026-10-15]]`, GS1])
  })

  it('Emoji writes the emoji picked at the cursor', async () => {
    renderEditor()
    const ed = await loadedEditor()
    const user = userEvent.setup()
    caretAfter(ed, 'Welcome')

    await user.click(button(t('toolbar.emoji')))
    await user.click(await screen.findByRole('button', { name: 'party popper' }))

    expect(lineOf(ed, 'Agaric')[0]).toBe(`- Welcome🎉 to Agaric! ${WELCOME_TEXT.slice(19)}`)
  })

  it('Insert query replaces the block’s text with the query built, as the block editor writes it', async () => {
    const { onClose, store } = renderEditor()
    const ed = await loadedEditor()
    const user = userEvent.setup()
    caretAfter(ed, 'Create')

    await user.click(button(t('toolbar.insertQuery')))
    await user.type(await screen.findByLabelText(t('queryBuilder.tagPrefix')), 'work')
    await user.click(screen.getByRole('button', { name: t('queryBuilder.insertButton') }))

    expect(lineOf(ed, '{{query')).toEqual(['- {{query type:tag expr:work}}', GS3])
    await saveAndClose(onClose)
    expect(store.getState().blocksById.get(GS3)?.content).toBe('{{query type:tag expr:work}}')
  })

  it('Turn into rewrites the block as the block editor’s Turn into does, and the save keeps it', async () => {
    const { onClose, store } = renderEditor()
    const ed = await loadedEditor()
    const user = userEvent.setup()
    caretAfter(ed, 'Welcome')

    await user.click(button(t('toolbar.turnInto')))
    await user.click(
      within(await screen.findByRole('menu', { name: t('toolbar.turnInto') })).getByRole(
        'menuitemradio',
        { name: t('contextMenu.turnIntoType.h1') },
      ),
    )

    expect(lineOf(ed, 'Welcome')).toEqual([`- # ${WELCOME_TEXT}`, GS1])
    await saveAndClose(onClose)
    expect(store.getState().blocksById.get(GS1)?.content).toBe(
      convertBlockContent(WELCOME_TEXT, 'h1'),
    )
  })

  it('Discard is Cancel: with changes it asks first, and Discard closes the buffer unsaved', async () => {
    const { onClose } = renderEditor()
    const ed = await loadedEditor()
    const user = userEvent.setup()
    caretAfter(ed, 'Welcome')
    await user.click(button(t('toolbar.todoToggle')))
    const before = pageBuffer()

    await user.click(button(t('toolbar.discard')))
    await user.click(await screen.findByRole('button', { name: t('pageSource.discard') }))

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(pageBuffer()).toEqual(before)
  })
})

describe('the block menu', () => {
  async function openMenu(): Promise<HTMLElement> {
    await userEvent.setup().click(button(t('contextMenu.blockActions')))
    return screen.findByRole('menu', { name: t('contextMenu.blockActions') })
  }

  function rows(menu: HTMLElement): string[] {
    return within(menu)
      .getAllByRole('menuitem')
      .map((row) => row.textContent ?? '')
  }

  it('acts on the block whose line starts the run the cursor is in, carrying its text along', async () => {
    const { onClose, store } = renderEditor()
    const ed = await loadedEditor()
    const user = userEvent.setup()
    caretAfter(ed, 'Create new blocks')
    await user.click(button(t('toolbar.newLine')))
    act(() => {
      ed.commands.insertContent('  ')
    })

    const menu = await openMenu()
    await user.click(
      within(menu).getByRole('menuitem', { name: menuRow(t('contextMenu.moveArrange')) }),
    )
    await user.click(within(menu).getByRole('menuitem', { name: menuRow(t('contextMenu.moveUp')) }))

    const ids = lines(ed).map(([, id]) => id)
    expect(ids.indexOf(GS3)).toBe(ids.indexOf(GS2) - 2)
    expect(lines(ed)[ids.indexOf(GS3) + 1]).toEqual([
      '   by pressing Enter at the end of any block.',
      null,
    ])
    await saveAndClose(onClose)
    const order = (store.getState().blocks as Array<{ id: string; parent_id: string | null }>)
      .filter((b) => b.parent_id === PAGE)
      .map((b) => b.id)
    expect(order.slice(0, 3)).toEqual([GS1, GS3, GS2])
  })

  it('Indent nests the block with its lines under the one above, which the save keeps', async () => {
    const { onClose, store } = renderEditor()
    const ed = await loadedEditor()
    const user = userEvent.setup()
    caretAfter(ed, 'Create new blocks')
    await user.click(button(t('toolbar.newLine')))
    act(() => {
      ed.commands.insertContent('  ')
    })

    const menu = await openMenu()
    await user.click(
      within(menu).getByRole('menuitem', { name: menuRow(t('contextMenu.moveArrange')) }),
    )
    await user.click(within(menu).getByRole('menuitem', { name: menuRow(t('contextMenu.indent')) }))

    const at = lines(ed).findIndex(([, id]) => id === GS3)
    expect(lines(ed).slice(at, at + 2)).toEqual([
      ['  - Create new blocks', GS3],
      ['     by pressing Enter at the end of any block.', null],
    ])
    await saveAndClose(onClose)
    const saved = store.getState().blocksById.get(GS3)
    expect(saved?.parent_id).toBe(GS2)
    expect(saved?.content).toBe('Create new blocks\n by pressing Enter at the end of any block.')
  })

  it('Dedent leaves a top-level block and the lines under it where they are', async () => {
    renderEditor()
    const ed = await loadedEditor()
    const user = userEvent.setup()
    caretAfter(ed, 'Create new blocks')
    await user.click(button(t('toolbar.newLine')))
    act(() => {
      ed.commands.insertContent('  ')
    })
    const before = lines(ed)

    const menu = await openMenu()
    await user.click(
      within(menu).getByRole('menuitem', { name: menuRow(t('contextMenu.moveArrange')) }),
    )
    await user.click(within(menu).getByRole('menuitem', { name: menuRow(t('contextMenu.dedent')) }))

    expect(lines(ed)).toEqual(before)
  })

  it('Duplicate copies the block as a new one after it, and Delete takes a block out', async () => {
    const { onClose, store } = renderEditor()
    const ed = await loadedEditor()
    const user = userEvent.setup()
    caretAfter(ed, 'Create')

    let menu = await openMenu()
    await user.click(
      within(menu).getByRole('menuitem', { name: menuRow(t('contextMenu.moveArrange')) }),
    )
    await user.click(
      within(menu).getByRole('menuitem', { name: menuRow(t('contextMenu.duplicate')) }),
    )
    const at = lines(ed).findIndex(([, id]) => id === GS3)
    expect(lines(ed).slice(at, at + 2)).toEqual([
      [CREATE, GS3],
      [CREATE, null],
    ])

    caretAfter(ed, 'Welcome')
    menu = await openMenu()
    await user.click(within(menu).getByRole('menuitem', { name: menuRow(t('contextMenu.delete')) }))
    expect(lines(ed).some(([, id]) => id === GS1)).toBe(false)

    await saveAndClose(onClose)
    const blocks = store.getState().blocks.filter((b) => b.parent_id === PAGE)
    expect(blocks.map((b) => b.id)).not.toContain(GS1)
    expect(blocks.filter((b) => b.content === CREATE.slice(2))).toHaveLength(2)
  })

  it('Turn into, TODO and priority rows rewrite the block at the cursor', async () => {
    renderEditor()
    const ed = await loadedEditor()
    const user = userEvent.setup()
    caretAfter(ed, 'Create')

    let menu = await openMenu()
    await user.click(
      within(menu).getByRole('menuitem', { name: menuRow(t('contextMenu.setTodo')) }),
    )
    menu = await openMenu()
    await user.click(
      within(menu).getByRole('menuitem', { name: menuRow(t('contextMenu.setPriority1')) }),
    )
    menu = await openMenu()
    await user.click(
      within(menu).getByRole('menuitem', { name: menuRow(t('contextMenu.turnInto')) }),
    )
    await user.click(
      within(menu).getByRole('menuitem', { name: t('contextMenu.turnIntoType.numberedList') }),
    )

    const at = lines(ed).findIndex(([, id]) => id === GS3)
    expect(lines(ed).slice(at, at + 2)).toEqual([
      ['- 1. [ ] Create new blocks by pressing Enter at the end of any block.', GS3],
      ['  priority:: 1', null],
    ])
  })

  it('shows none of the rows the buffer leaves out, and no reference to copy for a new block', async () => {
    renderEditor()
    const ed = await loadedEditor()
    const user = userEvent.setup()
    caretAfter(ed, 'Welcome')

    let menu = await openMenu()
    await user.click(
      within(menu).getByRole('menuitem', { name: menuRow(t('contextMenu.moveArrange')) }),
    )
    const shown = rows(menu)
    for (const label of [
      t('contextMenu.zoomIn'),
      t('contextMenu.history'),
      t('contextMenu.properties'),
      t('contextMenu.copyBlockContent'),
      t('contextMenu.merge'),
    ]) {
      expect(shown.some((row) => row.startsWith(label))).toBe(false)
    }
    expect(shown.some((row) => row.startsWith(t('contextMenu.copyBlockRef')))).toBe(true)

    await user.keyboard('{Escape}')
    caretAfter(ed, 'knowledge base.')
    await user.keyboard('{Enter}')
    menu = await openMenu()
    expect(rows(menu).some((row) => row.startsWith(t('contextMenu.copyBlockRef')))).toBe(false)
  })

  it('Copy block reference copies the block’s ((id)), and a failed copy says so', async () => {
    renderEditor()
    const ed = await loadedEditor()
    const user = userEvent.setup()
    caretAfter(ed, 'Welcome')

    let menu = await openMenu()
    await user.click(within(menu).getByRole('menuitem', { name: t('contextMenu.copyBlockRef') }))
    await waitFor(() => expect(pluginWriteText).toHaveBeenCalledWith(`((${GS1}))`))

    const failure = new Error('clipboard denied')
    vi.mocked(pluginWriteText).mockRejectedValueOnce(failure)
    const fallback = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(failure)
    try {
      menu = await openMenu()
      await user.click(within(menu).getByRole('menuitem', { name: t('contextMenu.copyBlockRef') }))
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(t('contextMenu.copyRefFailed')))
      expect(fallback).toHaveBeenCalledWith(`((${GS1}))`)
    } finally {
      fallback.mockRestore()
    }
  })

  it('is off in the front matter, where no block is', async () => {
    renderEditor()
    const ed = await loadedEditor()
    caretAfter(ed, 'aliases')

    expect(button(t('contextMenu.blockActions'))).toBeDisabled()
  })

  it('has no a11y violations while open', async () => {
    const { container } = renderEditor()
    const ed = await loadedEditor()
    caretAfter(ed, 'Welcome')
    await openMenu()

    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})

describe('on a phone', () => {
  beforeEach(() => {
    touch.value = true
  })

  it('the toolbar is pinned and carries New line, Cancel and Save, the row under the buffer gone', async () => {
    renderEditor()
    await loadedEditor()

    expect(toolbar()).toHaveAttribute('data-pinned', 'true')
    const names = within(toolbar())
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label') ?? b.textContent)
    expect(names).toContain(t('toolbar.newLine'))
    expect(names.slice(-3)).toEqual([
      t('contextMenu.blockActions'),
      t('action.cancel'),
      t('action.save'),
    ])
    expect(screen.getAllByRole('button', { name: t('action.save') })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: t('action.cancel') })).toHaveLength(1)
  })

  it('Save saves the buffer and closes it', async () => {
    const { onClose, store } = renderEditor()
    const ed = await loadedEditor()
    act(() => {
      ed.view.dispatch(ed.state.tr.insertText(' Saved.', positionOf(ed, 'knowledge base.', 15)))
    })

    await userEvent.setup().click(button(t('action.save')))

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(store.getState().blocksById.get(GS1)?.content).toBe(`${WELCOME_TEXT} Saved.`)
  })

  it('a refused Save shows why and keeps the buffer open', async () => {
    const { onClose } = renderEditor()
    const ed = await loadedEditor()
    act(() => {
      ed.view.dispatch(ed.state.tr.insertText(' Saved.', positionOf(ed, 'knowledge base.', 15)))
    })
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) =>
      cmd === 'apply_page_source'
        ? Promise.reject({ kind: 'validation', message: 'line 5: refused' })
        : dispatch(cmd, args),
    )

    await userEvent.setup().click(button(t('action.save')))

    expect(await screen.findByRole('alert')).toHaveTextContent('line 5: refused')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Cancel with changes asks first', async () => {
    renderEditor()
    const ed = await loadedEditor()
    caretAfter(ed, 'Welcome')
    const user = userEvent.setup()
    await user.click(button(t('toolbar.todoToggle')))

    await user.click(button(t('action.cancel')))

    expect(await screen.findByRole('alertdialog')).toHaveTextContent(t('pageSource.discardTitle'))
  })

  it('has no a11y violations', async () => {
    const { container } = renderEditor()
    await loadedEditor()

    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
