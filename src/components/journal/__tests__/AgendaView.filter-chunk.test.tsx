/**
 * The agenda's rows paint together with its lazily loaded filter bar, never
 * before it: on a phone the bar wraps to a second row, so rows painted first
 * jump down when its chunk arrives and a tap lands on the row above.
 */

// axe-exempt: every child is a stub here; AgendaView.test.tsx audits the view.

import { act, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

const { builderChunk } = vi.hoisted(() => {
  let release = (): void => {}
  const loaded = new Promise<void>((resolve) => {
    release = resolve
  })
  return { builderChunk: { loaded, release: () => release() } }
})

vi.mock('@/components/agenda/AgendaFilterBuilder', async () => {
  await builderChunk.loaded
  return { AgendaFilterBuilder: () => <div data-testid="agenda-filter-builder" /> }
})

vi.mock('@/components/agenda/AgendaResults', () => ({
  AgendaResults: () => <div data-testid="agenda-results" />,
}))

vi.mock('@/lib/agenda-filters', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agenda-filters')>()),
  executeAgendaFilters: vi.fn(() => Promise.resolve({ blocks: [], hasMore: false, cursor: null })),
}))

vi.mock('@/lib/bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bindings')>()
  const page = { items: [], next_cursor: null, has_more: false, total_count: null }
  return {
    ...actual,
    commands: {
      ...actual.commands,
      listProjectedAgenda: () => Promise.resolve({ status: 'ok', data: page }),
    },
  }
})

import { AgendaView } from '@/components/journal/AgendaView'
import { executeAgendaFilters } from '@/lib/agenda-filters'

it('paints the rows only once the filter bar has loaded', async () => {
  render(<AgendaView />)
  // The query has answered, so only the bar's chunk is holding the rows back.
  await act(async () => {
    await vi.mocked(executeAgendaFilters).mock.results[0]?.value
  })
  expect(screen.queryByTestId('agenda-results')).not.toBeInTheDocument()

  await act(async () => {
    builderChunk.release()
    await builderChunk.loaded
  })
  expect(await screen.findByTestId('agenda-filter-builder')).toBeInTheDocument()
  expect(screen.getByTestId('agenda-results')).toBeInTheDocument()
})
