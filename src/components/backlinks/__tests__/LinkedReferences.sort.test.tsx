/**
 * The References sort, end to end through the tauri-mock's real handlers: the
 * field picker and the direction toggle re-query `list_backlinks_grouped`, and
 * the rows come back in the order asked for. The mock's sort is pinned to the
 * backend by `conformance/fixtures/query_backlinks_grouped_sort.json`.
 */

import { invoke, type InvokeArgs } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { mockReactVirtual } from '@/__tests__/mocks/react-virtual'

vi.mock('@tanstack/react-virtual', () => mockReactVirtual())
vi.mock('@/hooks/useBlockPropertyEvents', () => ({
  useBlockPropertyEvents: vi.fn(() => ({ invalidationKey: 0 })),
}))

import { LinkedReferences } from '@/components/backlinks/LinkedReferences'
import { TooltipProvider } from '@/components/ui/tooltip'
import { _resetPropertyKeysCacheForTest } from '@/hooks/usePropertyKeysCache'
import { t } from '@/lib/i18n'
import { queryClient } from '@/lib/query-client'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)
const PERSONAL = 'SPACE_PERSONAL'
const TARGET = SEED_IDS.PAGE_GETTING_STARTED

async function seedNote(label: string, due: string | null): Promise<void> {
  const { id } = (await dispatch('create_block', {
    blockType: 'content',
    content: `Sort note ${label} [[${TARGET}]]`,
    parentId: SEED_IDS.PAGE_PROJECTS,
    index: null,
    scope: { kind: 'active', space_id: PERSONAL },
    blockId: null,
  })) as { id: string }
  if (due !== null) await dispatch('set_due_date', { blockId: id, date: due })
}

/** The seeded notes' labels, in the order the panel renders them. */
function renderedNoteOrder(): string[] {
  const panel = screen.getByTestId('linked-references')
  return within(panel)
    .getAllByText(/^Sort note [A-C]/)
    .map((el) => el.textContent?.match(/Sort note ([A-C])/)?.[1] ?? '?')
}

beforeEach(async () => {
  seedBlocks()
  queryClient.clear()
  _resetPropertyKeysCacheForTest()
  useSpaceStore.setState({
    currentSpaceId: PERSONAL,
    availableSpaces: [{ id: PERSONAL, name: 'Personal', accent_color: null }],
    isReady: true,
  })
  mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
  // Created A, B, C in that order; due B, C, A; C's date is the latest.
  await seedNote('A', '2026-03-01')
  await seedNote('B', '2026-01-01')
  await seedNote('C', null)
  // An old install still carries the retired migration marker.
  await dispatch('set_property', {
    blockId: PERSONAL,
    key: 'personal_to_work_migration_v1',
    value: { value_text: 'true' },
  })
})

function renderPanel() {
  return render(
    <TooltipProvider>
      <LinkedReferences targetId={TARGET} />
    </TooltipProvider>,
  )
}

describe('LinkedReferences sort', () => {
  it('re-queries in the picked field order, and the toggle reverses it', async () => {
    const user = userEvent.setup()
    renderPanel()
    await waitFor(() => expect(renderedNoteOrder()).toEqual(['A', 'B', 'C']))

    await user.selectOptions(screen.getByLabelText(t('backlink.sortByLabel')), 'due')
    // Earliest due first; C has no due date and stays last.
    await waitFor(() => expect(renderedNoteOrder()).toEqual(['B', 'A', 'C']))

    await user.click(
      screen.getByRole('button', {
        name: t('backlink.sortDirectionLabel', { direction: t('common.ascending') }),
      }),
    )
    await waitFor(() => expect(renderedNoteOrder()).toEqual(['A', 'B', 'C']))
    expect(
      screen.getByRole('button', {
        name: t('backlink.sortDirectionLabel', { direction: t('common.descending') }),
      }),
    ).toBeInTheDocument()
  })

  it('reverses the default order without picking a field first', async () => {
    const user = userEvent.setup()
    renderPanel()
    await waitFor(() => expect(renderedNoteOrder()).toEqual(['A', 'B', 'C']))

    await user.click(screen.getByTestId('backlink-sort-direction'))
    await waitFor(() => expect(renderedNoteOrder()).toEqual(['C', 'B', 'A']))
  })

  it('never offers the app bookkeeping keys', async () => {
    const user = userEvent.setup()
    const { container } = renderPanel()
    await waitFor(() => expect(renderedNoteOrder()).toEqual(['A', 'B', 'C']))
    // The panel loads the property list on first use.
    await user.click(screen.getByLabelText(t('backlink.sortByLabel')))

    const select = screen.getByLabelText(t('backlink.sortByLabel'))
    await waitFor(() => expect(within(select).getByText('effort')).toBeInTheDocument())
    const offered = [...select.querySelectorAll('option')].map((o) => o.textContent)
    for (const key of ['is_space', 'personal_to_work_migration_v1', 'accent_color', 'listStyle']) {
      expect(offered).not.toContain(key)
    }
    expect(await axe(container)).toHaveNoViolations()
  })
})
