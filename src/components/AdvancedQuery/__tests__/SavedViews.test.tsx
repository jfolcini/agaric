// @vitest-environment jsdom
// jsdom (not the default happy-dom): happy-dom's querySelectorAll throws on the
// attribute selectors axe-core synthesizes from aria-labels that embed double
// quotes (the view names `"My view"`), so the a11y audit must run under jsdom.
//
// Saved queries are view pages (#6544): `invoke` is routed through the real
// tauri-mock `dispatch`, so each assertion re-reads the stored pages.
import type { InvokeArgs } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { SavedViews } from '@/components/AdvancedQuery/SavedViews'
import { t } from '@/lib/i18n'
import { loadSavedViews, saveView } from '@/lib/saved-views'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, seedBlocks } from '@/lib/tauri-mock/seed'
import {
  selectAdvancedQueryBuilderForSpace,
  selectAdvancedQueryControlsForSpace,
  useAdvancedQueryStore,
} from '@/stores/advancedQuery'
import { useSpaceStore } from '@/stores/space'

const mockedToastSuccess = vi.mocked(toast.success)
const mockedToastError = vi.mocked(toast.error)

const SPACE_ID = 'SPACE_PERSONAL'

/** A spec used by the load path. */
const SAMPLE_SPEC = {
  filter: { type: 'And', children: [{ type: 'Leaf', primitive: { type: 'Tag', tag: 'work' } }] },
  sort: [],
  fulltext: 'hello',
  group_by: null,
  aggregates: [],
}

function resetStore(): void {
  useAdvancedQueryStore.setState({
    filtersBySpace: {},
    buildersBySpace: {},
    controlsBySpace: {},
    nextAddId: 0,
  })
}

function renderPicker(): ReturnType<typeof render> {
  return render(<SavedViews spaceKey={SPACE_ID} />)
}

/** The names of the space's live saved views, read back from the store. */
async function storedNames(spaceId = SPACE_ID): Promise<string[]> {
  return (await loadSavedViews(spaceId)).map((v) => v.name)
}

/** The rows the picker shows, once it has read the views. */
async function rowNames(): Promise<string[]> {
  const rows = await screen.findAllByTestId('saved-view-row')
  return rows.map((row) => row.textContent ?? '')
}

beforeEach(async () => {
  vi.clearAllMocks()
  localStorage.clear()
  localStorage.setItem('__mockWorkSpace', 'true')
  seedBlocks()
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: InvokeArgs) =>
    dispatch(cmd, args),
  )
  useSpaceStore.setState({ currentSpaceId: SPACE_ID })
  resetStore()
  await saveView(SPACE_ID, 'My view', { kind: 'query', spec: SAMPLE_SPEC })
})

afterEach(resetStore)

describe('SavedViews', () => {
  it("lists the space's saved queries, not its Pages views and not another space's", async () => {
    await saveView('SPACE_WORK', 'Other space view', { kind: 'query', spec: SAMPLE_SPEC })
    await saveView(SPACE_ID, 'A Pages view', { kind: 'pages', sort: 'recent', filters: [] })
    renderPicker()

    expect(await rowNames()).toEqual([expect.stringContaining('My view')])
  })

  it('shows the empty state when the space has no views', async () => {
    const view = [...blocks.values()].find((b) => b['content'] === 'My view')
    if (view) view['deleted_at'] = 1
    renderPicker()
    expect(await screen.findByText(t('advancedQuery.savedViews.empty'))).toBeInTheDocument()
  })

  it('lists a view saved while it is mounted', async () => {
    renderPicker()
    await rowNames()
    await act(() => saveView(SPACE_ID, 'Saved later', { kind: 'query', spec: SAMPLE_SPEC }))
    expect(await screen.findByText('Saved later')).toBeInTheDocument()
  })

  it('loads a view: parses its spec and hydrates the builder + controls', async () => {
    renderPicker()
    const user = userEvent.setup()
    await user.click(
      await screen.findByRole('button', {
        name: t('advancedQuery.savedViews.loadTitle', { name: 'My view' }),
      }),
    )

    const builder = selectAdvancedQueryBuilderForSpace(useAdvancedQueryStore.getState(), SPACE_ID)
    expect(builder.children).toHaveLength(1)
    expect(builder.children[0]).toMatchObject({
      kind: 'leaf',
      primitive: { type: 'Tag', tag: 'work' },
    })
    const controls = selectAdvancedQueryControlsForSpace(useAdvancedQueryStore.getState(), SPACE_ID)
    expect(controls.fulltext).toBe('hello')
    expect(mockedToastSuccess).toHaveBeenCalledTimes(1)
  })

  it('surfaces a toast error and leaves the builder alone when the spec is invalid', async () => {
    await saveView(SPACE_ID, 'No filter', { kind: 'query', spec: { sort: [] } })
    renderPicker()
    const user = userEvent.setup()
    await user.click(
      await screen.findByRole('button', {
        name: t('advancedQuery.savedViews.loadTitle', { name: 'No filter' }),
      }),
    )

    expect(mockedToastError).toHaveBeenCalledTimes(1)
    const builder = selectAdvancedQueryBuilderForSpace(useAdvancedQueryStore.getState(), SPACE_ID)
    expect(builder.children).toHaveLength(0)
  })

  it('renames a view and keeps the new name', async () => {
    renderPicker()
    const user = userEvent.setup()
    await user.click(
      await screen.findByRole('button', {
        name: t('advancedQuery.savedViews.renameTitle', { name: 'My view' }),
      }),
    )

    // Rename dialog (portal) — clear + type the new name, confirm via Save.
    const dialog = await screen.findByRole('dialog')
    const input = within(dialog).getByRole('textbox')
    await user.clear(input)
    await user.type(input, 'Renamed view')
    await user.click(within(dialog).getByRole('button', { name: t('rename.save') }))

    expect(await screen.findByText('Renamed view')).toBeInTheDocument()
    expect(await storedNames()).toEqual(['Renamed view'])
  })

  it('refuses a rename onto a title the space holds, and keeps the name', async () => {
    renderPicker()
    const user = userEvent.setup()
    await user.click(
      await screen.findByRole('button', {
        name: t('advancedQuery.savedViews.renameTitle', { name: 'My view' }),
      }),
    )
    const dialog = await screen.findByRole('dialog')
    const input = within(dialog).getByRole('textbox')
    await user.clear(input)
    await user.type(input, 'Projects')
    await user.click(within(dialog).getByRole('button', { name: t('rename.save') }))

    await waitFor(() =>
      expect(mockedToastError).toHaveBeenCalledWith(
        t('advancedQuery.savedViews.nameTaken', { name: 'Projects' }),
      ),
    )
    expect(await storedNames()).toEqual(['My view'])
  })

  it('deletes a view only after confirming, to the Trash', async () => {
    renderPicker()
    const user = userEvent.setup()
    await user.click(
      await screen.findByRole('button', {
        name: t('advancedQuery.savedViews.deleteTitle', { name: 'My view' }),
      }),
    )

    // Confirm dialog (portal) — destructive confirm button.
    const dialog = await screen.findByRole('alertdialog')
    await user.click(
      within(dialog).getByRole('button', { name: t('advancedQuery.savedViews.delete') }),
    )

    expect(await screen.findByText(t('advancedQuery.savedViews.empty'))).toBeInTheDocument()
    expect(await storedNames()).toEqual([])
    const page = [...blocks.values()].find((b) => b['content'] === 'My view')
    expect(page?.['deleted_at']).not.toBeNull()
  })

  it('reports a delete the backend refuses, and keeps listing the view', async () => {
    vi.mocked(invoke).mockImplementation((cmd: string, args?: InvokeArgs) =>
      cmd === 'delete_block'
        ? Promise.reject({ kind: 'database', message: 'disk I/O error' })
        : Promise.resolve(dispatch(cmd, args)),
    )
    renderPicker()
    const user = userEvent.setup()
    await user.click(
      await screen.findByRole('button', {
        name: t('advancedQuery.savedViews.deleteTitle', { name: 'My view' }),
      }),
    )
    const dialog = await screen.findByRole('alertdialog')
    await user.click(
      within(dialog).getByRole('button', { name: t('advancedQuery.savedViews.delete') }),
    )

    await waitFor(() =>
      expect(mockedToastError).toHaveBeenCalledWith(t('advancedQuery.savedViews.deleteError')),
    )
    expect(await storedNames()).toEqual(['My view'])
  })

  it('does not delete when the confirm dialog is cancelled', async () => {
    renderPicker()
    const user = userEvent.setup()
    await user.click(
      await screen.findByRole('button', {
        name: t('advancedQuery.savedViews.deleteTitle', { name: 'My view' }),
      }),
    )
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: t('dialog.cancel') }))

    expect(screen.getByText('My view')).toBeInTheDocument()
    expect(await storedNames()).toEqual(['My view'])
  })

  it('has no axe violations', async () => {
    const { container } = renderPicker()
    await rowNames()
    expect(await axe(container)).toHaveNoViolations()
  })
})
