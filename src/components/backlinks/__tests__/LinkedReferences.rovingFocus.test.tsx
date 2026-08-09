/**
 * #3316 item 3 follow-up — roving focus must survive WINDOWING.
 *
 * The regression this pins: `useListKeyboardNavigation` defaults to
 * `wrap: true`, so ArrowUp on the first row jumps to the LAST row of the list —
 * far outside the virtualizer's `overscan`. `VirtualizedBlockList` asks the
 * virtualizer to `scrollToIndex` that row, but the window is only remounted
 * once that scroll lands, whereas `LinkedReferences`' `useFocusedRowEffect`
 * runs in the SAME commit as the focus change and never re-runs (its deps are
 * keyed on the focused row id, which does not change again).
 *
 * The consequences are both user-visible:
 *   1. `aria-activedescendant` on the panel's `role="group"` container names an
 *      element that is not in the document — strictly worse for AT than the
 *      unvirtualized list it replaces.
 *   2. `LinkedReferences` paints its focus ring ONLY through that DOM lookup
 *      (`BACKLINK_FOCUS_CLASSES` via `useFocusedRowEffect`), unlike
 *      `UnlinkedReferences`, which also sets it declaratively via `className` —
 *      so the ring silently vanishes on wrap-around.
 *
 * This file deliberately uses a WINDOWED virtualizer mock (the other backlink
 * suites lay out every row, which cannot reproduce an off-window focus target).
 * The mock's `scrollToIndex` is inert, which faithfully models the same-commit
 * problem: the fix must make the active row exist WITHOUT waiting for a scroll.
 *
 * #3733 note 3 — because that `scrollToIndex` is inert, the window never
 * actually catches up here, so the ANCHOR-TO-WINDOW TRANSITION went untested.
 * `virtualWindow.size` below is the missing lever: growing it and re-rendering
 * is exactly the commit in which the scroll lands and the anchored row becomes
 * a windowed one. That transition used to swap the row's React child slot
 * (standalone anchor -> mapped array), which changes its reconciliation key and
 * makes React unmount the `<li>` and mount a fresh one — dropping the focus
 * ring `useFocusedRowEffect` had applied imperatively, with no re-run of the
 * effect (its deps are keyed on the unchanged `focusedRowId`) to repaint it.
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { mockReactVirtual } from '@/__tests__/mocks/react-virtual'

/** Rows the virtualizer lays out, well below `GROUP_SIZE`. */
const WINDOW_SIZE = 5
/**
 * Mutable so a test can model the moment `scrollToIndex` lands and the window
 * grows to include the row the panel had anchored. Read lazily by the mock on
 * every `useVirtualizer` call. Reset in `beforeEach`.
 */
const virtualWindow = vi.hoisted(() => ({ size: 5 }))
vi.mock('@tanstack/react-virtual', () => mockReactVirtual({ windowSize: () => virtualWindow.size }))

import { LinkedReferences } from '@/components/backlinks/LinkedReferences'
import { TooltipProvider } from '@/components/ui/tooltip'
import { _resetPropertyKeysCacheForTest } from '@/hooks/usePropertyKeysCache'
import { queryClient } from '@/lib/query-client'
import { useNavigationStore } from '@/stores/navigation'
import { useTabsStore } from '@/stores/tabs'

vi.mock('@/hooks/useBlockPropertyEvents', () => ({
  useBlockPropertyEvents: vi.fn(() => ({ invalidationKey: 0 })),
}))

vi.mock('@/components/filters/SourcePageFilter', () => ({
  SourcePageFilter: () => <div data-testid="source-page-filter" />,
}))

vi.mock('@/components/BacklinkFilterBuilder', () => ({
  BacklinkFilterBuilder: () => <div data-testid="backlink-filter-builder" />,
}))

vi.mock('@/components/pages/PageLink', () => ({
  PageLink: ({ title, children }: { title: string; children?: React.ReactNode }) => (
    <button type="button">{children ?? title}</button>
  ),
}))

const mockedInvoke = vi.mocked(invoke)

/** One group larger than the window, so most rows are never laid out. */
const GROUP_SIZE = 30

/**
 * The fixture's block id for row `i`.
 *
 * #3738 note 5 — every selector in this file goes through here. Two of them
 * used to hand-build the padding (`` `B0${WINDOW_SIZE - 1}` ``), which is only
 * correct while the constant it interpolates stays below 10: raise
 * `WINDOW_SIZE` and the selector silently stops matching any row, and the
 * `not.toBeNull()` on the next line fails somewhere unrelated to the change.
 */
function blockId(i: number): string {
  return `B${String(i).padStart(2, '0')}`
}

function makeGroupedResponse() {
  return {
    groups: [
      {
        page_id: 'P1',
        page_title: 'Page One',
        blocks: Array.from({ length: GROUP_SIZE }, (_, i) => ({
          id: blockId(i),
          block_type: 'content',
          content: `reference ${i}`,
          parent_id: 'P1',
          page_id: 'P1',
          position: i,
          deleted_at: null,
        })),
      },
    ],
    next_cursor: null,
    has_more: false,
    total_count: GROUP_SIZE,
    filtered_count: GROUP_SIZE,
    truncated: false,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  virtualWindow.size = WINDOW_SIZE
  queryClient.clear()
  _resetPropertyKeysCacheForTest()
  useNavigationStore.setState({ currentView: 'journal', selectedBlockId: null })
  useTabsStore.setState({ tabs: [{ id: '0', pageStack: [], label: '' }], activeTabIndex: 0 })
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'list_backlinks_grouped') return makeGroupedResponse()
    if (cmd === 'batch_resolve') return []
    if (cmd === 'list_property_keys') return []
    if (cmd === 'list_tags_by_prefix') return []
    return null
  })
})

/** The panel's roving container — it owns `aria-activedescendant`. */
function rovingContainer(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('.linked-references-list')
  if (!el) throw new Error('roving container not found')
  return el
}

/** Fresh element each call: React bails out of a re-render given the same one. */
function panelElement() {
  return (
    <TooltipProvider>
      <LinkedReferences pageId="PAGE1" />
    </TooltipProvider>
  )
}

async function renderPanel() {
  const utils = render(panelElement())
  await screen.findByText('reference 0')
  return { ...utils, rerenderPanel: () => utils.rerender(panelElement()) }
}

describe('LinkedReferences — roving focus under windowing (#3316 item 3)', () => {
  it('only the virtual window is laid out (precondition for the wrap-around case)', async () => {
    const { container } = await renderPanel()

    // Precondition: the last row is genuinely NOT rendered at rest, so the
    // wrap-around below really does target an off-window row.
    expect(container.querySelectorAll('[data-backlink-item]')).toHaveLength(WINDOW_SIZE)
    expect(
      container.querySelector(`[data-backlink-item="${blockId(GROUP_SIZE - 1)}"]`),
    ).not.toBeInTheDocument()
  })

  it('wrap-around leaves aria-activedescendant pointing at an element in the DOM', async () => {
    const user = userEvent.setup()
    const { container } = await renderPanel()

    const list = rovingContainer(container)
    // Focus the roving container — `useFocusedRowEffect` deliberately no-ops
    // until focus is actually inside the list.
    list.focus()
    expect(list).toHaveFocus()

    // ArrowUp at index 0 wraps to the LAST row, far outside the window.
    await user.keyboard('{ArrowUp}')

    await waitFor(() => {
      expect(list.getAttribute('aria-activedescendant')).toBeTruthy()
    })

    const activeId = list.getAttribute('aria-activedescendant') as string
    // THE assertion: the element the container names must actually exist.
    const active = container.ownerDocument.getElementById(activeId)
    expect(active).not.toBeNull()
    // And it is the wrapped-to last row, not some coincidental survivor.
    expect(active?.getAttribute('data-backlink-item')).toBe(blockId(GROUP_SIZE - 1))
  })

  it('wrap-around still paints the roving focus ring on the wrapped-to row', async () => {
    const user = userEvent.setup()
    const { container } = await renderPanel()

    const list = rovingContainer(container)
    list.focus()
    await user.keyboard('{ArrowUp}')

    await waitFor(() => {
      const active = container.querySelector(`[data-backlink-item="${blockId(GROUP_SIZE - 1)}"]`)
      expect(active).not.toBeNull()
      // `useFocusedRowEffect` adds BACKLINK_FOCUS_CLASSES via the DOM lookup;
      // LinkedReferences has no declarative fallback for the ring.
      expect(active).toHaveClass('ring-2')
    })
  })

  // #3733 note 3 — the half the original #3730 tests could not reach: what
  // happens once `scrollToIndex` LANDS. The anchored row becomes a windowed
  // row, and if that swap remounts the `<li>`, the focus ring goes with the old
  // node — `useFocusedRowEffect` applied it imperatively and does not re-run.
  it('keeps the focus ring when the window catches up to the anchored row', async () => {
    const user = userEvent.setup()
    const { container, rerenderPanel } = await renderPanel()

    const list = rovingContainer(container)
    list.focus()
    await user.keyboard('{ArrowUp}')

    const lastSelector = `[data-backlink-item="${blockId(GROUP_SIZE - 1)}"]`
    await waitFor(() => {
      expect(container.querySelector(lastSelector)).toHaveClass('ring-2')
    })
    const anchored = container.querySelector(lastSelector)

    // The scroll lands: the virtualizer's window now covers the whole group, so
    // the row is no longer an off-window anchor.
    virtualWindow.size = GROUP_SIZE
    rerenderPanel()

    const windowed = container.querySelector(lastSelector)
    expect(windowed).not.toBeNull()
    // The user-visible symptom first: the ring must still be painted.
    expect(windowed).toHaveClass('ring-2', 'ring-inset', 'bg-accent/30')
    // …and the mechanism: same DOM node. A remount is what dropped the ring,
    // since `useFocusedRowEffect` applied it imperatively and does not re-run.
    expect(windowed).toBe(anchored)
    // …and it is mounted exactly once (not duplicated by the transition).
    expect(container.querySelectorAll(lastSelector)).toHaveLength(1)
    expect(list.getAttribute('aria-activedescendant')).toBe(windowed?.getAttribute('id') as string)
  })

  // #3732/#3733 note 4 — `last:border-b-0` matches the last MOUNTED row under
  // windowing, so the divider vanishes from a row in the middle of the group.
  // jsdom computes no Tailwind, so the class string is the assertion.
  it('drops the row divider only on the real last row of the group, not the window', async () => {
    const user = userEvent.setup()
    const { container } = await renderPanel()

    const lastWindowed = container.querySelector(
      `[data-backlink-item="${blockId(WINDOW_SIZE - 1)}"]`,
    )
    expect(lastWindowed).not.toBeNull()
    // Mid-group: it must keep its divider, and must not defer to `:last-child`.
    expect(lastWindowed).toHaveClass('border-b')
    expect(lastWindowed).not.toHaveClass('border-b-0')
    expect(lastWindowed?.className).not.toMatch(/(?:^|\s)last:border-b-0(?:\s|$)/)

    // Anchor the true last row so it mounts, and only it drops the divider.
    const list = rovingContainer(container)
    list.focus()
    await user.keyboard('{ArrowUp}')

    await waitFor(() => {
      expect(
        container.querySelector(`[data-backlink-item="${blockId(GROUP_SIZE - 1)}"]`),
      ).not.toBeNull()
    })
    expect(
      container.querySelector(`[data-backlink-item="${blockId(GROUP_SIZE - 1)}"]`),
    ).toHaveClass('border-b-0')
  })

  it('has no a11y violations after a wrap-around', async () => {
    const user = userEvent.setup()
    const { container } = await renderPanel()

    const list = rovingContainer(container)
    list.focus()
    await user.keyboard('{ArrowUp}')

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
