/**
 * PageSourceEditor's link back to page mode (#5691), GitLab's "Switch to rich text editing": a
 * buffer as loaded switches at once, a changed one is saved first and switches once the save
 * lands. A refusal, a conflict kept editing and an emptied page left alone keep the buffer open,
 * and the next plain Save closes it as Save always does. The saves run against the REAL tauri-mock
 * dispatch; refusals stub the IPC.
 */

import type { InvokeArgs } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { type CommandReturns, mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { PageSourceEditor } from '@/components/pages/PageSourceEditor'
import type { PageBuffer } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'
import { createPageBlockStore, PageBlockContext } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'
import { useUndoStore } from '@/stores/undo'

vi.mock('@/components/pages/PageSourceToolbar', () => ({ PageSourceToolbar: () => null }))

const mockedInvoke = vi.mocked(invoke)
const PAGE = SEED_IDS.PAGE_GETTING_STARTED
const WELCOME = '- Welcome to Agaric!'
const HELLO = '- Hello, Agaric!'
const BLOCKED = 'Too many blocks for page mode.'

function pageBuffer(): PageBuffer {
  return dispatch('get_page_buffer', { pageId: PAGE }) as PageBuffer
}

/** Every IPC goes to the real tauri-mock; returns the seeded page's buffer. */
function routeToMockBackend(): PageBuffer {
  seedBlocks()
  useSpaceStore.setState({ currentSpaceId: 'SPACE_PERSONAL' })
  mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
  return pageBuffer()
}

/** The mock backend, but `apply_page_source` answers `replies` in turn, then saves as the mock does. */
function routeWithReplies(replies: unknown[]): void {
  routeToMockBackend()
  mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
    if (cmd === 'apply_page_source' && replies.length > 0) throw replies.shift()
    return dispatch(cmd, args)
  })
}

function renderEditor(props: { switchable?: boolean; blocked?: string | null } = {}) {
  const { switchable = true, blocked = null } = props
  const onClose = vi.fn()
  const onSwitchToPage = vi.fn()
  const store = createPageBlockStore(PAGE)
  const utils = render(
    <PageBlockContext.Provider value={store}>
      <PageSourceEditor
        pageId={PAGE}
        onClose={onClose}
        onSwitchToPage={switchable ? onSwitchToPage : undefined}
        pageModeBlocked={blocked}
      />
    </PageBlockContext.Provider>,
  )
  return { ...utils, onClose, onSwitchToPage }
}

async function loadedEditor(): Promise<HTMLElement> {
  return screen.findByRole('textbox', { name: t('pageSource.editorLabel') })
}

function editorOf(box: HTMLElement): Editor {
  return (box as HTMLElement & { editor: Editor }).editor
}

/** Replace `find` with `replacement`, as typing over it does. */
function edit(box: HTMLElement, find: string, replacement: string): void {
  const ed = editorOf(box)
  let from = -1
  ed.state.doc.descendants((node, pos) => {
    if (from === -1 && node.isText && node.text?.includes(find)) {
      from = pos + (node.text?.indexOf(find) ?? 0)
    }
  })
  if (from === -1) throw new Error(`no text ${find}`)
  act(() => {
    ed.view.dispatch(ed.state.tr.insertText(replacement, from, from + find.length))
  })
}

function pageLink(): HTMLElement {
  return screen.getByRole('button', { name: t('pageMode.page') })
}

function saveButton(): HTMLElement {
  return screen.getByRole('button', { name: /^Save(?: \(\d+ changes?\))?$/ })
}

function applyCount(): number {
  return mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'apply_page_source').length
}

/** Edit the buffer, change a block behind its back, and press the link: the conflict dialog. */
async function linkOverAChange() {
  routeToMockBackend()
  const user = userEvent.setup()
  const rendered = renderEditor()
  const box = await loadedEditor()
  edit(box, WELCOME, HELLO)
  dispatch('edit_block', { blockId: SEED_IDS.BLOCK_GS_3, toText: 'Edited on another device' })

  await user.click(pageLink())
  const dialog = await screen.findByRole('dialog', { name: t('pageSource.conflictTitle') })
  return { ...rendered, box, dialog, user }
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useUndoStore.setState({ pages: new Map() })
  mockedInvoke.mockImplementation(
    mockInvokeCommands({
      get_page_buffer: () => ({ source: '- first\n', text: '- first\n', line_ids: [null] }),
      load_page_subtree: () => ({ blocks: [], truncated: false, total: 0 }),
      apply_page_source: () => ({}) as CommandReturns['apply_page_source'],
    }),
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PageSourceEditor link to page mode', () => {
  it('is absent where page mode is not offered', async () => {
    renderEditor({ switchable: false })
    await loadedEditor()

    expect(screen.queryByRole('button', { name: t('pageMode.page') })).not.toBeInTheDocument()
  })

  it('is beside Cancel and Save, its tooltip naming it and its shortcut, with no a11y violations', async () => {
    const user = userEvent.setup()
    const { container } = renderEditor()
    await loadedEditor()

    expect(pageLink().parentElement).toBe(
      screen.getByRole('button', { name: t('action.cancel') }).parentElement,
    )
    await user.hover(pageLink())
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      `${t('pageMode.pageHint')} (Ctrl + E / Ctrl + Shift + M)`,
    )
    expect(await axe(container)).toHaveNoViolations()
  })

  it('where page mode cannot show the page, says why and pressing it does nothing', async () => {
    const user = userEvent.setup()
    const { onSwitchToPage, onClose } = renderEditor({ blocked: BLOCKED })
    await loadedEditor()
    const link = pageLink()

    expect(link).toHaveAttribute('aria-disabled', 'true')
    expect(link).toHaveAccessibleDescription(BLOCKED)
    await user.click(link)

    expect(onSwitchToPage).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('with the buffer as loaded, switches without a save', async () => {
    const user = userEvent.setup()
    const { onSwitchToPage, onClose } = renderEditor()
    await loadedEditor()

    await user.click(pageLink())

    expect(onSwitchToPage).toHaveBeenCalledOnce()
    expect(onClose).not.toHaveBeenCalled()
    expect(applyCount()).toBe(0)
  })

  it('Ctrl+E in the buffer switches, as the tooltip says', async () => {
    const user = userEvent.setup()
    const { onSwitchToPage } = renderEditor()
    await loadedEditor()

    await user.keyboard('{Control>}e{/Control}')

    expect(onSwitchToPage).toHaveBeenCalledOnce()
  })

  it('with the buffer changed, saves it and switches instead of closing', async () => {
    const base = routeToMockBackend()
    const user = userEvent.setup()
    const { onSwitchToPage, onClose } = renderEditor()
    const box = await loadedEditor()
    edit(box, WELCOME, HELLO)

    await user.click(pageLink())

    await waitFor(() => expect(onSwitchToPage).toHaveBeenCalledOnce())
    expect(onClose).not.toHaveBeenCalled()
    expect(pageBuffer().text).toBe(base.text.replace(WELCOME, HELLO))
  })

  it('a refused save stays in Markdown, and the next Save closes', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const refusal = { kind: 'validation', message: "line 5: 'due' takes a date" }
    routeWithReplies([refusal])
    const user = userEvent.setup()
    const { onSwitchToPage, onClose } = renderEditor()
    const box = await loadedEditor()
    edit(box, WELCOME, HELLO)

    await user.click(pageLink())

    expect(await screen.findByRole('alert')).toHaveTextContent(refusal.message)
    expect(onSwitchToPage).not.toHaveBeenCalled()
    await user.click(saveButton())
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(onSwitchToPage).not.toHaveBeenCalled()
  })

  it.each([
    ['Merge', 'pageSource.merge'],
    ['Overwrite', 'pageSource.overwrite'],
  ] as const)('a conflict resolved by %s saves and switches', async (_, key) => {
    const { dialog, onClose, onSwitchToPage, user } = await linkOverAChange()

    await user.click(within(dialog).getByRole('button', { name: t(key) }))

    await waitFor(() => expect(onSwitchToPage).toHaveBeenCalledOnce())
    expect(onClose).not.toHaveBeenCalled()
    expect(pageBuffer().text).toContain(HELLO)
  })

  it('a conflict kept editing stays in Markdown, and the next save closes', async () => {
    const { dialog, onClose, onSwitchToPage, user } = await linkOverAChange()

    await user.click(within(dialog).getByRole('button', { name: t('pageSource.keepEditing') }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(onSwitchToPage).not.toHaveBeenCalled()

    await user.click(saveButton())
    const again = await screen.findByRole('dialog', { name: t('pageSource.conflictTitle') })
    await user.click(within(again).getByRole('button', { name: t('pageSource.overwrite') }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(onSwitchToPage).not.toHaveBeenCalled()
  })

  it('a conflict reloaded stays in Markdown on the page as it is now, and the next save closes', async () => {
    const { dialog, onClose, onSwitchToPage, user } = await linkOverAChange()

    await user.click(within(dialog).getByRole('button', { name: t('action.reload') }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(onSwitchToPage).not.toHaveBeenCalled()

    edit(await loadedEditor(), WELCOME, HELLO)
    await user.click(saveButton())
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(onSwitchToPage).not.toHaveBeenCalled()
  })

  it('an emptied page asks first: Cancel stays in Markdown, and Delete all from Save closes', async () => {
    routeToMockBackend()
    const user = userEvent.setup()
    const { onSwitchToPage, onClose } = renderEditor()
    const box = await loadedEditor()
    act(() => {
      editorOf(box).chain().selectAll().deleteSelection().run()
    })

    await user.click(pageLink())
    const confirm = await screen.findByRole('alertdialog', {
      name: t('pageSource.deleteAllTitle'),
    })
    await user.click(within(confirm).getByRole('button', { name: t('dialog.cancel') }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(onSwitchToPage).not.toHaveBeenCalled()
    expect(applyCount()).toBe(0)

    await user.click(saveButton())
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: t('pageSource.deleteAll'),
      }),
    )
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(onSwitchToPage).not.toHaveBeenCalled()
  })

  it('an emptied page confirmed from the link saves and switches', async () => {
    routeToMockBackend()
    const user = userEvent.setup()
    const { onSwitchToPage, onClose } = renderEditor()
    const box = await loadedEditor()
    act(() => {
      editorOf(box).chain().selectAll().deleteSelection().run()
    })

    await user.click(pageLink())
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: t('pageSource.deleteAll'),
      }),
    )

    await waitFor(() => expect(onSwitchToPage).toHaveBeenCalledOnce())
    expect(onClose).not.toHaveBeenCalled()
    expect(pageBuffer().text).toBe('')
  })
})
