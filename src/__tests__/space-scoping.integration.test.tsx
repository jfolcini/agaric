/**
 * Integration tests for FEAT-3 Phase 4 — verify that space scoping flows
 * end-to-end from `useSpaceStore.currentSpaceId` through React state
 * and into the IPC wrapper call args.
 *
 * Three scenarios:
 *  1. Switching `useSpaceStore.currentSpaceId` causes `useDuePanelData`
 *     to refetch with the new `spaceId` (optional binding).
 *  2. `GraphView.helpers.fetchGraphData` produces space-scoped IPC calls
 *     for each of `listBlocks` / `listPageLinks` / `queryByProperty`.
 *  3. `TemplatesView` lists templates scoped to the current space (the
 *     `queryByProperty('template')` call carries `spaceId`).
 *
 * These mirror the per-callsite assertions in the unit tests but exercise
 * the full state-store → React-effect → wrapper-arg path so a regression
 * that breaks the wiring (e.g. forgetting to read `currentSpaceId` from
 * the store) fails here even if every individual unit test still passes.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { fetchGraphData } from '../components/GraphView.helpers'
import { TemplatesView } from '../components/TemplatesView'
import { useDuePanelData } from '../hooks/useDuePanelData'
import { useSpaceStore } from '../stores/space'

const mockedInvoke = vi.mocked(invoke)
const emptyPage = { items: [], next_cursor: null, has_more: false }

beforeEach(() => {
  vi.clearAllMocks()
  // Default: every IPC call resolves to an empty page so unrelated
  // commands don't crash the components under test.
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'list_page_links') return []
    return emptyPage
  })
  // Reset the space store between tests so seeding is explicit.
  useSpaceStore.setState({
    currentSpaceId: null,
    availableSpaces: [],
    isReady: true,
  })
})

/**
 * Find the most recent IPC call to `cmd` and return the args object
 * passed to `invoke`. Throws if the command was never called so the
 * assertion fails with a useful message rather than `undefined`.
 */
function lastInvokeArgs(cmd: string): Record<string, unknown> {
  const calls = mockedInvoke.mock.calls.filter((c) => c[0] === cmd)
  if (calls.length === 0) {
    throw new Error(`expected at least one '${cmd}' call but found none`)
  }
  const last = calls[calls.length - 1] as [string, Record<string, unknown>]
  return last[1]
}

describe('FEAT-3 Phase 4 — space scoping integration', () => {
  it('switching currentSpaceId causes useDuePanelData to refetch with the new spaceId', async () => {
    useSpaceStore.setState({
      currentSpaceId: 'SPACE_A',
      availableSpaces: [{ id: 'SPACE_A', name: 'A', accent_color: null }],
      isReady: true,
    })

    const { rerender } = renderHook(() =>
      useDuePanelData({ date: '2025-06-15', sourceFilter: null }),
    )

    // First fetch should have been issued under SPACE_A. The hook calls
    // `listBlocks` (for agenda) and `queryByProperty` (for projected
    // overdue / upcoming) — both must carry `spaceId: 'SPACE_A'`.
    await waitFor(() => {
      const args = lastInvokeArgs('list_blocks')
      expect(args['spaceId']).toBe('SPACE_A')
    })

    // Now switch space — a fresh fetch must go out under SPACE_B.
    mockedInvoke.mockClear()
    act(() => {
      useSpaceStore.setState({
        currentSpaceId: 'SPACE_B',
        availableSpaces: [{ id: 'SPACE_B', name: 'B', accent_color: null }],
        isReady: true,
      })
    })
    rerender()

    await waitFor(() => {
      const args = lastInvokeArgs('list_blocks')
      expect(args['spaceId']).toBe('SPACE_B')
    })
  })

  it('GraphView.helpers.fetchGraphData scopes every IPC call to the active space', async () => {
    await fetchGraphData([], 'SPACE_GRAPH')

    // `listBlocks` is required-`spaceId`; the wrapper forwards it as-is.
    const listBlocksArgs = lastInvokeArgs('list_blocks')
    expect(listBlocksArgs['spaceId']).toBe('SPACE_GRAPH')
    // `listPageLinks` is optional-`spaceId`; the wrapper forwards it as-is.
    const listPageLinksArgs = lastInvokeArgs('list_page_links')
    expect(listPageLinksArgs['spaceId']).toBe('SPACE_GRAPH')
    // `queryByProperty` is optional-`spaceId`; same expectation.
    const queryByPropertyArgs = lastInvokeArgs('query_by_property')
    expect(queryByPropertyArgs['spaceId']).toBe('SPACE_GRAPH')
  })

  it('TemplatesView lists templates scoped to the current space', async () => {
    useSpaceStore.setState({
      currentSpaceId: 'SPACE_TPL',
      availableSpaces: [{ id: 'SPACE_TPL', name: 'TPL', accent_color: null }],
      isReady: true,
    })

    render(
      <TooltipProvider>
        <TemplatesView />
      </TooltipProvider>,
    )

    // Wait for the empty state to render (means the load completed).
    expect(await screen.findByText(/no templates yet/i)).toBeInTheDocument()

    // The template-property query must be scoped to SPACE_TPL.
    const templateQuery = mockedInvoke.mock.calls.find((c) => {
      if (c[0] !== 'query_by_property') return false
      const args = c[1] as Record<string, unknown>
      return args['key'] === 'template'
    })
    expect(templateQuery).toBeDefined()
    const args = templateQuery?.[1] as Record<string, unknown>
    expect(args['spaceId']).toBe('SPACE_TPL')
  })
})
