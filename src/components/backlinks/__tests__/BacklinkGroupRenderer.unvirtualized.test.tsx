/**
 * #3738 note 6 — `BacklinkRow`'s `isLast === undefined` branch is the
 * UNVIRTUALIZED row-divider rule, and nothing exercised it.
 *
 * Both reference panels pass `virtualizeRows` unconditionally, and
 * `BacklinkGroupRenderer.test.tsx` mocks the virtualizer to lay out every row —
 * which is still the windowed path, so every row there arrives with a
 * `VirtualRowContext` and `isLast` is always a boolean. The fallback was a
 * guard for a future unvirtualized consumer, asserted nowhere.
 *
 * `CollapsibleGroupList` genuinely supports that path (`virtualizeRows` is
 * opt-in and defaults to `false`, in which case it calls
 * `renderBlock(block, group)` with NO third argument), so the mock here stands
 * in for that real branch rather than inventing one. What it pins is
 * `BacklinkGroupRenderer`'s own contract: given no virtual row it must forward
 * no positioning props at all and leave the divider to the `last:` CSS variant,
 * where `:last-child` and "last row of the group" are the same element.
 */

import { render, screen } from '@testing-library/react'
import type React from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { BacklinkGroup, BlockRow } from '@/lib/tauri'

vi.mock('@/components/common/CollapsibleGroupList', () => ({
  CollapsibleGroupList: ({
    groups,
    renderBlock,
  }: {
    groups: BacklinkGroup[]
    renderBlock: (block: BlockRow, group: BacklinkGroup) => React.ReactNode
  }) => (
    <ul data-testid="unvirtualized-list">
      {groups.flatMap((group) => group.blocks.map((block) => renderBlock(block, group)))}
    </ul>
  ),
}))

vi.mock('@/components/RichContentRenderer', () => ({
  renderRichContent: vi.fn((content: string) => content),
}))

import { makeBlock } from '@/__tests__/fixtures'
import { BacklinkGroupRenderer } from '@/components/backlinks/BacklinkGroupRenderer'

function renderUnvirtualized() {
  const groups: BacklinkGroup[] = [
    {
      page_id: 'P1',
      page_title: 'Page One',
      blocks: [
        makeBlock({ id: 'B1', content: 'first' }),
        makeBlock({ id: 'B2', content: 'second' }),
      ],
    },
  ]
  return render(
    <BacklinkGroupRenderer
      groups={groups}
      expandedGroups={{ P1: true }}
      onToggleGroup={vi.fn()}
      handleBlockClick={vi.fn()}
      handleBlockKeyDown={vi.fn()}
      resolveBlockTitle={(id) => `Title:${id}`}
      resolveBlockStatus={() => 'active'}
      resolveTagName={(id) => `Tag:${id}`}
    />,
  )
}

describe('BacklinkGroupRenderer — unvirtualized rows (#3738 note 6)', () => {
  it('leaves the divider to `last:border-b-0` when the list supplies no virtual row', () => {
    const { container } = renderUnvirtualized()

    expect(screen.getByTestId('unvirtualized-list')).toBeInTheDocument()
    const rows = container.querySelectorAll('[data-backlink-item]')
    expect(rows).toHaveLength(2)

    for (const row of rows) {
      expect(row).toHaveClass('border-b', 'last:border-b-0')
      // The windowed branch's unconditional `border-b-0` must NOT appear: in
      // flow, `:last-child` already names the group's real last row.
      expect(row).not.toHaveClass('border-b-0')
    }
  })

  it('forwards no positioning props, so rows stay in flow', () => {
    const { container } = renderUnvirtualized()

    for (const row of container.querySelectorAll('[data-backlink-item]')) {
      // `style`/`data-index` are the windowed contract; an in-flow row that
      // received them would be absolutely positioned at offset 0 and stack.
      expect(row.getAttribute('style')).toBeNull()
      expect(row.getAttribute('data-index')).toBeNull()
    }
  })
})
