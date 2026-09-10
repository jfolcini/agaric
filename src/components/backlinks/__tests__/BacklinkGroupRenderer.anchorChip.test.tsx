/**
 * #4551 — the anchor highlight on a linked-reference row.
 *
 * A backlink row is a whole block, and a block routinely links several
 * targets. Exactly one of them is the reason the row is in THIS list: the
 * panel's `targetId`. `BacklinkGroupRenderer` forwards it as `anchorRefId`,
 * and the chip renderers mark the matching chip `.ref-chip-anchor`.
 *
 * Its sibling files mock `renderRichContent` down to the raw string, so the
 * chip DOM this asserts on never exists there. This file deliberately uses the
 * REAL renderer — the class is produced three modules away
 * (`RichContentRenderer` → `marks/blockRef` / `marks/blockLink`) and a test
 * against a stub would pin the prop, not the highlight.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { mockReactVirtual } from '@/__tests__/mocks/react-virtual'

// jsdom gives the group's scroll container zero height, so the real
// virtualizer would window every row away. Same shared mock, same reason, as
// `BacklinkGroupRenderer.test.tsx`.
vi.mock('@tanstack/react-virtual', () => mockReactVirtual())

vi.mock('@/components/pages/PageLink', () => ({
  PageLink: ({ pageId, title }: { pageId: string; title: string }) => (
    <button type="button" data-testid={`page-link-${pageId}`}>
      {title}
    </button>
  ),
}))

import { makeBlockRow } from '@/__tests__/fixtures'
import { BacklinkGroupRenderer } from '@/components/backlinks/BacklinkGroupRenderer'
import type { BacklinkGroup } from '@/lib/bindings'

const TARGET = '000000000000000000000000T1'
const DECOY = '000000000000000000000000D1'

const resolvers = {
  resolveBlockTitle: (id: string) => `Title:${id}`,
  resolveBlockStatus: () => 'active' as const,
  resolveTagName: (id: string) => `Tag:${id}`,
}

function renderRow(content: string, anchorRefId: string | undefined) {
  const groups: BacklinkGroup[] = [
    {
      page_id: 'P1',
      page_title: 'Page One',
      blocks: [makeBlockRow({ id: 'B1', content, parent_id: 'P1', page_id: 'P1' })],
      truncated: false,
    },
  ]
  return render(
    <BacklinkGroupRenderer
      groups={groups}
      expandedGroups={{ P1: true }}
      onToggleGroup={vi.fn()}
      handleBlockClick={vi.fn()}
      handleBlockKeyDown={vi.fn()}
      anchorRefId={anchorRefId}
      {...resolvers}
    />,
  )
}

describe('BacklinkGroupRenderer — anchor chip (#4551)', () => {
  it('marks only the chip naming the target, on a row that links a decoy too', () => {
    const { container } = renderRow(`quotes ((${TARGET})) and also ((${DECOY}))`, TARGET)

    // Both chips render; exactly one is the anchor, and it is the target's.
    expect(screen.getAllByTestId('block-ref-chip')).toHaveLength(2)
    const anchors = container.querySelectorAll('.ref-chip-anchor')
    expect(anchors).toHaveLength(1)
    expect(anchors[0]).toHaveTextContent(`Title:${TARGET}`)
  })

  it('marks a page-link chip the same way', () => {
    const { container } = renderRow(`links [[${TARGET}]] and [[${DECOY}]]`, TARGET)

    const anchors = container.querySelectorAll('.ref-chip-anchor')
    expect(anchors).toHaveLength(1)
    expect(anchors[0]).toHaveTextContent(`Title:${TARGET}`)
  })

  it('marks nothing when no anchor is supplied', () => {
    const { container } = renderRow(`quotes ((${TARGET})) and also ((${DECOY}))`, undefined)

    expect(screen.getAllByTestId('block-ref-chip')).toHaveLength(2)
    expect(container.querySelectorAll('.ref-chip-anchor')).toHaveLength(0)
  })
})
