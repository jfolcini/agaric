/**
 * Tests for PagesTreeSection (PEND-83 Bug 2).
 *
 * Validates:
 *  1. Descendants render under the parent title.
 *  2. Zero-descendants returns null / hides the section entirely.
 *  3. Clicking a descendant leaf calls `onNavigateToPage`.
 *  4. Backend failure path keeps the section silently hidden (no crash).
 *  5. Accessibility — axe audit on rendered descendants.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { PageHeading } from '@/lib/bindings'

vi.mock('../../lib/tauri', () => ({
  listAllPagesInSpace: vi.fn(),
}))

vi.mock('../../lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { listAllPagesInSpace } from '../../lib/tauri'
import { useSpaceStore } from '../../stores/space'
import { PagesTreeSection } from '../PagesTreeSection'

const mockedListAllPagesInSpace = vi.mocked(listAllPagesInSpace)

/** Helper: minimal PageHeading row (todo/priority/dates fields default null). */
function makePageHeading(id: string, content: string): PageHeading {
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
  // Seed the space store so the component's `currentSpaceId` selector
  // returns a real ULID; null would gate the IPC out entirely and the
  // descendants-render test would never see `setPages`.
  useSpaceStore.setState({ currentSpaceId: 'SPACE_TEST' })
  mockedListAllPagesInSpace.mockResolvedValue([])
})

afterEach(() => {
  // Restore default null so cross-test space-store reads don't leak.
  useSpaceStore.setState({ currentSpaceId: null })
})

describe('PagesTreeSection', () => {
  it('renders descendants under the parent title', async () => {
    mockedListAllPagesInSpace.mockResolvedValue([
      makePageHeading('PARENT', 'Notes'),
      makePageHeading('CHILD_2026', 'Notes/2026'),
      makePageHeading('CHILD_2025', 'Notes/2025'),
      // Unrelated page — prefix collision is exact-segment, not raw text.
      makePageHeading('UNRELATED', 'Notebook'),
    ])

    render(<PagesTreeSection pageId="PARENT" pageTitle="Notes" onNavigateToPage={vi.fn()} />)

    // Wait for the section to appear (the empty-descendants early-return
    // hides it until the IPC resolves).
    const section = await screen.findByTestId('pages-tree-section')
    expect(section).toBeInTheDocument()

    // Expand the panel — collapsed by default per plan.
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /pages tree/i }))

    // Both descendants visible; the unrelated `Notebook` page is excluded.
    expect(await screen.findByText('2026')).toBeInTheDocument()
    expect(screen.getByText('2025')).toBeInTheDocument()
    expect(screen.queryByText('Notebook')).not.toBeInTheDocument()
  })

  it('returns null when the page has zero descendants', async () => {
    mockedListAllPagesInSpace.mockResolvedValue([
      // Parent page exists but has no children at all.
      makePageHeading('PARENT', 'Notes'),
      // Unrelated pages stay out of the descendants filter.
      makePageHeading('OTHER', 'Tasks'),
      makePageHeading('CHILD_OF_OTHER', 'Tasks/today'),
    ])

    const { container } = render(
      <PagesTreeSection pageId="PARENT" pageTitle="Notes" onNavigateToPage={vi.fn()} />,
    )

    // Let the IPC settle. The section should still be hidden.
    await waitFor(() => {
      expect(mockedListAllPagesInSpace).toHaveBeenCalledWith('SPACE_TEST')
    })

    // Section never renders — the early `return null` swallows the panel.
    expect(screen.queryByTestId('pages-tree-section')).not.toBeInTheDocument()
    // Container is effectively empty (React renders nothing for null).
    expect(container.firstChild).toBeNull()
  })

  it('calls onNavigateToPage when a descendant leaf is clicked', async () => {
    mockedListAllPagesInSpace.mockResolvedValue([
      makePageHeading('PARENT', 'Notes'),
      makePageHeading('CHILD_2026', 'Notes/2026'),
    ])

    const onNavigateToPage = vi.fn()
    render(
      <PagesTreeSection pageId="PARENT" pageTitle="Notes" onNavigateToPage={onNavigateToPage} />,
    )

    // Expand
    const user = userEvent.setup()
    const header = await screen.findByRole('button', { name: /pages tree/i })
    await user.click(header)

    // Click the leaf — PageTreeItem renders the leaf name as a clickable
    // button.
    const leaf = await screen.findByText('2026')
    await user.click(leaf)

    expect(onNavigateToPage).toHaveBeenCalledWith('CHILD_2026', 'Notes/2026')
  })

  it('stays hidden when the IPC rejects (no crash, no panel)', async () => {
    mockedListAllPagesInSpace.mockRejectedValue(new Error('backend down'))

    const { container } = render(
      <PagesTreeSection pageId="PARENT" pageTitle="Notes" onNavigateToPage={vi.fn()} />,
    )

    await waitFor(() => {
      expect(mockedListAllPagesInSpace).toHaveBeenCalled()
    })

    // Rejection path → `pages` stays `[]` → `children.length === 0` → null.
    expect(screen.queryByTestId('pages-tree-section')).not.toBeInTheDocument()
    expect(container.firstChild).toBeNull()
  })

  it('has no a11y violations when descendants are rendered', async () => {
    mockedListAllPagesInSpace.mockResolvedValue([
      makePageHeading('PARENT', 'Notes'),
      makePageHeading('CHILD_2026', 'Notes/2026'),
    ])

    const { container } = render(
      <PagesTreeSection pageId="PARENT" pageTitle="Notes" onNavigateToPage={vi.fn()} />,
    )

    // Wait for the section to mount; expand so axe sees the tree.
    const header = await screen.findByRole('button', { name: /pages tree/i })
    const user = userEvent.setup()
    await user.click(header)
    await screen.findByText('2026')

    await waitFor(
      async () => {
        expect(await axe(container)).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })
})
