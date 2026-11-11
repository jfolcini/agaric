/**
 * TrashView: a confirmed bulk action that resolves with a count of 0 while
 * rows are listed reports a failure instead of staying silent.
 *
 * The backend canonicalises the ids it receives and matches them byte for
 * byte, so a stored id that is not canonical is listed but never matched; the
 * call then resolves `{ affected_count: 0 }`. The real-backend repro is
 * `e2e-tauri/trash-bulk-noncanonical-ids.e2e.ts`.
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import { axe } from '@/__tests__/helpers/axe'
import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { mockReactVirtual } from '@/__tests__/mocks/react-virtual'
import { TrashView } from '@/components/TrashView'
import { useSpaceStore } from '@/stores/space'

vi.mock('@/components/RichContentRenderer', () => ({
  renderRichContent: vi.fn((markdown: string) => markdown),
}))
vi.mock('@tanstack/react-virtual', () => mockReactVirtual())
vi.mock('@/hooks/useRichContentCallbacks', () => ({
  useRichContentCallbacks: vi.fn(() => ({
    resolveBlockTitle: vi.fn(() => undefined),
    resolveBlockStatus: vi.fn(() => 'active' as const),
    resolveTagName: vi.fn(() => undefined),
    resolveTagStatus: vi.fn(() => 'active' as const),
  })),
  useTagClickHandler: vi.fn(() => vi.fn()),
}))
vi.mock('@/lib/announcer', () => ({ announce: vi.fn() }))

const mockedInvoke = vi.mocked(invoke)

const BLOCKS = [
  makeBlock({ id: 'b1', content: 'item 1', deleted_at: 1736899200000 }),
  makeBlock({ id: 'b2', content: 'item 2', deleted_at: 1736812800000 }),
]

beforeEach(() => {
  vi.clearAllMocks()
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [{ id: 'SPACE_TEST', name: 'Test', accent_color: null }],
    isReady: true,
  })
  mockedInvoke.mockImplementation(
    mockInvokeCommands({
      list_trash: () => ({ items: BLOCKS, next_cursor: null, has_more: false, total_count: null }),
      batch_resolve: () => [],
      trash_descendant_counts: () => ({}),
      purge_blocks_by_ids: () => ({ affected_count: 0 }),
      restore_blocks_by_ids: () => ({ affected_count: 0 }),
    }),
  )
})

async function selectBoth(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const [first, second] = screen.getAllByTestId('trash-item-checkbox')
  await user.click(first as HTMLElement)
  await user.click(second as HTMLElement)
}

describe('TrashView bulk action that changes nothing', () => {
  it('Empty trash reports a failure', async () => {
    const user = userEvent.setup()
    render(<TrashView />)
    await screen.findByText('item 1')
    await user.click(screen.getByTestId('trash-empty-trash-btn'))
    await user.click(screen.getByRole('button', { name: 'Yes, delete' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to empty trash'))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('Restore all reports a failure', async () => {
    const user = userEvent.setup()
    render(<TrashView />)
    await screen.findByText('item 1')
    await user.click(screen.getByTestId('trash-restore-all-btn'))
    await user.click(screen.getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to restore all items'))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('batch purge reports a failure', async () => {
    const user = userEvent.setup()
    render(<TrashView />)
    await screen.findByText('item 1')
    await selectBoth(user)
    await user.click(screen.getByTestId('trash-batch-purge-btn'))
    await user.click(screen.getByRole('button', { name: /Yes/ }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to purge selected blocks'))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('batch restore reports a failure', async () => {
    const user = userEvent.setup()
    render(<TrashView />)
    await screen.findByText('item 1')
    await selectBoth(user)
    await user.click(screen.getByTestId('trash-batch-restore-btn'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Failed to restore selected blocks'),
    )
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('has no a11y violations', async () => {
    const { container } = render(<TrashView />)
    await screen.findByText('item 1')
    expect(await axe(container)).toHaveNoViolations()
  })
})
