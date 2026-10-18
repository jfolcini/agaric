// @vitest-environment jsdom
// jsdom (not the default happy-dom): happy-dom's querySelectorAll throws on the
// attribute selectors axe-core synthesizes from aria-labels that embed double
// quotes (the view names `"My view"`), so the a11y audit must run under jsdom.
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { SavedViews } from '@/components/AdvancedQuery/SavedViews'
import { t } from '@/lib/i18n'
import { PREFERENCES, readPreference } from '@/lib/preferences'
import { saveQueryView } from '@/lib/saved-query-views'
import {
  selectAdvancedQueryBuilderForSpace,
  selectAdvancedQueryControlsForSpace,
  useAdvancedQueryStore,
} from '@/stores/advancedQuery'

const mockedToastSuccess = vi.mocked(toast.success)
const mockedToastError = vi.mocked(toast.error)

const SPACE_ID = 'SPACE_A'

/** A serialized spec used by the load path. */
const SAMPLE_SPEC = JSON.stringify({
  filter: { type: 'And', children: [{ type: 'Leaf', primitive: { type: 'Tag', tag: 'work' } }] },
  sort: [],
  fulltext: 'hello',
  group_by: null,
  aggregates: [],
})

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

function storedNames(): string[] {
  return readPreference(PREFERENCES.savedQueryViews, SPACE_ID).map((v) => v.name)
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  resetStore()
  saveQueryView(SPACE_ID, 'My view', SAMPLE_SPEC)
})

afterEach(resetStore)

describe('SavedViews', () => {
  it("lists the space's saved views and not another space's", () => {
    saveQueryView('SPACE_B', 'Other space view', SAMPLE_SPEC)
    renderPicker()

    expect(screen.getAllByTestId('saved-view-row').map((row) => row.textContent)).toEqual([
      expect.stringContaining('My view'),
    ])
  })

  it('shows the empty state when the space has no views', () => {
    localStorage.clear()
    renderPicker()
    expect(screen.getByText(t('advancedQuery.savedViews.empty'))).toBeInTheDocument()
  })

  it('lists a view saved while it is mounted', async () => {
    renderPicker()
    saveQueryView(SPACE_ID, 'Saved later', SAMPLE_SPEC)
    expect(await screen.findByText('Saved later')).toBeInTheDocument()
  })

  it('loads a view: parses its spec and hydrates the builder + controls', async () => {
    renderPicker()
    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', {
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
    localStorage.clear()
    saveQueryView(SPACE_ID, 'My view', JSON.stringify({ sort: [] }))
    renderPicker()
    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', {
        name: t('advancedQuery.savedViews.loadTitle', { name: 'My view' }),
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
      screen.getByRole('button', {
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
    expect(storedNames()).toEqual(['Renamed view'])
  })

  it('deletes a view only after confirming', async () => {
    renderPicker()
    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', {
        name: t('advancedQuery.savedViews.deleteTitle', { name: 'My view' }),
      }),
    )

    // Confirm dialog (portal) — destructive confirm button.
    const dialog = await screen.findByRole('alertdialog')
    await user.click(
      within(dialog).getByRole('button', { name: t('advancedQuery.savedViews.delete') }),
    )

    expect(await screen.findByText(t('advancedQuery.savedViews.empty'))).toBeInTheDocument()
    expect(storedNames()).toEqual([])
  })

  it('does not delete when the confirm dialog is cancelled', async () => {
    renderPicker()
    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', {
        name: t('advancedQuery.savedViews.deleteTitle', { name: 'My view' }),
      }),
    )
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: t('dialog.cancel') }))

    expect(screen.getByText('My view')).toBeInTheDocument()
    expect(storedNames()).toEqual(['My view'])
  })

  it('has no axe violations', async () => {
    const { container } = renderPicker()
    expect(await axe(container)).toHaveNoViolations()
  })
})
