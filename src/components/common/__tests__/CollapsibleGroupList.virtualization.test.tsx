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

function renderList(props: { virtualizeRows: boolean; groups: TestGroup[] }) {
  const expandedGroups = Object.fromEntries(props.groups.map((g) => [g.page_id, true]))
  return render(
    <CollapsibleGroupList<TestGroup>
      groups={props.groups}
      expandedGroups={expandedGroups}
      onToggleGroup={vi.fn()}
      untitledLabel="Untitled"
      virtualizeRows={props.virtualizeRows}
      renderBlock={(block, _group, virtualRow) => (
        <li
          key={block.id}
          data-testid="row"
          data-backlink-item={block.id}
          ref={virtualRow?.measureRef}
          style={virtualRow?.style}
          data-index={virtualRow?.index}
        >
          {block.id}
        </li>
      )}
    />,
  )
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

  it('has no a11y violations while windowed', async () => {
    const { container } = renderList({ virtualizeRows: true, groups: [makeBigGroup('P1')] })

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
