/**
 * NewPageDialog (#5637) against the in-memory backend (`tauri-mock`), so
 * every create is asserted by re-querying the space's pages, not by the
 * shape of the IPC call.
 *
 * The seed's Personal space holds, among others, `Meetings`, `Projects`
 * (alias `proj`), `Getting Started` (aliases `gs`, `getting-started`) and
 * `Meeting Notes Template`. Searches are debounced (300 ms) under fake timers.
 */

import { invoke, type InvokeArgs } from '@tauri-apps/api/core'
import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { useBlockResolve } from '@/components/block-tree/use-block-resolve'
import { NewPageDialog } from '@/components/dialogs/NewPageDialog'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)
const SPACE = 'SPACE_PERSONAL'

beforeEach(() => {
  vi.clearAllMocks()
  seedBlocks()
  useSpaceStore.setState({
    currentSpaceId: SPACE,
    availableSpaces: [{ id: SPACE, name: 'Personal', accent_color: null }],
    isReady: true,
  })
  mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
})

async function spacePageTitles(): Promise<string[]> {
  const pages = unwrap(
    await commands.listAllPagesInSpace({ kind: 'active', space_id: SPACE }, null),
  )
  return pages.map((page) => page.content ?? '')
}

/** Lets the 300 ms debounce fire and the matcher's IPC chain settle. */
async function settleSearch(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300)
  })
  await act(async () => {
    await vi.runAllTimersAsync()
  })
}

interface HarnessProps {
  initialTitle?: string
  onOpenPage?: (pageId: string, title: string) => void
}

/** Gate-mounts the dialog behind an opener, the way App does. */
function Harness({ initialTitle = '', onOpenPage = vi.fn() }: HarnessProps) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Opener
      </button>
      {open && (
        <NewPageDialog
          open
          onOpenChange={(next) => setOpen(next)}
          initialTitle={initialTitle}
          onOpenPage={onOpenPage}
        />
      )}
    </>
  )
}

async function openDialog(props: HarnessProps = {}) {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
  const view = render(<Harness {...props} />)
  await user.click(screen.getByRole('button', { name: 'Opener' }))
  const dialog = screen.getByRole('dialog', { name: t('newPageDialog.title') })
  const input = within(dialog).getByRole('textbox', { name: t('newPageDialog.inputLabel') })
  return { user, view, dialog, input }
}

function similarIds(): string[] {
  const list = screen.queryByTestId('similar-pages')
  if (list === null) return []
  return Array.from(list.querySelectorAll('li')).map((li) => li.dataset['pageId'] ?? '')
}

// The app-wide live region (`announce`) is a `status` too, so look inside the dialog.
function queryDialogStatus(): HTMLElement | null {
  const dialog = screen.queryByRole('dialog')
  return dialog === null ? null : within(dialog).queryByRole('status')
}

function dialogStatus(): HTMLElement {
  return within(screen.getByRole('dialog')).getByRole('status')
}

function similarSection(): HTMLElement | null {
  return screen.queryByRole('region', { name: t('newPageDialog.similarHeading') })
}

function createButton(): HTMLElement {
  return screen.getByRole('button', { name: t('newPageDialog.create') })
}

describe('NewPageDialog', () => {
  it('opens with the title field focused and no similar pages', async () => {
    const { view, input } = await openDialog()

    expect(input).toHaveFocus()
    expect(input).toHaveValue('')
    // Nothing is typed, so there is nothing to compare: no Similar pages section.
    expect(similarSection()).toBeNull()
    expect(screen.queryByText(t('newPageDialog.noSimilar'))).toBeNull()
    expect(createButton()).toBeEnabled()
    expect(await axe(view.container.ownerDocument.body)).toHaveNoViolations()
  })

  it('lists near matches with Open buttons that open the page and create nothing', async () => {
    const onOpenPage = vi.fn()
    const { user, view, input } = await openDialog({ onOpenPage })
    const before = await spacePageTitles()

    await user.type(input, 'Meeting')
    await settleSearch()

    expect(similarIds()).toEqual([SEED_IDS.PAGE_MEETINGS, SEED_IDS.PAGE_TMPL_MEETING])
    expect(queryDialogStatus()).not.toBeInTheDocument()
    expect(createButton()).toBeEnabled()
    expect(await axe(view.container.ownerDocument.body)).toHaveNoViolations()

    await user.click(
      screen.getByRole('button', { name: t('newPageDialog.openPage', { title: 'Meetings' }) }),
    )

    expect(onOpenPage).toHaveBeenCalledWith(SEED_IDS.PAGE_MEETINGS, 'Meetings')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(await spacePageTitles()).toEqual(before)
  })

  it('reports an exact title match ignoring case, disables Create, and opens it', async () => {
    const onOpenPage = vi.fn()
    const { user, view, input } = await openDialog({ onOpenPage })
    const before = await spacePageTitles()

    await user.type(input, 'meetings')
    await settleSearch()

    expect(dialogStatus()).toHaveTextContent(t('newPageDialog.exists', { title: 'Meetings' }))
    expect(createButton()).toBeDisabled()
    expect(similarIds()).not.toContain(SEED_IDS.PAGE_MEETINGS)
    expect(await axe(view.container.ownerDocument.body)).toHaveNoViolations()

    // Enter takes the primary action, which is now Open it.
    await user.keyboard('{Enter}')

    expect(onOpenPage).toHaveBeenCalledWith(SEED_IDS.PAGE_MEETINGS, 'Meetings')
    expect(await spacePageTitles()).toEqual(before)
  })

  it('an exact match with nothing else similar shows the notice alone', async () => {
    const { user, input } = await openDialog()

    await user.type(input, 'Projects')
    await settleSearch()

    expect(dialogStatus()).toHaveTextContent(t('newPageDialog.exists', { title: 'Projects' }))
    expect(similarSection()).toBeNull()
    expect(screen.queryByText(t('newPageDialog.noSimilar'))).toBeNull()
  })

  it.each([
    [
      'Open on a similar page',
      async (user: ReturnType<typeof userEvent.setup>, input: HTMLElement) => {
        await user.type(input, 'Meeting')
        await settleSearch()
        await user.click(
          screen.getByRole('button', { name: t('newPageDialog.openPage', { title: 'Meetings' }) }),
        )
      },
    ],
    [
      'Create',
      async (user: ReturnType<typeof userEvent.setup>, input: HTMLElement) => {
        await user.type(input, 'Fresh page{Enter}')
        await settleSearch()
      },
    ],
  ])(
    'after %s, focus is left for the opened page, not returned to the opener',
    async (_name, act_) => {
      const onOpenPage = vi.fn()
      const { user, input } = await openDialog({ onOpenPage })

      await act_(user, input)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      expect(onOpenPage).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Opener' })).not.toHaveFocus()
    },
  )

  it("reports a title that is another page's alias", async () => {
    const onOpenPage = vi.fn()
    const { user, input } = await openDialog({ onOpenPage })

    await user.type(input, 'PROJ')
    await settleSearch()

    expect(dialogStatus()).toHaveTextContent(
      t('newPageDialog.aliasExists', { alias: 'proj', title: 'Projects' }),
    )
    expect(createButton()).toBeDisabled()
    await user.click(screen.getByRole('button', { name: t('newPageDialog.openExisting') }))
    expect(onOpenPage).toHaveBeenCalledWith(SEED_IDS.PAGE_PROJECTS, 'Projects')
  })

  it('Enter creates exactly one page and opens it', async () => {
    const onOpenPage = vi.fn()
    const { user, input } = await openDialog({ onOpenPage })
    const before = await spacePageTitles()

    await user.type(input, 'Meeting minutes{Enter}')
    await settleSearch()

    const after = await spacePageTitles()
    expect(after).toHaveLength(before.length + 1)
    expect(after.filter((title) => title === 'Meeting minutes')).toHaveLength(1)
    const created = unwrap(
      await commands.listAllPagesInSpace({ kind: 'active', space_id: SPACE }, null),
    ).find((page) => page.content === 'Meeting minutes')
    expect(onOpenPage).toHaveBeenCalledWith(created?.id, 'Meeting minutes')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  // Enter can land inside the debounce: the name is re-checked before creating.
  it('Enter right after typing an existing name shows the match instead of creating', async () => {
    const { user, input } = await openDialog()
    const before = await spacePageTitles()

    await user.type(input, 'MEETINGS{Enter}')
    await settleSearch()

    expect(dialogStatus()).toHaveTextContent(t('newPageDialog.exists', { title: 'Meetings' }))
    expect(await spacePageTitles()).toEqual(before)
  })

  it('a blank title creates the first free Untitled page', async () => {
    const { user } = await openDialog()

    await user.keyboard('{Enter}')
    await settleSearch()

    expect((await spacePageTitles()).filter((title) => title === 'Untitled')).toHaveLength(1)
  })

  it('shows the error and stays open when the create IPC rejects', async () => {
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'create_page_in_space') throw new Error('disk full')
      return dispatch(cmd, args)
    })
    const onOpenPage = vi.fn()
    const { user, view, input } = await openDialog({ onOpenPage })
    const before = await spacePageTitles()

    await user.type(input, 'Doomed page')
    await user.click(createButton())
    await settleSearch()

    expect(screen.getByRole('alert')).toHaveTextContent(
      t('pageBrowser.createFailed', { error: 'Error: disk full' }),
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(input).toHaveValue('Doomed page')
    expect(onOpenPage).not.toHaveBeenCalled()
    expect(await spacePageTitles()).toEqual(before)
    expect(await axe(view.container.ownerDocument.body)).toHaveNoViolations()
  })

  it('disables Create while the page is being created', async () => {
    let finishCreate: () => void = () => {}
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'create_page_in_space') {
        await new Promise<void>((resolve) => {
          finishCreate = resolve
        })
      }
      return dispatch(cmd, args)
    })
    const { user, input } = await openDialog()

    await user.type(input, 'Slow page{Enter}')
    await settleSearch()
    expect(createButton()).toBeDisabled()

    await act(async () => {
      finishCreate()
    })
    await settleSearch()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect((await spacePageTitles()).filter((title) => title === 'Slow page')).toHaveLength(1)
  })

  it('Create under pre-fills the namespace prefix and shows the parent path', async () => {
    const { user, input } = await openDialog({ initialTitle: 'Projects/' })

    expect(input).toHaveValue('Projects/')
    expect(screen.getByTestId('new-page-parent-path')).toHaveTextContent(
      t('newPageDialog.parentPath', { path: 'Projects' }),
    )

    await user.type(input, 'Alpha{Enter}')
    await settleSearch()

    expect((await spacePageTitles()).filter((title) => title === 'Projects/Alpha')).toHaveLength(1)
  })

  it('Escape closes the dialog and returns focus to the opener', async () => {
    const { user } = await openDialog()

    await user.keyboard('{Escape}')
    // Radix returns focus on the tick after the dialog unmounts.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Opener' })).toHaveFocus()
  })

  it('a newer keystroke cancels the pending search', async () => {
    const { input } = await openDialog()

    fireEvent.change(input, { target: { value: 'Meet' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    fireEvent.change(input, { target: { value: 'Proj' } })
    await settleSearch()

    const searched = mockedInvoke.mock.calls
      .filter(([cmd]) => cmd === 'search_blocks')
      .map(([, args]) => (args as { query: string }).query)
    expect(searched).toEqual(['proj'])
  })
})

describe('NewPageDialog and the [[ picker', () => {
  // Both call `matchPages`; the dialog lists the picker's pages (minus the
  // create item and the page that already carries the name), at most five.
  // Both start warm, as in real use: the picker's cache is filled by the empty
  // query `[[` opens with, and the dialog fills its own on open. FTS folds
  // case but not accents, so only the cache finds "Café plans" for "cafe plans".
  beforeEach(async () => {
    await dispatch('create_page_in_space', {
      parentId: null,
      content: 'Café plans',
      spaceId: SPACE,
    })
  })

  it.each(['me', 'Meeting', 'proj', 'gs', 'notes', 'cafe plans'])(
    'list the same pages for %j',
    async (query) => {
      const { result } = renderHook(() => useBlockResolve())
      let pickerItems: Awaited<ReturnType<typeof result.current.searchPages>> = []
      await act(async () => {
        await result.current.searchPages('')
        pickerItems = await result.current.searchPages(query)
      })

      const onOpenPage = vi.fn()
      const { user, input } = await openDialog({ onOpenPage })
      fireEvent.change(input, { target: { value: query } })
      await settleSearch()
      const listed = similarIds()
      // The page that already carries the name is offered as Open it, not listed.
      if (queryDialogStatus() !== null) {
        await user.click(screen.getByRole('button', { name: t('newPageDialog.openExisting') }))
      }
      const existingId = onOpenPage.mock.calls[0]?.[0] as string | undefined

      const pickerPages = pickerItems.filter((item) => !item.isCreate).map((item) => item.id)
      expect(pickerPages.length).toBeGreaterThan(0)
      expect(listed).toEqual(pickerPages.filter((id) => id !== existingId).slice(0, 5))
    },
  )
})
