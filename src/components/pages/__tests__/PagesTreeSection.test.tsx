/**
 * Tests for PagesTreeSection (Bug 2).
 *
 * Validates:
 *  1. Descendants render under the parent title.
 *  2. Zero-descendants returns null / hides the section entirely.
 *  3. Clicking a descendant leaf calls `onNavigateToPage`.
 *  4. Backend failure path keeps the section silently hidden (no crash).
 *  5. The fetch is a namespace-scoped, cursor-paginated query — never the
 *     explicitly-unpaginated whole-space list (#3342).
 *  6. Accessibility — axe audit on rendered descendants.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import type { PageWithMetadataRow } from '@/lib/bindings'

// #2927 phase 7 — `PagesTreeSection` calls `commands` from `@/lib/bindings`
// directly. The spies see the real wire arguments; the shim wraps a
// fulfilment in the `{ status: 'ok', data }` envelope `unwrap` expects.
const mockedListPagesWithMetadata = vi.hoisted(() => vi.fn())
const mockedListAllPagesInSpace = vi.hoisted(() => vi.fn())
vi.mock('@/lib/bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bindings')>()
  return {
    ...actual,
    commands: {
      ...actual.commands,
      listPagesWithMetadata: (...args: unknown[]) =>
        mockedListPagesWithMetadata(...args).then((data: unknown) => ({ status: 'ok', data })),
      listAllPagesInSpace: (...args: unknown[]) =>
        mockedListAllPagesInSpace(...args).then((data: unknown) => ({ status: 'ok', data })),
    },
  }
})

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { PagesTreeSection } from '@/components/pages/PagesTreeSection'
import { useSpaceStore } from '@/stores/space'

/** Helper: minimal metadata row — only `id`/`content` are read by the tree. */
function makeRow(id: string, content: string): PageWithMetadataRow {
  return {
    id,
    blockType: 'page',
    content,
    parentId: null,
    position: null,
    deletedAt: null,
    todoState: null,
    priority: null,
    dueDate: null,
    scheduledDate: null,
    pageId: id,
    lastModifiedAt: null,
    inboundLinkCount: 0,
    childBlockCount: 0,
    flags: { hasTags: false, hasTodo: false, hasScheduled: false, hasDue: false },
  } as unknown as PageWithMetadataRow
}

/** One settled page of the cursor chain. */
function onePage(items: PageWithMetadataRow[]) {
  return { items, next_cursor: null, has_more: false, total_count: items.length }
}

beforeEach(() => {
  vi.clearAllMocks()
  // Seed the space store so the component's `currentSpaceId` selector
  // returns a real ULID; null would gate the IPC out entirely and the
  // descendants-render test would never see `setPages`.
  useSpaceStore.setState({ currentSpaceId: 'SPACE_TEST' })
  mockedListPagesWithMetadata.mockResolvedValue(onePage([]))
  mockedListAllPagesInSpace.mockResolvedValue([])
})

afterEach(() => {
  // Restore default null so cross-test space-store reads don't leak.
  useSpaceStore.setState({ currentSpaceId: null })
})

describe('PagesTreeSection', () => {
  it('renders descendants under the parent title', async () => {
    mockedListPagesWithMetadata.mockResolvedValue(
      onePage([makeRow('CHILD_2026', 'Notes/2026'), makeRow('CHILD_2025', 'Notes/2025')]),
    )

    render(<PagesTreeSection pageId="PARENT" pageTitle="Notes" onNavigateToPage={vi.fn()} />)

    // Wait for the section to appear (the empty-descendants early-return
    // hides it until the IPC resolves).
    const section = await screen.findByTestId('pages-tree-section')
    expect(section).toBeInTheDocument()

    // Expand the panel — collapsed by default per plan.
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /pages tree/i }))

    expect(await screen.findByText('2026')).toBeInTheDocument()
    expect(screen.getByText('2025')).toBeInTheDocument()
  })

  // #3342 — the panel used to fetch EVERY live page in the space (the
  // explicitly-unpaginated `listAllPagesInSpace`, reserved by the backend for
  // markdown export / graph rendering) on every page open and every title
  // edit, then discard all but the `Notes/` prefixed rows.
  it('queries only the page namespace, never the whole-space page list', async () => {
    mockedListPagesWithMetadata.mockResolvedValue(onePage([makeRow('CHILD', 'Notes/2026')]))

    render(<PagesTreeSection pageId="PARENT" pageTitle="Notes" onNavigateToPage={vi.fn()} />)
    await screen.findByTestId('pages-tree-section')

    expect(mockedListAllPagesInSpace).not.toHaveBeenCalled()
    expect(mockedListPagesWithMetadata).toHaveBeenCalledWith(
      {
        spaceId: 'SPACE_TEST',
        filters: [{ type: 'PathGlob', pattern: 'Notes/*', exclude: false }],
      },
      null,
      200,
    )
  })

  // `prepare_globs` splits an entry on top-level commas and rejects
  // unbalanced brackets, so a page title carrying either would silently
  // widen the match or fail the IPC. Neutralising them to `?` keeps the
  // pattern a superset; the exact prefix test still narrows it.
  it('neutralises glob-significant characters in the page title', async () => {
    mockedListPagesWithMetadata.mockResolvedValue(
      onePage([
        makeRow('CHILD', 'Notes, [2026]/plan'),
        // Matched by the widened glob but NOT a real descendant — the exact
        // prefix test must still drop it.
        makeRow('DECOY', 'Notes? x2026x/plan'),
      ]),
    )

    render(
      <PagesTreeSection pageId="PARENT" pageTitle="Notes, [2026]" onNavigateToPage={vi.fn()} />,
    )
    await screen.findByTestId('pages-tree-section')

    expect(mockedListPagesWithMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [{ type: 'PathGlob', pattern: 'Notes? ?2026?/*', exclude: false }],
      }),
      null,
      200,
    )

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /pages tree/i }))
    expect(await screen.findByText('plan')).toBeInTheDocument()
    // Exactly one leaf: the decoy the widened glob let through is filtered out.
    expect(screen.getAllByText('plan')).toHaveLength(1)
  })

  it('follows the cursor chain so a namespace wider than one page is complete', async () => {
    mockedListPagesWithMetadata.mockImplementation(
      async (_filter: unknown, cursor: string | null) => {
        if (cursor == null) {
          return { items: [makeRow('C1', 'Notes/2026')], next_cursor: 'CUR-1', has_more: true }
        }
        return { items: [makeRow('C2', 'Notes/2025')], next_cursor: null, has_more: false }
      },
    )

    render(<PagesTreeSection pageId="PARENT" pageTitle="Notes" onNavigateToPage={vi.fn()} />)
    await screen.findByTestId('pages-tree-section')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /pages tree/i }))
    expect(await screen.findByText('2026')).toBeInTheDocument()
    expect(screen.getByText('2025')).toBeInTheDocument()
  })

  it('returns null when the page has zero descendants', async () => {
    mockedListPagesWithMetadata.mockResolvedValue(onePage([]))

    const { container } = render(
      <PagesTreeSection pageId="PARENT" pageTitle="Notes" onNavigateToPage={vi.fn()} />,
    )

    // Let the IPC settle. The section should still be hidden.
    await waitFor(() => {
      expect(mockedListPagesWithMetadata).toHaveBeenCalled()
    })

    // Section never renders — the early `return null` swallows the panel.
    expect(screen.queryByTestId('pages-tree-section')).not.toBeInTheDocument()
    // Container is effectively empty (React renders nothing for null).
    expect(container.firstChild).toBeNull()
  })

  it('calls onNavigateToPage when a descendant leaf is clicked', async () => {
    mockedListPagesWithMetadata.mockResolvedValue(onePage([makeRow('CHILD_2026', 'Notes/2026')]))

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
    mockedListPagesWithMetadata.mockRejectedValue(new Error('backend down'))

    const { container } = render(
      <PagesTreeSection pageId="PARENT" pageTitle="Notes" onNavigateToPage={vi.fn()} />,
    )

    await waitFor(() => {
      expect(mockedListPagesWithMetadata).toHaveBeenCalled()
    })

    // Rejection path → `pages` stays `[]` → `children.length === 0` → null.
    expect(screen.queryByTestId('pages-tree-section')).not.toBeInTheDocument()
    expect(container.firstChild).toBeNull()
  })

  it('has no a11y violations when descendants are rendered', async () => {
    mockedListPagesWithMetadata.mockResolvedValue(onePage([makeRow('CHILD_2026', 'Notes/2026')]))

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
