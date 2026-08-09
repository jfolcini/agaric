/**
 * #3316 item 3 — `CollapsibleGroupList`'s default block path must WINDOW an
 * expanded group's rows instead of mounting all of them.
 *
 * The regression: `CollapsibleGroupListInner` mapped over every block of every
 * expanded group with no virtualizer and no cap, and both reference panels use
 * that path. A hub page referenced by 20 source pages with
 * `MAX_BLOCKS_PER_GROUP` (200) matching blocks each commits ~4,000 `<li>`s plus
 * their PageLink/badge subtrees in one synchronous render — with
 * UnlinkedReferences default-expanding every group, and each Load-more
 * appending up to 4,000 more, all retained.
 *
 * The mechanism (not a timing budget) is what is pinned here: rows must flow
 * through `@tanstack/react-virtual`, so only the virtualizer's window mounts.
 * The shared mock is configured with an explicit `windowSize`, which is the
 * lever: on the unvirtualized path the window is irrelevant and ALL rows mount.
 */

import { render, screen } from '@testing-library/react'
import type React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { mockReactVirtual } from '@/__tests__/mocks/react-virtual'
import type { GroupItem } from '@/components/common/CollapsibleGroupList'
import { CollapsibleGroupList } from '@/components/common/CollapsibleGroupList'
import type { VirtualRowContext } from '@/components/common/VirtualizedBlockList'

/** Rows the virtualizer is allowed to lay out, out of `GROUP_SIZE`. */
const WINDOW_SIZE = 12
vi.mock('@tanstack/react-virtual', () => mockReactVirtual({ windowSize: 12 }))

vi.mock('@/components/ui/chevron-toggle', () => ({
  ChevronToggle: ({ isExpanded }: { isExpanded: boolean }) => (
    <svg data-testid={isExpanded ? 'chevron-down' : 'chevron-right'} />
  ),
}))

vi.mock('@/components/pages/PageLink', () => ({
  PageLink: ({ title, children }: { title: string; children?: React.ReactNode }) => (
    <button type="button">{children ?? title}</button>
  ),
}))

/** One over-full group: the backend caps a group at MAX_BLOCKS_PER_GROUP = 200. */
const GROUP_SIZE = 200

interface TestGroup extends GroupItem {
  page_id: string
  page_title: string | null
  blocks: { id: string }[]
}

function makeBigGroup(pageId: string): TestGroup {
  return {
    page_id: pageId,
    page_title: `Page ${pageId}`,
    blocks: Array.from({ length: GROUP_SIZE }, (_, i) => ({ id: `${pageId}-B${i}` })),
  }
}

interface RenderListProps {
  virtualizeRows: boolean
  groups: TestGroup[]
  listClassName?: string
  activeBlockId?: string
  /** Called with every row's virtualization context, in render order. */
  onRow?: (blockId: string, ctx: VirtualRowContext | undefined) => void
}

function listElement(props: RenderListProps) {
  const expandedGroups = Object.fromEntries(props.groups.map((g) => [g.page_id, true]))
  return (
    <CollapsibleGroupList<TestGroup>
      groups={props.groups}
      expandedGroups={expandedGroups}
      onToggleGroup={vi.fn()}
      untitledLabel="Untitled"
      virtualizeRows={props.virtualizeRows}
      {...(props.listClassName === undefined ? {} : { listClassName: props.listClassName })}
      {...(props.activeBlockId === undefined ? {} : { activeBlockId: props.activeBlockId })}
      renderBlock={(block, _group, virtualRow) => {
        props.onRow?.(block.id, virtualRow)
        return (
          <li
            key={block.id}
            data-testid="row"
            data-backlink-item={block.id}
            ref={virtualRow?.measureRef}
            style={virtualRow?.style}
            data-index={virtualRow?.index}
            data-is-last={virtualRow === undefined ? undefined : String(virtualRow.isLast)}
          >
            {block.id}
          </li>
        )
      }}
    />
  )
}

function renderList(props: RenderListProps) {
  const utils = render(listElement(props))
  return {
    ...utils,
    /** Re-render with a fresh element (fresh `renderBlock`, so `memo` yields). */
    rerenderList: (next: RenderListProps = props) => utils.rerender(listElement(next)),
  }
}

describe('CollapsibleGroupList — #3316 item 3 windowing', () => {
  it('mounts only the virtual window of an expanded group, not all of its blocks', () => {
    renderList({ virtualizeRows: true, groups: [makeBigGroup('P1')] })

    expect(screen.getAllByTestId('row')).toHaveLength(WINDOW_SIZE)
    expect(WINDOW_SIZE).toBeLessThan(GROUP_SIZE)
  })

  it('windows every expanded group, so cost does not grow with Load-more', () => {
    // Two Load-more pages' worth of groups, all expanded (the UnlinkedReferences
    // default). Unwindowed this is 3 x 200 = 600 committed rows.
    const groups = [makeBigGroup('P1'), makeBigGroup('P2'), makeBigGroup('P3')]
    renderList({ virtualizeRows: true, groups })

    expect(screen.getAllByTestId('row')).toHaveLength(WINDOW_SIZE * groups.length)
  })

  it('reserves the full scroll height so the scrollbar and scrollToIndex stay honest', () => {
    const { container } = renderList({ virtualizeRows: true, groups: [makeBigGroup('P1')] })

    // The `<ul>` is its own scroll container, so the un-mounted rows' height is
    // reserved by an in-flow `::before` spacer fed by this custom property
    // (#737). The mock's `getTotalSize` sums ALL rows' estimated sizes.
    const list = container.querySelector('ul')
    expect(list?.style.getPropertyValue('--vbl-total-size')).toBe(`${GROUP_SIZE * 36}px`)
  })

  it('the opt-out path still mounts every row (guards against a silent global change)', () => {
    renderList({ virtualizeRows: false, groups: [makeBigGroup('P1')] })

    expect(screen.getAllByTestId('row')).toHaveLength(GROUP_SIZE)
  })

  // Both reference panels pass `space-y-1` through `listClassName` — correct
  // for the unvirtualized `<ul>`, where rows are in flow. On the windowed path
  // it compiles to `& > * ~ * { margin-top: .25rem }`, and margin-top DOES
  // displace an absolutely-positioned box: with `top: 0` the MARGIN edge is
  // placed at the offset, so every mounted row but the first lands 4px below
  // the `translateY(start)` the virtualizer computed — and the gap jumps as the
  // window slides. The windowed list owns row positioning, so it drops the
  // utility itself rather than relying on every caller to know its layout mode.
  it('strips caller-supplied space-y-* so it cannot displace the absolute rows', () => {
    const { container } = renderList({
      virtualizeRows: true,
      groups: [makeBigGroup('P1')],
      // The exact string BacklinkGroupRenderer / UnlinkedReferences pass.
      listClassName: 'linked-references-blocks ml-4 mt-1 space-y-1',
    })

    const list = container.querySelector('ul')
    expect(list).not.toBeNull()
    // The spacing utility is gone…
    expect(list?.className).not.toMatch(/(?:^|[\s:])space-y-/)
    // …while every other caller class survives untouched.
    expect(list).toHaveClass('linked-references-blocks', 'ml-4', 'mt-1')
  })

  // `useListKeyboardNavigation` defaults to `wrap: true`, so ArrowUp at index 0
  // jumps to the LAST row — far outside `overscan`. `scrollToIndex` remounts the
  // window only after its scroll lands, but the panels' `useFocusedRowEffect`
  // runs in the same commit and never re-runs, so without an anchor the ring is
  // never painted and `aria-activedescendant` names an absent element.
  it('mounts the roving-focus row even when it falls outside the window', () => {
    const group = makeBigGroup('P1')
    const lastId = group.blocks[GROUP_SIZE - 1]?.id as string

    const { container } = renderList({
      virtualizeRows: true,
      groups: [group],
      activeBlockId: lastId,
    })

    // The window still holds only its own rows…
    expect(container.querySelectorAll('[data-backlink-item]')).toHaveLength(WINDOW_SIZE + 1)
    // …plus the out-of-window active row, mounted exactly once.
    expect(container.querySelectorAll(`[data-backlink-item="${lastId}"]`)).toHaveLength(1)
  })

  it('does not double-mount the active row when it is already inside the window', () => {
    const group = makeBigGroup('P1')
    const firstId = group.blocks[0]?.id as string

    const { container } = renderList({
      virtualizeRows: true,
      groups: [group],
      activeBlockId: firstId,
    })

    expect(container.querySelectorAll('[data-backlink-item]')).toHaveLength(WINDOW_SIZE)
    expect(container.querySelectorAll(`[data-backlink-item="${firstId}"]`)).toHaveLength(1)
  })

  // #3732/#3733 note 4 — the panels draw their row divider with `border-b
  // last:border-b-0`. Under windowing `:last-child` is the last MOUNTED row, so
  // the divider disappears from a row in the MIDDLE of the group and the gap
  // migrates as the window slides; with a focus anchor present the anchor was
  // the last DOM child and took the rule instead. `ctx.isLast` is the group's
  // real end, which is what the callers must branch on.
  it('reports isLast for the last row of the GROUP, never the last row of the window', () => {
    const group = makeBigGroup('P1')
    const lastId = group.blocks[GROUP_SIZE - 1]?.id as string

    const { container } = renderList({
      virtualizeRows: true,
      groups: [group],
      // Anchored on the true last row, so it is mounted alongside the window.
      activeBlockId: lastId,
    })

    const flagged = container.querySelectorAll('[data-is-last="true"]')
    expect(flagged).toHaveLength(1)
    expect(flagged[0]?.getAttribute('data-backlink-item')).toBe(lastId)

    // The last row of the WINDOW (index WINDOW_SIZE - 1) is mid-group and must
    // keep its divider.
    const lastWindowed = container.querySelector(`[data-index="${WINDOW_SIZE - 1}"]`)
    expect(lastWindowed?.getAttribute('data-is-last')).toBe('false')
  })

  // #3732 item 3 — `BacklinkRow` is `memo`'d so the panel re-rendering on every
  // arrow-key / focus change does not rebuild every mounted row's element tree
  // (#2193). A fresh `style` object literal per render made that comparison
  // fail every time, so the memo protected nothing for the mounted window.
  it('hands renderBlock a stable style reference while a row has not moved', () => {
    const seen: Array<Map<string, React.CSSProperties | undefined>> = []
    let current = new Map<string, React.CSSProperties | undefined>()
    const onRow = (blockId: string, ctx: VirtualRowContext | undefined) => {
      current.set(blockId, ctx?.style)
    }
    const props = { virtualizeRows: true, groups: [makeBigGroup('P1')], onRow }

    const { rerenderList } = renderList(props)
    seen.push(current)
    current = new Map()
    rerenderList(props)
    seen.push(current)

    const [first, second] = seen
    expect(first?.size).toBe(WINDOW_SIZE)
    expect(second?.size).toBe(WINDOW_SIZE)
    for (const [blockId, style] of first ?? []) {
      expect(style).toBeDefined()
      // Identity, not deep equality: `memo` compares by reference.
      expect(second?.get(blockId)).toBe(style)
    }
  })

  it('has no a11y violations while windowed', async () => {
    const { container } = renderList({ virtualizeRows: true, groups: [makeBigGroup('P1')] })

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
