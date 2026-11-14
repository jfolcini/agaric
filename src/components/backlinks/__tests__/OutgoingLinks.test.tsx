/**
 * #6749 — a page's Outgoing links section: what the page's blocks link to,
 * grouped by the target's page, unresolved targets on their own, collapsed
 * until opened.
 */
import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { OutgoingLinks } from '@/components/backlinks/OutgoingLinks'
import type { OutgoingLinkRow, PageResponse } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)

function row(overrides: Partial<OutgoingLinkRow>): OutgoingLinkRow {
  return {
    source_id: 'SRC_1',
    source_content: 'see the plan',
    target_id: 'PAGE_PLAN',
    kind: 'page_link',
    target_page_id: 'PAGE_PLAN',
    target_page_title: 'Plan',
    ...overrides,
  }
}

function page(items: OutgoingLinkRow[]): PageResponse<OutgoingLinkRow> {
  return { items, next_cursor: null, has_more: false, total_count: null }
}

const TWO_LINKS = page([
  row({ source_id: 'SRC_1', source_content: 'see the plan' }),
  row({
    source_id: 'SRC_2',
    source_content: 'quote from notes',
    target_id: 'NOTE_BLOCK',
    kind: 'block_ref',
    target_page_id: 'PAGE_NOTES',
    target_page_title: 'Notes',
  }),
])

function renderSection(onNavigateToPage = vi.fn()) {
  return {
    onNavigateToPage,
    ...render(
      <OutgoingLinks pageId="PAGE_HOME" pageTitle="Home" onNavigateToPage={onNavigateToPage} />,
    ),
  }
}

async function expand(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: new RegExp(t('outgoingLinks.header')) }))
}

const listCalls = () => mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_outgoing_links')

beforeEach(() => {
  vi.clearAllMocks()
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [{ id: 'SPACE_TEST', name: 'Test', accent_color: null }],
    isReady: true,
  })
  mockedInvoke.mockImplementation(
    mockInvokeCommands({ list_outgoing_links: () => TWO_LINKS, batch_resolve: () => [] }),
  )
})

describe('OutgoingLinks (#6749)', () => {
  it('is collapsed by default and reads nothing until opened', () => {
    renderSection()
    expect(
      screen.getByRole('button', { name: new RegExp(t('outgoingLinks.header')) }),
    ).toHaveAttribute('aria-expanded', 'false')
    expect(listCalls()).toHaveLength(0)
  })

  it('a page with two links lists both under their pages and jumps to the linking block', async () => {
    const user = userEvent.setup()
    const { onNavigateToPage } = renderSection()
    await expand(user)

    expect(await screen.findByText('see the plan')).toBeInTheDocument()
    expect(screen.getByText('quote from notes')).toBeInTheDocument()
    expect(
      within(
        screen.getByRole('list', { name: t('outgoingLinks.listLabel', { title: 'Plan' }) }),
      ).getByText('see the plan'),
    ).toBeInTheDocument()
    expect(
      within(
        screen.getByRole('list', { name: t('outgoingLinks.listLabel', { title: 'Notes' }) }),
      ).getByText('quote from notes'),
    ).toBeInTheDocument()
    expect(listCalls()[0]).toEqual([
      'list_outgoing_links',
      {
        pageId: 'PAGE_HOME',
        kind: null,
        cursor: null,
        limit: expect.any(Number),
        scope: { kind: 'active', space_id: 'SPACE_TEST' },
      },
    ])

    await user.click(screen.getByText('quote from notes'))
    expect(onNavigateToPage).toHaveBeenCalledExactlyOnceWith('PAGE_HOME', 'Home', 'SRC_2')
  })

  it('a page with no links shows the empty state', async () => {
    mockedInvoke.mockImplementation(
      mockInvokeCommands({ list_outgoing_links: () => page([]), batch_resolve: () => [] }),
    )
    const user = userEvent.setup()
    renderSection()
    await expand(user)
    expect(await screen.findByText(t('outgoingLinks.empty'))).toBeInTheDocument()
  })

  it('lists an unresolved target in a group of its own', async () => {
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        list_outgoing_links: () =>
          page([
            row({ source_id: 'SRC_1' }),
            row({
              source_id: 'SRC_3',
              source_content: 'points at a trashed page',
              target_id: 'GONE',
              target_page_id: null,
              target_page_title: null,
            }),
          ]),
        batch_resolve: () => [],
      }),
    )
    const user = userEvent.setup()
    renderSection()
    await expand(user)
    const unresolved = await screen.findByRole('list', {
      name: t('outgoingLinks.listLabel', { title: t('outgoingLinks.unresolved') }),
    })
    expect(within(unresolved).getByText('points at a trashed page')).toBeInTheDocument()
    expect(within(unresolved).queryByText('see the plan')).not.toBeInTheDocument()
  })

  it('narrows to block references with the kind toggle', async () => {
    const user = userEvent.setup()
    renderSection()
    await expand(user)
    await screen.findByText('see the plan')
    await user.click(screen.getByRole('radio', { name: t('references.kindBlockRefs') }))
    await waitFor(() => expect(listCalls().at(-1)?.[1]).toMatchObject({ kind: 'block_ref' }))
  })

  it('shows the error state when the read fails', async () => {
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        list_outgoing_links: () => Promise.reject(new Error('backend gone')),
        batch_resolve: () => [],
      }),
    )
    const user = userEvent.setup()
    renderSection()
    await expand(user)
    expect(await screen.findByText(t('outgoingLinks.loadFailed'))).toBeInTheDocument()
  })

  it('has no a11y violations, collapsed or open', async () => {
    const user = userEvent.setup()
    const { container } = renderSection()
    expect(await axe(container)).toHaveNoViolations()
    await expand(user)
    await screen.findByText('see the plan')
    expect(await axe(container)).toHaveNoViolations()
  })
})
