/**
 * Tests for TagsModeBody — error-path coverage (#1270).
 *
 * The tags-mode body debounces `searchBlocks({ blockTypeFilter:
 * 'tag' })`. On a non-cancellation rejection it must surface a
 * once-per-session failure toast (`notify.error`) rather than swallow
 * the failure. These tests cover both the rejection path and the
 * happy-path render.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TagsModeBody } from '@/components/palette/TagsModeBody'
import { Command } from '@/components/ui/command'
import { notify } from '@/lib/notify'
import { searchBlocks } from '@/lib/tauri'
import { useSpaceStore } from '@/stores/space'

vi.mock('@/lib/tauri', () => ({
  searchBlocks: vi.fn(),
  // `searchBlocksLimit` is a plain clamp helper — keep it pure so the
  // component's limit math runs unchanged.
  searchBlocksLimit: (n: number) => n,
}))

vi.mock('@/lib/notify', () => ({
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

const mockSearch = vi.mocked(searchBlocks)
const mockNotify = vi.mocked(notify)

// A non-cancellation thrown value — `isCancellation` only matches
// `{ kind: 'cancelled' }`, so a bare Error takes the real-failure path.
const realFailure = new Error('search backend down')

function renderBody(onEscalate: (query: string) => void = vi.fn()) {
  // The search effect only fires once the space store is ready.
  useSpaceStore.setState({ currentSpaceId: 'space-1', isReady: true })
  const t = ((key: string) => key) as never
  // TagsModeBody renders cmdk `CommandGroup`/`CommandItem`/`CommandEmpty`
  // primitives that require the `Command` root's context.
  return render(
    <Command>
      <TagsModeBody onEscalate={onEscalate} t={t} />
    </Command>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('TagsModeBody', () => {
  it('renders matched tags when searchBlocks resolves', async () => {
    mockSearch.mockResolvedValue({
      items: [{ id: 'b1', content: 'urgent' } as never],
    } as never)
    renderBody()
    await waitFor(() => {
      expect(screen.getByTestId('palette-tags-group')).toBeInTheDocument()
    })
    expect(mockSearch).toHaveBeenCalled()
    expect(mockNotify.error).not.toHaveBeenCalled()
  })

  // #3288 — a multi-word tag escalates as one `tag:` chip, not `tag:#my`
  // plus the free text `tag`.
  it('quotes a spaced tag name when escalating to search', async () => {
    mockSearch.mockResolvedValue({
      items: [{ id: 'b1', content: 'my tag' } as never],
    } as never)
    const onEscalate = vi.fn()
    renderBody(onEscalate)
    fireEvent.click(await screen.findByTestId('palette-tag-b1'))
    expect(onEscalate).toHaveBeenCalledWith('tag:#"my tag"')
  })

  // #1270 error-path: a rejected (non-cancellation) tag search must
  // surface a failure toast, not be silently swallowed.
  it('surfaces a failure toast when searchBlocks rejects', async () => {
    mockSearch.mockRejectedValue(realFailure)
    renderBody()
    await waitFor(() => {
      expect(mockNotify.error).toHaveBeenCalled()
    })
  })
})
