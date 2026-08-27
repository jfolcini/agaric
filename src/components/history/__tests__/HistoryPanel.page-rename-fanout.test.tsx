/**
 * Tests for #4056 — the History panel's page-title revert bypasses
 * `renamePage`, so it reaches neither the name-change bus nor tabs/recents.
 *
 * `HistoryPanel.handleRestore` (and its undo-toast counterpart
 * `handleUndoRestore`) write a restored block's content back through the raw
 * `editBlock` IPC. When the restored block is a PAGE, that content IS the
 * page's title — but `editBlock` only ever writes the block row. Every other
 * rename surface (`PageHeader.tsx`, `useUndoShortcuts.ts`) additionally fans
 * the new title out through `renamePage` (`@/stores/page-rename`), which is
 * what keeps the `[[` / `#` picker's name caches, open tabs, and recents in
 * sync. Before the fix, History's revert path skipped that fan-out entirely.
 *
 * The assertion shape mirrors the `#4007` block in
 * `use-block-resolve.test.ts`: prime the picker's page-name cache with a
 * first read, mutate through the code path under test, then assert the
 * SECOND read — served from the same cache — reflects the mutation. Merely
 * asserting `editBlock` was called (as the pre-existing restore-invariant
 * tests do) would pass whether or not the fan-out happened, so it is not
 * sufficient here.
 */

import { render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeHistoryEntry } from '@/__tests__/fixtures'
import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { useBlockResolve } from '@/components/block-tree/use-block-resolve'
import { HistoryPanel } from '@/components/history/HistoryPanel'
import type { NameChange } from '@/lib/name-change-bus'
import { subscribeToNameChanges } from '@/lib/name-change-bus'
import { queryClient } from '@/lib/query-client'
import type { HistoryEntry } from '@/lib/tauri'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

// Stub BlockHistoryItem exactly as HistoryPanel.restore-invariant.test.tsx
// does: render a restore button for every row so the test can drive
// `handleRestore` without depending on the real row markup.
vi.mock('@/components/HistoryListItem', () => ({
  BlockHistoryItem: ({
    entry,
    index,
    onRestore,
  }: {
    entry: HistoryEntry
    index: number
    onRestore: (entry: HistoryEntry) => void
  }) => (
    <li data-testid={`stub-row-${index}`}>
      <span>{entry.op_type}</span>
      <button type="button" data-testid={`stub-restore-${index}`} onClick={() => onRestore(entry)}>
        Restore
      </button>
    </li>
  ),
}))

function pageRow(id: string, content: string) {
  return {
    id,
    content,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  queryClient.clear()
  useResolveStore.setState({ cache: new Map(), version: 0, _preloaded: false })
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [{ id: 'SPACE_TEST', name: 'Test', accent_color: null }],
    isReady: true,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('HistoryPanel page-title revert fans out through renamePage (#4056)', () => {
  it('reverting a page title from History leaves the [[ picker offering the REVERTED title', async () => {
    const user = userEvent.setup()
    const mockedInvoke = mockInvokeCommands({
      list_all_pages_in_space: () => [pageRow('PAGE001', 'Old Title')],
      get_block_history: () => ({
        items: [makeHistoryEntry(1, 'edit_block', { to_text: 'Reverted Title' })],
        next_cursor: null,
        has_more: false,
        total_count: null,
      }),
      get_block: () => ({ id: 'PAGE001', block_type: 'page', content: 'Old Title' }),
      edit_block: () => ({
        id: 'PAGE001',
        block_type: 'page',
        content: 'Reverted Title',
        op_refs: [],
      }),
    })
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke).mockImplementation(mockedInvoke)

    const { result: resolveResult } = renderHook(() => useBlockResolve())

    // (a) prime the picker's page-name cache.
    await resolveResult.current.searchPages('').then((items) => {
      expect(items.filter((i) => !i.isCreate).map((i) => i.label)).toContain('Old Title')
    })

    render(<HistoryPanel blockId="PAGE001" />)

    // (b) revert the page title from History.
    const restoreBtn = await screen.findByTestId('stub-restore-0')
    await user.click(restoreBtn)

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Reverted successfully', expect.anything())
    })

    // (c) the SECOND picker read, served from the primed cache, must offer
    // the reverted title — not the pre-revert one.
    const itemsAfter = await resolveResult.current.searchPages('')
    const labelsAfter = itemsAfter.filter((i) => !i.isCreate).map((i) => i.label)
    expect(labelsAfter).toContain('Reverted Title')
    expect(labelsAfter).not.toContain('Old Title')
  })

  it('undoing a page-title revert from the toast ALSO fans out through renamePage', async () => {
    const user = userEvent.setup()
    const mockedInvoke = mockInvokeCommands({
      list_all_pages_in_space: () => [pageRow('PAGE001', 'Old Title')],
      get_block_history: () => ({
        items: [makeHistoryEntry(1, 'edit_block', { to_text: 'Reverted Title' })],
        next_cursor: null,
        has_more: false,
        total_count: null,
      }),
      get_block: () => ({ id: 'PAGE001', block_type: 'page', content: 'Old Title' }),
      edit_block: () => ({
        id: 'PAGE001',
        block_type: 'page',
        content: 'Reverted Title',
        op_refs: [],
      }),
    })
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke).mockImplementation(mockedInvoke)

    const { result: resolveResult } = renderHook(() => useBlockResolve())
    await resolveResult.current.searchPages('')

    render(<HistoryPanel blockId="PAGE001" />)

    const restoreBtn = await screen.findByTestId('stub-restore-0')
    await user.click(restoreBtn)

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Reverted successfully', expect.anything())
    })

    const itemsAfterRestore = await resolveResult.current.searchPages('')
    expect(itemsAfterRestore.filter((i) => !i.isCreate).map((i) => i.label)).toContain(
      'Reverted Title',
    )

    // Fire the toast's Undo action, which re-applies the ORIGINAL
    // ("Old Title") content via `handleUndoRestore`.
    const successCall = vi
      .mocked(toast.success)
      .mock.calls.find((c) => c[0] === 'Reverted successfully')
    const action = (successCall?.[1] as { action?: { onClick: () => void } } | undefined)?.action
    expect(action).toBeDefined()
    action?.onClick()

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Restore undone')
    })

    const itemsAfterUndo = await resolveResult.current.searchPages('')
    const labelsAfterUndo = itemsAfterUndo.filter((i) => !i.isCreate).map((i) => i.label)
    expect(labelsAfterUndo).toContain('Old Title')
    expect(labelsAfterUndo).not.toContain('Reverted Title')
  })

  // #4458 — `handleUndoRestore` must scope its rename to the space the
  // RESTORED row lives in, captured at the restore click, not the space
  // that happens to be live when the toast's Undo is later clicked. The two
  // prior tests above restore and undo in the SAME space throughout, so they
  // cannot tell a correct capture from a live re-read — both would pass
  // either way. This test makes them diverge: switch spaces between the
  // restore and the Undo click, and assert the emitted rename is scoped to
  // the ORIGIN space both times.
  it('undoing a page-title revert scopes the rename to the RESTORED space, not the space live when Undo is clicked', async () => {
    const user = userEvent.setup()
    const mockedInvoke = mockInvokeCommands({
      list_all_pages_in_space: () => [pageRow('PAGE001', 'Old Title')],
      get_block_history: () => ({
        items: [makeHistoryEntry(1, 'edit_block', { to_text: 'Reverted Title' })],
        next_cursor: null,
        has_more: false,
        total_count: null,
      }),
      get_block: () => ({ id: 'PAGE001', block_type: 'page', content: 'Old Title' }),
      edit_block: () => ({
        id: 'PAGE001',
        block_type: 'page',
        content: 'Reverted Title',
        op_refs: [],
      }),
    })
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke).mockImplementation(mockedInvoke)

    useSpaceStore.setState({
      currentSpaceId: 'SPACE_A',
      availableSpaces: [
        { id: 'SPACE_A', name: 'A', accent_color: null },
        { id: 'SPACE_B', name: 'B', accent_color: null },
      ],
      isReady: true,
    })

    const seen: NameChange[] = []
    const unsubscribe = subscribeToNameChanges((c) => seen.push(c))

    render(<HistoryPanel blockId="PAGE001" />)

    // Restore while SPACE_A is live.
    const restoreBtn = await screen.findByTestId('stub-restore-0')
    await user.click(restoreBtn)

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Reverted successfully', expect.anything())
    })

    // The user navigates to a DIFFERENT space before clicking the toast's
    // Undo — the exact divergence #4458 is about. The restored row is still
    // in SPACE_A; only the user's live location changed.
    useSpaceStore.setState({ currentSpaceId: 'SPACE_B' })

    const successCall = vi
      .mocked(toast.success)
      .mock.calls.find((c) => c[0] === 'Reverted successfully')
    const action = (successCall?.[1] as { action?: { onClick: () => void } } | undefined)?.action
    expect(action).toBeDefined()
    action?.onClick()

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Restore undone')
    })
    unsubscribe()

    const renamedSpaceIds = seen
      .filter((c) => c.kind === 'renamed' && c.id === 'PAGE001')
      .map((c) => (c.kind === 'renamed' ? c.spaceId : null))
    // Two renames reach the bus: the restore itself, and the undo. Both must
    // be scoped to SPACE_A — the space the row is actually in — never
    // SPACE_B, which is only where the user was standing when Undo was
    // clicked. A live re-read at the Undo click would report the second
    // entry as SPACE_B instead.
    expect(renamedSpaceIds).toEqual(['SPACE_A', 'SPACE_A'])
  })
})
