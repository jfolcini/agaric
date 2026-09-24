/**
 * PageSourceEditor + PageSourceConflictDialog — source mode (#5140 Phase 4b).
 *
 * The save paths that change the page run against the REAL tauri-mock
 * dispatch and re-read the page's source afterwards; the paths that only
 * decide what to show stub the two IPCs.
 */

import type { InvokeArgs } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { type CommandReturns, deferred, mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { PageSourceConflictDialog } from '@/components/pages/PageSourceConflictDialog'
import { PageSourceEditor } from '@/components/pages/PageSourceEditor'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'
import { createPageBlockStore, PageBlockContext } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'
import { useUndoStore } from '@/stores/undo'

const mockedInvoke = vi.mocked(invoke)

const PAGE_ID = '01J00000000000000000000PAG'
const A = '01J0000000000000000000000A'
const B = '01J0000000000000000000000B'
const BUFFER = `- first ^${A}\n- second ^${B}\n`
const draftKey = (pageId = PAGE_ID): string => `agaric-page-source-draft:${pageId}`

function report(
  overrides: Partial<CommandReturns['apply_page_source']> = {},
): CommandReturns['apply_page_source'] {
  return {
    op_refs: [{ device_id: 'dev1', seq: 1 }],
    created: 0,
    edited: 0,
    moved: 0,
    deleted: 0,
    properties_set: 0,
    properties_deleted: 0,
    names_created: [],
    warnings: [],
    ...overrides,
  }
}

/** `get_page_source` answers BUFFER; `apply_page_source` as given. */
function stubSource(applyPageSource: () => unknown = () => report()): void {
  mockedInvoke.mockImplementation(
    mockInvokeCommands({
      get_page_source: () => BUFFER,
      apply_page_source: applyPageSource as () => CommandReturns['apply_page_source'],
      load_page_subtree: () => ({ blocks: [], truncated: false, total: 0 }),
    }),
  )
}

/** Every IPC goes to the real tauri-mock; returns the seeded page's source. */
function routeToMockBackend(): string {
  seedBlocks()
  useSpaceStore.setState({ currentSpaceId: 'SPACE_PERSONAL' })
  mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
  return pageSource(SEED_IDS.PAGE_GETTING_STARTED)
}

function pageSource(pageId: string): string {
  return dispatch('get_page_source', { pageId }) as string
}

function renderEditor(pageId = PAGE_ID) {
  const onClose = vi.fn()
  const store = createPageBlockStore(pageId)
  const utils = render(
    <PageBlockContext.Provider value={store}>
      <PageSourceEditor pageId={pageId} onClose={onClose} />
    </PageBlockContext.Provider>,
  )
  return { ...utils, onClose, store }
}

async function loadedEditor(): Promise<HTMLTextAreaElement> {
  const textarea = await screen.findByRole('textbox', { name: t('pageSource.editorLabel') })
  return textarea as HTMLTextAreaElement
}

async function replaceBuffer(
  user: ReturnType<typeof userEvent.setup>,
  textarea: HTMLTextAreaElement,
  text: string,
): Promise<void> {
  await user.clear(textarea)
  if (text !== '') await user.paste(text)
}

function applyCalls(): unknown[] {
  return mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'apply_page_source').map(([, a]) => a)
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useSpaceStore.setState({ currentSpaceId: 'SPACE_TEST' })
  useUndoStore.setState({ pages: new Map() })
  stubSource()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PageSourceEditor loading', () => {
  it('shows the page source in a focused textarea', async () => {
    renderEditor()

    const textarea = await loadedEditor()
    expect(textarea.value).toBe(BUFFER)
    expect(textarea).toHaveFocus()
    expect(textarea).toHaveAttribute('data-testid', 'page-source-editor')
  })

  it('a rejected load shows the load-failed alert, logs, and Close closes', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const failure = { kind: 'not_found', message: `page '${PAGE_ID}' not found` }
    mockedInvoke.mockImplementation(
      mockInvokeCommands({ get_page_source: () => Promise.reject(failure) }),
    )
    const user = userEvent.setup()
    const { onClose } = renderEditor()

    expect(await screen.findByRole('alert')).toHaveTextContent(t('pageSource.loadFailed'))
    expect(errorSpy).toHaveBeenCalledWith(
      'PageSourceEditor',
      'Failed to load page source',
      { pageId: PAGE_ID },
      failure,
    )
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: t('ui.close') }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('has no a11y violations once loaded', async () => {
    const { container } = renderEditor()
    await loadedEditor()

    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})

describe('PageSourceEditor saving', () => {
  it('Save writes the edited buffer against its base, closes, and the page reads back as the buffer', async () => {
    const base = routeToMockBackend()
    const { BLOCK_GS_1, PAGE_GETTING_STARTED } = SEED_IDS
    const text = base.replace('- Welcome to Agaric!', '- Hello, Agaric!')
    const user = userEvent.setup()
    const { onClose, store } = renderEditor(PAGE_GETTING_STARTED)
    const textarea = await loadedEditor()
    expect(textarea.value).toBe(base)

    await replaceBuffer(user, textarea, text)
    await user.click(screen.getByRole('button', { name: t('action.save') }))

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce()
    })
    expect(applyCalls()).toEqual([
      { pageId: PAGE_GETTING_STARTED, source: text, baseSource: base, force: false, merge: false },
    ])
    expect(pageSource(PAGE_GETTING_STARTED)).toBe(text)
    expect(store.getState().blocksById.get(BLOCK_GS_1)?.content).toBe(
      'Hello, Agaric! This is your personal knowledge base.',
    )
    expect(useUndoStore.getState().pages.get(PAGE_GETTING_STARTED)?.undoStack).toHaveLength(1)
  })

  it('Save with the buffer unchanged closes without any IPC', async () => {
    const user = userEvent.setup()
    const { onClose } = renderEditor()
    await loadedEditor()

    await user.click(screen.getByRole('button', { name: t('action.save') }))

    expect(onClose).toHaveBeenCalledOnce()
    expect(mockedInvoke.mock.calls.map(([cmd]) => cmd)).toEqual(['get_page_source'])
  })

  it('Mod+Enter in the textarea saves', async () => {
    const base = routeToMockBackend()
    const { PAGE_GETTING_STARTED } = SEED_IDS
    const text = base.replace('- Welcome to Agaric!', '- Hello, Agaric!')
    const user = userEvent.setup()
    const { onClose } = renderEditor(PAGE_GETTING_STARTED)
    await replaceBuffer(user, await loadedEditor(), text)

    await user.keyboard('{Control>}{Enter}{/Control}')

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce()
    })
    expect(pageSource(PAGE_GETTING_STARTED)).toBe(text)
  })

  it('a second Mod+Enter while the save is in flight does not save again', async () => {
    const base = routeToMockBackend()
    const gate = deferred<void>()
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'apply_page_source') await gate.promise
      return dispatch(cmd, args)
    })
    const { PAGE_GETTING_STARTED } = SEED_IDS
    const text = base.replace('- Welcome to Agaric!', '- Hello, Agaric!')
    const user = userEvent.setup()
    const { onClose } = renderEditor(PAGE_GETTING_STARTED)
    await replaceBuffer(user, await loadedEditor(), text)

    await user.keyboard('{Control>}{Enter}{Enter}{/Control}')
    gate.resolve()

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce()
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(pageSource(PAGE_GETTING_STARTED)).toBe(text)
    expect(useUndoStore.getState().pages.get(PAGE_GETTING_STARTED)?.undoStack).toHaveLength(1)
  })

  it('disables Save while the save is in flight', async () => {
    const pending = deferred<CommandReturns['apply_page_source']>()
    stubSource(() => pending.promise)
    const user = userEvent.setup()
    const { onClose } = renderEditor()
    const textarea = await loadedEditor()
    await user.type(textarea, 'x')

    await user.click(screen.getByRole('button', { name: t('action.save') }))

    expect(screen.getByRole('button', { name: t('action.save') })).toBeDisabled()
    expect(textarea).toHaveAttribute('readonly')
    pending.resolve(report())
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce()
    })
  })

  it('shows the save warnings in one toast', async () => {
    const warnings = [`^${A} no longer on this page; saved as a new block`, 'second warning']
    stubSource(() => report({ warnings }))
    const user = userEvent.setup()
    const { onClose } = renderEditor()
    await user.type(await loadedEditor(), 'x')

    await user.click(screen.getByRole('button', { name: t('action.save') }))

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce()
    })
    expect(vi.mocked(toast.warning).mock.calls).toEqual([
      [t('pageSource.warnings', { warnings: warnings.join('; ') })],
    ])
  })

  it('a rejected save shows the backend message inline, logs, and keeps the buffer open', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const failure = { kind: 'validation', message: `^${A} appears more than once` }
    stubSource(() => Promise.reject(failure))
    const user = userEvent.setup()
    const { onClose } = renderEditor()
    const textarea = await loadedEditor()
    await user.type(textarea, '- dup')

    await user.click(screen.getByRole('button', { name: t('action.save') }))

    expect(await screen.findByRole('alert')).toHaveTextContent(failure.message)
    expect(textarea.value).toBe(`${BUFFER}- dup`)
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(warnSpy).toHaveBeenCalledWith(
      'PageSourceEditor',
      'Failed to save page source',
      { pageId: PAGE_ID },
      failure,
    )
  })
})

describe('PageSourceEditor emptying the page', () => {
  it('asks before deleting every block: Cancel keeps the buffer, Delete all saves it', async () => {
    const base = routeToMockBackend()
    const { PAGE_GETTING_STARTED } = SEED_IDS
    const user = userEvent.setup()
    const { onClose } = renderEditor(PAGE_GETTING_STARTED)
    const textarea = await loadedEditor()
    await replaceBuffer(user, textarea, '  \n')

    await user.click(screen.getByRole('button', { name: t('action.save') }))
    const confirm = await screen.findByRole('alertdialog', {
      name: t('pageSource.deleteAllTitle'),
    })
    await user.click(within(confirm).getByRole('button', { name: t('dialog.cancel') }))

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })
    expect(pageSource(PAGE_GETTING_STARTED)).toBe(base)
    expect(textarea.value).toBe('  \n')
    expect(onClose).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: t('action.save') }))
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: t('pageSource.deleteAll'),
      }),
    )

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce()
    })
    expect(pageSource(PAGE_GETTING_STARTED)).toBe('')
  })
})

describe('PageSourceEditor when the page changed elsewhere', () => {
  const ELSEWHERE = 'Edited on another device'

  const HELLO = (source: string): string =>
    source.replace('- Welcome to Agaric!', '- Hello, Agaric!')

  /** Opens the seeded page, edits the buffer, changes a block behind its back, and saves. */
  async function saveOverAChange(edit: (source: string) => string = HELLO) {
    const base = routeToMockBackend()
    const { BLOCK_GS_3, PAGE_GETTING_STARTED } = SEED_IDS
    const text = edit(base)
    const user = userEvent.setup()
    const rendered = renderEditor(PAGE_GETTING_STARTED)
    const textarea = await loadedEditor()
    await replaceBuffer(user, textarea, text)
    dispatch('edit_block', { blockId: BLOCK_GS_3, toText: ELSEWHERE })
    const current = pageSource(PAGE_GETTING_STARTED)

    await user.click(screen.getByRole('button', { name: t('action.save') }))
    const dialog = await screen.findByRole('dialog', { name: t('pageSource.conflictTitle') })
    return { ...rendered, base, current, dialog, text, textarea, user }
  }

  it('opens the conflict dialog listing what changed since the buffer was loaded', async () => {
    const { dialog, onClose } = await saveOverAChange()

    const row = within(dialog).getByText(`- ${ELSEWHERE} ^${SEED_IDS.BLOCK_GS_3}`)
    expect(row.closest('li')).toHaveTextContent(t('pageSource.changeChanged'))
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Overwrite saves the buffer with force against the page as it is now, and the buffer wins', async () => {
    const { base, current, dialog, onClose, text, user } = await saveOverAChange()
    const { PAGE_GETTING_STARTED } = SEED_IDS

    await user.click(within(dialog).getByRole('button', { name: t('pageSource.overwrite') }))

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce()
    })
    expect(applyCalls()).toEqual([
      { pageId: PAGE_GETTING_STARTED, source: text, baseSource: base, force: false, merge: false },
      {
        pageId: PAGE_GETTING_STARTED,
        source: text,
        baseSource: current,
        force: true,
        merge: false,
      },
    ])
    expect(pageSource(PAGE_GETTING_STARTED)).toBe(text)
  })

  it('Merge saves the buffer against its own base with the change made elsewhere folded in, as one undo entry', async () => {
    const { current, dialog, onClose, user } = await saveOverAChange()
    const { PAGE_GETTING_STARTED } = SEED_IDS
    await waitFor(() => {
      expect(localStorage.getItem(draftKey(PAGE_GETTING_STARTED))).not.toBeNull()
    })

    await user.click(within(dialog).getByRole('button', { name: t('pageSource.merge') }))

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce()
    })
    expect(pageSource(PAGE_GETTING_STARTED)).toBe(HELLO(current))
    expect(useUndoStore.getState().pages.get(PAGE_GETTING_STARTED)?.undoStack).toHaveLength(1)
    expect(localStorage.getItem(draftKey(PAGE_GETTING_STARTED))).toBeNull()
    expect(vi.mocked(toast.warning)).not.toHaveBeenCalled()
  })

  it("Merge keeps both versions of a block changed on both sides, the buffer's first, and warns", async () => {
    const mine = '- Mine: new blocks by pressing Enter'
    const { current, dialog, onClose, user } = await saveOverAChange((source) =>
      source.replace('- Create new blocks by pressing Enter', mine),
    )
    const withoutAnchors = (source: string): string => source.replace(/ \^\w{26}$/gm, '')

    await user.click(within(dialog).getByRole('button', { name: t('pageSource.merge') }))

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce()
    })
    expect(withoutAnchors(pageSource(SEED_IDS.PAGE_GETTING_STARTED))).toBe(
      withoutAnchors(
        current.replace(`- ${ELSEWHERE}`, `${mine} at the end of any block.\n- ${ELSEWHERE}`),
      ),
    )
    expect(vi.mocked(toast.warning)).toHaveBeenCalledOnce()
  })

  it('a refused Merge shows the backend message inline and keeps the buffer', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const failure = { kind: 'validation', message: `^${A} is not a block of this page` }
    const replies = [{ kind: 'validation', code: 'RequiresRefresh', message: 'stale' }, failure]
    stubSource(() => Promise.reject(replies.shift()))
    const user = userEvent.setup()
    const { onClose } = renderEditor()
    const textarea = await loadedEditor()
    await user.type(textarea, 'x')
    await user.click(screen.getByRole('button', { name: t('action.save') }))
    const dialog = await screen.findByRole('dialog', { name: t('pageSource.conflictTitle') })

    await user.click(within(dialog).getByRole('button', { name: t('pageSource.merge') }))

    expect(await screen.findByRole('alert')).toHaveTextContent(failure.message)
    expect(textarea.value).toBe(`${BUFFER}x`)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Reload replaces the buffer and its base with the page as it is now and drops the draft', async () => {
    const { current, dialog, onClose, textarea, user } = await saveOverAChange()
    await waitFor(() => {
      expect(localStorage.getItem(draftKey(SEED_IDS.PAGE_GETTING_STARTED))).not.toBeNull()
    })

    await user.click(within(dialog).getByRole('button', { name: t('action.reload') }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(textarea.value).toBe(current)
    expect(localStorage.getItem(draftKey(SEED_IDS.PAGE_GETTING_STARTED))).toBeNull()
    // The new base is the page as it is now, so the reloaded buffer saves without a conflict.
    await user.type(textarea, '- after reload')
    await user.click(screen.getByRole('button', { name: t('action.save') }))
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce()
    })
    expect(pageSource(SEED_IDS.PAGE_GETTING_STARTED)).toContain('\n- after reload ^')
  })

  it('Keep editing closes the dialog and keeps the buffer', async () => {
    const { dialog, onClose, text, textarea, user } = await saveOverAChange()

    await user.click(within(dialog).getByRole('button', { name: t('pageSource.keepEditing') }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    await waitFor(() => {
      expect(textarea).toHaveFocus()
    })
    expect(textarea.value).toBe(text)
    expect(applyCalls()).toHaveLength(1)
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('PageSourceEditor draft', () => {
  it('writes the buffer as a draft while it differs from its base, and drops it when it matches again', async () => {
    const user = userEvent.setup()
    renderEditor()
    const textarea = await loadedEditor()

    await user.type(textarea, 'x')
    await waitFor(() => {
      expect(localStorage.getItem(draftKey())).toBe(
        JSON.stringify({ base: BUFFER, text: `${BUFFER}x` }),
      )
    })

    await user.type(textarea, '{Backspace}')
    await waitFor(() => {
      expect(localStorage.getItem(draftKey())).toBeNull()
    })
  })

  // `fireEvent.change` then `unmount()` run in one task, so the 300 ms timer cannot fire between.
  it('leaving before the debounce fires still stores the last keystrokes', async () => {
    const { unmount } = renderEditor()
    const textarea = await loadedEditor()

    fireEvent.change(textarea, { target: { value: `${BUFFER}x` } })
    unmount()

    expect(localStorage.getItem(draftKey())).toBe(
      JSON.stringify({ base: BUFFER, text: `${BUFFER}x` }),
    )
  })

  it('leaving after Cancel stores nothing', async () => {
    const user = userEvent.setup()
    const { unmount } = renderEditor()
    const textarea = await loadedEditor()
    fireEvent.change(textarea, { target: { value: `${BUFFER}x` } })

    await user.click(screen.getByRole('button', { name: t('action.cancel') }))
    unmount()

    expect(localStorage.getItem(draftKey())).toBeNull()
  })

  it('restores a stored draft over the fresh source, says so, saves it and clears it', async () => {
    const base = routeToMockBackend()
    const { PAGE_GETTING_STARTED } = SEED_IDS
    const draft = { base, text: base.replace('- Welcome to Agaric!', '- Hello, Agaric!') }
    localStorage.setItem(draftKey(PAGE_GETTING_STARTED), JSON.stringify(draft))
    const user = userEvent.setup()
    const { onClose } = renderEditor(PAGE_GETTING_STARTED)
    const textarea = await loadedEditor()

    expect(textarea.value).toBe(draft.text)
    expect(textarea).toHaveAccessibleDescription(
      `${t('pageSource.draftRestored')} ${t('pageSource.hint')}`,
    )

    await user.click(screen.getByRole('button', { name: t('action.save') }))

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce()
    })
    expect(pageSource(PAGE_GETTING_STARTED)).toBe(draft.text)
    expect(localStorage.getItem(draftKey(PAGE_GETTING_STARTED))).toBeNull()
  })

  it('a restored draft the page has changed since saves nothing and opens the conflict dialog', async () => {
    const now = routeToMockBackend()
    const { BLOCK_GS_1, PAGE_GETTING_STARTED } = SEED_IDS
    const draftBase = now.replace('- Welcome to Agaric!', '- Welcome, before an edit elsewhere!')
    const draft = { base: draftBase, text: `${draftBase}- mine\n` }
    localStorage.setItem(draftKey(PAGE_GETTING_STARTED), JSON.stringify(draft))
    const user = userEvent.setup()
    const { onClose } = renderEditor(PAGE_GETTING_STARTED)
    await loadedEditor()

    await user.click(screen.getByRole('button', { name: t('action.save') }))

    const dialog = await screen.findByRole('dialog', { name: t('pageSource.conflictTitle') })
    const gs1Now = now.split('\n').find((line) => line.endsWith(` ^${BLOCK_GS_1}`)) as string
    expect(within(dialog).getByText(gs1Now).closest('li')).toHaveTextContent(
      t('pageSource.changeChanged'),
    )
    expect(pageSource(PAGE_GETTING_STARTED)).toBe(now)
    expect(onClose).not.toHaveBeenCalled()
    expect(localStorage.getItem(draftKey(PAGE_GETTING_STARTED))).toBe(JSON.stringify(draft))
  })

  it('Cancel drops the draft and closes without saving', async () => {
    localStorage.setItem(draftKey(), JSON.stringify({ base: BUFFER, text: `${BUFFER}x` }))
    const user = userEvent.setup()
    const { onClose } = renderEditor()
    await loadedEditor()

    await user.click(screen.getByRole('button', { name: t('action.cancel') }))

    expect(onClose).toHaveBeenCalledOnce()
    expect(localStorage.getItem(draftKey())).toBeNull()
    expect(applyCalls()).toEqual([])
  })

  it.each([
    ['not JSON', '{not json'],
    ['missing its text', JSON.stringify({ base: BUFFER })],
    ['with a non-string base', JSON.stringify({ base: 1, text: BUFFER })],
  ])('ignores a draft that is %s and shows the fresh source', async (_, stored) => {
    localStorage.setItem(draftKey(), stored)
    renderEditor()

    const textarea = await loadedEditor()

    expect(textarea.value).toBe(BUFFER)
    expect(textarea).toHaveAccessibleDescription(t('pageSource.hint'))
  })
})

describe('PageSourceConflictDialog', () => {
  const base = `- one ^${A}\n- two ^${B}\n`

  it('says only the order changed when no block did', () => {
    render(
      <PageSourceConflictDialog
        base={base}
        current={`- two ^${B}\n- one ^${A}\n`}
        onMerge={vi.fn()}
        onReload={vi.fn()}
        onOverwrite={vi.fn()}
        onKeepEditing={vi.fn()}
        onCloseAutoFocus={vi.fn()}
      />,
    )

    const dialog = screen.getByRole('dialog', { name: t('pageSource.conflictTitle') })
    expect(within(dialog).getByText(t('pageSource.onlyOrderChanged'))).toBeInTheDocument()
    expect(within(dialog).queryByRole('list')).not.toBeInTheDocument()
  })

  it('offers Merge as the primary action: last, focused on open, described by what it does', async () => {
    const onMerge = vi.fn()
    const user = userEvent.setup()
    render(
      <PageSourceConflictDialog
        base={base}
        current={`- one ^${A}\n`}
        onMerge={onMerge}
        onReload={vi.fn()}
        onOverwrite={vi.fn()}
        onKeepEditing={vi.fn()}
        onCloseAutoFocus={vi.fn()}
      />,
    )

    const dialog = screen.getByRole('dialog')
    const footer = dialog.querySelector('[data-slot="dialog-footer"]') as HTMLElement
    expect(
      within(footer)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([
      t('pageSource.overwrite'),
      t('action.reload'),
      t('pageSource.keepEditing'),
      t('pageSource.merge'),
    ])
    const merge = within(footer).getByRole('button', { name: t('pageSource.merge') })
    expect(merge).toHaveFocus()
    expect(merge).toHaveAccessibleDescription(t('pageSource.mergeHint'))
    await user.click(merge)
    expect(onMerge).toHaveBeenCalledOnce()
  })

  it('describes Overwrite with its warning and closing it keeps editing', async () => {
    const onKeepEditing = vi.fn()
    const user = userEvent.setup()
    render(
      <PageSourceConflictDialog
        base={base}
        current={`- one ^${A}\n`}
        onMerge={vi.fn()}
        onReload={vi.fn()}
        onOverwrite={vi.fn()}
        onKeepEditing={onKeepEditing}
        onCloseAutoFocus={vi.fn()}
      />,
    )

    expect(
      screen.getByRole('button', { name: t('pageSource.overwrite') }),
    ).toHaveAccessibleDescription(t('pageSource.overwriteWarning'))
    await user.keyboard('{Escape}')
    expect(onKeepEditing).toHaveBeenCalledOnce()
  })

  it('has no a11y violations listing changes', async () => {
    render(
      <PageSourceConflictDialog
        base={base}
        current={`- one, edited ^${A}\n- three\n`}
        onMerge={vi.fn()}
        onReload={vi.fn()}
        onOverwrite={vi.fn()}
        onKeepEditing={vi.fn()}
        onCloseAutoFocus={vi.fn()}
      />,
    )

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(3)
    await waitFor(async () => {
      expect(await axe(dialog)).toHaveNoViolations()
    })
  })
})
