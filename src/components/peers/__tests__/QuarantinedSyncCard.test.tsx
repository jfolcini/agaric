/**
 * Tests for QuarantinedSyncCard (#6057): the read-only list of sync deltas the
 * boot replay moved to `loro_sync_quarantine`.
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { QuarantinedSyncCard } from '@/components/peers/QuarantinedSyncCard'
import type { QuarantinedSlot, QuarantinedSlotList } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { queryClient } from '@/lib/query-client'
import { useSpaceStore } from '@/stores/space'

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const mockedInvoke = vi.mocked(invoke)
const NOW = Date.now()
const HOUR = 60 * 60 * 1000

function slot(fields: Partial<QuarantinedSlot>): QuarantinedSlot {
  return {
    id: 1,
    inbox_id: 1,
    space_id: 'SPACE_WORK',
    byte_len: 2048,
    declared_end_vv: '[]',
    last_reason: 'replay failed: corrupt blob',
    unresolved_boots: 5,
    first_seen_at_ms: NOW - 3 * HOUR,
    quarantined_at_ms: NOW,
    ...fields,
  }
}

function serve(list: QuarantinedSlotList) {
  mockedInvoke.mockImplementation(mockInvokeCommands({ list_quarantined_sync_slots: () => list }))
}

beforeEach(() => {
  vi.clearAllMocks()
  queryClient.clear()
  useSpaceStore.setState({
    availableSpaces: [{ id: 'SPACE_WORK', name: 'Work', accent_color: null }],
  })
})

describe('QuarantinedSyncCard', () => {
  it('lists each delta with its space, first-seen time, size and reason', async () => {
    serve({
      slots: [
        slot({ id: 2, space_id: 'SPACE_WORK' }),
        slot({ id: 1, space_id: 'SPACE_GONE', byte_len: 512, last_reason: 'shortfall: peer 7' }),
      ],
      total: 2,
    })
    render(<QuarantinedSyncCard />)

    const card = await screen.findByRole('region', {
      name: '2 sync changes could not be applied',
    })
    const rows = within(card).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Work')
    expect(rows[0]).toHaveTextContent('First seen 3h ago · 2.0 KB')
    expect(rows[0]).toHaveTextContent('replay failed: corrupt blob')
    // A deleted space is no longer in the store: the raw id stands in.
    expect(rows[1]).toHaveTextContent('SPACE_GONE')
    expect(rows[1]).toHaveTextContent('First seen 3h ago · 512 B')
    expect(rows[1]).toHaveTextContent('shortfall: peer 7')
  })

  it('counts every quarantined delta in the header, past the listed rows', async () => {
    serve({ slots: [slot({ id: 1 })], total: 3 })
    render(<QuarantinedSyncCard />)
    const card = await screen.findByRole('region', { name: '3 sync changes could not be applied' })
    expect(within(card).getAllByRole('listitem')).toHaveLength(1)
  })

  it('renders nothing when nothing is quarantined', async () => {
    serve({ slots: [], total: 0 })
    const { container } = render(<QuarantinedSyncCard />)
    // Settled, not still loading: loading renders nothing too.
    await waitFor(() => {
      expect(queryClient.getQueryState(['quarantinedSyncSlots'])?.status).toBe('success')
    })
    expect(container).toBeEmptyDOMElement()
  })

  it('shows an error and logs a warning when the listing is rejected', async () => {
    const failure = { kind: 'database', message: 'disk I/O error' }
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        list_quarantined_sync_slots: () => Promise.reject(failure),
      }),
    )
    render(<QuarantinedSyncCard />)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not check for sync changes that failed to apply',
    )
    expect(logger.warn).toHaveBeenCalledWith(
      'QuarantinedSyncCard',
      'listing quarantined sync deltas failed',
      undefined,
      expect.objectContaining({ message: 'disk I/O error' }),
    )
  })

  it('has no a11y violations', async () => {
    serve({ slots: [slot({ id: 1 })], total: 1 })
    const { container } = render(<QuarantinedSyncCard />)
    await screen.findByRole('region')
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
