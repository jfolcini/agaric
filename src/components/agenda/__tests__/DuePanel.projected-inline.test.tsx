/**
 * DuePanel — projected agenda rows render INLINE rich content (#4719).
 *
 * `ProjectedEntryContentInner` called `renderRichContent` without `inline`,
 * and its output lands in `<span className="min-w-0 flex-1 truncate">` inside
 * a flex `<li>`. Without `inline`, a recurring task written with leading
 * markdown (`- pick up keys`, `# standup`) put a `<ul>` / `<h1>` block box
 * inside a wrapper sized for one clamped line. `inline: true` (#1533) exists
 * to downgrade block-level nodes before they enter such a wrapper, and the
 * sibling `AlertSection` rows in this same panel already pass it (#4705).
 *
 * A SEPARATE file from `DuePanel.test.tsx` because that suite stubs
 * `renderRichContent` with an identity function (`(markdown) => markdown`),
 * which cannot observe the option at all: under that stub every content
 * string renders as bare text and the bug is invisible. These tests need the
 * real renderer.
 */

import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mockReactVirtual } from '@/__tests__/mocks/react-virtual'
import { clearProjectedCache } from '@/hooks/useDuePanelData'

// #4412 — `listBlocks` / `batchResolve` / `queryByProperty` retired their
// hand-written wrappers; the hook calls `commands.*` and unwraps the `Result`
// envelope, so the spies resolve raw data and the mock wraps it.
const { mockedListBlocks, mockedBatchResolve, mockedQueryByProperty, mockedListProjectedAgenda } =
  vi.hoisted(() => ({
    mockedListBlocks: vi.fn(),
    mockedBatchResolve: vi.fn(),
    mockedQueryByProperty: vi.fn(),
    mockedListProjectedAgenda: vi.fn(),
  }))
vi.mock('@/lib/bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bindings')>()
  return {
    ...actual,
    commands: {
      ...actual.commands,
      listBlocks: (...args: unknown[]) =>
        mockedListBlocks(...args).then((data: unknown) => ({ status: 'ok', data })),
      batchResolve: (...args: unknown[]) =>
        mockedBatchResolve(...args).then((data: unknown) => ({ status: 'ok', data })),
      queryByProperty: (...args: unknown[]) =>
        mockedQueryByProperty(...args).then((data: unknown) => ({ status: 'ok', data })),
      listProjectedAgenda: (...args: unknown[]) =>
        mockedListProjectedAgenda(...args).then((data: unknown) => ({ status: 'ok', data })),
    },
  }
})

// jsdom's zero-height scroll container would otherwise collapse the virtual
// grouped-blocks list to zero rows (mirrors `DuePanel.test.tsx`).
vi.mock('@tanstack/react-virtual', () => mockReactVirtual())

// NOTE: `@/components/RichContentRenderer` is deliberately NOT mocked here.

vi.mock('@/hooks/useRichContentCallbacks', () => ({
  useRichContentCallbacks: vi.fn(() => ({
    resolveBlockTitle: vi.fn(() => undefined),
    resolveBlockStatus: vi.fn(() => 'active' as const),
    resolveTagName: vi.fn(() => undefined),
    resolveTagStatus: vi.fn(() => 'active' as const),
  })),
  useTagClickHandler: vi.fn(() => vi.fn()),
}))

// `lucide-react` is deliberately NOT mocked either: the real
// `RichContentRenderer` pulls icons (callout `Info`, …) that a hand-listed
// icon stub would not export.

import { makeBlock } from '@/__tests__/fixtures'
import { DuePanel } from '@/components/agenda/DuePanel'
import { useNavigationStore } from '@/stores/navigation'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'

const emptyResponse = { items: [], next_cursor: null, has_more: false, total_count: null }

const DATE = '2026-04-13'

/** Queue one projected entry carrying `content` for `DATE`. */
function projectOne(content: string): void {
  mockedListProjectedAgenda.mockResolvedValue({
    items: [
      {
        block: makeBlock({
          id: 'PROJ1',
          content,
          parent_id: 'PAGE1',
          page_id: 'PAGE1',
          todo_state: 'TODO',
          due_date: DATE,
        }),
        projected_date: DATE,
        source: 'due_date',
      },
    ],
    next_cursor: null,
    has_more: false,
    total_count: null,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  clearProjectedCache()
  useSpaceStore.setState({ currentSpaceId: 'SPACE_1' })
  mockedListBlocks.mockResolvedValue(emptyResponse)
  mockedBatchResolve.mockResolvedValue([])
  mockedListProjectedAgenda.mockResolvedValue(emptyResponse)
  mockedQueryByProperty.mockResolvedValue(emptyResponse)
  useNavigationStore.setState({ currentView: 'journal', selectedBlockId: null })
  useTabsStore.setState({ tabs: [{ id: '0', pageStack: [], label: '' }], activeTabIndex: 0 })
})

/** The clamping `<span class="min-w-0 flex-1 truncate">` of the projected row. */
async function clampingSpan(): Promise<HTMLElement> {
  const li = await screen.findByTestId('projected-entry')
  const span = li.querySelector('span.truncate')
  expect(span).not.toBeNull()
  return span as HTMLElement
}

describe('DuePanel — projected rows render inline (#4719)', () => {
  it('a bullet-led recurring task produces no <ul> inside the clamping span', async () => {
    projectOne('- pick up keys')
    render(<DuePanel date={DATE} />)

    const span = await clampingSpan()

    expect(span.querySelector('ul')).toBeNull()
    expect(span.querySelector('li')).toBeNull()
    // The text still shows — `inline` downgrades the node, it does not drop it.
    expect(span.textContent).toContain('pick up keys')
  })

  it('a heading-led recurring task produces no <h1> inside the clamping span', async () => {
    projectOne('# standup')
    render(<DuePanel date={DATE} />)

    const span = await clampingSpan()

    expect(span.querySelector('h1')).toBeNull()
    expect(span.textContent).toContain('standup')
  })

  it('leaves the row with no block-level box at all', async () => {
    // The counterweight to the two above: `inline` is a whole-taxonomy
    // contract, not two special cases. A table and a code block are the other
    // shapes that would break the single-line row.
    projectOne('| a | b |\n| - | - |\n| 1 | 2 |')
    render(<DuePanel date={DATE} />)

    const span = await clampingSpan()

    expect(span.querySelector('table')).toBeNull()
    expect(span.querySelector('div')).toBeNull()
  })

  it('keeps tag chips interactive — the row is not fully inert', async () => {
    // `interactive: true` is deliberate here and survives the fix: `DuePanel`
    // wires `useTagClickHandler()` down to this row on purpose, so its chips
    // stay focusable (unlike `AlertSection`'s, whose row is the sole target).
    // Pinned so a later "match AlertSection" edit is a decision, not a slip.
    projectOne('- ship it #[01KP36KDG2ZZZZZZZZZZZZZZZZ]')
    render(<DuePanel date={DATE} />)

    const span = await clampingSpan()

    await waitFor(() => {
      expect(span.querySelector('[data-testid="tag-ref-chip"]')).not.toBeNull()
    })
    expect(span.querySelector('[data-testid="tag-ref-chip"]')).toHaveAttribute('tabindex', '0')
  })
})
