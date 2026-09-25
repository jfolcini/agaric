/**
 * #5160 follow-up, item 23 — the trash row's content is one clamped
 * `truncate` line, so a stored line break renders as a space there, not as a
 * second line. `TrashRowItem.test.tsx` mocks `renderRichContent` down to the
 * raw string, so the `<br>` this asserts on never exists there; this file uses
 * the real renderer.
 */

import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import { TrashRowItem } from '@/components/TrashView/TrashRowItem'
import type { RichContentCallbacks } from '@/hooks/useRichContentCallbacks'
import type { BlockRow } from '@/lib/bindings'

const callbacks: RichContentCallbacks = {
  resolveBlockTitle: () => undefined,
  resolveBlockStatus: () => 'active',
  resolveTagName: () => undefined,
  resolveTagStatus: () => 'active',
}

describe('TrashRowItem — one-line preview', () => {
  it('renders a block with a line break on one line', () => {
    const block = makeBlock({
      id: 'B1',
      content: 'hello\nworld',
      deleted_at: 1736899200000,
      block_type: 'block',
    }) as BlockRow
    const { container } = render(
      <TrashRowItem
        block={block}
        isSelected={false}
        isFocused={false}
        pageLabel={null}
        descendantCount={0}
        callbacks={callbacks}
        onTagClick={vi.fn()}
        onRowClick={vi.fn()}
        onToggleSelection={vi.fn()}
        onRestore={vi.fn()}
        onRequestPurge={vi.fn()}
      />,
    )

    expect(container.querySelector('.trash-item-text')).toHaveTextContent('hello world')
    expect(container.querySelector('br')).toBeNull()
  })
})
