// @vitest-environment jsdom
// jsdom (not the default happy-dom): happy-dom's querySelectorAll throws on the
// attribute selectors axe-core synthesizes from aria-labels that embed double
// quotes (the view names `"My view"`), so the a11y audit must run under jsdom.
import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { t } from '@/lib/i18n'
import type { BlockRow } from '@/lib/tauri'
import {
  selectAdvancedQueryBuilderForSpace,
  selectAdvancedQueryControlsForSpace,
  useAdvancedQueryStore,
} from '@/stores/advancedQuery'

import { QUERY_SPEC_KEY, QUERY_VIEW_MARKER, SavedViews, VIEW_TYPE_KEY } from '../SavedViews'

const mockedInvoke = vi.mocked(invoke)
const mockedToastSuccess = vi.mocked(toast.success)
const mockedToastError = vi.mocked(toast.error)

const SPACE_ID = 'SPACE_A'

function makeViewRow(over: Partial<BlockRow> = {}): BlockRow {
  return {
    id: 'VIEW1',
    block_type: 'content',
    content: 'My view',
    parent_id: null,
    position: 0,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    page_id: null,
    ...over,
  }
}

/** A serialized query_spec used by the load path. */
const SAMPLE_SPEC = JSON.stringify({
  filter: { type: 'And', children: [{ type: 'Leaf', primitive: { type: 'Tag', tag: 'work' } }] },
  sort: [],
  fulltext: 'hello',
  group_by: null,
  aggregates: [],
})

/** Route IPC by command. Defaults: one saved view in the list. */
function routeInvoke(
  over: {
    list?: BlockRow[]
    spec?: string | null
    onEdit?: () => void
    onDelete?: () => void
    fail?: 'list' | 'load' | 'rename' | 'delete' | null
  } = {},
): void {
  const { list = [makeViewRow()], spec = SAMPLE_SPEC, fail = null } = over
  mockedInvoke.mockImplementation(async (cmd, args) => {
    if (cmd === 'query_by_property') {
      if (fail === 'list') throw new Error('list boom')
      return { items: list, next_cursor: null, has_more: false }
    }
    if (cmd === 'get_property') {
      if (fail === 'load') throw new Error('load boom')
      return spec == null
        ? null
        : {
            key: QUERY_SPEC_KEY,
            value_text: spec,
            value_num: null,
            value_date: null,
            value_ref: null,
            value_bool: null,
          }
    }
    if (cmd === 'edit_block') {
      if (fail === 'rename') throw new Error('rename boom')
      over.onEdit?.()
      const blockId = (args as { blockId: string }).blockId
      const toText = (args as { toText: string }).toText
      return makeViewRow({ id: blockId, content: toText })
    }
    if (cmd === 'delete_block') {
      if (fail === 'delete') throw new Error('delete boom')
      over.onDelete?.()
      return { deleted: 1 }
    }
    return null
  })
}

function renderPicker(): ReturnType<typeof render> {
  return render(<SavedViews spaceKey={SPACE_ID} spaceId={SPACE_ID} />)
}

beforeEach(() => {
  vi.clearAllMocks()
  useAdvancedQueryStore.setState({
    filtersBySpace: {},
    buildersBySpace: {},
    controlsBySpace: {},
    nextAddId: 0,
  })
  routeInvoke()
})

afterEach(() => {
  useAdvancedQueryStore.setState({
    filtersBySpace: {},
    buildersBySpace: {},
    controlsBySpace: {},
    nextAddId: 0,
  })
})

describe('SavedViews', () => {
  it('lists saved views via queryByProperty with the view_type marker', async () => {
    renderPicker()

    expect(await screen.findByText('My view')).toBeInTheDocument()
    expect(mockedInvoke).toHaveBeenCalledWith('query_by_property', {
      key: VIEW_TYPE_KEY,
      valueText: QUERY_VIEW_MARKER,
      valueDate: null,
      operator: null,
      cursor: null,
      limit: 50,
      scope: { kind: 'active', space_id: SPACE_ID },
      extraFilters: null,
    })
  })

  it('shows the empty state when no views exist', async () => {
    routeInvoke({ list: [] })
    renderPicker()
    expect(await screen.findByText(t('advancedQuery.savedViews.empty'))).toBeInTheDocument()
  })

  it('shows an error + retry when the listing fails, then recovers on retry', async () => {
    routeInvoke({ fail: 'list' })
    renderPicker()
    expect(await screen.findByText(t('advancedQuery.savedViews.listError'))).toBeInTheDocument()

    // Recover: next listing succeeds.
    routeInvoke()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: t('action.retry') }))
    expect(await screen.findByText('My view')).toBeInTheDocument()
  })

  it('loads a view: reads query_spec and hydrates the builder + controls', async () => {
    renderPicker()
    await screen.findByText('My view')

    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', {
        name: t('advancedQuery.savedViews.loadTitle', { name: 'My view' }),
      }),
    )

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('get_property', {
        blockId: 'VIEW1',
        key: QUERY_SPEC_KEY,
      })
    })

    // Builder tree hydrated from the spec's filter.
    await waitFor(() => {
      const builder = selectAdvancedQueryBuilderForSpace(useAdvancedQueryStore.getState(), SPACE_ID)
      expect(builder.children).toHaveLength(1)
    })
    const builder = selectAdvancedQueryBuilderForSpace(useAdvancedQueryStore.getState(), SPACE_ID)
    expect(builder.children[0]).toMatchObject({
      kind: 'leaf',
      primitive: { type: 'Tag', tag: 'work' },
    })
    // Controls hydrated too.
    const controls = selectAdvancedQueryControlsForSpace(useAdvancedQueryStore.getState(), SPACE_ID)
    expect(controls.fulltext).toBe('hello')
    expect(mockedToastSuccess).toHaveBeenCalled()
  })

  it('surfaces a toast error when loading a view fails', async () => {
    routeInvoke({ fail: 'load' })
    renderPicker()
    await screen.findByText('My view')

    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', {
        name: t('advancedQuery.savedViews.loadTitle', { name: 'My view' }),
      }),
    )
    await waitFor(() => expect(mockedToastError).toHaveBeenCalled())
  })

  it('renames a view: edits the block content and updates the row', async () => {
    const onEdit = vi.fn()
    routeInvoke({ onEdit })
    renderPicker()
    await screen.findByText('My view')

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

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
        blockId: 'VIEW1',
        toText: 'Renamed view',
      })
    })
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Renamed view')).toBeInTheDocument()
  })

  it('deletes a view only after confirming, then removes the row', async () => {
    const onDelete = vi.fn()
    routeInvoke({ onDelete })
    renderPicker()
    await screen.findByText('My view')

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

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('delete_block', { blockId: 'VIEW1' })
    })
    expect(onDelete).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByText('My view')).not.toBeInTheDocument())
  })

  it('does not delete when the confirm dialog is cancelled', async () => {
    renderPicker()
    await screen.findByText('My view')

    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', {
        name: t('advancedQuery.savedViews.deleteTitle', { name: 'My view' }),
      }),
    )
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: t('dialog.cancel') }))

    expect(mockedInvoke).not.toHaveBeenCalledWith('delete_block', expect.anything())
    expect(screen.getByText('My view')).toBeInTheDocument()
  })

  it('has no axe violations', async () => {
    const { container } = renderPicker()
    await screen.findByText('My view')
    await waitFor(
      async () => {
        expect(await axe(container)).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })
})
